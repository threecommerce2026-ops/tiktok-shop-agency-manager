import type { SupabaseClient } from "@supabase/supabase-js";

import { fetchAllFrom } from "@/lib/db/paged-select";
import { toAmount } from "@/lib/revenue/amount";
import { isAgencyPayoutEligibleOrderLine } from "@/lib/revenue/order-line-status";
import type { AgencyAssignmentState } from "@/lib/agency/agency-assignment";
import {
  resolveAgencyAnnualState,
  resolveAgencyRewardItemAmount,
  roundAgencyAmount,
  sumAgencyAmounts,
} from "@/lib/agency/agency-reward-engine";

/*
  代理店報酬タブのデータソース。

  代理店報酬額 = AP「エージェンシーの収益総額」を100%。
  金額は agency_reward_items.reward_amount（= AP 実額）をそのまま合算するだけで、
  AK（agency_split_rate）を掛け直すことはしない。

  一覧と詳細（月別 / クリエイター別）は同じ1回の読み取りから組み立てる。
*/

type AgencyRewardItemRow = {
  target_month: string;
  agency_id: string;
  creator_id: string;
  agency_source: string | null;
  commission_base: number | string | null;
  commission_gmv: number | string | null;
  creator_revenue_before_split: number | string | null;
  agency_split_rate: number | string | null;
  reward_amount: number | string | null;
  is_reward_target: boolean;
  is_paid: boolean;
  paid_at: string | null;
  payout_id: string | null;
};

const ITEM_COLUMNS =
  "target_month, agency_id, creator_id, agency_source, commission_base, commission_gmv, creator_revenue_before_split, agency_split_rate, reward_amount, is_reward_target, is_paid, paid_at, payout_id";

export type AgencyPaymentState = "paid" | "partial" | "unpaid";

function resolvePaymentState(
  rewardAmount: number,
  paidAmount: number,
): AgencyPaymentState {
  if (paidAmount <= 0) return "unpaid";
  if (paidAmount >= rewardAmount - 0.005) return "paid";
  return "partial";
}

export type AgencyMonthlyBreakdownRow = {
  targetMonth: string;
  /** AD 成果報酬ベース */
  commissionBase: number;
  /** AJ 収益分配前のクリエイター収益 */
  creatorRevenueBeforeSplit: number;
  rewardAmount: number;
  paidAmount: number;
  unpaidAmount: number;
  itemCount: number;
  creatorCount: number;
  paymentState: AgencyPaymentState;
};

export type AgencyCreatorBreakdownRow = {
  creatorId: string;
  creatorName: string;
  tiktokId: string;
  targetMonth: string;
  /** AD 成果報酬ベース */
  commissionBase: number;
  /** AJ 収益分配前のクリエイター収益 */
  creatorRevenueBeforeSplit: number;
  /** AK エージェンシー分配率(%)。表示専用で計算には使わない */
  agencySplitRate: number;
  rewardAmount: number;
  paidAmount: number;
  unpaidAmount: number;
  itemCount: number;
  /** monthly = 月別確定 / current = 現在所属（暫定） / none = 未確定 */
  assignmentState: AgencyAssignmentState;
  paymentState: AgencyPaymentState;
};

export type AgencyAnnualSummaryRow = {
  agencyId: string;
  agencyName: string;
  annualRewardAmount: number;
  annualCommissionBase: number;
  paidAmount: number;
  unpaidAmount: number;
  payableAmount: number;
  isPayable: boolean;
  latestUnpaidMonth: string | null;
  lastPaidAt: string | null;
  creatorCount: number;
  itemCount: number;
  /** 現在所属フォールバックで計算された明細を含むか */
  usesCurrentAgencyFallback: boolean;
  /** 未払いのうち、月別所属が未確定（現在所属で暫定計算）の金額 */
  provisionalUnpaidAmount: number;
  /** 未払いのうち、月別所属が未確定のクリエイター数 */
  provisionalCreatorCount: number;
  /** 支払前チェック: 未確定所属が含まれるか */
  hasUnconfirmedAssignment: boolean;
  payoutId: string | null;
  payoutStatus: "hold" | "unpaid" | "paid" | null;
  monthlyRows: AgencyMonthlyBreakdownRow[];
  creatorRows: AgencyCreatorBreakdownRow[];
};

