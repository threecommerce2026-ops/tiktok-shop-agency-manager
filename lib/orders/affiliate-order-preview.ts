import type { AffiliateOrderPayloadRow } from "@/lib/orders/affiliate-order-import-payload";

/*
  取込プレビューの集計（ブラウザ側で実行する純ロジック）。

  ■ 金額計算はしない
  ここで出すのは「これから取り込む Excel の中身」の要約だけ。
  代理店報酬・紹介者報酬の計算式には一切関与しない。

  ■ DB へは書き込まない
  プレビュー時点の DB WRITE は 0 件。
  既存行との比較は別途 source_row_key と指紋だけをサーバーへ送って行う。
*/

export type AffiliateOrderImportSummary = {
  /** 解析できた行数（重複排除前） */
  parsedRows: number;
  /** 取込対象の行数（重複排除後） */
  validRows: number;
  /** 解析できなかった行数 */
  invalidRows: number;
  /** ファイル内で重複していた行数 */
  duplicateRows: number;

  uniqueOrders: number;
  uniqueCreators: number;
  uniqueShops: number;

  /** 対象月（昇順） */
  targetMonths: string[];
  /** 対象月が取れなかった行数 */
  missingTargetMonth: number;

  /** 作成日時の範囲（ISO文字列） */
  periodStart: string | null;
  periodEnd: string | null;

  commissionGmv: number;
  commissionBase: number;
  agencyRevenue: number;
};

function roundAmount(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

export function summarizeAffiliateOrderRows(
  rows: AffiliateOrderPayloadRow[],
  counts: { parsedRows: number; invalidRows: number; duplicateRows: number },
): AffiliateOrderImportSummary {
  const orders = new Set<string>();
  const creators = new Set<string>();
  const shops = new Set<string>();
  const months = new Set<string>();

  let missingTargetMonth = 0;
  let periodStart: string | null = null;
  let periodEnd: string | null = null;

  let commissionGmv = 0;
  let commissionBase = 0;
  let agencyRevenue = 0;

  for (const row of rows) {
    orders.add(row.orderId);
    creators.add(row.creatorTiktokId);

    const shop = (row.shopName ?? row.shopCode ?? "").trim();
    if (shop) shops.add(shop);

    if (row.targetMonth) months.add(row.targetMonth);
    else missingTargetMonth += 1;

    if (row.orderedAt) {
      if (!periodStart || row.orderedAt < periodStart) periodStart = row.orderedAt;
      if (!periodEnd || row.orderedAt > periodEnd) periodEnd = row.orderedAt;
    }

    commissionGmv += row.commissionGmv;
    commissionBase += row.commissionBase;
    agencyRevenue += row.agencyRevenue;
  }

  return {
    parsedRows: counts.parsedRows,
    validRows: rows.length,
    invalidRows: counts.invalidRows,
    duplicateRows: counts.duplicateRows,

    uniqueOrders: orders.size,
    uniqueCreators: creators.size,
    uniqueShops: shops.size,

    targetMonths: [...months].sort(),
    missingTargetMonth,

    periodStart,
    periodEnd,

    commissionGmv: roundAmount(commissionGmv),
    commissionBase: roundAmount(commissionBase),
    agencyRevenue: roundAmount(agencyRevenue),
  };
}

/** 既存DBとの突き合わせ結果 */
export type AffiliateOrderCompareTotals = {
  /** DB に無い＝新規INSERT予定 */
  newRows: number;
  /** DB にあり、かつ内容が変わる＝UPDATE予定 */
  changedRows: number;
  /** DB にあり、内容も同じ＝実質変更なし */
  unchangedRows: number;
};

export function emptyCompareTotals(): AffiliateOrderCompareTotals {
  return { newRows: 0, changedRows: 0, unchangedRows: 0 };
}

export function mergeCompareTotals(
  a: AffiliateOrderCompareTotals,
  b: AffiliateOrderCompareTotals,
): AffiliateOrderCompareTotals {
  return {
    newRows: a.newRows + b.newRows,
    changedRows: a.changedRows + b.changedRows,
    unchangedRows: a.unchangedRows + b.unchangedRows,
  };
}

/** 重大エラー（取込ボタンを無効化する条件） */
export type ImportBlocker = {
  code: "no_valid_rows" | "header_missing" | "all_invalid";
  message: string;
};

export function resolveImportBlockers(params: {
  summary: AffiliateOrderImportSummary;
  headerError: string | null;
}): ImportBlocker[] {
  const blockers: ImportBlocker[] = [];

  if (params.headerError) {
    blockers.push({ code: "header_missing", message: params.headerError });
    return blockers;
  }

  if (params.summary.validRows === 0) {
    blockers.push({
      code: "no_valid_rows",
      message: "取り込める明細が1件もありません",
    });
  }

  return blockers;
}
