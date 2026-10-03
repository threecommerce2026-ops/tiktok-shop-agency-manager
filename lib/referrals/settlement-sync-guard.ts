import type { SupabaseClient } from "@supabase/supabase-js";

/*
  月次確定（finalized）済みの月は紹介報酬を再集計させない。

  ■ なぜ必要か
  既存のガードは明細単位（is_paid / payout_id / payment_batch_id）で、
  その明細だけを守る。確定済みの月に「まだ支払っていない明細」が
  残っていると、再集計でその金額が動いてしまう。
  月次確定は「この月の紹介報酬はこの金額で締めた」という宣言なので、
  締めた後に総額が変わってはいけない。

  ■ 明細単位のガードは置き換えない
  この月単位のガードは追加であって、既存の
  paidSourceKeys（sync-referral-rewards.ts）の代わりではない。
  未確定の月でも支払済み明細は引き続き守られる。

  ■ 読み方
  referral_month_settlements は authenticated / service_role に
  SELECT が grant されていない（postgres のみ）。直接 .from() で引くと
  permission denied になるため、既存の security definer RPC
  list_referral_month_settlements() を使う。
  呼び出しには auth.uid() が必要なのでユーザーのクライアントで呼ぶ。

  行が無い月は未確定として扱う（finalized だけ拾えばよい）。
*/

export const FINALIZED_SETTLEMENT_STATUS = "finalized" as const;

type SettlementRow = {
  target_month?: string | null;
  status?: string | null;
};

/** 確定済みの月だけを取り出す */
export function finalizedMonthsOf(rows: SettlementRow[]): Set<string> {
  const months = new Set<string>();

  for (const row of rows) {
    const month = String(row?.target_month ?? "").trim();
    if (!month) continue;
    if (String(row?.status ?? "").trim() !== FINALIZED_SETTLEMENT_STATUS) continue;
    months.add(month);
  }

  return months;
}

/**
 * 確定済みの月を取得する（読み取りのみ）。
 *
 * RPC が使えない環境（migration 未適用など）では空集合を返し、
 * 既存の明細単位ガードに委ねる。ここで例外にすると
 * 再集計そのものが実行不能になるため、ガードは「あれば効く」形にする。
 */
export async function fetchFinalizedReferralMonths(
  supabase: SupabaseClient,
): Promise<{ months: Set<string>; error: string | null }> {
  const { data, error } = await supabase.rpc("list_referral_month_settlements");

  if (error) {
    return { months: new Set(), error: error.message };
  }

  return {
    months: finalizedMonthsOf((data ?? []) as SettlementRow[]),
    error: null,
  };
}

/** 対象月を「再集計してよい月」と「確定済みで触らない月」に分ける */
export function splitSyncableMonths(
  months: string[],
  finalized: Set<string>,
): { syncable: string[]; blocked: string[] } {
  const syncable: string[] = [];
  const blocked: string[] = [];

  for (const month of months) {
    if (finalized.has(month)) blocked.push(month);
    else syncable.push(month);
  }

  return { syncable, blocked };
}