/** 支払対象から外れた要確認クリエイター */
export type AgencyReviewRow = {
  creatorId: string;
  creatorName: string;
  tiktokId: string;
  targetMonths: string[];
  commissionBase: number;
  agencySplitRate: number;
  /** 帰属先が決まっていない代理店収益 */
  unassignedAgencyRevenue: number;
  itemCount: number;
  reason: "no_agency_with_split";
};

export type AgencyPayoutHistoryRow = {
  id: string;
  targetMonth: string;
  agencyId: string;
  agencyName: string;
  totalRewardAmount: number;
  status: "hold" | "unpaid" | "paid";
  paidAt: string | null;
};

export type AgencyAnnualSummary = {
  year: string;
  rows: AgencyAnnualSummaryRow[];
  reviewRows: AgencyReviewRow[];
  history: AgencyPayoutHistoryRow[];
  totals: {
    annualRewardAmount: number;
    paidAmount: number;
    unpaidAmount: number;
    payableAmount: number;
    agencyCount: number;
    payableAgencyCount: number;
    itemCount: number;
    /** 月別確定を根拠にしている未払い金額 */
    confirmedUnpaidAmount: number;
    /** 現在所属（暫定）を根拠にしている未払い金額 */
    provisionalUnpaidAmount: number;
  };
  error: string | null;
};

type Bucket = {
  base: number;
  beforeSplit: number;
  earned: number[];
  paid: number[];
  itemCount: number;
  creators: Set<string>;
  splitRates: Set<number>;
  sources: Set<string>;
};

function createBucket(): Bucket {
  return {
    base: 0,
    beforeSplit: 0,
    earned: [],
    paid: [],
    itemCount: 0,
    creators: new Set<string>(),
    splitRates: new Set<number>(),
    sources: new Set<string>(),
  };
}

function addToBucket(bucket: Bucket, item: AgencyRewardItemRow, value: number) {
  bucket.base += toAmount(item.commission_base);
  bucket.beforeSplit += toAmount(item.creator_revenue_before_split);
  bucket.earned.push(value);
  if (item.is_paid) bucket.paid.push(value);
  bucket.itemCount += 1;
  bucket.creators.add(item.creator_id);
  bucket.splitRates.add(toAmount(item.agency_split_rate));
  if (item.agency_source) bucket.sources.add(item.agency_source);
}

