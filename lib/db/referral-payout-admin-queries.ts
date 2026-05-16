import type { SupabaseClient } from "@supabase/supabase-js";
import { currentMonthKey } from "@/lib/db/dashboard-queries";

export type ReferralPayoutAdminRow = {
  id: string;
  targetMonth: string;
  referrerId: string;
  referrerName: string;
  totalRewardAmount: number;
  thresholdAmount: number;
  isPayable: boolean;
  status: "unpaid" | "paid" | "hold";
  paidAt: string | null;
  memo: string | null;
};

export type ReferralRewardItemRow = {
  id: string;
  targetMonth: string;
  orderId: string;
  productId: string;
  creatorName: string;
  referrerName: string;
  baseAmount: number;
  rewardRate: number;
  rewardAmount: number;
  paymentStatus: string | null;
  orderStatus: string | null;
  refundStatus: string | null;
  isRewardTarget: boolean;
  isPaid: boolean;
  paidAt: string | null;
};

export async function fetchReferralPayoutAdminRows(
  supabase: SupabaseClient,
  targetMonth: string = currentMonthKey(),
): Promise<{ data: ReferralPayoutAdminRow[]; error: string | null }> {
  const { data, error } = await supabase
    .from("referral_payouts")
    .select(
      "id, target_month, referrer_id, total_reward_amount, threshold_amount, is_payable, status, paid_at, memo, referrers ( referrer_name )",
    )
    .eq("target_month", targetMonth)
    .order("total_reward_amount", { ascending: false });

  if (error) {
    return { data: [], error: error.message };
  }

  return {
    data: (data ?? []).map((row) => {
      const referrersJoin = row.referrers as
        | { referrer_name: string }
        | { referrer_name: string }[]
        | null;
      const referrer = Array.isArray(referrersJoin) ? referrersJoin[0] : referrersJoin;
      return {
        id: row.id as string,
        targetMonth: row.target_month as string,
        referrerId: row.referrer_id as string,
        referrerName: referrer?.referrer_name ?? "—",
        totalRewardAmount: Number(row.total_reward_amount),
        thresholdAmount: Number(row.threshold_amount),
        isPayable: Boolean(row.is_payable),
        status: row.status as ReferralPayoutAdminRow["status"],
        paidAt: (row.paid_at as string | null) ?? null,
        memo: (row.memo as string | null) ?? null,
      };
    }),
    error: null,
  };
}

export async function fetchReferralRewardItems(
  supabase: SupabaseClient,
  params: { targetMonth: string; referrerId?: string | null },
): Promise<{ data: ReferralRewardItemRow[]; error: string | null }> {
  let query = supabase
    .from("referral_reward_items")
    .select(
      "id, target_month, order_id, product_id, base_amount, reward_rate, reward_amount, payment_status, order_status, refund_status, is_reward_target, is_paid, paid_at, creators ( creator_name ), referrers ( referrer_name )",
    )
    .eq("target_month", params.targetMonth)
    .order("created_at", { ascending: false });

  if (params.referrerId) {
    query = query.eq("referrer_id", params.referrerId);
  }

  const { data, error } = await query;
  if (error) {
    return { data: [], error: error.message };
  }

  return {
    data: (data ?? []).map((row) => {
      const creatorsJoin = row.creators as
        | { creator_name: string }
        | { creator_name: string }[]
        | null;
      const referrersJoin = row.referrers as
        | { referrer_name: string }
        | { referrer_name: string }[]
        | null;
      const creator = Array.isArray(creatorsJoin) ? creatorsJoin[0] : creatorsJoin;
      const referrer = Array.isArray(referrersJoin) ? referrersJoin[0] : referrersJoin;
      return {
        id: row.id as string,
        targetMonth: row.target_month as string,
        orderId: row.order_id as string,
        productId: row.product_id as string,
        creatorName: creator?.creator_name ?? "—",
        referrerName: referrer?.referrer_name ?? "—",
        baseAmount: Number(row.base_amount),
        rewardRate: Number(row.reward_rate),
        rewardAmount: Number(row.reward_amount),
        paymentStatus: (row.payment_status as string | null) ?? null,
        orderStatus: (row.order_status as string | null) ?? null,
        refundStatus: (row.refund_status as string | null) ?? null,
        isRewardTarget: Boolean(row.is_reward_target),
        isPaid: Boolean(row.is_paid),
        paidAt: (row.paid_at as string | null) ?? null,
      };
    }),
    error: null,
  };
}
