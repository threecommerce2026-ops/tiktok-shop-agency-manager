import type { SupabaseClient } from "@supabase/supabase-js";

import { fetchAllFrom } from "@/lib/db/paged-select";
import {
  REFERRAL_PAYOUT_THRESHOLD_YEN,
  resolveAnnualPayoutState,
  resolveRewardItemAmount,
  roundReferralAmount,
  sumReferralAmounts,
} from "@/lib/referrals/referral-reward-engine";
import { isInHouseReferrer } from "@/lib/referrals/in-house-referrer";

/*
  紹介者報酬タブのデータソース。

  支払判定は月単位ではなく「その年の未払い累積」で行う。
  1,000円未満でも明細は残り、翌月へ繰り越される。
*/

type RewardItemRow = {
  id: string;
  target_month: string;
  referrer_id: string;
  creator_id: string;
  base_amount: number | string | null;
  reward_amount: number | string | null;
  adjusted_reward_amount: number | string | null;
  is_reward_target: boolean;
  is_paid: boolean;
  paid_at: string | null;
  payout_id: string | null;
  order_id: string | null;
  product_id: string | null;
  source_row_key: string | null;
};

async function fetchYearItems(
  supabase: SupabaseClient,
  year: string,
  referrerId?: string | null,
): Promise<{ data: RewardItemRow[]; error: string | null }> {
  return fetchAllFrom<RewardItemRow>(
    supabase,
    "referral_reward_items",
    "id, target_month, referrer_id, creator_id, base_amount, reward_amount, adjusted_reward_amount, is_reward_target, is_paid, paid_at, payout_id, order_id, product_id, source_row_key",
    (query) => {
      const scoped = query
        .gte("target_month", `${year}-01`)
        .lte("target_month", `${year}-12`)
        .order("target_month", { ascending: true });
      return referrerId ? scoped.eq("referrer_id", referrerId) : scoped;
    },
  );
}

export type ReferralAnnualSummaryRow = {
  referrerId: string;
  referrerName: string;
  /** 年間発生額 */
  annualRewardAmount: number;
  /** 年間支払済額 */
  paidAmount: number;
  /** 未払残高（繰越含む） */
  unpaidAmount: number;
  /** 今回支払対象額（＝未払残高が基準額以上のとき） */
  payableAmount: number;
  isPayable: boolean;
  thresholdAmount: number;
  /** 未払いが発生している最新の対象月 */
  latestUnpaidMonth: string | null;
  lastPaidAt: string | null;
  creatorCount: number;
  itemCount: number;
  bankName: string | null;
  bankBranchName: string | null;
  bankAccountType: string | null;
  bankAccountNumber: string | null;
  bankAccountHolder: string | null;
  /** 支払確定に使う payout レコード（未作成なら null） */
  payoutId: string | null;
  payoutStatus: "hold" | "unpaid" | "paid" | null;
  /** 自社（（株）3）の紹介分か。実績には含めるが外部支払対象にしない */
  isInHouse: boolean;
};

export type ReferralAnnualSummary = {
  year: string;
  rows: ReferralAnnualSummaryRow[];
  totals: {
    /** 総発生額（自社分を含む） */
    annualRewardAmount: number;
    /** うち自社（（株）3）分。外部へは支払わない */
    inHouseRewardAmount: number;
    /** うち外部紹介者分 */
    externalRewardAmount: number;
    paidAmount: number;
    unpaidAmount: number;
    /** 外部紹介者への今回支払対象額（自社分を含まない） */
    payableAmount: number;
    carryOverAmount: number;
    payableReferrerCount: number;
    referrerCount: number;
    inHouseReferrerCount: number;
  };
  thresholdAmount: number;
  error: string | null;
};

