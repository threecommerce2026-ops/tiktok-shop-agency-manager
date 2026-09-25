import type { SupabaseClient } from "@supabase/supabase-js";

import {
  fetchCreatorMonthlyFinance,
  type CreatorMonthlyFinanceRow,
} from "@/lib/db/creator-monthly-finance-queries";

import {
  currentMonthKey,
  type MonthlyTrendPoint,
} from "@/lib/db/dashboard-queries";

export type AgencyRankingRow = {
  rank: number | null;
  agencyId: string;
  agencyName: string;
  salesMonth: number;
  profitMonth: number;
  rewardMonth: number;
  creatorCount: number;
  activeCreatorCount: number;
};

export type AgencyRankingData = {
  month: string;
  rows: AgencyRankingRow[];
  dbError: string | null;
};

export type AdminDashboardData = {
  month: string;
  totalSales: number;
  totalProfit: number;
  totalReward: number;
  agencyCount: number;
  creatorCount: number;
  sellerCount: number;
  /** 今月発生した紹介者報酬 */
  referralRewardMonth: number;
  /** 紹介者報酬の未払残高（全期間） */
  referralUnpaidBalance: number;
  monthlyTrend: MonthlyTrendPoint[];
  agencyRanking: AgencyRankingRow[];
  dbError: string | null;
};

function monthKeys(count: number, base = new Date()) {
  const result: string[] = [];

  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(base.getFullYear(), base.getMonth() - i, 1);
    result.push(currentMonthKey(d));
  }

  return result;
}

function isActiveFinanceRow(row: CreatorMonthlyFinanceRow) {
  return (
    row.capGmv > 0 ||
    row.capRevenue > 0 ||
    row.tapRevenue > 0 ||
    row.agencyPayout > 0
  );
}

function buildAgencyRanking(
  agencies: Array<{ id: string; name: string }>,
  creators: Array<{ id: string; agency_id: string | null }>,
  financeRows: CreatorMonthlyFinanceRow[],
): AgencyRankingRow[] {
  const creatorsByAgency = new Map<string, Set<string>>();

  for (const creator of creators) {
    if (!creator.agency_id) continue;

    const set =
      creatorsByAgency.get(creator.agency_id) ?? new Set<string>();

    set.add(creator.id);
    creatorsByAgency.set(creator.agency_id, set);
  }

  return agencies
    .map((agency) => {
      const agencyRows = financeRows.filter(
        (row) => row.agencyId === agency.id,
      );

      const activeCreatorIds = new Set(
        agencyRows
          .filter(isActiveFinanceRow)
          .map((row) => row.creatorId),
      );

      return {
        rank: null,
        agencyId: agency.id,
        agencyName: agency.name,
        salesMonth: agencyRows.reduce(
          (sum, row) => sum + row.capGmv,
          0,
        ),
        profitMonth: agencyRows.reduce(
          (sum, row) => sum + row.capRevenue,
          0,
        ),
        rewardMonth: agencyRows.reduce(
          (sum, row) => sum + row.agencyPayout,
          0,
        ),
        creatorCount:
          creatorsByAgency.get(agency.id)?.size ?? 0,
        activeCreatorCount: activeCreatorIds.size,
      };
    })
    .sort((a, b) => {
      if (b.profitMonth !== a.profitMonth) {
        return b.profitMonth - a.profitMonth;
      }

      if (b.salesMonth !== a.salesMonth) {
        return b.salesMonth - a.salesMonth;
      }

      return a.agencyName.localeCompare(b.agencyName, "ja");
    })
    .map((row, index) => ({
      ...row,
      rank: row.profitMonth > 0 ? index + 1 : null,
    }));
}

export async function fetchAgencyRanking(
  supabase: SupabaseClient,
  financeSupabase: SupabaseClient = supabase,
  targetMonth?: string,
): Promise<AgencyRankingData> {
  const month = targetMonth ?? currentMonthKey();

  const empty: AgencyRankingData = {
    month,
    rows: [],
    dbError: null,
  };

  const [
    { data: agencies, error: agenciesError },
    { data: creators, error: creatorsError },
    finance,
  ] = await Promise.all([
    supabase
      .from("agencies")
      .select("id, name")
      .order("name"),
    supabase
      .from("creators")
      .select("id, agency_id"),
    fetchCreatorMonthlyFinance(financeSupabase, month),
  ]);

  if (agenciesError || creatorsError || finance.error) {
    return {
      ...empty,
      dbError:
        agenciesError?.message ??
        creatorsError?.message ??
        finance.error ??
        null,
    };
  }

  const rows = buildAgencyRanking(
    (agencies ?? []) as Array<{
      id: string;
      name: string;
    }>,
    (creators ?? []) as Array<{
      id: string;
      agency_id: string | null;
    }>,
    finance.rows,
  );

  return {
    month,
    rows,
    dbError: null,
  };
}

