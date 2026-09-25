import type { SupabaseClient } from "@supabase/supabase-js";

import { currentMonthKey } from "@/lib/db/dashboard-queries";
import { fetchAllFrom } from "@/lib/db/paged-select";
import {
  DEFAULT_REFERRER_LIFETIME_PAYOUT_CAP_YEN,
  isReferralCapReached,
  resolveRemainingReferralCap,
} from "@/lib/referrals/cap";
import {
  resolveAnnualPayoutState,
  resolveRewardItemAmount,
  rewardYearOf,
  roundReferralAmount,
  sumReferralAmounts,
} from "@/lib/referrals/referral-reward-engine";
import { isCountedOrderLine } from "@/lib/revenue/order-line-status";
import {
  formatCreatorTiktokIdLabel,
  formatOfficialLineRegisteredLabel,
} from "@/lib/creators/referral-registration";
import { toAmount } from "@/lib/revenue/amount";

/*
  紹介者ポータルの表示データ。

  報酬金額は referral_reward_items（管理画面と同じ Single Source of Truth）
  だけを参照する。ここで報酬を再計算しないこと。

  売上表示のみ affiliate_order_lines を使う。
*/

export type ReferrerDashboardCreatorRow = {
  creatorId: string;
  creatorName: string;
  tiktokId: string;
  officialLineRegistered: string;
  salesMonth: number;
  referralRewardMonth: number;
  profitMonth: number;
  lifetimePaidAmount: number;
  remainingCap: number;
  lifetimePayoutCap: number;
  capReached: boolean;
  payoutStatus: string | null;
};

export type ReferrerDashboardData = {
  month: string;
  /** 報酬年度（暦年） */
  year: string;
  creatorCount: number;
  /** 当月の報酬計算対象 Commission Base */
  eligibleRevenueMonth: number;
  referralRewardMonth: number;
  /** 年間発生額 */
  referralRewardTotal: number;
  /** 年間支払済額 */
  paidRewardTotal: number;
  /** 未払残高（繰越込み） */
  unpaidRewardTotal: number;
  /** 未払残高が支払基準額に達しているか */
  isPayableMonth: boolean;
  payoutStatus: string | null;
  creators: ReferrerDashboardCreatorRow[];
};

type RewardItemRow = {
  creator_id: string;
  target_month: string;
  base_amount: number | string | null;
  reward_amount: number | string | null;
  adjusted_reward_amount: number | string | null;
  is_reward_target: boolean;
  is_paid: boolean;
};

type OrderLineRow = {
  creator_id: string | null;
  order_amount: number | string | null;
  commission_base: number | string | null;
  order_status: string | null;
  payment_status: string | null;
  refund_status: string | null;
};


