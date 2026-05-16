import type { SupabaseClient } from "@supabase/supabase-js";
import { currentMonthKey } from "@/lib/db/dashboard-queries";
import { agencyRewardFromEligibleProfit } from "@/lib/referrals/calc";
import {
  getOrderRevenueBase,
  isCancelledStatus,
  isPaidPaymentStatus,
  isRefundedStatus,
} from "@/lib/revenue/order-eligibility";

export type AgencyAdminRow = {
  id: string;
  name: string;
  defaultCommissionRate: number;
  isActive: boolean;
  creatorCount: number;
  activeCreatorCount: number;
  paidSalesMonth: number;
  paidProfitMonth: number;
  agencyRewardMonth: number;
};

export type AgencyCreatorRow = {
  id: string;
  creatorName: string;
  tiktokId: string;
  commissionRate: number;
  paidSalesMonth: number;
  paidProfitMonth: number;
  agencyRewardMonth: number;
};

export type AgencyMonthlyRewardRow = {
  targetMonth: string;
  paidSales: number;
  paidProfit: number;
  agencyReward: number;
  activeCreatorCount: number;
};

function isEligibleAgencyOrder(order: {
  payment_status: string | null;
  cancel_status: string | null;
  refund_status: string | null;
}): boolean {
  return (
    isPaidPaymentStatus(order.payment_status) &&
    !isCancelledStatus(order.cancel_status) &&
    !isRefundedStatus(order.refund_status)
  );
}

export async function fetchAgencyAdminRows(
  supabase: SupabaseClient,
  targetMonth: string = currentMonthKey(),
): Promise<{ data: AgencyAdminRow[]; error: string | null }> {
  const [{ data: agencies, error: agenciesError }, { data: creators, error: creatorsError }, { data: orders, error: ordersError }] =
    await Promise.all([
      supabase
        .from("agencies")
        .select("id, name, default_commission_rate, is_active")
        .order("name"),
      supabase.from("creators").select("id, agency_id, commission_rate"),
      supabase
        .from("orders")
        .select(
          "agency_id, creator_id, target_month, order_amount, commission_base, payment_status, cancel_status, refund_status",
        )
        .eq("target_month", targetMonth),
    ]);

  if (agenciesError || creatorsError || ordersError) {
    return {
      data: [],
      error: agenciesError?.message ?? creatorsError?.message ?? ordersError?.message ?? null,
    };
  }

  const creatorsByAgency = new Map<string, Set<string>>();
  const commissionByCreator = new Map<string, number>();
  for (const creator of creators ?? []) {
    const agencyId = creator.agency_id as string | null;
    if (!agencyId) continue;
    const set = creatorsByAgency.get(agencyId) ?? new Set<string>();
    set.add(creator.id as string);
    creatorsByAgency.set(agencyId, set);
    commissionByCreator.set(creator.id as string, Number(creator.commission_rate));
  }

  const metrics = new Map<
    string,
    {
      activeCreatorIds: Set<string>;
      paidSales: number;
      paidProfit: number;
      agencyReward: number;
    }
  >();

  for (const order of orders ?? []) {
    const agencyId = order.agency_id as string | null;
    if (!agencyId || !isEligibleAgencyOrder(order)) {
      continue;
    }

    const creatorId = order.creator_id as string | null;
    const base = getOrderRevenueBase({
      order_amount: Number(order.order_amount),
      commission_base: Number(order.commission_base),
    });
    const reward = agencyRewardFromEligibleProfit(
      base,
      commissionByCreator.get(creatorId ?? "") ?? 0,
    );
    const bucket = metrics.get(agencyId) ?? {
      activeCreatorIds: new Set<string>(),
      paidSales: 0,
      paidProfit: 0,
      agencyReward: 0,
    };
    if (creatorId) {
      bucket.activeCreatorIds.add(creatorId);
    }
    bucket.paidSales += Number(order.order_amount);
    bucket.paidProfit += base;
    bucket.agencyReward += reward;
    metrics.set(agencyId, bucket);
  }

  return {
    data: (agencies ?? []).map((agency) => {
      const agencyId = agency.id as string;
      const bucket = metrics.get(agencyId);
      return {
        id: agencyId,
        name: agency.name as string,
        defaultCommissionRate: Number(agency.default_commission_rate),
        isActive: Boolean(agency.is_active),
        creatorCount: creatorsByAgency.get(agencyId)?.size ?? 0,
        activeCreatorCount: bucket?.activeCreatorIds.size ?? 0,
        paidSalesMonth: bucket?.paidSales ?? 0,
        paidProfitMonth: bucket?.paidProfit ?? 0,
        agencyRewardMonth: bucket?.agencyReward ?? 0,
      };
    }),
    error: null,
  };
}

