import type { SupabaseClient } from "@supabase/supabase-js";

import { fetchAllFrom } from "@/lib/db/paged-select";

/*
  端末貸し出しの分配率の個別設定を読む。

  ■ どこに入っているか
  creator_monthly_agency_assignments.lending_split_rate。
  分配先（どの代理店へ払うか）は同じ行の agency_id なので、
  「対象月の分配先」と「対象月の分配率」が1行で揃う。
  貸し出し先専用のマスタは作らない。

  ■ 未設定のとき
  null を返す。率の決定は agency-reward-engine の
  resolveLendingSplitRate() が単一ソースで、
  未設定なら ACCOUNT_LENDING_SPLIT_RATE（80%）になる。
  ここで既定値を埋めないこと（既定値が2か所に散ると食い違う）。

  ■ 列が無い環境
  migration 適用前のローカル・CI では列が存在しない。
  その場合は「個別設定が1件も無い」と同じ状態なので、
  空の索引を返して既定率で計算させる。
  列が無いことを支払可否の判断には使わない。
*/

export type LendingSplitRateIndex = Map<string, number>;

export function lendingSplitRateKey(
  creatorId: string,
  targetMonth: string,
): string {
  return `${creatorId}|${targetMonth}`;
}

type LendingSplitRateRow = {
  creator_id: string;
  target_month: string;
  lending_split_rate: number | string | null;
};

/* 列が無いことを示すエラーか（Postgres 42703 / PostgREST のスキーマキャッシュ） */
export function isLendingSplitRateColumnMissing(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes("42703") ||
    text.includes("lending_split_rate") ||
    (text.includes("column") && text.includes("does not exist")) ||
    text.includes("could not find the")
  );
}

/**
 * 対象月の分配率の個別設定を読み込む（読み取りのみ）。
 *
 * 値の検証はしない。範囲外の値は engine 側の
 * resolveLendingSplitRate() が不正として弾く
 * （そこで報酬を作らない = fail-closed）。
 */
export async function fetchMonthlyLendingSplitRates(
  supabase: SupabaseClient,
  options: { targetMonth?: string } = {},
): Promise<{ index: LendingSplitRateIndex; error: string | null }> {
  const result = await fetchAllFrom<LendingSplitRateRow>(
    supabase,
    "creator_monthly_agency_assignments",
    "creator_id, target_month, lending_split_rate",
    (query) =>
      options.targetMonth ? query.eq("target_month", options.targetMonth) : query,
  );

  if (result.error) {
    if (isLendingSplitRateColumnMissing(result.error)) {
      return { index: new Map(), error: null };
    }
    return { index: new Map(), error: result.error };
  }

  const index: LendingSplitRateIndex = new Map();

  for (const row of result.data) {
    if (!row.creator_id || !row.target_month) continue;
    if (row.lending_split_rate == null) continue;

    const parsed = Number(row.lending_split_rate);
    if (!Number.isFinite(parsed)) continue;

    index.set(lendingSplitRateKey(row.creator_id, row.target_month), parsed);
  }

  return { index, error: null };
}