export async function fetchReferrerDashboardData(
  supabase: SupabaseClient,
  referrerId: string,
  targetMonth: string = currentMonthKey(),
): Promise<{ data: ReferrerDashboardData; error: string | null }> {
  const year = rewardYearOf(targetMonth);

  const empty: ReferrerDashboardData = {
    month: targetMonth,
    year,
    creatorCount: 0,
    eligibleRevenueMonth: 0,
    referralRewardMonth: 0,
    referralRewardTotal: 0,
    paidRewardTotal: 0,
    unpaidRewardTotal: 0,
    isPayableMonth: false,
    payoutStatus: null,
    creators: [],
  };

  const [referralsResult, rewardItemsResult, payoutsResult] = await Promise.all([
    supabase
      .from("creator_referrals")
      .select("creator_id, lifetime_payout_cap, lifetime_paid_amount")
      .eq("referrer_id", referrerId)
      .eq("is_active", true),
    fetchAllFrom<RewardItemRow>(
      supabase,
      "referral_reward_items",
      "creator_id, target_month, base_amount, reward_amount, adjusted_reward_amount, is_reward_target, is_paid",
      (query) =>
        query
          .eq("referrer_id", referrerId)
          .gte("target_month", `${year}-01`)
          .lte("target_month", `${year}-12`),
    ),
    supabase
      .from("referral_payouts")
      .select("target_month, status")
      .eq("referrer_id", referrerId)
      .eq("target_month", targetMonth)
      .maybeSingle(),
  ]);

  const loadError =
    referralsResult.error?.message ??
    rewardItemsResult.error ??
    payoutsResult.error?.message ??
    null;

  if (loadError) {
    return { data: empty, error: loadError };
  }

  const referrals = referralsResult.data ?? [];
  const creatorIds = [...new Set(referrals.map((row) => row.creator_id as string))];

  if (creatorIds.length === 0) {
    return { data: empty, error: null };
  }

  const [creatorsResult, orderLinesResult] = await Promise.all([
    supabase
      .from("creators")
      .select("id, creator_name, tiktok_id, official_line_registered")
      .in("id", creatorIds),
    fetchAllFrom<OrderLineRow>(
      supabase,
      "affiliate_order_lines",
      "creator_id, order_amount, commission_base, order_status, payment_status, refund_status",
      (query) => query.eq("target_month", targetMonth).in("creator_id", creatorIds),
    ),
  ]);

  const detailError = creatorsResult.error?.message ?? orderLinesResult.error ?? null;
  if (detailError) {
    return { data: empty, error: detailError };
  }

  const creatorById = new Map(
    (creatorsResult.data ?? []).map((creator) => [
      creator.id as string,
      {
        creatorName: String(creator.creator_name ?? "—"),
        tiktokId: formatCreatorTiktokIdLabel(creator.tiktok_id as string),
        officialLineRegistered: formatOfficialLineRegisteredLabel(
          creator.official_line_registered as boolean | null,
        ),
      },
    ]),
  );

  const rows = new Map<string, ReferrerDashboardCreatorRow>();

  for (const referral of referrals) {
    const creatorId = referral.creator_id as string;
    const meta = creatorById.get(creatorId);
    const lifetimePayoutCap = Number(
      referral.lifetime_payout_cap ?? DEFAULT_REFERRER_LIFETIME_PAYOUT_CAP_YEN,
    );
    const lifetimePaidAmount = Number(referral.lifetime_paid_amount ?? 0);

    rows.set(creatorId, {
      creatorId,
      creatorName: meta?.creatorName ?? "—",
      tiktokId: meta?.tiktokId ?? "未登録",
      officialLineRegistered: meta?.officialLineRegistered ?? "未登録",
      salesMonth: 0,
      profitMonth: 0,
      referralRewardMonth: 0,
      lifetimePaidAmount,
      remainingCap: resolveRemainingReferralCap(lifetimePayoutCap, lifetimePaidAmount),
      lifetimePayoutCap,
      capReached: isReferralCapReached(lifetimePayoutCap, lifetimePaidAmount),
      payoutStatus: null,
    });
  }

  // --- 当月の売上表示（報酬計算には使わない）----------------------------------
  for (const line of orderLinesResult.data) {
    const creatorId = line.creator_id;
    if (!creatorId) continue;

    const row = rows.get(creatorId);
    if (!row) continue;
    if (!isCountedOrderLine(line)) continue;

    row.salesMonth += toAmount(line.order_amount);
    row.profitMonth += toAmount(line.commission_base);
  }

  // --- 報酬は referral_reward_items のみを参照 ---------------------------------
  const monthAmounts: number[] = [];
  const yearAmounts: number[] = [];
  const paidAmounts: number[] = [];
  let eligibleRevenueMonth = 0;

  for (const item of rewardItemsResult.data) {
    if (!item.is_reward_target) continue;

    const amount = resolveRewardItemAmount(item);
    yearAmounts.push(amount);

    if (item.is_paid) {
      paidAmounts.push(amount);
    }

    if (item.target_month === targetMonth) {
      monthAmounts.push(amount);
      eligibleRevenueMonth += toAmount(item.base_amount);

      const row = rows.get(item.creator_id);
      if (row) {
        row.referralRewardMonth = roundReferralAmount(row.referralRewardMonth + amount);
      }
    }
  }

  const annual = resolveAnnualPayoutState({
    annualRewardAmount: sumReferralAmounts(yearAmounts),
    paidAmount: sumReferralAmounts(paidAmounts),
  });

  const payoutStatus = (payoutsResult.data?.status as string | null) ?? null;
  for (const row of rows.values()) {
    row.payoutStatus = payoutStatus;
  }

  return {
    data: {
      month: targetMonth,
      year,
      creatorCount: creatorIds.length,
      eligibleRevenueMonth: roundReferralAmount(eligibleRevenueMonth),
      referralRewardMonth: sumReferralAmounts(monthAmounts),
      referralRewardTotal: annual.annualRewardAmount,
      paidRewardTotal: annual.paidAmount,
      unpaidRewardTotal: Math.max(annual.unpaidAmount, 0),
      isPayableMonth: annual.isPayable,
      payoutStatus,
      creators: [...rows.values()].sort((a, b) =>
        a.creatorName.localeCompare(b.creatorName, "ja"),
      ),
    },
    error: null,
  };
}
