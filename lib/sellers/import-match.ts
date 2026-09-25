import type { SellerImportSourceRow, SellerMatchSnapshot } from "@/lib/sellers/import-types";
import { normalizeEmail, normalizeNamePart, normalizePhone } from "@/lib/sellers/import-validate";

/*
  セラー取込の同一判定。

  ■ 前提: 1ショップ = 1 seller
    ・sellers.shop_id は UNIQUE（1 seller が持てる shop_id は1つ）
    ・seller_invoices は (seller_id, target_month) が UNIQUE
      → 2ショップを1sellerにまとめると、請求書も契約料率も1つしか持てなくなる
    ・ショップ実績は shop 単位で取り込まれ、seller_id 単位で合算される
    同じ会社が複数ショップを運営していても、別 seller として保持する。

  ■ 同一 seller と確定してよい条件（これ以外では自動統合しない）
    B) shop_id 一致        … 最優先。取込側に shop_id がある場合のみ
    A) 会社名 + SHOP名 一致

  ■ 自動統合しない（警告だけ出す）
    C) メールだけ一致          … 連絡先の共有はよくある
    D) 電話だけ一致            … 同上
    E) 会社名一致・SHOP名不一致 … 同じ会社の別ショップの可能性
    F) SHOP名一致・会社名不一致 … 既存が仮会社名で登録されている可能性

  メール・電話は「同一 seller を確定するキー」ではなく
  「重複の可能性を検出する補助情報」として扱う。
*/

export type SellerMatchReason = "shop_id" | "name_and_shop";

export type SellerMatchWarningKind =
  /** メールだけ一致（会社名もSHOP名も違う） */
  | "email_only"
  /** 電話だけ一致（会社名もSHOP名も違う） */
  | "phone_only"
  /** 会社名は同じだがSHOP名が違う（別ショップの可能性） */
  | "same_company_other_shop"
  /** SHOP名は同じだが会社名が違う（既存が仮会社名の可能性） */
  | "same_shop_other_company";

export type SellerMatchWarning = {
  kind: SellerMatchWarningKind;
  candidateId: string;
  candidateSellerName: string;
  candidateShopName: string;
  /** 一致した値（メールアドレス / 電話番号 / 会社名 / SHOP名） */
  matchedValue: string;
};

export type SellerMatchResult = {
  /** 同一 seller と確定できた既存 id。null なら新規登録 */
  matchedId: string | null;
  matchedBy: SellerMatchReason | null;
  /** 自動統合はしないが人の確認が必要な候補 */
  warnings: SellerMatchWarning[];
};

/** 警告の説明文（画面表示用） */
export const SELLER_MATCH_WARNING_LABEL_JA: Record<SellerMatchWarningKind, string> = {
  email_only: "同一メールアドレスの別seller候補",
  phone_only: "同一電話番号の別seller候補",
  same_company_other_shop: "同一会社だがSHOP名が異なる（別ショップ）",
  same_shop_other_company: "同一SHOP名だが会社名が異なる",
};

function shopIdOf(value: unknown): string {
  return String(value ?? "").trim();
}

/**
 * 取込1行に対する同一 seller 判定。
 * snapshot の先頭から順に見て、最初に確定した1件だけを採用する。
 */
export function matchSellerImportRow(
  snapshot: SellerMatchSnapshot[],
  row: SellerImportSourceRow & { shop_id?: string | null },
): SellerMatchResult {
  const email = normalizeEmail(row.contact_email);
  const phone = normalizePhone(row.contact_phone);
  const sellerName = normalizeNamePart(row.seller_name);
  const shopName = normalizeNamePart(row.shop_name);
  const shopId = shopIdOf(row.shop_id);

  let matchedId: string | null = null;
  let matchedBy: SellerMatchReason | null = null;

  // B) shop_id 一致（最優先）。取込側に shop_id が無ければ使わない
  if (shopId) {
    const hit = snapshot.find((s) => shopIdOf(s.shop_id) === shopId);
    if (hit) {
      matchedId = hit.id;
      matchedBy = "shop_id";
    }
  }

  // A) 会社名 + SHOP名 の両方が一致
  if (!matchedId && sellerName && shopName) {
    const hit = snapshot.find(
      (s) =>
        normalizeNamePart(s.seller_name) === sellerName &&
        normalizeNamePart(s.shop_name) === shopName,
    );
    if (hit) {
      matchedId = hit.id;
      matchedBy = "name_and_shop";
    }
  }

  /*
    警告の収集。
    確定した seller 自身は対象外（そちらは値の競合として別途検出する）。
    1候補につき1種類だけ出す。上のものほど重要。
  */
  const warnings: SellerMatchWarning[] = [];

  for (const s of snapshot) {
    if (s.id === matchedId) continue;

    const candidateSellerName = normalizeNamePart(s.seller_name);
    const candidateShopName = normalizeNamePart(s.shop_name);

    let kind: SellerMatchWarningKind | null = null;
    let matchedValue = "";

    if (sellerName && candidateSellerName === sellerName && candidateShopName !== shopName) {
      // E) 会社名一致・SHOP名不一致
      kind = "same_company_other_shop";
      matchedValue = String(row.seller_name ?? "").trim();
    } else if (shopName && candidateShopName === shopName && candidateSellerName !== sellerName) {
      // F) SHOP名一致・会社名不一致
      kind = "same_shop_other_company";
      matchedValue = String(row.shop_name ?? "").trim();
    } else if (email && normalizeEmail(s.contact_email) === email) {
      // C) メールだけ一致
      kind = "email_only";
      matchedValue = String(row.contact_email ?? "").trim();
    } else if (phone && normalizePhone(s.contact_phone) === phone) {
      // D) 電話だけ一致
      kind = "phone_only";
      matchedValue = String(row.contact_phone ?? "").trim();
    }

    if (!kind) continue;

    warnings.push({
      kind,
      candidateId: s.id,
      candidateSellerName: String(s.seller_name ?? ""),
      candidateShopName: String(s.shop_name ?? ""),
      matchedValue,
    });
  }

  return { matchedId, matchedBy, warnings };
}

/**
 * 同一 seller と確定できた id だけを返す薄いラッパー。
 * メール・電話だけの一致では null を返す（自動統合しない）。
 */
export function findExistingSellerId(
  snapshot: SellerMatchSnapshot[],
  row: SellerImportSourceRow & { shop_id?: string | null },
): string | null {
  return matchSellerImportRow(snapshot, row).matchedId;
}

export function upsertSnapshotAfterInsert(
  snapshot: SellerMatchSnapshot[],
  inserted: SellerMatchSnapshot,
): void {
  snapshot.push(inserted);
}

export function refreshSnapshotRow(
  snapshot: SellerMatchSnapshot[],
  id: string,
  patch: Partial<SellerMatchSnapshot>,
): void {
  const i = snapshot.findIndex((s) => s.id === id);
  if (i >= 0) {
    snapshot[i] = { ...snapshot[i], ...patch };
  }
}
