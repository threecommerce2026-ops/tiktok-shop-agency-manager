import type { SupabaseClient } from "@supabase/supabase-js";
import { currentMonthKey } from "@/lib/db/dashboard-queries";
import {
  DEFAULT_REFERRER_LIFETIME_PAYOUT_CAP_YEN,
  isReferralCapReached,
  resolveRemainingReferralCap,
} from "@/lib/referrals/cap";
import {
  formatCreatorTiktokIdLabel,
  formatOfficialLineRegisteredLabel,
} from "@/lib/creators/referral-registration";

export type ReferrerAdminRow = {
  id: string;
  referrerName: string;
  email: string | null;
  phone: string | null;
  memo: string | null;
  referralCode: string | null;
  isActive: boolean;
  creatorCount: number;
  rewardMonth: number;
  rewardTotal: number;
  isPayableMonth: boolean;
};

export async function fetchReferrerAdminRows(
  supabase: SupabaseClient,
  targetMonth: string = currentMonthKey(),
): Promise<{ data: ReferrerAdminRow[]; error: string | null }> {
  const [
    { data: referrers, error: referrersError },
    { data: referrals, error: referralsError },
    { data: rewardItems, error: rewardItemsError },
    { data: payouts, error: payoutsError },
  ] = await Promise.all([
    supabase
      .from("referrers")
      .select("id, referrer_name, email, phone, memo, referral_code, is_active")
      .order("referrer_name"),
    supabase.from("creator_referrals").select("id, referrer_id, creator_id, is_active"),
    supabase
      .from("referral_reward_items")
      .select("referrer_id, target_month, reward_amount, is_reward_target"),
    supabase
      .from("referral_payouts")
      .select("referrer_id, target_month, is_payable")
      .eq("target_month", targetMonth),
  ]);

  if (referrersError || referralsError || rewardItemsError || payoutsError) {
    return {
      data: [],
      error:
        referrersError?.message ??
        referralsError?.message ??
        rewardItemsError?.message ??
        payoutsError?.message ??
        null,
    };
  }

  const creatorCountByReferrer = new Map<string, Set<string>>();
  for (const referral of referrals ?? []) {
    if (!referral.is_active) continue;
    const referrerId = referral.referrer_id as string;
    const set = creatorCountByReferrer.get(referrerId) ?? new Set<string>();
    set.add(referral.creator_id as string);
    creatorCountByReferrer.set(referrerId, set);
  }

  const monthRewardByReferrer = new Map<string, number>();
  const totalRewardByReferrer = new Map<string, number>();
  for (const item of rewardItems ?? []) {
    if (!item.is_reward_target) continue;
    const referrerId = item.referrer_id as string;
    const amount = Number(item.reward_amount);
    totalRewardByReferrer.set(referrerId, (totalRewardByReferrer.get(referrerId) ?? 0) + amount);
    if (item.target_month === targetMonth) {
      monthRewardByReferrer.set(
        referrerId,
        (monthRewardByReferrer.get(referrerId) ?? 0) + amount,
      );
    }
  }

  const payableByReferrer = new Map<string, boolean>();
  for (const payout of payouts ?? []) {
    payableByReferrer.set(payout.referrer_id as string, Boolean(payout.is_payable));
  }

  return {
    data: (referrers ?? []).map((referrer) => {
      const id = referrer.id as string;
      return {
        id,
        referrerName: referrer.referrer_name as string,
        email: (referrer.email as string | null) ?? null,
        phone: (referrer.phone as string | null) ?? null,
        memo: (referrer.memo as string | null) ?? null,
        referralCode: (referrer.referral_code as string | null) ?? null,
        isActive: Boolean(referrer.is_active),
        creatorCount: creatorCountByReferrer.get(id)?.size ?? 0,
        rewardMonth: monthRewardByReferrer.get(id) ?? 0,
        rewardTotal: totalRewardByReferrer.get(id) ?? 0,
        isPayableMonth: payableByReferrer.get(id) ?? false,
      };
    }),
    error: null,
  };
}

