import type { SupabaseClient } from "@supabase/supabase-js";
import {
  applyReferralRewardCap,
  DEFAULT_REFERRER_LIFETIME_PAYOUT_CAP_YEN,
  pairReferralKey,
} from "@/lib/referrals/cap";
import {
  isReferralEligibleOrder,
  isReferralMonthActive,
  referralRewardFromBase,
  resolveReferralPayoutStatus,
  REFERRAL_PAYOUT_THRESHOLD_YEN,
} from "@/lib/referrals/calc";
import { isInHouseCreator } from "@/lib/revenue/in-house-creator";

type ReferralLink = {
  creatorId: string;
  referrerId: string;
  referralRate: number;
  startMonth: string;
  endMonth: string | null;
  isActive: boolean;
  lifetimePayoutCap: number;
  lifetimePaidAmount: number;
};

type PairCapState = {
  lifetimePayoutCap: number;
  lifetimePaidAmount: number;
  allocatedUnpaidAmount: number;
};

function resolvePaidRewardAmount(item: {
  adjusted_reward_amount?: number | null;
  reward_amount?: number | null;
}): number {
  return Number(item.adjusted_reward_amount ?? item.reward_amount ?? 0);
}

function buildPairCapState(
  referral: ReferralLink,
  unpaidByPair: Map<string, number>,
): PairCapState {
  const key = pairReferralKey(referral.referrerId, referral.creatorId);
  return {
    lifetimePayoutCap: referral.lifetimePayoutCap,
    lifetimePaidAmount: referral.lifetimePaidAmount,
    allocatedUnpaidAmount: unpaidByPair.get(key) ?? 0,
  };
}

function applyCapForPair(
  originalRewardAmount: number,
  eligible: boolean,
  capState: PairCapState,
): ReturnType<typeof applyReferralRewardCap> {
  const effectivePaidAmount =
    capState.lifetimePaidAmount + capState.allocatedUnpaidAmount;
  const capped = applyReferralRewardCap({
    originalRewardAmount,
    lifetimePayoutCap: capState.lifetimePayoutCap,
    lifetimePaidAmount: effectivePaidAmount,
    eligible,
  });
  capState.allocatedUnpaidAmount += capped.adjustedRewardAmount;
  return capped;
}