export async function fetchAgencyAnnualSummary(
  supabase: SupabaseClient,
  year: string,
  options: { agencyId?: string | null } = {},
): Promise<AgencyAnnualSummary> {
  const scopedAgencyId = options.agencyId ?? null;

  const empty: AgencyAnnualSummary = {
    year,
    rows: [],
    reviewRows: [],
    history: [],
    totals: {
      annualRewardAmount: 0,
      paidAmount: 0,
      unpaidAmount: 0,
      payableAmount: 0,
      agencyCount: 0,
      payableAgencyCount: 0,
      itemCount: 0,
      confirmedUnpaidAmount: 0,
      provisionalUnpaidAmount: 0,
    },
    error: null,
  };

  const [itemsResult, agenciesResult, payoutsResult, reviewResult] = await Promise.all([
    fetchAllFrom<AgencyRewardItemRow>(
      supabase,
      "agency_reward_items",
      ITEM_COLUMNS,
      (query) => {
        const scoped = query
          .gte("target_month", `${year}-01`)
          .lte("target_month", `${year}-12`)
          .order("target_month", { ascending: true });
        return scopedAgencyId ? scoped.eq("agency_id", scopedAgencyId) : scoped;
      },
    ),
    supabase.from("agencies").select("id, name"),
    supabase
      .from("agency_payouts")
      .select("id, agency_id, target_month, status, paid_at, total_reward_amount")
      .gte("target_month", `${year}-01`)
      .lte("target_month", `${year}-12`)
      .order("target_month", { ascending: false }),
    scopedAgencyId
      ? Promise.resolve({ data: [], error: null })
      : fetchAgencyReviewRows(supabase, year),
  ]);

  const error =
    itemsResult.error ??
    agenciesResult.error?.message ??
    payoutsResult.error?.message ??
    reviewResult.error ??
    null;

  if (error) {
    return { ...empty, error };
  }

  const agencyNameById = new Map<string, string>();
  for (const agency of agenciesResult.data ?? []) {
    agencyNameById.set(agency.id as string, String(agency.name ?? ""));
  }

  const targetItems = itemsResult.data.filter((item) => item.is_reward_target);

  const creatorIds = [...new Set(targetItems.map((item) => item.creator_id))];
  const creatorsResult =
    creatorIds.length > 0
      ? await supabase
          .from("creators")
          .select("id, creator_name, tiktok_id")
          .in("id", creatorIds)
      : { data: [] as Array<Record<string, unknown>>, error: null };

  if (creatorsResult.error) {
    return { ...empty, error: creatorsResult.error.message };
  }

  const creatorById = new Map(
    (creatorsResult.data ?? []).map((row) => [
      row.id as string,
      {
        creatorName: String(row.creator_name ?? "—"),
        tiktokId: String(row.tiktok_id ?? ""),
      },
    ]),
  );

  const payoutByKey = new Map<
    string,
    { id: string; status: "hold" | "unpaid" | "paid" }
  >();
  const history: AgencyPayoutHistoryRow[] = [];

  for (const payout of payoutsResult.data ?? []) {
    const agencyId = payout.agency_id as string;
    const key = `${agencyId}:${payout.target_month as string}`;
    if (!payoutByKey.has(key)) {
      payoutByKey.set(key, {
        id: payout.id as string,
        status: payout.status as "hold" | "unpaid" | "paid",
      });
    }

    if (payout.status === "paid") {
      history.push({
        id: payout.id as string,
        targetMonth: payout.target_month as string,
        agencyId,
        agencyName: agencyNameById.get(agencyId) ?? "—",
        totalRewardAmount: toAmount(payout.total_reward_amount),
        status: "paid",
        paidAt: (payout.paid_at as string | null) ?? null,
      });
    }
  }

  type AgencyAcc = {
    total: Bucket;
    byMonth: Map<string, Bucket>;
    byCreatorMonth: Map<string, Bucket>;
    latestUnpaidMonth: string | null;
    lastPaidAt: string | null;
    /* 未払い かつ 所属が現在所属（暫定）の明細 */
    provisionalUnpaid: number[];
    provisionalCreators: Set<string>;
  };

  const byAgency = new Map<string, AgencyAcc>();

  for (const item of targetItems) {
    const acc =
      byAgency.get(item.agency_id) ??
      {
        total: createBucket(),
        byMonth: new Map<string, Bucket>(),
        byCreatorMonth: new Map<string, Bucket>(),
        latestUnpaidMonth: null,
        lastPaidAt: null,
        provisionalUnpaid: [],
        provisionalCreators: new Set<string>(),
      };

    const value = resolveAgencyRewardItemAmount(item);

    addToBucket(acc.total, item, value);

    const monthBucket = acc.byMonth.get(item.target_month) ?? createBucket();
    addToBucket(monthBucket, item, value);
    acc.byMonth.set(item.target_month, monthBucket);

    const pairKey = `${item.target_month}:${item.creator_id}`;
    const pairBucket = acc.byCreatorMonth.get(pairKey) ?? createBucket();
    addToBucket(pairBucket, item, value);
    acc.byCreatorMonth.set(pairKey, pairBucket);

    if (item.is_paid) {
      if (item.paid_at && (!acc.lastPaidAt || item.paid_at > acc.lastPaidAt)) {
        acc.lastPaidAt = item.paid_at;
      }
    } else {
      if (!acc.latestUnpaidMonth || item.target_month > acc.latestUnpaidMonth) {
        acc.latestUnpaidMonth = item.target_month;
      }
      // 月別確定でない明細は支払前チェックの対象にする
      if (item.agency_source !== "monthly") {
        acc.provisionalUnpaid.push(value);
        acc.provisionalCreators.add(item.creator_id);
      }
    }

    byAgency.set(item.agency_id, acc);
  }

  const rows: AgencyAnnualSummaryRow[] = [];

  for (const [agencyId, acc] of byAgency) {
    const annualRewardAmount = sumAgencyAmounts(acc.total.earned);
    const paidAmount = sumAgencyAmounts(acc.total.paid);
    const state = resolveAgencyAnnualState({ annualRewardAmount, paidAmount });

    const payout = acc.latestUnpaidMonth
      ? payoutByKey.get(`${agencyId}:${acc.latestUnpaidMonth}`) ?? null
      : null;

    const monthlyRows: AgencyMonthlyBreakdownRow[] = [...acc.byMonth.entries()]
      .map(([targetMonth, bucket]) => {
        const rewardAmount = sumAgencyAmounts(bucket.earned);
        const monthPaid = sumAgencyAmounts(bucket.paid);
        return {
          targetMonth,
          commissionBase: roundAgencyAmount(bucket.base),
          creatorRevenueBeforeSplit: roundAgencyAmount(bucket.beforeSplit),
          rewardAmount,
          paidAmount: monthPaid,
          unpaidAmount: roundAgencyAmount(rewardAmount - monthPaid),
          itemCount: bucket.itemCount,
          creatorCount: bucket.creators.size,
          paymentState: resolvePaymentState(rewardAmount, monthPaid),
        };
      })
      .sort((a, b) => a.targetMonth.localeCompare(b.targetMonth));

    const creatorRows: AgencyCreatorBreakdownRow[] = [...acc.byCreatorMonth.entries()]
      .map(([pairKey, bucket]) => {
        const separator = pairKey.indexOf(":");
        const targetMonth = pairKey.slice(0, separator);
        const creatorId = pairKey.slice(separator + 1);
        const rewardAmount = sumAgencyAmounts(bucket.earned);
        const pairPaid = sumAgencyAmounts(bucket.paid);
        const meta = creatorById.get(creatorId);
        const rates = [...bucket.splitRates];

        return {
          creatorId,
          creatorName: meta?.creatorName ?? "—",
          tiktokId: meta?.tiktokId ?? "",
          targetMonth,
          commissionBase: roundAgencyAmount(bucket.base),
          creatorRevenueBeforeSplit: roundAgencyAmount(bucket.beforeSplit),
          agencySplitRate: rates.length === 1 ? rates[0] : Math.max(...rates, 0),
          rewardAmount,
          paidAmount: pairPaid,
          unpaidAmount: roundAgencyAmount(rewardAmount - pairPaid),
          itemCount: bucket.itemCount,
          assignmentState: ([...bucket.sources][0] as AgencyAssignmentState) ?? "none",
          paymentState: resolvePaymentState(rewardAmount, pairPaid),
        };
      })
      .sort(
        (a, b) =>
          a.targetMonth.localeCompare(b.targetMonth) || b.rewardAmount - a.rewardAmount,
      );

    rows.push({
      agencyId,
      agencyName: agencyNameById.get(agencyId) ?? "（削除済み代理店）",
      annualRewardAmount,
      annualCommissionBase: roundAgencyAmount(acc.total.base),
      paidAmount,
      unpaidAmount: state.unpaidAmount,
      payableAmount: state.payableAmount,
      isPayable: state.isPayable,
      latestUnpaidMonth: acc.latestUnpaidMonth,
      lastPaidAt: acc.lastPaidAt,
      creatorCount: acc.total.creators.size,
      itemCount: acc.total.itemCount,
      usesCurrentAgencyFallback: acc.total.sources.has("current"),
      provisionalUnpaidAmount: sumAgencyAmounts(acc.provisionalUnpaid),
      provisionalCreatorCount: acc.provisionalCreators.size,
      hasUnconfirmedAssignment: acc.provisionalUnpaid.length > 0,
      payoutId: payout?.id ?? null,
      payoutStatus: payout?.status ?? null,
      monthlyRows,
      creatorRows,
    });
  }

  rows.sort(
    (a, b) => b.unpaidAmount - a.unpaidAmount || b.annualRewardAmount - a.annualRewardAmount,
  );

  history.sort(
    (a, b) => (b.paidAt ?? "").localeCompare(a.paidAt ?? "") || b.targetMonth.localeCompare(a.targetMonth),
  );

  return {
    year,
    rows,
    reviewRows: reviewResult.data as AgencyReviewRow[],
    history,
    totals: {
      annualRewardAmount: sumAgencyAmounts(rows.map((r) => r.annualRewardAmount)),
      paidAmount: sumAgencyAmounts(rows.map((r) => r.paidAmount)),
      unpaidAmount: sumAgencyAmounts(rows.map((r) => r.unpaidAmount)),
      payableAmount: sumAgencyAmounts(rows.map((r) => r.payableAmount)),
      agencyCount: rows.length,
      payableAgencyCount: rows.filter((r) => r.isPayable).length,
      itemCount: rows.reduce((sum, r) => sum + r.itemCount, 0),
      confirmedUnpaidAmount: sumAgencyAmounts(
        rows.map((r) => roundAgencyAmount(r.unpaidAmount - r.provisionalUnpaidAmount)),
      ),
      provisionalUnpaidAmount: sumAgencyAmounts(
        rows.map((r) => r.provisionalUnpaidAmount),
      ),
    },
    error: null,
  };
}

