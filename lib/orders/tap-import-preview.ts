import { tapLineExclusionReason } from "@/lib/referrals/tap-referral-source";
import { summarizeUnknownCreators } from "@/lib/orders/tap-creator-alias";
import type { UnknownCreatorSummary } from "@/lib/orders/tap-creator-alias";
import type { TapAffiliateOrderRow } from "@/lib/orders/parse-tap-affiliate-order-export";
import { normalizeTiktokId } from "@/lib/sales/parse-partner-sales";

/*
  TAP取込のプレビューを組み立てる。

  ■ ブラウザで動かす
  Excel 本体をサーバーへ送らないため、集計もブラウザで行う。
  サーバーへ聞くのは「creators に居るか」「既に入っている行はどれか」だけで、
  それもページ単位で取り寄せて手元で突き合わせる（URL を長くしない）。

  ■ 判定はサーバーと同じものを使う
  紹介者報酬の対象・対象外は lib/referrals/tap-referral-source.ts が唯一の正。
  プレビュー用に別の条件を書かない（書くと画面と実データがずれる）。
*/

export type TapPreviewMonth = {
  month: string;
  rowCount: number;
  commissionBase: number;
};

export type TapImportPreview = {
  fileName: string;
  fileHash: string;
  totalRows: number;
  periodStart: string | null;
  periodEnd: string | null;
  monthCounts: TapPreviewMonth[];
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
  /** クリエイターが解決できず取り込めない行 */
  skippedRowCount: number;
  /** 紹介者報酬の対象外になる行（理由別） */
  excludedCounts: Array<{ reason: string; rowCount: number }>;
  chunkCount: number;
  maxChunkBytes: number;
};

export function buildTapImportPreview(input: {
  fileName: string;
  fileHash: string;
  rows: TapAffiliateOrderRow[];
  /** creators に存在する TikTok ID（正規化済み） */
  knownTiktokIds: Set<string>;
  /** 既に取り込まれている一意キー */
  existingSourceRowKeys: Set<string>;
  aliasedRowCount: number;
  appliedAliases: Array<{ from: string; to: string; rowCount: number }>;
  chunkCount: number;
  maxChunkBytes: number;
}): TapImportPreview {
  const { rows, knownTiktokIds, existingSourceRowKeys } = input;

  // ---- 月別 -----------------------------------------------------------------
  const byMonth = new Map<string, { rowCount: number; commissionBase: number }>();
  for (const row of rows) {
    const month = row.targetMonth ?? "(不明)";
    const current = byMonth.get(month) ?? { rowCount: 0, commissionBase: 0 };
    current.rowCount += 1;
    current.commissionBase += Number(row.commissionBase ?? 0);
    byMonth.set(month, current);
  }
  const monthCounts = [...byMonth.entries()]
    .map(([month, value]) => ({ month, ...value }))
    .sort((a, b) => a.month.localeCompare(b.month));
  const months = monthCounts.map((m) => m.month).filter((m) => m !== "(不明)");

  // ---- クリエイター ---------------------------------------------------------
  const unknownCreators = summarizeUnknownCreators(rows, knownTiktokIds);
  const creatorIds = new Set(
    rows.map((row) => normalizeTiktokId(row.creatorTikTokId ?? "")).filter(Boolean),
  );
  const linkedRows = rows.filter((row) =>
    knownTiktokIds.has(normalizeTiktokId(row.creatorTikTokId ?? "")),
  );

  // ---- 既存との重複 ---------------------------------------------------------
  const existingRowCount = linkedRows.filter((row) =>
    existingSourceRowKeys.has(row.sourceRowKey),
  ).length;

  // ---- 紹介者報酬の対象外 ---------------------------------------------------
  const excluded = new Map<string, number>();
  for (const row of linkedRows) {
    const reason = tapLineExclusionReason({
      source_row_key: row.sourceRowKey,
      order_id: row.orderId,
      product_id: row.productId,
      // ここでは creator の解決ができていることだけ分かればよい
      creator_id: "resolved",
      target_month: row.targetMonth,
      commission_base: row.commissionBase,
      payment_status: row.paymentStatus,
      order_status: row.orderStatus,
      refund_status: row.refundStatus,
    });
    if (reason) excluded.set(reason, (excluded.get(reason) ?? 0) + 1);
  }

  return {
    fileName: input.fileName,
    fileHash: input.fileHash,
    totalRows: rows.length,
    periodStart: months[0] ?? null,
    periodEnd: months.at(-1) ?? null,
    monthCounts,
    creatorCount: creatorIds.size,
    knownCreatorCount: creatorIds.size - unknownCreators.length,
    aliasedRowCount: input.aliasedRowCount,
    appliedAliases: input.appliedAliases,
    unknownCreators,
    commissionBaseTotal: rows.reduce((sum, row) => sum + Number(row.commissionBase ?? 0), 0),
    existingRowCount,
    newRowCount: linkedRows.length - existingRowCount,
    skippedRowCount: rows.length - linkedRows.length,
    excludedCounts: [...excluded.entries()].map(([reason, rowCount]) => ({ reason, rowCount })),
    chunkCount: input.chunkCount,
    maxChunkBytes: input.maxChunkBytes,
  };
}
