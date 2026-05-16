import type { SupabaseClient } from "@supabase/supabase-js";
import { currentMonthKey } from "@/lib/db/dashboard-queries";
import { isInHouseCreator } from "@/lib/revenue/in-house-creator";
import {
  formatCreatorRegistrationStatusLabel,
  formatCreatorTiktokIdLabel,
  formatOfficialLineRegisteredLabel,
  isPendingReferralTiktokId,
} from "@/lib/creators/referral-registration";

export type CreatorReferralAdminRow = {
  id: string;
  creatorId: string;
  creatorName: string;
  tiktokId: string;
  officialLineRegistered: string;
  tiktokIdEditable: boolean;
  registrationStatus: string;
  referrerId: string | null;
  referrerName: string | null;
  referralRate: number;
  startMonth: string;
  endMonth: string | null;
  isActive: boolean;
  paidProfitMonth: number;
  referralRewardMonth: number;
  payoutStatus: string | null;
  isPayable: boolean;
};

export async function fetchCreatorReferralAdminRows(
  supabase: SupabaseClient,
  targetMonth: string = currentMonthKey(),
): Promise<{ data: CreatorReferralAdminRow[]; error: string | null }> {
  const [
    { data: creators, error: creatorsError },
    { data: agencies, error: agenciesError },
    { data: referrals, error: referralsError },
    { data: rewardItems, error: rewardItemsError },
    { data: payouts, error: payoutsError },
  ] = await Promise.all([
    supabase
      .from("creators")
      .select(
        "id, creator_name, tiktok_id, official_line_registered, registration_status, agency_id, agencies ( name )",
      )
      .order("creator_name"),
    supabase.from("agencies").select("id, name"),
    supabase
      .from("creator_referrals")
      .select(
        "id, creator_id, referrer_id, referral_rate, start_month, end_month, is_active, referrers ( referrer_name )",
      )
      .order("created_at", { ascending: false }),
    supabase
      .from("referral_reward_items")
      .select("creator_id, referrer_id, target_month, base_amount, reward_amount, is_reward_target")
      .eq("target_month", targetMonth),
    supabase
      .from("referral_payouts")
      .select("referrer_id, target_month, status, is_payable")
      .eq("target_month", targetMonth),
  ]);

  if (creatorsError || agenciesError || referralsError || rewardItemsError || payoutsError) {
    return {
      data: [],
      error:
        creatorsError?.message ??
        agenciesError?.message ??
        referralsError?.message ??
        rewardItemsError?.message ??
        payoutsError?.message ??
        null,
    };
  }

  const agencyNameById = new Map<string, string>();
  for (const agency of agencies ?? []) {
    agencyNameById.set(agency.id as string, agency.name as string);
  }

  const activeReferralByCreator = new Map<
    string,
    {
      id: string;
      referrerId: string;
      referrerName: string | null;
      referralRate: number;
      startMonth: string;
      endMonth: string | null;
      isActive: boolean;
    }
  >();

  for (const referral of referrals ?? []) {
    const creatorId = referral.creator_id as string;
    if (activeReferralByCreator.has(creatorId)) continue;
    const referrersJoin = referral.referrers as
      | { referrer_name: string }
      | { referrer_name: string }[]
      | null;
    const referrer = Array.isArray(referrersJoin) ? referrersJoin[0] : referrersJoin;
    activeReferralByCreator.set(creatorId, {
      id: referral.id as string,
      referrerId: referral.referrer_id as string,
      referrerName: referrer?.referrer_name ?? null,
      referralRate: Number(referral.referral_rate),
      startMonth: referral.start_month as string,
      endMonth: (referral.end_month as string | null) ?? null,
      isActive: Boolean(referral.is_active),
    });
  }

  const rewardByCreatorReferrer = new Map<string, { profit: number; reward: number }>();
  for (const item of rewardItems ?? []) {
    if (!item.is_reward_target) continue;
    const key = `${item.creator_id}:${item.referrer_id}`;
    const bucket = rewardByCreatorReferrer.get(key) ?? { profit: 0, reward: 0 };
    bucket.profit += Number(item.base_amount);
    bucket.reward += Number(item.reward_amount);
    rewardByCreatorReferrer.set(key, bucket);
  }

  const payoutByReferrer = new Map<string, { status: string | null; isPayable: boolean }>();
  for (const payout of payouts ?? []) {
    payoutByReferrer.set(payout.referrer_id as string, {
      status: payout.status as string,
      isPayable: Boolean(payout.is_payable),
    });
  }

  const rows: CreatorReferralAdminRow[] = [];
  for (const creator of creators ?? []) {
    const agencyId = (creator.agency_id as string | null) ?? null;
    const agenciesJoin = creator.agencies as { name: string } | { name: string }[] | null;
    const agency = Array.isArray(agenciesJoin) ? agenciesJoin[0] : agenciesJoin;
    const agencyName = agency?.name ?? agencyNameById.get(agencyId ?? "") ?? null;
    if (!isInHouseCreator({ agencyId, agencyName })) {
      continue;
    }

    const referral = activeReferralByCreator.get(creator.id as string);
    const rewardKey = referral ? `${creator.id}:${referral.referrerId}` : null;
    const reward = rewardKey ? rewardByCreatorReferrer.get(rewardKey) : undefined;
    const payout = referral ? payoutByReferrer.get(referral.referrerId) : undefined;

    rows.push({
      id: referral?.id ?? `creator:${creator.id as string}`,
      creatorId: creator.id as string,
      creatorName: creator.creator_name as string,
      tiktokId: formatCreatorTiktokIdLabel(creator.tiktok_id as string),
      officialLineRegistered: formatOfficialLineRegisteredLabel(
        creator.official_line_registered as boolean | null,
      ),
      tiktokIdEditable: isPendingReferralTiktokId(creator.tiktok_id as string),
      registrationStatus: formatCreatorRegistrationStatusLabel(
        creator.registration_status as string | null,
      ),
      referrerId: referral?.referrerId ?? null,
      referrerName: referral?.referrerName ?? null,
      referralRate: referral?.referralRate ?? 0.05,
      startMonth: referral?.startMonth ?? targetMonth,
      endMonth: referral?.endMonth ?? null,
      isActive: referral?.isActive ?? false,
      paidProfitMonth: reward?.profit ?? 0,
      referralRewardMonth: reward?.reward ?? 0,
      payoutStatus: payout?.status ?? null,
      isPayable: payout?.isPayable ?? false,
    });
  }

  return { data: rows, error: null };
}