export async function fetchReferralAnnualSummary(
  supabase: SupabaseClient,
  year: string,
): Promise<ReferralAnnualSummary> {
  const empty: ReferralAnnualSummary = {
    year,
    rows: [],
    totals: {
      annualRewardAmount: 0,
      inHouseRewardAmount: 0,
      externalRewardAmount: 0,
      paidAmount: 0,
      unpaidAmount: 0,
      payableAmount: 0,
      carryOverAmount: 0,
      payableReferrerCount: 0,
      referrerCount: 0,
      inHouseReferrerCount: 0,
    },
    thresholdAmount: REFERRAL_PAYOUT_THRESHOLD_YEN,
    error: null,
  };

  const [itemsResult, referrersResult, payoutsResult] = await Promise.all([
    fetchYearItems(supabase, year),
    supabase
      .from("referrers")
      .select(
        "id, name, referrer_name, is_in_house, bank_name, bank_branch_name, bank_account_type, bank_account_number, bank_account_holder",
      ),
    supabase
      .from("referral_payouts")
      .select("id, referrer_id, target_month, status, paid_at")
      .gte("target_month", `${year}-01`)
      .lte("target_month", `${year}-12`)
      .order("target_month", { ascending: false }),
  ]);

  const error =
    itemsResult.error ??
    referrersResult.error?.message ??
    payoutsResult.error?.message ??
    null;

  if (error) {
    return { ...empty, error };
  }

  const referrerById = new Map(
    (referrersResult.data ?? []).map((row) => [row.id as string, row]),
  );

  type Acc = {
    earned: number[];
    paid: number[];
    unpaid: number[];
    creators: Set<string>;
    itemCount: number;
    latestUnpaidMonth: string | null;
    lastPaidAt: string | null;
  };

  const byReferrer = new Map<string, Acc>();

  for (const item of itemsResult.data) {
    if (!item.is_reward_target) continue;

    const referrerId = item.referrer_id;
    const acc =
      byReferrer.get(referrerId) ??
      {
        earned: [],
        paid: [],
        unpaid: [],
        creators: new Set<string>(),
        itemCount: 0,
        latestUnpaidMonth: null,
        lastPaidAt: null,
      };

    const amount = resolveRewardItemAmount(item);
    acc.earned.push(amount);
    acc.creators.add(item.creator_id);
    acc.itemCount += 1;

    if (item.is_paid) {
      acc.paid.push(amount);
      if (item.paid_at && (!acc.lastPaidAt || item.paid_at > acc.lastPaidAt)) {
        acc.lastPaidAt = item.paid_at;
      }
    } else {
      acc.unpaid.push(amount);
      if (!acc.latestUnpaidMonth || item.target_month > acc.latestUnpaidMonth) {
        acc.latestUnpaidMonth = item.target_month;
      }
    }

    byReferrer.set(referrerId, acc);
  }

  // 未払いが残る最新月の payout レコードを支払操作の対象にする
  const payoutByKey = new Map<
    string,
    { id: string; status: "hold" | "unpaid" | "paid" }
  >();

  for (const payout of payoutsResult.data ?? []) {
    const key = `${payout.referrer_id as string}:${payout.target_month as string}`;
    if (payoutByKey.has(key)) continue;
    payoutByKey.set(key, {
      id: payout.id as string,
      status: payout.status as "hold" | "unpaid" | "paid",
    });
  }

  const rows: ReferralAnnualSummaryRow[] = [];

  for (const [referrerId, acc] of byReferrer) {
    const referrer = referrerById.get(referrerId);
    const annualRewardAmount = sumReferralAmounts(acc.earned);
    const paidAmount = sumReferralAmounts(acc.paid);

    const state = resolveAnnualPayoutState({
      annualRewardAmount,
      paidAmount,
    });

    // 自社紹介分は実績として集計するが、外部支払の対象にはしない
    const isInHouse = isInHouseReferrer(referrer);

    const payout = acc.latestUnpaidMonth
      ? payoutByKey.get(`${referrerId}:${acc.latestUnpaidMonth}`) ?? null
      : null;

    rows.push({
      referrerId,
      referrerName: String(
        referrer?.referrer_name ?? referrer?.name ?? "（削除済み紹介者）",
      ),
      annualRewardAmount,
      paidAmount,
      unpaidAmount: state.unpaidAmount,
      payableAmount: isInHouse ? 0 : state.isPayable ? state.unpaidAmount : 0,
      isPayable: !isInHouse && state.isPayable,
      isInHouse,
      thresholdAmount: state.thresholdAmount,
      latestUnpaidMonth: acc.latestUnpaidMonth,
      lastPaidAt: acc.lastPaidAt,
      creatorCount: acc.creators.size,
      itemCount: acc.itemCount,
      bankName: (referrer?.bank_name as string | null) ?? null,
      bankBranchName: (referrer?.bank_branch_name as string | null) ?? null,
      bankAccountType: (referrer?.bank_account_type as string | null) ?? null,
      bankAccountNumber: (referrer?.bank_account_number as string | null) ?? null,
      bankAccountHolder: (referrer?.bank_account_holder as string | null) ?? null,
      payoutId: payout?.id ?? null,
      payoutStatus: payout?.status ?? null,
    });
  }

  rows.sort((a, b) => b.unpaidAmount - a.unpaidAmount || b.annualRewardAmount - a.annualRewardAmount);

  const externalRows = rows.filter((row) => !row.isInHouse);
  const inHouseRows = rows.filter((row) => row.isInHouse);

  const totals = {
    annualRewardAmount: sumReferralAmounts(rows.map((r) => r.annualRewardAmount)),
    inHouseRewardAmount: sumReferralAmounts(
      inHouseRows.map((r) => r.annualRewardAmount),
    ),
    externalRewardAmount: sumReferralAmounts(
      externalRows.map((r) => r.annualRewardAmount),
    ),
    paidAmount: sumReferralAmounts(rows.map((r) => r.paidAmount)),
    unpaidAmount: sumReferralAmounts(rows.map((r) => r.unpaidAmount)),
    payableAmount: sumReferralAmounts(rows.map((r) => r.payableAmount)),
    // 繰越は外部紹介者だけを数える（自社分はそもそも支払対象外）
    carryOverAmount: sumReferralAmounts(
      externalRows.filter((r) => !r.isPayable).map((r) => r.unpaidAmount),
    ),
    payableReferrerCount: rows.filter((r) => r.isPayable).length,
    referrerCount: rows.length,
    inHouseReferrerCount: inHouseRows.length,
  };

  return {
    year,
    rows,
    totals,
    thresholdAmount: REFERRAL_PAYOUT_THRESHOLD_YEN,
    error: null,
  };
}