/**
 * 支払対象外だが要確認のクリエイター。
 * 代理店未設定なのに TikTok 側で分配率が付いている明細を拾う。
 * 勝手に代理店を割り当てず、警告として表示するためだけに使う。
 */
async function fetchAgencyReviewRows(
  supabase: SupabaseClient,
  year: string,
): Promise<{ data: AgencyReviewRow[]; error: string | null }> {
  const [linesResult, creatorsResult, monthlyResult] = await Promise.all([
    fetchAllFrom<{
      creator_id: string | null;
      target_month: string | null;
      commission_base: number | string | null;
      agency_split_rate: number | string | null;
      agency_revenue: number | string | null;
      order_status: string | null;
      payment_status: string | null;
      refund_status: string | null;
    }>(
      supabase,
      "affiliate_order_lines",
      "creator_id, target_month, commission_base, agency_split_rate, agency_revenue, order_status, payment_status, refund_status",
      (query) =>
        query
          .gte("target_month", `${year}-01`)
          .lte("target_month", `${year}-12`)
          .gt("agency_split_rate", 0),
    ),
    supabase.from("creators").select("id, creator_name, tiktok_id, agency_id"),
    supabase
      .from("creator_monthly_agency_assignments")
      .select("creator_id, target_month, agency_id")
      .gte("target_month", `${year}-01`)
      .lte("target_month", `${year}-12`),
  ]);

  const error =
    linesResult.error ??
    creatorsResult.error?.message ??
    monthlyResult.error?.message ??
    null;

  if (error) {
    return { data: [], error };
  }

  const creatorById = new Map(
    (creatorsResult.data ?? []).map((row) => [
      row.id as string,
      {
        creatorName: String(row.creator_name ?? "—"),
        tiktokId: String(row.tiktok_id ?? ""),
        agencyId: (row.agency_id as string | null) ?? null,
      },
    ]),
  );

  const monthlyByKey = new Set(
    (monthlyResult.data ?? [])
      .filter((row) => row.agency_id != null)
      .map((row) => `${row.creator_id as string}:${row.target_month as string}`),
  );

  const byCreator = new Map<string, AgencyReviewRow & { months: Set<string> }>();

  for (const line of linesResult.data) {
    const creatorId = line.creator_id;
    const targetMonth = line.target_month;
    if (!creatorId || !targetMonth) continue;

    // 支払対象と同じ条件（AU「支払い状況」= 支払い済み）で判定する
    if (!isAgencyPayoutEligibleOrderLine(line)) continue;

    const creator = creatorById.get(creatorId);
    if (!creator) continue;

    // 月別確定または現在所属で代理店が決まっていれば要確認ではない
    if (monthlyByKey.has(`${creatorId}:${targetMonth}`)) continue;
    if (creator.agencyId) continue;

    const current =
      byCreator.get(creatorId) ??
      {
        creatorId,
        creatorName: creator.creatorName,
        tiktokId: creator.tiktokId,
        targetMonths: [] as string[],
        months: new Set<string>(),
        commissionBase: 0,
        agencySplitRate: toAmount(line.agency_split_rate),
        unassignedAgencyRevenue: 0,
        itemCount: 0,
        reason: "no_agency_with_split" as const,
      };

    current.months.add(targetMonth);
    current.commissionBase += toAmount(line.commission_base);
    current.unassignedAgencyRevenue += toAmount(line.agency_revenue);
    current.itemCount += 1;
    byCreator.set(creatorId, current);
  }

  const data: AgencyReviewRow[] = [...byCreator.values()]
    .map(({ months, ...row }) => ({
      ...row,
      targetMonths: [...months].sort(),
      commissionBase: roundAgencyAmount(row.commissionBase),
      unassignedAgencyRevenue: roundAgencyAmount(row.unassignedAgencyRevenue),
    }))
    .sort((a, b) => b.unassignedAgencyRevenue - a.unassignedAgencyRevenue);

  return { data, error: null };
}
