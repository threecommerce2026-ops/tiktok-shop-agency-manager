import type { SupabaseClient } from "@supabase/supabase-js";
import { agencyRewardFromRevenue } from "@/lib/revenue/calc";
import { currentMonthKey, type MonthlyTrendPoint } from "@/lib/db/dashboard-queries";

export type AgencyRankingRow = {
  rank: number;
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
  monthlyTrend: MonthlyTrendPoint[];
  agencyRanking: AgencyRankingRow[];
  dbError: string | null;
};

export async function fetchAgencyRanking(
  supabase: SupabaseClient,
): Promise<AgencyRankingData> {
  const month = currentMonthKey();
  const empty: AgencyRankingData = {
    month,
    rows: [],
    dbError: null,
  };

  const [{ data: agencies, error: agenciesError }, { data: creators, error: creatorsError }, { data: imports, error: importsError }] =
    await Promise.all([
      supabase.from("agencies").select("id, name").order("name"),
      supabase.from("creators").select("id, agency_id"),
      supabase
        .from("sales_imports")
        .select(
          `
          agency_id,
          creator_id,
          target_month,
          sales_amount,
          profit_amount,
          creators ( commission_rate )
        `,
        )
        .eq("target_month", month),
    ]);

  if (agenciesError || creatorsError || importsError) {
    return {
      ...empty,
      dbError: agenciesError?.message ?? creatorsError?.message ?? importsError?.message ?? null,
    };
  }

  const creatorsByAgency = new Map<string, Set<string>>();
  for (const creator of creators ?? []) {
    const agencyId = creator.agency_id as string;
    const set = creatorsByAgency.get(agencyId) ?? new Set<string>();
    set.add(creator.id as string);
    creatorsByAgency.set(agencyId, set);
  }

  const agencyMonth = new Map<
    string,
    {
      sales: number;
      profit: number;
      reward: number;
      activeIds: Set<string>;
    }
  >();

  for (const row of imports ?? []) {
    const agencyId = row.agency_id as string;
    const creatorId = row.creator_id as string;
    const sales = Number(row.sales_amount);
    const profit = Number(row.profit_amount);
    const creatorsJoin = row.creators as
      | { commission_rate: number }
      | { commission_rate: number }[]
      | null;
    const creator = Array.isArray(creatorsJoin) ? creatorsJoin[0] : creatorsJoin;
    const reward = agencyRewardFromRevenue(profit, Number(creator?.commission_rate ?? 0));

    const agencyAgg = agencyMonth.get(agencyId) ?? {
      sales: 0,
      profit: 0,
      reward: 0,
      activeIds: new Set<string>(),
    };
    agencyAgg.sales += sales;
    agencyAgg.profit += profit;
    agencyAgg.reward += reward;
    if (sales > 0 || profit > 0) agencyAgg.activeIds.add(creatorId);
    agencyMonth.set(agencyId, agencyAgg);
  }

  const rows = (agencies ?? [])
    .map((agency) => {
      const agencyId = agency.id as string;
      const value = agencyMonth.get(agencyId) ?? {
        sales: 0,
        profit: 0,
        reward: 0,
        activeIds: new Set<string>(),
      };
      return {
        agencyId,
        agencyName: agency.name as string,
        salesMonth: value.sales,
        profitMonth: value.profit,
        rewardMonth: value.reward,
        creatorCount: creatorsByAgency.get(agencyId)?.size ?? 0,
        activeCreatorCount: value.activeIds.size,
        rank: 0,
      };
    })
    .sort((a, b) => b.profitMonth - a.profitMonth)
    .map((row, index) => ({ ...row, rank: index + 1 }));

  return { month, rows, dbError: null };
}

