import type { SupabaseClient } from "@supabase/supabase-js";
import { currentMonthKey } from "@/lib/db/dashboard-queries";
import {
  getOrderRevenueBase,
  isCancelledStatus,
  isPaidPaymentStatus,
  isRefundedStatus,
} from "@/lib/revenue/order-eligibility";
import { referralRewardFromBase } from "@/lib/referrals/calc";
import { REFERRAL_PAYOUT_THRESHOLD_YEN } from "@/lib/referrals/calc";
import {
  DEFAULT_REFERRER_LIFETIME_PAYOUT_CAP_YEN,
  isReferralCapReached,
  resolveRemainingReferralCap,
} from "@/lib/referrals/cap";
import {
  formatCreatorTiktokIdLabel,
  formatOfficialLineRegisteredLabel,
} from "@/lib/creators/referral-registration";

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
  creatorCount: number;
  eligibleRevenueMonth: number;
  referralRewardMonth: number;
  referralRewardTotal: number;
  paidRewardTotal: number;
  unpaidRewardTotal: number;
  isPayableMonth: boolean;
  payoutStatus: string | null;
  creators: ReferrerDashboardCreatorRow[];
};

function isEligibleOrder(order: {
  payment_status: string | null;
  cancel_status: string | null;
  refund_status: string | null;
}): boolean {
  return (
    isPaidPaymentStatus(order.payment_status) &&
    !isCancelledStatus(order.cancel_status) &&
    !isRefundedStatus(order.refund_status)
  );
}

