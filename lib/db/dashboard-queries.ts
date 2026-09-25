import type { SupabaseClient } from "@supabase/supabase-js";

import { fetchCreatorMonthlyFinance } from "@/lib/db/creator-monthly-finance-queries";

export function currentMonthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export type MonthlyTrendPoint = {
  month: string;
  sales: number;
  profit: number;
  reward: number;
};

export type DashboardData = {
  agencyName: string;
  month: string;
  totalSales: number;
  totalProfit: number;
  totalReward: number;
  creatorCount: number;
  activeCreatorCount: number;
  monthlyTrend: MonthlyTrendPoint[];
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

export async function fetchDashboardData(
  supabase: SupabaseClient,
  adminSupabase: SupabaseClient,
  agencyId: string,
  agencyName: string,
): Promise<DashboardData> {
  const month = currentMonthKey();

  const empty: DashboardData = {
    agencyName,
    month,
    totalSales: 0,
    totalProfit: 0,
    totalReward: 0,
    creatorCount: 0,
    activeCreatorCount: 0,
    monthlyTrend: [],
    dbError: null,
  };

  const { data: creators, error: creatorsError } = await supabase
    .from("creators")
    .select("id")
    .eq("agency_id", agencyId);

  if (creatorsError) {
    return { ...empty, dbError: creatorsError.message };
  }

  const months = monthKeys(12);

  const financeResults = await Promise.all(
    months.map((targetMonth) =>
      fetchCreatorMonthlyFinance(adminSupabase, targetMonth),
    ),
  );

  const failed = financeResults.find((result) => result.error);

  if (failed?.error) {
    return { ...empty, dbError: failed.error };
  }

  const monthlyTrend: MonthlyTrendPoint[] = financeResults.map(
    (result, index) => {
      const agencyRows = result.rows.filter(
        (row) => row.agencyId === agencyId && !row.isInHouse,
      );

      return {
        month: months[index],
        sales: agencyRows.reduce((sum, row) => sum + row.capGmv, 0),
        profit: agencyRows.reduce((sum, row) => sum + row.capRevenue, 0),
        reward: agencyRows.reduce((sum, row) => sum + row.agencyPayout, 0),
      };
    },
  );

  const currentRows =
    financeResults[financeResults.length - 1]?.rows.filter(
      (row) => row.agencyId === agencyId && !row.isInHouse,
    ) ?? [];

  const activeCreatorIds = new Set(
    currentRows
      .filter(
        (row) =>
          row.capGmv > 0 ||
          row.capRevenue > 0 ||
          row.tapRevenue > 0 ||
          row.agencyPayout > 0,
      )
      .map((row) => row.creatorId),
  );

  return {
    agencyName,
    month,
    totalSales: currentRows.reduce((sum, row) => sum + row.capGmv, 0),
    totalProfit: currentRows.reduce((sum, row) => sum + row.capRevenue, 0),
    totalReward: currentRows.reduce((sum, row) => sum + row.agencyPayout, 0),
    creatorCount: creators?.length ?? 0,
    activeCreatorCount: activeCreatorIds.size,
    monthlyTrend,
    dbError: null,
  };
}
