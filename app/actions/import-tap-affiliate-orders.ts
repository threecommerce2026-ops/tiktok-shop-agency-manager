"use server";

import { createClient } from "@supabase/supabase-js";
import {
  getTapFileHash,
  parseTapAffiliateOrderExport,
} from "@/lib/orders/parse-tap-affiliate-order-export";
import { buildCreatorAliasMap, creatorAliasFromRow } from "@/lib/orders/creator-alias";
import {
  applyCreatorAliasesToTapRows,
  summarizeUnknownCreators,
  type UnknownCreatorSummary,
} from "@/lib/orders/tap-creator-alias";
import { tapLineExclusionReason } from "@/lib/referrals/tap-referral-source";

/*
  TAP 取込の結果とプレビュー。

  ■ 紹介者報酬の正データなので、取り込む前に必ず中身を見せる
  ここで取り込んだ行がそのまま紹介者への支払根拠になる。
  何行入るのか、誰に紐付くのか、紐付かない名前が何件あるのかを
  確定前に出す。

  ■ 未登録クリエイターを勝手に作らない
  以前は知らないユーザー名を creators へ自動作成していた。
  紹介者も分からないまま報酬計算の対象が増えるため、作成をやめ、
  未紐付けとして一覧に出すだけにする。
*/
export type TapImportPreview = {
  fileName: string;
  fileHash: string;
  totalRows: number;
  /** 対象期間（最小月 〜 最大月） */
  periodStart: string | null;
  periodEnd: string | null;
  monthCounts: Array<{ month: string; rowCount: number; commissionBase: number }>;
  creatorCount: number;
  knownCreatorCount: number;
  aliasedRowCount: number;
  appliedAliases: Array<{ from: string; to: string; rowCount: number }>;
  unknownCreators: UnknownCreatorSummary[];
  commissionBaseTotal: number;
  /** 既に tap_affiliate_order_lines にある行（更新になる） */
  existingRowCount: number;
  /** 新しく入る行 */
  newRowCount: number;
  /** 紹介者報酬の対象外になる行（理由別） */
  excludedCounts: Array<{ reason: string; rowCount: number }>;
  duplicateFile: boolean;
};