export async function fetchReferrerDashboardData(
  supabase: SupabaseClient,
  referrerId: string,
  targetMonth: string = currentMonthKey(),
): Promise<{ data: ReferrerDashboardData; error: string | null }> {
  const empty: ReferrerDashboardData = {
    month: targetMonth,
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

  const [
    { data: referrals, error: referralsError },
    { data: rewardItems, error: rewardItemsError },
    { data: payouts, error: payoutsError },
    { data: orders, error: ordersError },
  ] = await Promise.all([
    supabase
      .from("creator_referrals")
      .select(
        "creator_id, referral_rate, lifetime_payout_cap, lifetime_paid_amount, start_month, end_month",
      )
      .eq("referrer_id", referrerId)
      .eq("is_active", true),
    supabase
      .from("referral_reward_items")
      .select("creator_id, target_month, base_amount, reward_amount, is_reward_target, is_paid")
      .eq("referrer_id", referrerId),
    supabase
      .from("referral_payouts")
      .select("target_month, status, is_payable, total_reward_amount")
      .eq("referrer_id", referrerId),
    supabase
      .from("orders")
      .select(
        "creator_id, target_month, order_amount, commission_base, payment_status, cancel_status, refund_status",
      )
      .eq("target_month", targetMonth),
  ]);

  const loadError =
    referralsError?.message ??
    rewardItemsError?.message ??
    payoutsError?.message ??
    ordersError?.message ??
    null;
  if (loadError) {
    return { data: empty, error: loadError };
  }

  const creatorIds = [...new Set((referrals ?? []).map((row) => row.creator_id as string))];
  const { data: creators, error: creatorsError } =
    creatorIds.length > 0
      ? await supabase
          .from("creators")
          .select("id, creator_name, tiktok_id, official_line_registered")
          .in("id", creatorIds)
      : { data: [], error: null };

  if (creatorsError) {
    return { data: empty, error: creatorsError.message };
  }

  const creatorById = new Map(
    (creators ?? []).map((creator) => [
      creator.id as string,
      {
        creatorName: creator.creator_name as string,
        tiktokId: creator.tiktok_id as string,
        officialLineRegistered: formatOfficialLineRegisteredLabel(
          creator.official_line_registered as boolean | null,
        ),
      },
    ]),
  );

  const creatorMeta = new Map<
    string,
    {
      creatorName: string;
      tiktokId: string;
      officialLineRegistered: string;
      referralRate: number;
      lifetimePayoutCap: number;
      lifetimePaidAmount: number;
    }
  >();
  for (const referral of referrals ?? []) {
    const creatorId = referral.creator_id as string;
    const creator = creatorById.get(creatorId);
    creatorMeta.set(creatorId, {
      creatorName: creator?.creatorName ?? "—",
      tiktokId: creator?.tiktokId ?? "",
      officialLineRegistered: creator?.officialLineRegistered ?? "未登録",
      referralRate: Number(referral.referral_rate),
      lifetimePayoutCap: Number(
        referral.lifetime_payout_cap ?? DEFAULT_REFERRER_LIFETIME_PAYOUT_CAP_YEN,
      ),
      lifetimePaidAmount: Number(referral.lifetime_paid_amount ?? 0),
    });
  }

  const creatorRows = new Map<string, ReferrerDashboardCreatorRow>();
  for (const referral of referrals ?? []) {
    const creatorId = referral.creator_id as string;
    const meta = creatorMeta.get(creatorId);
    creatorRows.set(creatorId, {
      creatorId,
      creatorName: meta?.creatorName ?? "—",
      tiktokId: formatCreatorTiktokIdLabel(meta?.tiktokId),
      officialLineRegistered: meta?.officialLineRegistered ?? "未登録",
      salesMonth: 0,
      profitMonth: 0,
      referralRewardMonth: 0,
      lifetimePaidAmount: meta?.lifetimePaidAmount ?? 0,
      remainingCap: resolveRemainingReferralCap(
        meta?.lifetimePayoutCap ?? DEFAULT_REFERRER_LIFETIME_PAYOUT_CAP_YEN,
        meta?.lifetimePaidAmount ?? 0,
      ),
      lifetimePayoutCap: meta?.lifetimePayoutCap ?? DEFAULT_REFERRER_LIFETIME_PAYOUT_CAP_YEN,
      capReached: isReferralCapReached(
        meta?.lifetimePayoutCap ?? DEFAULT_REFERRER_LIFETIME_PAYOUT_CAP_YEN,
        meta?.lifetimePaidAmount ?? 0,
      ),
      payoutStatus: null,
    });
  }

  let eligibleRevenueMonth = 0;
  for (const order of orders ?? []) {
    const creatorId = order.creator_id as string | null;
    if (!creatorId || !creatorRows.has(creatorId) || !isEligibleOrder(order)) {
      continue;
    }
    const base = getOrderRevenueBase({
      order_amount: Number(order.order_amount),
      commission_base: Number(order.commission_base),
    });
    const row = creatorRows.get(creatorId)!;
    row.salesMonth += Number(order.order_amount);
    row.profitMonth += base;
    row.referralRewardMonth += referralRewardFromBase(
      base,
      creatorMeta.get(creatorId)?.referralRate ?? 0.05,
    );
    eligibleRevenueMonth += base;
  }

  let referralRewardMonthFromItems = 0;
  let referralRewardTotal = 0;
  let paidRewardTotal = 0;
  const monthRewardItems = (rewardItems ?? []).filter(
    (item) => item.target_month === targetMonth && item.is_reward_target,
  );

  for (const item of rewardItems ?? []) {
    if (!item.is_reward_target) continue;
    const amount = Number(item.reward_amount);
    referralRewardTotal += amount;
    if (item.is_paid) {
      paidRewardTotal += amount;
    }
    if (item.target_month === targetMonth) {
      referralRewardMonthFromItems += amount;
    }
  }

  let referralRewardMonth = referralRewardMonthFromItems;
  if (monthRewardItems.length > 0) {
    for (const row of creatorRows.values()) {
      row.referralRewardMonth = 0;
    }
    for (const item of monthRewardItems) {
      const creatorId = item.creator_id as string;
      const row = creatorRows.get(creatorId);
      if (row) {
        row.referralRewardMonth += Number(item.reward_amount);
      }
    }
  } else {
    referralRewardMonth = [...creatorRows.values()].reduce(
      (sum, row) => sum + row.referralRewardMonth,
      0,
    );
  }

  const monthPayout = (payouts ?? []).find((row) => row.target_month === targetMonth);
  const payoutStatus = (monthPayout?.status as string | null) ?? null;
  for (const row of creatorRows.values()) {
    row.payoutStatus = payoutStatus;
  }

  return {
    data: {
      month: targetMonth,
      creatorCount: referrals?.length ?? 0,
      eligibleRevenueMonth,
      referralRewardMonth,
      referralRewardTotal,
      paidRewardTotal,
      unpaidRewardTotal: Math.max(referralRewardTotal - paidRewardTotal, 0),
      isPayableMonth: Boolean(monthPayout?.is_payable) || referralRewardMonth >= REFERRAL_PAYOUT_THRESHOLD_YEN,
      payoutStatus,
      creators: [...creatorRows.values()].sort((a, b) =>
        a.creatorName.localeCompare(b.creatorName, "ja"),
      ),
    },
    error: null,
  };
}
