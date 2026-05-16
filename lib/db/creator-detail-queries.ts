import type { SupabaseClient } from "@supabase/supabase-js";
import { agencyRewardFromRevenue } from "@/lib/revenue/calc";
import { currentMonthKey } from "@/lib/db/dashboard-queries";

export type CreatorMonthlyPoint = {
  month: string;
  sales: number;
  profit: number;
};

export type CreatorImportHistoryRow = {
  id: string;
  created_at: string;
  target_month: string;
  sales_amount: number;
  profit_amount: number;
  order_count: number;
};

export type CreatorDetail = {
  id: string;
  creator_name: string;
  tiktok_id: string;
  agency_id: string;
  agency_name: string;
  commission_rate: number;
  salesMonth: number;
  salesTotal: number;
  profitMonth: number;
  profitTotal: number;
  rewardMonth: number;
  rewardTotal: number;
  monthlySalesTrend: CreatorMonthlyPoint[];
  monthlyProfitTrend: CreatorMonthlyPoint[];
  importHistory: CreatorImportHistoryRow[];
  lastUpdatedAt: string | null;
};

export async function fetchCreatorDetail(
  supabase: SupabaseClient,
  creatorId: string,
): Promise<{ data: CreatorDetail | null; error: string | null }> {
  const month = currentMonthKey();

  const { data: creator, error: creatorError } = await supabase
    .from("creators")
    .select(
      `
      id,
      creator_name,
      tiktok_id,
      agency_id,
      commission_rate,
      created_at,
      agencies ( name )
    `,
    )
    .eq("id", creatorId)
    .maybeSingle();

  if (creatorError) {
    return { data: null, error: creatorError.message };
  }
  if (!creator) {
    return { data: null, error: null };
  }

  const agencies = creator.agencies as { name: string } | { name: string }[] | null;
  const agency = Array.isArray(agencies) ? agencies[0] : agencies;

  const { data: imports, error: importsError } = await supabase
    .from("sales_imports")
    .select("id, created_at, target_month, sales_amount, profit_amount, order_count")
    .eq("creator_id", creatorId)
    .order("target_month", { ascending: false });

  if (importsError) {
    return { data: null, error: importsError.message };
  }

  const byMonth = new Map<string, { sales: number; profit: number }>();
  let salesMonth = 0;
  let salesTotal = 0;
  let profitMonth = 0;
  let profitTotal = 0;
  let lastUpdatedAt: string | null = null;

  const importHistory: CreatorImportHistoryRow[] = (imports ?? []).map((row) => {
    const sales = Number(row.sales_amount);
    const profit = Number(row.profit_amount);
    const targetMonth = row.target_month as string;
    const createdAt = row.created_at as string;
    if (!lastUpdatedAt || createdAt > lastUpdatedAt) lastUpdatedAt = createdAt;

    salesTotal += sales;
    profitTotal += profit;
    if (targetMonth === month) {
      salesMonth += sales;
      profitMonth += profit;
    }

    const monthAgg = byMonth.get(targetMonth) ?? { sales: 0, profit: 0 };
    monthAgg.sales += sales;
    monthAgg.profit += profit;
    byMonth.set(targetMonth, monthAgg);

    return {
      id: row.id as string,
      created_at: createdAt,
      target_month: targetMonth,
      sales_amount: sales,
      profit_amount: profit,
      order_count: Number(row.order_count),
    };
  });

  const monthsSorted = [...byMonth.keys()].sort((a, b) => a.localeCompare(b));
  const monthlySalesTrend = monthsSorted.map((targetMonth) => {
    const value = byMonth.get(targetMonth)!;
    return { month: targetMonth, sales: value.sales, profit: value.profit };
  });
  const monthlyProfitTrend = monthlySalesTrend.map((point) => ({
    month: point.month,
    sales: point.sales,
    profit: point.profit,
  }));

  const rate = Number(creator.commission_rate);

  return {
    data: {
      id: creator.id as string,
      creator_name: creator.creator_name as string,
      tiktok_id: creator.tiktok_id as string,
      agency_id: creator.agency_id as string,
      agency_name: agency?.name ?? "—",
      commission_rate: rate,
      salesMonth,
      salesTotal,
      profitMonth,
      profitTotal,
      rewardMonth: agencyRewardFromRevenue(profitMonth, rate),
      rewardTotal: agencyRewardFromRevenue(profitTotal, rate),
      monthlySalesTrend,
      monthlyProfitTrend,
      importHistory,
      lastUpdatedAt,
    },
    error: null,
  };
}