async function incrementCreatorReferralLifetimePaidAmounts(
  supabase: SupabaseClient,
  increments: Map<string, number>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  for (const [key, amount] of increments.entries()) {
    if (amount === 0) continue;
    const [referrerId, creatorId] = key.split(":");
    const { data: referral, error: referralError } = await supabase
      .from("creator_referrals")
      .select("id, lifetime_paid_amount")
      .eq("referrer_id", referrerId)
      .eq("creator_id", creatorId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (referralError) {
      return { ok: false, error: referralError.message };
    }
    if (!referral?.id) {
      return { ok: false, error: "紹介紐付けが見つかりません" };
    }

    const nextAmount = Math.max(Number(referral.lifetime_paid_amount) + amount, 0);
    const { error: updateError } = await supabase
      .from("creator_referrals")
      .update({
        lifetime_paid_amount: nextAmount,
        updated_at: new Date().toISOString(),
      })
      .eq("id", referral.id as string);

    if (updateError) {
      return { ok: false, error: updateError.message };
    }
  }

  return { ok: true };
}

export async function syncReferralRewardsForMonth(
  supabase: SupabaseClient,
  targetMonth: string,
): Promise<{
  insertedCount: number;
  payoutCount: number;
  error: string | null;
}> {
  const [
    { data: creators, error: creatorsError },
    { data: agencies, error: agenciesError },
    { data: referrals, error: referralsError },
    { data: orders, error: ordersError },
    { data: existingItems, error: existingItemsError },
    { data: unpaidItems, error: unpaidItemsError },
  ] = await Promise.all([
    supabase.from("creators").select("id, agency_id, agencies ( name )"),
    supabase.from("agencies").select("id, name"),
    supabase
      .from("creator_referrals")
      .select(
        "creator_id, referrer_id, referral_rate, start_month, end_month, is_active, lifetime_payout_cap, lifetime_paid_amount",
      ),
    supabase
      .from("orders")
      .select(
        "order_id, product_id, creator_id, creator_tiktok_id, target_month, order_amount, commission_base, payment_status, order_status, cancel_status, refund_status",
      )
      .eq("target_month", targetMonth),
    supabase
      .from("referral_reward_items")
      .select("target_month, order_id, product_id, creator_id, referrer_id")
      .eq("target_month", targetMonth),
    supabase
      .from("referral_reward_items")
      .select("creator_id, referrer_id, reward_amount, adjusted_reward_amount, is_reward_target, is_paid")
      .eq("is_paid", false)
      .eq("is_reward_target", true),
  ]);

  const loadError =
    creatorsError?.message ??
    agenciesError?.message ??
    referralsError?.message ??
    ordersError?.message ??
    existingItemsError?.message ??
    unpaidItemsError?.message ??
    null;
  if (loadError) {
    return { insertedCount: 0, payoutCount: 0, error: loadError };
  }

  const agencyNameById = new Map<string, string>();
  for (const agency of agencies ?? []) {
    agencyNameById.set(agency.id as string, agency.name as string);
  }

  const inHouseCreatorIds = new Set<string>();
  for (const creator of creators ?? []) {
    const agencyId = (creator.agency_id as string | null) ?? null;
    const agenciesJoin = creator.agencies as { name: string } | { name: string }[] | null;
    const agency = Array.isArray(agenciesJoin) ? agenciesJoin[0] : agenciesJoin;
    const agencyName = agency?.name ?? agencyNameById.get(agencyId ?? "") ?? null;
    if (isInHouseCreator({ agencyId, agencyName })) {
      inHouseCreatorIds.add(creator.id as string);
    }
  }

  const referralByCreator = new Map<string, ReferralLink>();
  for (const referral of referrals ?? []) {
    const creatorId = referral.creator_id as string;
    if (!referral.is_active || referralByCreator.has(creatorId)) continue;
    referralByCreator.set(creatorId, {
      creatorId,
      referrerId: referral.referrer_id as string,
      referralRate: Number(referral.referral_rate),
      startMonth: referral.start_month as string,
      endMonth: (referral.end_month as string | null) ?? null,
      isActive: Boolean(referral.is_active),
      lifetimePayoutCap: Number(
        referral.lifetime_payout_cap ?? DEFAULT_REFERRER_LIFETIME_PAYOUT_CAP_YEN,
      ),
      lifetimePaidAmount: Number(referral.lifetime_paid_amount ?? 0),
    });
  }

  const unpaidByPair = new Map<string, number>();
  for (const item of unpaidItems ?? []) {
    const key = pairReferralKey(item.referrer_id as string, item.creator_id as string);
    unpaidByPair.set(key, (unpaidByPair.get(key) ?? 0) + resolvePaidRewardAmount(item));
  }

  const capStateByPair = new Map<string, PairCapState>();
  for (const referral of referralByCreator.values()) {
    capStateByPair.set(
      pairReferralKey(referral.referrerId, referral.creatorId),
      buildPairCapState(referral, unpaidByPair),
    );
  }

  const existingKeys = new Set(
    (existingItems ?? []).map(
      (item) =>
        `${item.target_month}:${item.order_id}:${item.product_id ?? ""}:${item.creator_id}:${item.referrer_id}`,
    ),
  );

  const inserts: Array<Record<string, unknown>> = [];
  for (const order of orders ?? []) {
    const creatorId = order.creator_id as string | null;
    if (!creatorId || !inHouseCreatorIds.has(creatorId)) continue;

    const referral = referralByCreator.get(creatorId);
    if (!referral || !isReferralMonthActive(targetMonth, referral.startMonth, referral.endMonth)) {
      continue;
    }

    const eligible = isReferralEligibleOrder({
      payment_status: order.payment_status as string | null,
      cancel_status: order.cancel_status as string | null,
      refund_status: order.refund_status as string | null,
      order_amount: Number(order.order_amount),
      commission_base: Number(order.commission_base),
    });
    const productId = String(order.product_id ?? "");
    const key = `${targetMonth}:${order.order_id as string}:${productId}:${creatorId}:${referral.referrerId}`;
    if (existingKeys.has(key)) continue;

    const baseAmount = eligible
      ? Number(order.commission_base) > 0
        ? Number(order.commission_base)
        : Number(order.order_amount)
      : 0;
    const originalRewardAmount = eligible
      ? referralRewardFromBase(baseAmount, referral.referralRate)
      : 0;
    const pairKey = pairReferralKey(referral.referrerId, creatorId);
    const capState =
      capStateByPair.get(pairKey) ?? buildPairCapState(referral, unpaidByPair);
    capStateByPair.set(pairKey, capState);
    const capped = applyCapForPair(originalRewardAmount, eligible, capState);

    inserts.push({
      target_month: targetMonth,
      order_id: order.order_id,
      product_id: productId,
      creator_id: creatorId,
      referrer_id: referral.referrerId,
      base_amount: baseAmount,
      reward_rate: referral.referralRate,
      reward_amount: capped.rewardAmount,
      original_reward_amount: capped.originalRewardAmount,
      adjusted_reward_amount: capped.adjustedRewardAmount,
      cap_applied: capped.capApplied,
      cap_reached: capped.capReached,
      payment_status: order.payment_status,
      order_status: order.order_status,
      refund_status: order.refund_status,
      is_reward_target: capped.isRewardTarget,
      is_paid: false,
    });
    existingKeys.add(key);
  }

  let insertedCount = 0;
  if (inserts.length > 0) {
    const { error } = await supabase.from("referral_reward_items").insert(inserts);
    if (error) {
      return { insertedCount: 0, payoutCount: 0, error: error.message };
    }
    insertedCount = inserts.length;
  }

  const { data: rewardItems, error: rewardItemsError } = await supabase
    .from("referral_reward_items")
    .select("referrer_id, reward_amount, adjusted_reward_amount, is_reward_target, is_paid")
    .eq("target_month", targetMonth);
  if (rewardItemsError) {
    return { insertedCount, payoutCount: 0, error: rewardItemsError.message };
  }

  const totals = new Map<string, number>();
  for (const item of rewardItems ?? []) {
    if (!item.is_reward_target || item.is_paid) continue;
    const referrerId = item.referrer_id as string;
    totals.set(
      referrerId,
      (totals.get(referrerId) ?? 0) + resolvePaidRewardAmount(item),
    );
  }

  let payoutCount = 0;
  for (const [referrerId, totalRewardAmount] of totals.entries()) {
    const payoutState = resolveReferralPayoutStatus(totalRewardAmount);
    const { error } = await supabase.from("referral_payouts").upsert(
      {
        target_month: targetMonth,
        referrer_id: referrerId,
        total_reward_amount: totalRewardAmount,
        threshold_amount: REFERRAL_PAYOUT_THRESHOLD_YEN,
        is_payable: payoutState.isPayable,
        status: payoutState.status,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "target_month,referrer_id" },
    );
    if (error) {
      return { insertedCount, payoutCount, error: error.message };
    }
    payoutCount += 1;
  }

  return { insertedCount, payoutCount, error: null };
}

export async function markReferralPayoutPaid(
  supabase: SupabaseClient,
  payoutId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: payout, error: payoutError } = await supabase
    .from("referral_payouts")
    .select("id, target_month, referrer_id, status")
    .eq("id", payoutId)
    .maybeSingle();

  if (payoutError) {
    return { ok: false, error: payoutError.message };
  }
  if (!payout) {
    return { ok: false, error: "支払いレコードが見つかりません" };
  }

  const { data: unpaidItems, error: unpaidItemsError } = await supabase
    .from("referral_reward_items")
    .select("creator_id, referrer_id, reward_amount, adjusted_reward_amount")
    .eq("target_month", payout.target_month as string)
    .eq("referrer_id", payout.referrer_id as string)
    .eq("is_reward_target", true)
    .eq("is_paid", false);

  if (unpaidItemsError) {
    return { ok: false, error: unpaidItemsError.message };
  }

  const increments = new Map<string, number>();
  for (const item of unpaidItems ?? []) {
    const key = pairReferralKey(item.referrer_id as string, item.creator_id as string);
    const amount = resolvePaidRewardAmount(item);
    increments.set(key, (increments.get(key) ?? 0) + amount);
  }

  const paidAt = new Date().toISOString();
  const { error: updatePayoutError } = await supabase
    .from("referral_payouts")
    .update({
      status: "paid",
      is_payable: true,
      paid_at: paidAt,
      updated_at: paidAt,
    })
    .eq("id", payoutId);

  if (updatePayoutError) {
    return { ok: false, error: updatePayoutError.message };
  }

  const { error: updateItemsError } = await supabase
    .from("referral_reward_items")
    .update({
      is_paid: true,
      paid_at: paidAt,
      updated_at: paidAt,
    })
    .eq("target_month", payout.target_month as string)
    .eq("referrer_id", payout.referrer_id as string)
    .eq("is_reward_target", true)
    .eq("is_paid", false);

  if (updateItemsError) {
    return { ok: false, error: updateItemsError.message };
  }

  const incrementResult = await incrementCreatorReferralLifetimePaidAmounts(supabase, increments);
  if (!incrementResult.ok) {
    return incrementResult;
  }

  return { ok: true };
}