export async function fetchAdminDashboardData(
  supabase: SupabaseClient,
): Promise<AdminDashboardData> {
  const month = currentMonthKey();
  const empty: AdminDashboardData = {
    month,
    totalSales: 0,
    totalProfit: 0,
    totalReward: 0,
    agencyCount: 0,
    creatorCount: 0,
    monthlyTrend: [],
    agencyRanking: [],
    dbError: null,
  };

  const [{ data: agencies, error: agenciesError }, { data: creators, error: creatorsError }, { data: imports, error: importsError }] =
    await Promise.all([
      supabase.from("agencies").select("id, name"),
      supabase.from("creators").select("id, agency_id"),
      supabase
        .from("sales_imports")
        .select(
          `
          agency_id,
          creator_id,
          target_month,
          sales_amount,
          profit_amount,
          creators ( commission_rate )
        `,
        ),
    ]);

  if (agenciesError || creatorsError || importsError) {
    return {
      ...empty,
      dbError: agenciesError?.message ?? creatorsError?.message ?? importsError?.message ?? null,
    };
  }

  const agencyNameById = new Map(
    (agencies ?? []).map((agency) => [agency.id as string, agency.name as string]),
  );
  const creatorsByAgency = new Map<string, Set<string>>();
  for (const creator of creators ?? []) {
    const agencyId = creator.agency_id as string;
    const set = creatorsByAgency.get(agencyId) ?? new Set<string>();
    set.add(creator.id as string);
    creatorsByAgency.set(agencyId, set);
  }

  const byMonth = new Map<string, { sales: number; profit: number; reward: number }>();
  const agencyMonth = new Map<
    string,
    {
      sales: number;
      profit: number;
      reward: number;
      activeIds: Set<string>;
    }
  >();

  let totalSales = 0;
  let totalProfit = 0;
  let totalReward = 0;

  for (const row of imports ?? []) {
    const agencyId = row.agency_id as string;
    const creatorId = row.creator_id as string;
    const targetMonth = row.target_month as string;
    const sales = Number(row.sales_amount);
    const profit = Number(row.profit_amount);
    const creatorsJoin = row.creators as
      | { commission_rate: number }
      | { commission_rate: number }[]
      | null;
    const creator = Array.isArray(creatorsJoin) ? creatorsJoin[0] : creatorsJoin;
    const reward = agencyRewardFromRevenue(profit, Number(creator?.commission_rate ?? 0));

    const monthAgg = byMonth.get(targetMonth) ?? { sales: 0, profit: 0, reward: 0 };
    monthAgg.sales += sales;
    monthAgg.profit += profit;
    monthAgg.reward += reward;
    byMonth.set(targetMonth, monthAgg);

    if (targetMonth === month) {
      totalSales += sales;
      totalProfit += profit;
      totalReward += reward;

      const agencyAgg = agencyMonth.get(agencyId) ?? {
        sales: 0,
        profit: 0,
        reward: 0,
        activeIds: new Set<string>(),
      };
      agencyAgg.sales += sales;
      agencyAgg.profit += profit;
      agencyAgg.reward += reward;
      if (sales > 0 || profit > 0) agencyAgg.activeIds.add(creatorId);
      agencyMonth.set(agencyId, agencyAgg);
    }
  }

  const monthsSorted = [...byMonth.keys()].sort((a, b) => b.localeCompare(a));
  const monthlyTrend = monthsSorted
    .slice(0, 12)
    .reverse()
    .map((targetMonth) => {
      const value = byMonth.get(targetMonth)!;
      return {
        month: targetMonth,
        sales: value.sales,
        profit: value.profit,
        reward: value.reward,
      };
    });

  const ranking = [...agencyMonth.entries()]
    .map(([agencyId, value]) => ({
      agencyId,
      agencyName: agencyNameById.get(agencyId) ?? "—",
      salesMonth: value.sales,
      profitMonth: value.profit,
      rewardMonth: value.reward,
      creatorCount: creatorsByAgency.get(agencyId)?.size ?? 0,
      activeCreatorCount: value.activeIds.size,
    }))
    .sort((a, b) => b.salesMonth - a.salesMonth)
    .map((row, index) => ({ ...row, rank: index + 1 }));

  return {
    month,
    totalSales,
    totalProfit,
    totalReward,
    agencyCount: agencies?.length ?? 0,
    creatorCount: creators?.length ?? 0,
    monthlyTrend,
    agencyRanking: ranking,
    dbError: null,
  };
}