export type ReferralMonthlyBreakdownRow = {
  targetMonth: string;
  earnedAmount: number;
  paidAmount: number;
  unpaidAmount: number;
  itemCount: number;
};

export type ReferralAnnualDetail = {
  year: string;
  referrerId: string;
  monthlyRows: ReferralMonthlyBreakdownRow[];
  creatorRows: Array<{
    creatorId: string;
    creatorName: string;
    tiktokId: string;
    baseAmount: number;
    earnedAmount: number;
    unpaidAmount: number;
    itemCount: number;
  }>;
  error: string | null;
};

export async function fetchReferralAnnualDetail(
  supabase: SupabaseClient,
  year: string,
  referrerId: string,
): Promise<ReferralAnnualDetail> {
  const empty: ReferralAnnualDetail = {
    year,
    referrerId,
    monthlyRows: [],
    creatorRows: [],
    error: null,
  };

  const itemsResult = await fetchYearItems(supabase, year, referrerId);
  if (itemsResult.error) {
    return { ...empty, error: itemsResult.error };
  }

  const creatorIds = [
    ...new Set(itemsResult.data.map((item) => item.creator_id)),
  ];

  const { data: creators, error: creatorsError } =
    creatorIds.length > 0
      ? await supabase
          .from("creators")
          .select("id, creator_name, tiktok_id")
          .in("id", creatorIds)
      : { data: [], error: null };

  if (creatorsError) {
    return { ...empty, error: creatorsError.message };
  }

  const creatorById = new Map(
    (creators ?? []).map((row) => [
      row.id as string,
      {
        creatorName: String(row.creator_name ?? "—"),
        tiktokId: String(row.tiktok_id ?? ""),
      },
    ]),
  );

  const monthlyMap = new Map<
    string,
    { earned: number[]; paid: number[]; unpaid: number[]; itemCount: number }
  >();
  const creatorMap = new Map<
    string,
    { base: number; earned: number[]; unpaid: number[]; itemCount: number }
  >();

  for (const item of itemsResult.data) {
    if (!item.is_reward_target) continue;

    const amount = resolveRewardItemAmount(item);

    const monthly =
      monthlyMap.get(item.target_month) ??
      { earned: [], paid: [], unpaid: [], itemCount: 0 };
    monthly.earned.push(amount);
    monthly.itemCount += 1;
    if (item.is_paid) monthly.paid.push(amount);
    else monthly.unpaid.push(amount);
    monthlyMap.set(item.target_month, monthly);

    const creator =
      creatorMap.get(item.creator_id) ??
      { base: 0, earned: [], unpaid: [], itemCount: 0 };
    creator.base += Number(item.base_amount ?? 0);
    creator.earned.push(amount);
    creator.itemCount += 1;
    if (!item.is_paid) creator.unpaid.push(amount);
    creatorMap.set(item.creator_id, creator);
  }

  const monthlyRows = [...monthlyMap.entries()]
    .map(([targetMonth, acc]) => ({
      targetMonth,
      earnedAmount: sumReferralAmounts(acc.earned),
      paidAmount: sumReferralAmounts(acc.paid),
      unpaidAmount: sumReferralAmounts(acc.unpaid),
      itemCount: acc.itemCount,
    }))
    .sort((a, b) => a.targetMonth.localeCompare(b.targetMonth));

  const creatorRows = [...creatorMap.entries()]
    .map(([creatorId, acc]) => ({
      creatorId,
      creatorName: creatorById.get(creatorId)?.creatorName ?? "—",
      tiktokId: creatorById.get(creatorId)?.tiktokId ?? "",
      baseAmount: roundReferralAmount(acc.base),
      earnedAmount: sumReferralAmounts(acc.earned),
      unpaidAmount: sumReferralAmounts(acc.unpaid),
      itemCount: acc.itemCount,
    }))
    .sort((a, b) => b.earnedAmount - a.earnedAmount);

  return { year, referrerId, monthlyRows, creatorRows, error: null };
}