export async function markReferralPayoutUnpaid(
  supabase: SupabaseClient,
  payoutId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: payout, error: payoutError } = await supabase
    .from("referral_payouts")
    .select("id, target_month, referrer_id, status")
    .eq("id", payoutId)
    .maybeSingle();

  if (payoutError) {
    return { ok: false, error: payoutError.message };
  }
  if (!payout) {
    return { ok: false, error: "支払いレコードが見つかりません" };
  }
  if (payout.status !== "paid") {
    return { ok: false, error: "支払い済みのレコードのみ取消できます" };
  }

  const { data: paidItems, error: paidItemsError } = await supabase
    .from("referral_reward_items")
    .select("creator_id, referrer_id, reward_amount, adjusted_reward_amount")
    .eq("target_month", payout.target_month as string)
    .eq("referrer_id", payout.referrer_id as string)
    .eq("is_reward_target", true)
    .eq("is_paid", true);

  if (paidItemsError) {
    return { ok: false, error: paidItemsError.message };
  }

  const decrements = new Map<string, number>();
  for (const item of paidItems ?? []) {
    const key = pairReferralKey(item.referrer_id as string, item.creator_id as string);
    const amount = resolvePaidRewardAmount(item);
    decrements.set(key, (decrements.get(key) ?? 0) + amount);
  }

  const reversedAt = new Date().toISOString();
  const { error: updatePayoutError } = await supabase
    .from("referral_payouts")
    .update({
      status: "unpaid",
      paid_at: null,
      updated_at: reversedAt,
    })
    .eq("id", payoutId);

  if (updatePayoutError) {
    return { ok: false, error: updatePayoutError.message };
  }

  const { error: updateItemsError } = await supabase
    .from("referral_reward_items")
    .update({
      is_paid: false,
      paid_at: null,
      updated_at: reversedAt,
    })
    .eq("target_month", payout.target_month as string)
    .eq("referrer_id", payout.referrer_id as string)
    .eq("is_reward_target", true)
    .eq("is_paid", true);

  if (updateItemsError) {
    return { ok: false, error: updateItemsError.message };
  }

  const decrementIncrements = new Map<string, number>();
  for (const [key, amount] of decrements.entries()) {
    decrementIncrements.set(key, -amount);
  }
  const decrementResult = await incrementCreatorReferralLifetimePaidAmounts(
    supabase,
    decrementIncrements,
  );
  if (!decrementResult.ok) {
    return decrementResult;
  }

  return { ok: true };
}