export async function fetchInHouseCreatorOptions(
  supabase: SupabaseClient,
): Promise<{ data: Array<{ id: string; creatorName: string; tiktokId: string }>; error: string | null }> {
  const [{ data: creators, error: creatorsError }, { data: agencies, error: agenciesError }] =
    await Promise.all([
      supabase
        .from("creators")
        .select("id, creator_name, tiktok_id, agency_id, agencies ( name )")
        .order("creator_name"),
      supabase.from("agencies").select("id, name"),
    ]);

  if (creatorsError || agenciesError) {
    return { data: [], error: creatorsError?.message ?? agenciesError?.message ?? null };
  }

  const agencyNameById = new Map<string, string>();
  for (const agency of agencies ?? []) {
    agencyNameById.set(agency.id as string, agency.name as string);
  }

  return {
    data: (creators ?? [])
      .filter((creator) => {
        const agencyId = (creator.agency_id as string | null) ?? null;
        const agenciesJoin = creator.agencies as { name: string } | { name: string }[] | null;
        const agency = Array.isArray(agenciesJoin) ? agenciesJoin[0] : agenciesJoin;
        const agencyName = agency?.name ?? agencyNameById.get(agencyId ?? "") ?? null;
        return isInHouseCreator({ agencyId, agencyName });
      })
      .map((creator) => ({
        id: creator.id as string,
        creatorName: creator.creator_name as string,
        tiktokId: formatCreatorTiktokIdLabel(creator.tiktok_id as string),
      })),
    error: null,
  };
}
