import type { SupabaseClient } from "@supabase/supabase-js";
import { agencyRewardFromRevenue } from "@/lib/revenue/calc";
import { currentMonthKey } from "@/lib/db/dashboard-queries";

function unwrapCreator<T extends Record<string, unknown>>(v: unknown): T | null {
  if (!v) return null;
  if (Array.isArray(v)) return (v[0] as T) ?? null;
  return v as T;
}

export type UploadHistoryRow = {
  id: string;
  created_at: string;
  target_month: string;
  sales_amount: number;
  profit_amount: number;
  order_count: number;
  creator_name: string;
  tiktok_id: string;
};

export async function fetchUploadHistory(
  supabase: SupabaseClient,
  agencyId: string,
  limit = 40,
): Promise<{ data: UploadHistoryRow[]; error: string | null }> {
  const { data, error } = await supabase
    .from("sales_imports")
    .select(
      `
      id,
      created_at,
      target_month,
      sales_amount,
      profit_amount,
      order_count,
      creators ( creator_name, tiktok_id )
    `,
    )
    .eq("agency_id", agencyId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    return { data: [], error: error.message };
  }

  const rows = (data ?? []).map((r) => {
    const c = unwrapCreator<{ creator_name: string; tiktok_id: string }>(r.creators);
    return {
      id: r.id as string,
      created_at: r.created_at as string,
      target_month: r.target_month as string,
      sales_amount: Number(r.sales_amount),
      profit_amount: Number(r.profit_amount),
      order_count: Number(r.order_count),
      creator_name: c?.creator_name ?? "",
      tiktok_id: c?.tiktok_id ?? "",
    };
  });

  return { data: rows, error: null };
}

export type RankingRow = {
  creator_id: string;
  creator_name: string;
  tiktok_id: string;
  sales: number;
  profit: number;
  reward: number;
};

export async function fetchMonthlyRanking(
  supabase: SupabaseClient,
  agencyId?: string | null,
  month = currentMonthKey(),
): Promise<{ data: RankingRow[]; error: string | null }> {
  let query = supabase
    .from("sales_imports")
    .select(
      `
      creator_id,
      sales_amount,
      profit_amount,
      creators ( creator_name, tiktok_id, commission_rate )
    `,
    )
    .eq("target_month", month);

  if (agencyId) {
    query = query.eq("agency_id", agencyId);
  }

  const { data, error } = await query;

  if (error) {
    return { data: [], error: error.message };
  }

  const rows: RankingRow[] = (data ?? []).map((r) => {
    const c = unwrapCreator<{
      creator_name: string;
      tiktok_id: string;
      commission_rate: number;
    }>(r.creators);
    const profit = Number(r.profit_amount);
    const rate = Number(c?.commission_rate ?? 0);
    return {
      creator_id: r.creator_id as string,
      creator_name: c?.creator_name ?? "",
      tiktok_id: c?.tiktok_id ?? "",
      sales: Number(r.sales_amount),
      profit,
      reward: agencyRewardFromRevenue(profit, rate),
    };
  });

  rows.sort((a, b) => b.sales - a.sales);
  return { data: rows, error: null };
}

export type MonthSummaryRow = {
  month: string;
  sales: number;
  profit: number;
  reward: number;
  orders: number;
};

export async function fetchMonthSummaries(
  supabase: SupabaseClient,
  agencyId?: string | null,
): Promise<{ data: MonthSummaryRow[]; error: string | null }> {
  let query = supabase.from("sales_imports").select(
    `
      target_month,
      sales_amount,
      profit_amount,
      order_count,
      creators ( commission_rate )
    `,
  );

  if (agencyId) {
    query = query.eq("agency_id", agencyId);
  }

  const { data, error } = await query;

  if (error) {
    return { data: [], error: error.message };
  }

  const map = new Map<string, MonthSummaryRow>();

  for (const r of data ?? []) {
    const m = r.target_month as string;
    const cur = map.get(m) ?? {
      month: m,
      sales: 0,
      profit: 0,
      reward: 0,
      orders: 0,
    };
    const sales = Number(r.sales_amount);
    const profit = Number(r.profit_amount);
    const rate = Number(
      unwrapCreator<{ commission_rate: number }>(r.creators)?.commission_rate ?? 0,
    );
    cur.sales += sales;
    cur.profit += profit;
    cur.reward += agencyRewardFromRevenue(profit, rate);
    cur.orders += Number(r.order_count);
    map.set(m, cur);
  }

  const list = [...map.values()].sort((a, b) => b.month.localeCompare(a.month));
  return { data: list, error: null };
}