export async function fetchAdminDashboardData(
  supabase: SupabaseClient,
  financeSupabase: SupabaseClient = supabase,
): Promise<AdminDashboardData> {
  const month = currentMonthKey();

  const empty: AdminDashboardData = {
    month,
    totalSales: 0,
    totalProfit: 0,
    totalReward: 0,
    agencyCount: 0,
    creatorCount: 0,
    sellerCount: 0,
    referralRewardMonth: 0,
    referralUnpaidBalance: 0,
    monthlyTrend: [],
    agencyRanking: [],
    dbError: null,
  };

  const [
    { data: agencies, error: agenciesError },
    { data: creators, error: creatorsError },
    { count: sellerCount },
    unpaidResult,
  ] = await Promise.all([
    supabase
      .from("agencies")
      .select("id, name")
      .order("name"),
    supabase
      .from("creators")
      .select("id, agency_id"),
    supabase
      .from("sellers")
      .select("id", { count: "exact", head: true }),
    supabase
      .from("referral_reward_items")
      .select("reward_amount, adjusted_reward_amount")
      .eq("is_reward_target", true)
      .eq("is_paid", false),
  ]);

  /*
    紹介者報酬の未払残高。
    referral_reward_items が未生成の環境では 0 になる。
  */
  const referralUnpaidBalance =
    Math.round(
      (unpaidResult.data ?? []).reduce((sum, item) => {
        const adjusted = Number(item.adjusted_reward_amount ?? NaN);
        const amount = Number.isFinite(adjusted)
          ? adjusted
          : Number(item.reward_amount ?? 0);
        return sum + (Number.isFinite(amount) ? amount : 0);
      }, 0) * 100,
    ) / 100;

  if (agenciesError || creatorsError) {
    return {
      ...empty,
      dbError:
        agenciesError?.message ??
        creatorsError?.message ??
        null,
    };
  }

  const months = monthKeys(12);

  const financeResults = await Promise.all(
    months.map((targetMonth) =>
      fetchCreatorMonthlyFinance(
        financeSupabase,
        targetMonth,
      ),
    ),
  );

  const failed = financeResults.find(
    (result) => result.error,
  );

  if (failed?.error) {
    return {
      ...empty,
      dbError: failed.error,
    };
  }

  const currentFinance =
    financeResults[financeResults.length - 1];

  const currentRows = currentFinance?.rows ?? [];

  const monthlyTrend: MonthlyTrendPoint[] =
    financeResults.map((result, index) => ({
      month: months[index],
      sales: result.rows.reduce(
        (sum, row) => sum + row.capGmv,
        0,
      ),
      profit: result.rows.reduce(
        (sum, row) => sum + row.capRevenue,
        0,
      ),
      reward: result.rows.reduce(
        (sum, row) => sum + row.agencyPayout,
        0,
      ),
    }));

  const agencyRanking = buildAgencyRanking(
    (agencies ?? []) as Array<{
      id: string;
      name: string;
    }>,
    (creators ?? []) as Array<{
      id: string;
      agency_id: string | null;
    }>,
    currentRows,
  );

  return {
    month,
    totalSales: currentRows.reduce(
      (sum, row) => sum + row.capGmv,
      0,
    ),
    totalProfit: currentRows.reduce(
      (sum, row) => sum + row.capRevenue,
      0,
    ),
    totalReward: currentRows.reduce(
      (sum, row) => sum + row.agencyPayout,
      0,
    ),
    agencyCount: agencies?.length ?? 0,
    creatorCount: creators?.length ?? 0,
    sellerCount: sellerCount ?? 0,
    referralRewardMonth:
      Math.round(
        currentRows.reduce((sum, row) => sum + row.referralReward, 0) * 100,
      ) / 100,
    referralUnpaidBalance,
    monthlyTrend,
    agencyRanking,
    dbError: null,
  };
}
