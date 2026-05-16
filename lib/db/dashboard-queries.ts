import type { SupabaseClient } from "@supabase/supabase-js";
import { aggregateMonthlyOrderTrend } from "@/lib/db/order-metrics";
import { fetchOrderMetricRows } from "@/lib/db/orders-queries";

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

export async function fetchDashboardData(
  supabase: SupabaseClient,
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

  const { data: creators, error: e2 } = await supabase
    .from("creators")
    .select("id, commission_rate")
    .eq("agency_id", agencyId);

  if (e2) {
    return { ...empty, dbError: e2.message };
  }

  const ordersResult = await fetchOrderMetricRows(supabase, { agencyId });
  if (ordersResult.error) {
    return { ...empty, dbError: ordersResult.error };
  }

  const commissionRateByCreator = new Map<string, number>();
  for (const creator of creators ?? []) {
    commissionRateByCreator.set(
      creator.id as string,
      Number(creator.commission_rate),
    );
  }

  const byMonth = aggregateMonthlyOrderTrend(
    ordersResult.data,
    commissionRateByCreator,
  );

  const creatorIds = new Set((creators ?? []).map((c) => c.id as string));
  const activeIds = new Set<string>();

  let totalSalesMonth = 0;
  let totalProfitMonth = 0;
  let totalRewardMonth = 0;

  for (const order of ordersResult.data) {
    if (!order.creator_id || !creatorIds.has(order.creator_id)) continue;
    if (order.target_month === month) {
      totalSalesMonth += Number(order.order_amount);
    }
  }

  const current = byMonth.get(month);
  if (current) {
    totalProfitMonth = current.profit;
    totalRewardMonth = current.reward;
  }

  for (const order of ordersResult.data) {
    if (!order.creator_id || order.target_month !== month) continue;
    if (Number(order.order_amount) > 0) {
      activeIds.add(order.creator_id);
    }
  }

  const monthsSorted = [...byMonth.keys()].sort((a, b) => b.localeCompare(a));
  const take = monthsSorted.slice(0, 12).reverse();
  const monthlyTrend: MonthlyTrendPoint[] = take.map((m) => {
    const v = byMonth.get(m)!;
    return { month: m, sales: v.sales, profit: v.profit, reward: v.reward };
  });

  return {
    agencyName,
    month,
    totalSales: totalSalesMonth,
    totalProfit: totalProfitMonth,
    totalReward: totalRewardMonth,
    creatorCount: creatorIds.size,
    activeCreatorCount: activeIds.size,
    monthlyTrend,
    dbError: null,
  };
}
