import type { SupabaseClient } from "@supabase/supabase-js";

import { fetchAllFrom } from "@/lib/db/paged-select";
import {
  computeReferralReward,
  REFERRAL_REWARD_RATE,
  resolveReferralRate,
  roundReferralAmount,
  sumReferralAmounts,
  type ReferralOrderLine,
} from "@/lib/referrals/referral-reward-engine";

/*
  紹介者報酬の再計算プレビュー（DBへは書き込まない）。

  affiliate_order_lines と現在の creators / referrers 設定だけから
  報酬額を再現する。金額はコードに一切ハードコードしない。

  検証値（2026-05〜2026-08）:
    対象 Commission Base  2,309,135 円
    通常紹介者報酬        115,456.75 円
*/

const ORDER_LINE_COLUMNS =
  "source_row_key, order_id, product_id, creator_id, target_month, commission_base, payment_status, order_status, refund_status";

export type ReferralPreviewRow = {
  referrerId: string;
  referrerName: string;
  creatorId: string;
  creatorName: string;
  tiktokId: string;
  agencyName: string | null;
  accountManagementType: string;
  lineCount: number;
  baseAmount: number;
  rewardAmount: number;
};

export type ReferralPreviewResult = {
  months: string[];
  rows: ReferralPreviewRow[];
  totalBaseAmount: number;
  totalRewardAmount: number;
  totalLineCount: number;
  error: string | null;
};

function unwrap<T>(value: unknown): T | null {
  if (!value) return null;
  if (Array.isArray(value)) return (value[0] as T) ?? null;
  return value as T;
}

async function fetchOrderLinesForMonths(
  supabase: SupabaseClient,
  months: string[],
): Promise<{ data: ReferralOrderLine[]; error: string | null }> {
  const rows: ReferralOrderLine[] = [];

  for (const month of months) {
    const result = await fetchAllFrom<ReferralOrderLine>(
      supabase,
      "affiliate_order_lines",
      ORDER_LINE_COLUMNS,
      (query) => query.eq("target_month", month),
    );

    if (result.error) {
      return { data: [], error: result.error };
    }

    rows.push(...result.data);
  }

  return { data: rows, error: null };
}

/**
 * 指定月群の紹介者報酬を再計算して返す（DBへは書き込まない）。
 */
export async function previewReferralRewards(
  supabase: SupabaseClient,
  months: string[],
): Promise<ReferralPreviewResult> {
  const empty: ReferralPreviewResult = {
    months,
    rows: [],
    totalBaseAmount: 0,
    totalRewardAmount: 0,
    totalLineCount: 0,
    error: null,
  };

  if (months.length === 0) return empty;

  const [creatorsResult, referrersResult, referralsResult, ordersResult] =
    await Promise.all([
      supabase
        .from("creators")
        .select(
          "id, creator_name, tiktok_id, account_management_type, referred_by_referrer_id, agencies ( name )",
        ),
      supabase.from("referrers").select("id, name, referrer_name"),
      supabase
        .from("creator_referrals")
        .select("creator_id, referrer_id, referral_rate")
        .eq("is_active", true),
      fetchOrderLinesForMonths(supabase, months),
    ]);

  const error =
    creatorsResult.error?.message ??
    referrersResult.error?.message ??
    referralsResult.error?.message ??
    ordersResult.error ??
    null;

  if (error) {
    return { ...empty, error };
  }

  const referrerNameById = new Map<string, string>();
  for (const referrer of referrersResult.data ?? []) {
    referrerNameById.set(
      referrer.id as string,
      String(referrer.referrer_name ?? referrer.name ?? "紹介者"),
    );
  }

  const rateByCreator = new Map<string, number>();
  for (const referral of referralsResult.data ?? []) {
    const creatorId = referral.creator_id as string;
    if (rateByCreator.has(creatorId)) continue;
    rateByCreator.set(creatorId, resolveReferralRate(referral.referral_rate));
  }

  const creatorById = new Map<
    string,
    {
      creatorName: string;
      tiktokId: string;
      agencyName: string | null;
      accountManagementType: string;
      referrerId: string | null;
    }
  >();

  for (const creator of creatorsResult.data ?? []) {
    creatorById.set(creator.id as string, {
      creatorName: String(creator.creator_name ?? ""),
      tiktokId: String(creator.tiktok_id ?? ""),
      agencyName: unwrap<{ name: string }>(creator.agencies)?.name ?? null,
      accountManagementType: String(creator.account_management_type ?? "standard"),
      referrerId: (creator.referred_by_referrer_id as string | null) ?? null,
    });
  }

  type PairAccumulator = Omit<ReferralPreviewRow, "rewardAmount"> & {
    rewardAmounts: number[];
  };

  const byPair = new Map<string, PairAccumulator>();

  for (const line of ordersResult.data) {
    const creatorId = line.creator_id;
    if (!creatorId) continue;

    const creator = creatorById.get(creatorId);
    if (!creator) continue;

    const computed = computeReferralReward(
      line,
      {
        creatorId,
        referrerId: creator.referrerId,
        accountManagementType: creator.accountManagementType,
      },
      rateByCreator.get(creatorId) ?? REFERRAL_REWARD_RATE,
    );

    if (!computed) continue;

    const key = `${computed.referrerId}:${creatorId}`;
    const current =
      byPair.get(key) ??
      {
        referrerId: computed.referrerId,
        referrerName: referrerNameById.get(computed.referrerId) ?? "紹介者",
        creatorId,
        creatorName: creator.creatorName,
        tiktokId: creator.tiktokId,
        agencyName: creator.agencyName,
        accountManagementType: creator.accountManagementType,
        lineCount: 0,
        baseAmount: 0,
        rewardAmounts: [] as number[],
      };

    current.lineCount += 1;
    current.baseAmount += computed.baseAmount;
    current.rewardAmounts.push(computed.rewardAmount);
    byPair.set(key, current);
  }

  const rows: ReferralPreviewRow[] = [...byPair.values()]
    .map(({ rewardAmounts, ...row }) => ({
      ...row,
      baseAmount: roundReferralAmount(row.baseAmount),
      rewardAmount: sumReferralAmounts(rewardAmounts),
    }))
    .sort((a, b) => b.rewardAmount - a.rewardAmount);

  return {
    months,
    rows,
    totalBaseAmount: roundReferralAmount(
      rows.reduce((sum, row) => sum + row.baseAmount, 0),
    ),
    totalRewardAmount: sumReferralAmounts(rows.map((row) => row.rewardAmount)),
    totalLineCount: rows.reduce((sum, row) => sum + row.lineCount, 0),
    error: null,
  };
}

/** YYYY-MM の範囲を配列に展開する */
export function expandMonthRange(fromMonth: string, toMonth: string): string[] {
  if (!/^\d{4}-\d{2}$/.test(fromMonth) || !/^\d{4}-\d{2}$/.test(toMonth)) {
    return [];
  }

  const months: string[] = [];
  const [fromYear, fromMonthNum] = fromMonth.split("-").map(Number);
  const [toYear, toMonthNum] = toMonth.split("-").map(Number);

  let year = fromYear;
  let month = fromMonthNum;

  while (year < toYear || (year === toYear && month <= toMonthNum)) {
    months.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
    if (months.length > 120) break;
  }

  return months;
}
