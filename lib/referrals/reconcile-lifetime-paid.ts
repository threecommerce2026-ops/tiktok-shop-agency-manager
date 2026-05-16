import type { SupabaseClient } from "@supabase/supabase-js";

type PaidPairTotal = {
  creatorId: string;
  referrerId: string;
  paidTotal: number;
};

export async function reconcileReferrerLifetimePaidAmounts(
  supabase: SupabaseClient,
): Promise<{ updatedCount: number; error: string | null }> {
  const { data: paidItems, error: paidItemsError } = await supabase
    .from("referral_reward_items")
    .select("creator_id, referrer_id, reward_amount, adjusted_reward_amount")
    .eq("is_paid", true)
    .eq("is_reward_target", true);

  if (paidItemsError) {
    return { updatedCount: 0, error: paidItemsError.message };
  }

  const paidByPair = new Map<string, PaidPairTotal>();
  for (const item of paidItems ?? []) {
    const creatorId = item.creator_id as string;
    const referrerId = item.referrer_id as string;
    const key = `${referrerId}:${creatorId}`;
    const amount = Number(item.adjusted_reward_amount ?? item.reward_amount ?? 0);
    const current = paidByPair.get(key);
    if (current) {
      current.paidTotal += amount;
    } else {
      paidByPair.set(key, { creatorId, referrerId, paidTotal: amount });
    }
  }

  const { data: referrals, error: referralsError } = await supabase
    .from("creator_referrals")
    .select("id, creator_id, referrer_id");

  if (referralsError) {
    return { updatedCount: 0, error: referralsError.message };
  }

  let updatedCount = 0;
  for (const referral of referrals ?? []) {
    const creatorId = referral.creator_id as string;
    const referrerId = referral.referrer_id as string;
    const paidTotal = paidByPair.get(`${referrerId}:${creatorId}`)?.paidTotal ?? 0;
    const { error } = await supabase
      .from("creator_referrals")
      .update({
        lifetime_paid_amount: paidTotal,
        updated_at: new Date().toISOString(),
      })
      .eq("id", referral.id as string);

    if (error) {
      return { updatedCount, error: error.message };
    }
    updatedCount += 1;
  }

  return { updatedCount, error: null };
}
