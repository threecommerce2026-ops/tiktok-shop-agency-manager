import type {
  SellerImportPreviewRow,
  SellerImportSourceRow,
  SellerMatchSnapshot,
} from "@/lib/sellers/import-types";
import {
  SELLER_MATCH_WARNING_LABEL_JA,
  matchSellerImportRow,
  refreshSnapshotRow,
  type SellerMatchWarning,
} from "@/lib/sellers/import-match";
import { validateSellerImportRow } from "@/lib/sellers/import-validate";
import { isDeclinedSeller, isTapOnlySeller } from "@/lib/sellers/tsp-form";
import { applyShopNameOverride } from "@/lib/sellers/shop-name-overrides";
import {
  BLANK_PRESERVING_SELLER_FIELDS,
  SELLER_FIELD_LABEL_JA,
  collectSellerImportConflicts,
  mergeSellerUpdatePatch,
} from "@/lib/sellers/import-merge";

/** 上書き判定に使う全列を取り出す */
function pickMergeFields(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of BLANK_PRESERVING_SELLER_FIELDS) out[field] = row[field] ?? null;
  return out;
}

export function simulateSellerImport(
  rows: SellerImportSourceRow[],
  dbSnapshot: SellerMatchSnapshot[],
): {
  previewRows: SellerImportPreviewRow[];
  counts: {
    total: number;
    new: number;
    update: number;
    error: number;
    duplicateInFile: number;
    declined: number;
    tapOnly: number;
    needsReview: number;
    /** 同一セラー判定された行同士で、非空の値が食い違う行数 */
    conflict: number;
    /** 自動統合せず警告だけ出した候補の種類別件数 */
    emailOnly: number;
    phoneOnly: number;
    sameCompanyOtherShop: number;
    sameShopOtherCompany: number;
    /** ステータス後退を拒否して既存値を維持した列の延べ件数 */
    blockedRegression: number;
  };
} {
  const snapshot: SellerMatchSnapshot[] = dbSnapshot.map((s) => ({ ...s }));
  const previewRows: SellerImportPreviewRow[] = [];
  let newCount = 0;
  let updateCount = 0;
  let errorCount = 0;
  let duplicateInFileCount = 0;
  let declinedCount = 0;
  let tapOnlyCount = 0;
  let needsReviewCount = 0;
  let conflictCount = 0;
  const warningCounts: Partial<Record<SellerMatchWarning["kind"], number>> = {};
  let blockedRegressionCount = 0;

  /* 上書き判定に使う列の現在値（id → 値）。DB既存もファイル内新規も入れる */
  const fieldsById = new Map<string, Record<string, unknown>>();
  for (const s of dbSnapshot) fieldsById.set(s.id, pickMergeFields(s as unknown as Record<string, unknown>));

  /* 同じファイル内で既に出てきた行かどうかを見るための仮ID集合 */
  const virtualIds = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const seller_name = row.seller_name.trim();
    /*
      同一ショップと人が確認済みの改称は、ここでもSHOP名を正の表記へ揃える。
      クライアント解析側でも同じ処理をしているが、
      サーバー側の判定が渡されたデータに依存しないように再適用する（冪等）。
    */
    const shop_name = applyShopNameOverride(seller_name, row.shop_name.trim()).shopName;
    const contact_person = row.contact_person?.trim() || null;
    const contact_phone = row.contact_phone?.trim() || null;
    const contact_email = row.contact_email?.trim() || null;

    const err = validateSellerImportRow({ ...row, seller_name, shop_name, contact_person, contact_phone, contact_email });
    if (err) {
      previewRows.push({
        index: i,
        seller_name,
        shop_name,
        contact_person,
        contact_phone,
        contact_email,
        status: "error",
        errorMessage: err,
      });
      errorCount++;
      continue;
    }

    const match = matchSellerImportRow(snapshot, {
      ...row,
      seller_name,
      shop_name,
      contact_person,
      contact_phone,
      contact_email,
    });
    const existingId = match.matchedId;

    for (const w of match.warnings) {
      warningCounts[w.kind] = (warningCounts[w.kind] ?? 0) + 1;
    }

    const matchWarning =
      match.warnings.length > 0
        ? match.warnings
            .map(
              (w) =>
                `${SELLER_MATCH_WARNING_LABEL_JA[w.kind]}: 「${w.candidateSellerName} / ${w.candidateShopName}」（${w.matchedValue}）`,
            )
            .join(" / ")
        : undefined;

    const declined = isDeclinedSeller(row);
    const tapOnly = isTapOnlySeller(row);
    const needsReview = row.source_created_at_unparsable === true;

    if (declined) declinedCount++;
    if (tapOnly) tapOnlyCount++;
    if (needsReview) needsReviewCount++;

    const flags = {
      declined,
      tapOnly,
      needsReview,
      reviewMessage: needsReview ? "創建時間を解釈できません（日付は保存しません）" : undefined,
      matchWarning,
    };

    if (existingId) {
      // 同じファイル内で既に出た行との重複か、DB既存との一致かを区別する
      const duplicateInFile = virtualIds.has(existingId);
      if (duplicateInFile) duplicateInFileCount++;

      const incoming = pickMergeFields({
        ...row,
        seller_name,
        shop_name,
        contact_person,
        contact_phone,
        contact_email,
      } as unknown as Record<string, unknown>);
      const current = fieldsById.get(existingId) ?? null;

      /*
        非空同士で値が食い違う列は、後勝ちで片方の情報が失われる。
        どちらを残すかは人が決める必要があるので警告として出す。
      */
      const conflicts = collectSellerImportConflicts(current, incoming);
      if (conflicts.length > 0) conflictCount++;

      // ステータス後退を拒否した列（既存値が残る）
      const blocked = mergeSellerUpdatePatch(current, { ...incoming }).blockedRegressions;
      if (blocked.length > 0) blockedRegressionCount += blocked.length;

      previewRows.push({
        index: i,
        seller_name,
        shop_name,
        contact_person,
        contact_phone,
        contact_email,
        status: "update",
        duplicateInFile,
        regressionMessage:
          blocked.length > 0
            ? blocked
                .map(
                  (r) =>
                    `${SELLER_FIELD_LABEL_JA[r.field]}: 「${r.existingValue}」を維持（「${r.rejectedValue}」への後退を取り込みません）`,
                )
                .join(" / ")
            : undefined,
        conflictMessage:
          conflicts.length > 0
            ? conflicts
                .map(
                  (c) =>
                    `${SELLER_FIELD_LABEL_JA[c.field]}: 「${c.existingValue}」→「${c.incomingValue}」`,
                )
                .join(" / ")
            : undefined,
        ...flags,
      });
      updateCount++;

      // 空欄では既存値を消さない（取込実行と同じ挙動にする）
      if (current) {
        // 実際にDBへ書かれる値と同じものを作る（空欄維持・後退防止を反映）
        const next: Record<string, unknown> = {
          ...current,
          ...mergeSellerUpdatePatch(current, { ...incoming }).patch,
        };
        fieldsById.set(existingId, next);
        refreshSnapshotRow(snapshot, existingId, {
          seller_name: String(next.seller_name ?? seller_name),
          shop_name: String(next.shop_name ?? shop_name),
          contact_email: (next.contact_email as string | null) ?? null,
          contact_phone: (next.contact_phone as string | null) ?? null,
        });
      }
    } else {
      previewRows.push({
        index: i,
        seller_name,
        shop_name,
        contact_person,
        contact_phone,
        contact_email,
        status: "new",
        ...flags,
      });
      newCount++;
      const virtualId = `__virt__${i}`;
      virtualIds.add(virtualId);
      fieldsById.set(
        virtualId,
        pickMergeFields({
          ...row,
          seller_name,
          shop_name,
          contact_person,
          contact_phone,
          contact_email,
        } as unknown as Record<string, unknown>),
      );
      snapshot.push({
        id: virtualId,
        seller_name,
        shop_name,
        contact_email,
        contact_phone,
      });
    }
  }

  return {
    previewRows,
    counts: {
      total: rows.length,
      new: newCount,
      update: updateCount,
      error: errorCount,
      duplicateInFile: duplicateInFileCount,
      declined: declinedCount,
      tapOnly: tapOnlyCount,
      needsReview: needsReviewCount,
      conflict: conflictCount,
      emailOnly: warningCounts.email_only ?? 0,
      phoneOnly: warningCounts.phone_only ?? 0,
      sameCompanyOtherShop: warningCounts.same_company_other_shop ?? 0,
      sameShopOtherCompany: warningCounts.same_shop_other_company ?? 0,
      blockedRegression: blockedRegressionCount,
    },
  };
}