export async function fetchReferrerOptions(
  supabase: SupabaseClient,
): Promise<{ data: Array<{ id: string; referrerName: string }>; error: string | null }> {
  const { data, error } = await supabase
    .from("referrers")
    .select("id, referrer_name")
    .eq("is_active", true)
    .order("referrer_name");

  if (error) {
    return { data: [], error: error.message };
  }

  return {
    data: (data ?? []).map((row) => ({
      id: row.id as string,
      referrerName: row.referrer_name as string,
    })),
    error: null,
  };
}

export type ReferrerAdminCreatorRow = {
  creatorId: string;
  creatorName: string;
  officialLineRegistered: string;
  tiktokId: string;
  startMonth: string;
  isActive: boolean;
  rewardMonth: number;
  lifetimePaidAmount: number;
  remainingCap: number;
  lifetimePayoutCap: number;
  capReached: boolean;
};

export async function fetchReferrerAdminCreators(
  supabase: SupabaseClient,
  referrerId: string,
  targetMonth: string = currentMonthKey(),
): Promise<{ data: ReferrerAdminCreatorRow[]; error: string | null }> {
  const [
    { data: referrals, error: referralsError },
    { data: rewardItems, error: rewardItemsError },
  ] = await Promise.all([
    supabase
      .from("creator_referrals")
      .select(
        "creator_id, start_month, is_active, lifetime_payout_cap, lifetime_paid_amount, creators ( creator_name, tiktok_id, official_line_registered )",
      )
      .eq("referrer_id", referrerId)
      .order("start_month", { ascending: false }),
    supabase
      .from("referral_reward_items")
      .select("creator_id, reward_amount, is_reward_target")
      .eq("referrer_id", referrerId)
      .eq("target_month", targetMonth),
  ]);

  if (referralsError || rewardItemsError) {
    return {
      data: [],
      error: referralsError?.message ?? rewardItemsError?.message ?? null,
    };
  }

  const rewardByCreator = new Map<string, number>();
  for (const item of rewardItems ?? []) {
    if (!item.is_reward_target) continue;
    const creatorId = item.creator_id as string;
    rewardByCreator.set(
      creatorId,
      (rewardByCreator.get(creatorId) ?? 0) + Number(item.reward_amount),
    );
  }

  return {
    data: (referrals ?? []).map((referral) => {
      const creatorsJoin = referral.creators as
        | {
            creator_name: string;
            tiktok_id: string;
            official_line_registered: boolean | null;
          }
        | {
            creator_name: string;
            tiktok_id: string;
            official_line_registered: boolean | null;
          }[]
        | null;
      const creator = Array.isArray(creatorsJoin) ? creatorsJoin[0] : creatorsJoin;
      const creatorId = referral.creator_id as string;
      const lifetimePayoutCap = Number(
        referral.lifetime_payout_cap ?? DEFAULT_REFERRER_LIFETIME_PAYOUT_CAP_YEN,
      );
      const lifetimePaidAmount = Number(referral.lifetime_paid_amount ?? 0);
      return {
        creatorId,
        creatorName: creator?.creator_name ?? "—",
        officialLineRegistered: formatOfficialLineRegisteredLabel(
          creator?.official_line_registered ?? null,
        ),
        tiktokId: formatCreatorTiktokIdLabel(creator?.tiktok_id),
        startMonth: referral.start_month as string,
        isActive: Boolean(referral.is_active),
        rewardMonth: rewardByCreator.get(creatorId) ?? 0,
        lifetimePaidAmount,
        remainingCap: resolveRemainingReferralCap(lifetimePayoutCap, lifetimePaidAmount),
        lifetimePayoutCap,
        capReached: isReferralCapReached(lifetimePayoutCap, lifetimePaidAmount),
      };
    }),
    error: null,
  };
}