export async function fetchAgencyCreators(
  supabase: SupabaseClient,
  agencyId: string,
  targetMonth: string = currentMonthKey(),
): Promise<{ data: AgencyCreatorRow[]; error: string | null }> {
  const [{ data: creators, error: creatorsError }, { data: orders, error: ordersError }] =
    await Promise.all([
      supabase
        .from("creators")
        .select("id, creator_name, tiktok_id, commission_rate")
        .eq("agency_id", agencyId)
        .order("creator_name"),
      supabase
        .from("orders")
        .select(
          "creator_id, order_amount, commission_base, payment_status, cancel_status, refund_status",
        )
        .eq("agency_id", agencyId)
        .eq("target_month", targetMonth),
    ]);

  if (creatorsError || ordersError) {
    return { data: [], error: creatorsError?.message ?? ordersError?.message ?? null };
  }

  const metrics = new Map<string, { sales: number; profit: number; reward: number }>();
  for (const creator of creators ?? []) {
    metrics.set(creator.id as string, { sales: 0, profit: 0, reward: 0 });
  }

  for (const order of orders ?? []) {
    const creatorId = order.creator_id as string | null;
    if (!creatorId || !metrics.has(creatorId) || !isEligibleAgencyOrder(order)) {
      continue;
    }
    const creator = creators?.find((row) => row.id === creatorId);
    const base = getOrderRevenueBase({
      order_amount: Number(order.order_amount),
      commission_base: Number(order.commission_base),
    });
    const reward = agencyRewardFromEligibleProfit(base, Number(creator?.commission_rate ?? 0));
    const bucket = metrics.get(creatorId)!;
    bucket.sales += Number(order.order_amount);
    bucket.profit += base;
    bucket.reward += reward;
  }

  return {
    data: (creators ?? []).map((creator) => {
      const bucket = metrics.get(creator.id as string)!;
      return {
        id: creator.id as string,
        creatorName: creator.creator_name as string,
        tiktokId: creator.tiktok_id as string,
        commissionRate: Number(creator.commission_rate),
        paidSalesMonth: bucket.sales,
        paidProfitMonth: bucket.profit,
        agencyRewardMonth: bucket.reward,
      };
    }),
    error: null,
  };
}

export async function fetchAgencyMonthlyRewards(
  supabase: SupabaseClient,
  agencyId: string,
): Promise<{ data: AgencyMonthlyRewardRow[]; error: string | null }> {
  const [{ data: creators, error: creatorsError }, { data: orders, error: ordersError }] =
    await Promise.all([
      supabase.from("creators").select("id, commission_rate").eq("agency_id", agencyId),
      supabase
        .from("orders")
        .select(
          "creator_id, target_month, order_amount, commission_base, payment_status, cancel_status, refund_status",
        )
        .eq("agency_id", agencyId),
    ]);

  if (creatorsError || ordersError) {
    return { data: [], error: creatorsError?.message ?? ordersError?.message ?? null };
  }

  const commissionByCreator = new Map<string, number>();
  for (const creator of creators ?? []) {
    commissionByCreator.set(creator.id as string, Number(creator.commission_rate));
  }

  const metrics = new Map<
    string,
    { sales: number; profit: number; reward: number; activeCreatorIds: Set<string> }
  >();

  for (const order of orders ?? []) {
    if (!isEligibleAgencyOrder(order)) continue;
    const month = order.target_month as string;
    const creatorId = order.creator_id as string | null;
    const base = getOrderRevenueBase({
      order_amount: Number(order.order_amount),
      commission_base: Number(order.commission_base),
    });
    const reward = agencyRewardFromEligibleProfit(
      base,
      commissionByCreator.get(creatorId ?? "") ?? 0,
    );
    const bucket = metrics.get(month) ?? {
      sales: 0,
      profit: 0,
      reward: 0,
      activeCreatorIds: new Set<string>(),
    };
    if (creatorId) bucket.activeCreatorIds.add(creatorId);
    bucket.sales += Number(order.order_amount);
    bucket.profit += base;
    bucket.reward += reward;
    metrics.set(month, bucket);
  }

  return {
    data: [...metrics.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([targetMonth, bucket]) => ({
        targetMonth,
        paidSales: bucket.sales,
        paidProfit: bucket.profit,
        agencyReward: bucket.reward,
        activeCreatorCount: bucket.activeCreatorIds.size,
      })),
    error: null,
  };
}