type ImportResult = {
  ok: boolean;
  message: string;
  parsedCount?: number;
  insertedOrUpdatedCount?: number;
  creatorCount?: number;
  duplicateFile?: boolean;
  unknownCreatorCount?: number;
  skippedUnlinkedRowCount?: number;
  aliasedRowCount?: number;
  preview?: TapImportPreview;
};

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error("Supabase環境変数が設定されていません。");
  }

  return createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function normalizeTikTokId(value: string | null | undefined) {
  return (value ?? "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
}

export async function importTapAffiliateOrdersAction(
  formData: FormData,
): Promise<ImportResult> {
  try {
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return {
        ok: false,
        message: "TAP Excelファイルを選択してください。",
      };
    }

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    const fileHash = getTapFileHash(buffer);
    const supabase = getSupabaseAdmin();

    /*
      完全に同じファイルが過去に正常取込済みなら
      二重取込を防止。
    */
    const { data: existingBatch, error: existingBatchError } =
      await supabase
        .from("tap_affiliate_order_import_batches")
        .select("id, file_name, imported_at")
        .eq("file_hash", fileHash)
        .maybeSingle();

    if (existingBatchError) {
      throw new Error(
        `既存ファイル確認に失敗しました: ${existingBatchError.message}`,
      );
    }

    if (existingBatch) {
      return {
        ok: true,
        duplicateFile: true,
        message:
          "このファイルはすでに取り込み済みです。重複登録は行いませんでした。",
      };
    }

    const parsedRows = parseTapAffiliateOrderExport(buffer);

    if (parsedRows.length === 0) {
      return {
        ok: false,
        message: "TAP注文明細をExcelから取得できませんでした。",
      };
    }

    /*
      別名（改名）を先に適用する。

      TAP の一意キーにもクリエイター名が入るため、改名されたまま取り込むと
      同じ明細が別行になり、紹介者報酬が二重計上になる。
      解決規則は affiliate 取込と同じ共通実装を使う。
    */
    const { data: aliasRows, error: aliasError } = await supabase
      .from("creator_tiktok_aliases")
      .select("alias_tiktok_id, canonical_tiktok_id");

    if (aliasError) {
      throw new Error(`別名の取得に失敗しました: ${aliasError.message}`);
    }

    const aliasMap = buildCreatorAliasMap(
      (aliasRows ?? []).map((row) => creatorAliasFromRow(row)),
    );
    const aliasApplied = applyCreatorAliasesToTapRows(parsedRows, aliasMap);
    const rows = aliasApplied.rows;

    /*
      取り込む前に必ず中身を見せる。
      dryRun のときはここで返し、DBへは一切書き込まない。
    */
    const dryRun = formData.get("dry_run") === "1";

    const { data: batch, error: batchError } = dryRun
      ? { data: null, error: null }
      : await supabase
      .from("tap_affiliate_order_import_batches")
      .insert({
        file_name: file.name,
        file_hash: fileHash,
        row_count: rows.length,
        inserted_count: 0,
        updated_count: 0,
        skipped_count: 0,
      })
      .select("id")
      .single();

    if (!dryRun && (batchError || !batch)) {
      throw new Error(
        `取込履歴の作成に失敗しました: ${
          batchError?.message ?? "unknown error"
        }`,
      );
    }

    /*
      まずExcel内のTikTok IDをユニーク化。
    */
    const creatorTikTokIds = [
      ...new Set(
        rows
          .map((row) => normalizeTikTokId(row.creatorTikTokId))
          .filter(Boolean),
      ),
    ];

    /*
      既存クリエイターを一括取得。
    */
    const creatorMap = new Map<
      string,
      {
        id: string;
        agency_id: string | null;
      }
    >();

    if (creatorTikTokIds.length > 0) {
      const { data: existingCreators, error: creatorsError } =
        await supabase
          .from("creators")
          .select("id, tiktok_id, agency_id")
          .in("tiktok_id", creatorTikTokIds);

      if (creatorsError) {
        throw new Error(
          `クリエイター取得に失敗しました: ${creatorsError.message}`,
        );
      }

      for (const creator of existingCreators ?? []) {
        creatorMap.set(normalizeTikTokId(creator.tiktok_id), {
          id: creator.id,
          agency_id: creator.agency_id ?? null,
        });
      }
    }

    /*
      未登録クリエイターは作らない。

      TAP は紹介者報酬の正データになったので、知らないユーザー名が来ても
      その場で creators を作ってはいけない。誰の紹介かも分からないまま
      報酬計算の対象クリエイターが増え、紹介者への支払根拠が濁る。
      未紐付けとしてプレビューへ出し、人が紐付けてから取り込み直す。
    */
    const unknownCreators = summarizeUnknownCreators(rows, new Set(creatorMap.keys()));

    /*
      creators に紐付く行だけを取り込む。
      紐付かない行を creator_id = null で入れると、
      紹介者報酬の集計時に「誰の売上か分からない金額」が混ざる。
    */
    const linkedRows = rows.filter((row) =>
      creatorMap.has(normalizeTikTokId(row.creatorTikTokId)),
    );
    const skippedUnlinkedRowCount = rows.length - linkedRows.length;

    /*
      source_row_keyを一意キーとしてupsert。
      金額や支払い状況が後日変わった場合は既存行を更新。
    */
    const payload = linkedRows.map((row) => {
      const creator = creatorMap.get(
        normalizeTikTokId(row.creatorTikTokId),
      );

      return {
        source_row_key: row.sourceRowKey,

        order_id: row.orderId,
        sku_id: row.skuId,
        product_id: row.productId,
        product_name: row.productName,

        creator_id: creator?.id ?? null,
        creator_tiktok_id: row.creatorTikTokId
          ? normalizeTikTokId(row.creatorTikTokId)
          : null,
        creator_name: row.creatorName,

        shop_name: row.shopName,
        shop_code: row.shopCode,

        target_month: row.targetMonth,

        content_type: row.contentType,
        content_id: row.contentId,
        invitation_id: row.invitationId,
        commission_type: row.commissionType,

        product_price: row.productPrice,
        quantity: row.quantity,

        commission_gmv: row.commissionGmv,
        commission_base: row.commissionBase,

        partner_estimated_commission:
          row.partnerEstimatedCommission,

        partner_shop_ads_estimated_commission:
          row.partnerShopAdsEstimatedCommission,

        partner_bonus_estimated_commission:
          row.partnerBonusEstimatedCommission,

        tap_revenue: row.tapRevenue,

        payment_status: row.paymentStatus,
        order_status: row.orderStatus,
        refund_status: row.refundStatus,

        ordered_at: row.orderedAt,
        delivered_at: row.deliveredAt,
        paid_at: row.paidAt,

        import_batch_id: batch?.id ?? null,
        raw_row_json: row.rawRowJson,

        updated_at: new Date().toISOString(),
      };
    });

    // ---- プレビュー（取り込む前に必ず見せる） ----------------------------------
    const byMonth = new Map<string, { rowCount: number; commissionBase: number }>();
    for (const row of rows) {
      const month = row.targetMonth ?? "(不明)";
      const current = byMonth.get(month) ?? { rowCount: 0, commissionBase: 0 };
      current.rowCount += 1;
      current.commissionBase += Number(row.commissionBase ?? 0);
      byMonth.set(month, current);
    }
    const monthCounts = [...byMonth.entries()]
      .map(([month, v]) => ({ month, ...v }))
      .sort((a, b) => a.month.localeCompare(b.month));
    const months = monthCounts.map((m) => m.month).filter((m) => m !== "(不明)");

    /*
      既に入っている行の数。
      source_row_key は長いので .in() に渡さず、creator_id で引いて
      メモリ上で突き合わせる（URLが長すぎると無言で失敗する）。
    */
    const linkedCreatorIds = [
      ...new Set(linkedRows.map((row) => creatorMap.get(normalizeTikTokId(row.creatorTikTokId))?.id).filter(Boolean)),
    ] as string[];
    const existingKeys = new Set<string>();
    for (let i = 0; i < linkedCreatorIds.length; i += 50) {
      const slice = linkedCreatorIds.slice(i, i + 50);
      const { data: existing } = await supabase
        .from("tap_affiliate_order_lines")
        .select("source_row_key")
        .in("creator_id", slice);
      for (const row of existing ?? []) existingKeys.add(row.source_row_key);
    }
    const existingRowCount = linkedRows.filter((r) => existingKeys.has(r.sourceRowKey)).length;

    // 紹介者報酬の対象外になる行を理由別に数える
    const excluded = new Map<string, number>();
    for (const row of linkedRows) {
      const reason = tapLineExclusionReason({
        source_row_key: row.sourceRowKey,
        order_id: row.orderId,
        product_id: row.productId,
        creator_id: creatorMap.get(normalizeTikTokId(row.creatorTikTokId))?.id ?? null,
        target_month: row.targetMonth,
        commission_base: row.commissionBase,
        payment_status: row.paymentStatus,
        order_status: row.orderStatus,
        refund_status: row.refundStatus,
      });
      if (reason) excluded.set(reason, (excluded.get(reason) ?? 0) + 1);
    }

    const preview: TapImportPreview = {
      fileName: file.name,
      fileHash,
      totalRows: rows.length,
      periodStart: months[0] ?? null,
      periodEnd: months.at(-1) ?? null,
      monthCounts,
      creatorCount: creatorTikTokIds.length,
      knownCreatorCount: creatorMap.size,
      aliasedRowCount: aliasApplied.aliasedRowCount,
      appliedAliases: aliasApplied.appliedAliases,
      unknownCreators,
      commissionBaseTotal: rows.reduce((sum, r) => sum + Number(r.commissionBase ?? 0), 0),
      existingRowCount,
      newRowCount: linkedRows.length - existingRowCount,
      excludedCounts: [...excluded.entries()].map(([reason, rowCount]) => ({ reason, rowCount })),
      duplicateFile: false,
    };

    if (dryRun) {
      return {
        ok: true,
        message: `${rows.length.toLocaleString("ja-JP")} 行を確認しました。まだ取り込んでいません。`,
        parsedCount: rows.length,
        unknownCreatorCount: unknownCreators.length,
        skippedUnlinkedRowCount,
        aliasedRowCount: aliasApplied.aliasedRowCount,
        preview,
      };
    }

    /*
      大量データなので1000件ずつupsert。
    */
    const chunkSize = 1000;
    let processedCount = 0;

    for (let i = 0; i < payload.length; i += chunkSize) {
      const chunk = payload.slice(i, i + chunkSize);

      const { error: upsertError } = await supabase
        .from("tap_affiliate_order_lines")
        .upsert(chunk, {
          onConflict: "source_row_key",
          ignoreDuplicates: false,
        });

      if (upsertError) {
        throw new Error(
          `TAP注文明細の保存に失敗しました: ${upsertError.message}`,
        );
      }

      processedCount += chunk.length;
    }

    const { error: updateBatchError } = await supabase
      .from("tap_affiliate_order_import_batches")
      .update({
        inserted_count: processedCount,
      })
      .eq("id", batch!.id);

    if (updateBatchError) {
      console.error(
        "TAP取込履歴更新エラー:",
        updateBatchError.message,
      );
    }

    return {
      ok: true,
      message: `${processedCount.toLocaleString(
        "ja-JP",
      )}件のTAP注文明細を取り込みました。`,
      parsedCount: rows.length,
      insertedOrUpdatedCount: processedCount,
      unknownCreatorCount: unknownCreators.length,
      skippedUnlinkedRowCount,
      aliasedRowCount: aliasApplied.aliasedRowCount,
      preview,
      creatorCount: creatorTikTokIds.length,
    };
  } catch (error) {
    console.error(error);

    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "TAP注文の取込中にエラーが発生しました。",
    };
  }
}
