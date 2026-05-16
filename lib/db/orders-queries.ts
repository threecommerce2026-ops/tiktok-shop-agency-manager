import type { SupabaseClient } from "@supabase/supabase-js";
import { currentMonthKey } from "@/lib/db/dashboard-queries";
import {
  getOrderRevenueBase,
  isCancelledStatus,
  isOrderEligibleForAgencyReward,
  isPaidPaymentStatus,
  isRefundedStatus,
} from "@/lib/revenue/order-eligibility";
import { agencyRewardFromRevenue } from "@/lib/revenue/calc";

export type OrderListRow = {
  id: string;
  tiktok_order_id: string;
  creator_id: string | null;
  agency_id: string | null;
  agency_name: string | null;
  target_month: string;
  product_name: string | null;
  product_id: string | null;
  sku: string | null;
  order_amount: number;
  commission_base: number;
  payment_status: string | null;
  order_status: string | null;
  shipping_status: string | null;
  cancellation_status: string | null;
  return_status: string | null;
  creator_tiktok_id: string;
  creator_name: string | null;
  ordered_at: string | null;
  paid_at: string | null;
  is_paid: boolean;
  is_cancelled: boolean;
  is_refunded: boolean;
  is_commission_target: boolean;
  reward_eligible: boolean;
  reward_base: number;
  reward_amount: number;
};

export type CreatorPaidOrderSummary = {
  creator_id: string;
  creator_name: string;
  tiktok_id: string;
  paid_sales_month: number;
  reward_profit_month: number;
  reward_amount_month: number;
  order_count_month: number;
};

type CreatorLookupRow = {
  id: string;
  creator_name: string;
  tiktok_id: string;
  agency_id: string | null;
  commission_rate: number;
};

type AgencyLookupRow = {
  id: string;
  name: string;
};

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function normalizeTiktokId(raw: string | null | undefined): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase();
}

async function fetchCreatorsForOrders(
  supabase: SupabaseClient,
  creatorIds: string[],
  fallbackTiktokIds: string[],
): Promise<{
  byId: Map<string, CreatorLookupRow>;
  byTiktokId: Map<string, CreatorLookupRow>;
  error: string | null;
}> {
  const byId = new Map<string, CreatorLookupRow>();
  const byTiktokId = new Map<string, CreatorLookupRow>();

  const rememberCreator = (creator: CreatorLookupRow) => {
    byId.set(creator.id, creator);
    const tiktokKey = normalizeTiktokId(creator.tiktok_id);
    if (tiktokKey) {
      byTiktokId.set(tiktokKey, creator);
    }
  };

  if (creatorIds.length > 0) {
    const { data, error } = await supabase
      .from("creators")
      .select("id, creator_name, tiktok_id, agency_id, commission_rate")
      .in("id", creatorIds);

    if (error) {
      return { byId, byTiktokId, error: error.message };
    }

    for (const row of data ?? []) {
      rememberCreator({
        id: row.id as string,
        creator_name: row.creator_name as string,
        tiktok_id: row.tiktok_id as string,
        agency_id: (row.agency_id as string | null) ?? null,
        commission_rate: Number(row.commission_rate),
      });
    }
  }

  const missingTiktokIds = uniqueStrings(
    fallbackTiktokIds.filter((tiktokId) => !byTiktokId.has(normalizeTiktokId(tiktokId))),
  );
  if (missingTiktokIds.length > 0) {
    const { data, error } = await supabase
      .from("creators")
      .select("id, creator_name, tiktok_id, agency_id, commission_rate")
      .in("tiktok_id", missingTiktokIds);

    if (error) {
      return { byId, byTiktokId, error: error.message };
    }

    for (const row of data ?? []) {
      rememberCreator({
        id: row.id as string,
        creator_name: row.creator_name as string,
        tiktok_id: row.tiktok_id as string,
        agency_id: (row.agency_id as string | null) ?? null,
        commission_rate: Number(row.commission_rate),
      });
    }
  }

  return { byId, byTiktokId, error: null };
}

async function fetchAgenciesByIds(
  supabase: SupabaseClient,
  agencyIds: string[],
): Promise<{ byId: Map<string, AgencyLookupRow>; error: string | null }> {
  const byId = new Map<string, AgencyLookupRow>();
  if (agencyIds.length === 0) {
    return { byId, error: null };
  }

  const { data, error } = await supabase
    .from("agencies")
    .select("id, name")
    .in("id", agencyIds);

  if (error) {
    return { byId, error: error.message };
  }

  for (const row of data ?? []) {
    byId.set(row.id as string, {
      id: row.id as string,
      name: row.name as string,
    });
  }

  return { byId, error: null };
}

function resolveCreatorForOrder(
  row: {
    creator_id: string | null;
    creator_tiktok_id: string;
  },
  creatorsById: Map<string, CreatorLookupRow>,
  creatorsByTiktokId: Map<string, CreatorLookupRow>,
): CreatorLookupRow | null {
  if (row.creator_id) {
    const byId = creatorsById.get(row.creator_id);
    if (byId) return byId;
  }

  const tiktokKey = normalizeTiktokId(row.creator_tiktok_id);
  if (!tiktokKey) return null;
  return creatorsByTiktokId.get(tiktokKey) ?? null;
}

export async function fetchOrders(
  supabase: SupabaseClient,
  options: { agencyId?: string | null; limit?: number } = {},
): Promise<{ data: OrderListRow[]; error: string | null }> {
  const limit = options.limit ?? 500;

  let query = supabase
    .from("orders")
    .select(
      "id, order_id, creator_id, agency_id, target_month, product_name, product_id, sku, order_amount, commission_base, payment_status, order_status, shipping_status, cancel_status, refund_status, creator_tiktok_id, creator_name, ordered_at, paid_at, is_commission_target",
    )
    .order("ordered_at", { ascending: false, nullsFirst: false })
    .limit(limit);

  if (options.agencyId) {
    query = query.eq("agency_id", options.agencyId);
  }

  const { data, error } = await query;
  if (error) {
    return { data: [], error: error.message };
  }

  const orderRows = data ?? [];
  const creatorIds = uniqueStrings(orderRows.map((row) => row.creator_id as string | null));
  const fallbackTiktokIds = uniqueStrings(
    orderRows.map((row) => String(row.creator_tiktok_id ?? "").trim()),
  );

  const creatorsResult = await fetchCreatorsForOrders(
    supabase,
    creatorIds,
    fallbackTiktokIds,
  );
  if (creatorsResult.error) {
    return { data: [], error: creatorsResult.error };
  }

  const agencyIds = uniqueStrings(
    orderRows.flatMap((row) => {
      const creator = resolveCreatorForOrder(
        {
          creator_id: (row.creator_id as string | null) ?? null,
          creator_tiktok_id: row.creator_tiktok_id as string,
        },
        creatorsResult.byId,
        creatorsResult.byTiktokId,
      );
      return [
        (row.agency_id as string | null) ?? null,
        creator?.agency_id ?? null,
      ];
    }),
  );

  const agenciesResult = await fetchAgenciesByIds(supabase, agencyIds);
  if (agenciesResult.error) {
    return { data: [], error: agenciesResult.error };
  }

  return {
    data: orderRows.map((row) => {
      const creator = resolveCreatorForOrder(
        {
          creator_id: (row.creator_id as string | null) ?? null,
          creator_tiktok_id: row.creator_tiktok_id as string,
        },
        creatorsResult.byId,
        creatorsResult.byTiktokId,
      );
      const agencyId =
        (row.agency_id as string | null) ?? creator?.agency_id ?? null;
      const cancellationStatus = (row.cancel_status as string | null) ?? null;
      const returnStatus = (row.refund_status as string | null) ?? null;
      const rewardFields = {
        payment_status: row.payment_status as string | null,
        cancellation_status: cancellationStatus,
        return_status: returnStatus,
        order_amount: Number(row.order_amount),
        commission_base: Number(row.commission_base),
      };
      const rewardEligible = isOrderEligibleForAgencyReward(rewardFields);
      const rewardBase = getOrderRevenueBase(rewardFields);
      const rate = Number(creator?.commission_rate ?? 0);

      return {
        id: row.id as string,
        tiktok_order_id: row.order_id as string,
        creator_id: (row.creator_id as string | null) ?? creator?.id ?? null,
        agency_id: agencyId,
        agency_name: agencyId ? agenciesResult.byId.get(agencyId)?.name ?? null : null,
        target_month: row.target_month as string,
        product_name: (row.product_name as string | null) ?? null,
        product_id: (row.product_id as string | null) ?? null,
        sku: (row.sku as string | null) ?? null,
        order_amount: Number(row.order_amount),
        commission_base: Number(row.commission_base),
        payment_status: (row.payment_status as string | null) ?? null,
        order_status: (row.order_status as string | null) ?? null,
        shipping_status: (row.shipping_status as string | null) ?? null,
        cancellation_status: cancellationStatus,
        return_status: returnStatus,
        creator_tiktok_id: row.creator_tiktok_id as string,
        creator_name:
          (row.creator_name as string | null) ??
          creator?.creator_name ??
          null,
        ordered_at: (row.ordered_at as string | null) ?? null,
        paid_at: (row.paid_at as string | null) ?? null,
        is_paid: isPaidPaymentStatus(row.payment_status as string | null),
        is_cancelled: isCancelledStatus(cancellationStatus),
        is_refunded: isRefundedStatus(returnStatus),
        is_commission_target: Boolean(row.is_commission_target),
        reward_eligible: rewardEligible,
        reward_base: rewardBase,
        reward_amount: rewardEligible
          ? agencyRewardFromRevenue(rewardBase, rate)
          : 0,
      };
    }),
    error: null,
  };
}

export async function fetchCreatorPaidOrderSummaries(
  supabase: SupabaseClient,
  options: { agencyId?: string | null; month?: string } = {},
): Promise<{ data: CreatorPaidOrderSummary[]; error: string | null }> {
  const month = options.month ?? currentMonthKey();
  const orders = await fetchOrders(supabase, {
    agencyId: options.agencyId,
    limit: 2000,
  });

  if (orders.error) {
    return { data: [], error: orders.error };
  }

  const byCreator = new Map<string, CreatorPaidOrderSummary>();

  for (const order of orders.data) {
    if (!order.creator_id || order.target_month !== month) continue;
    if (!order.reward_eligible) continue;

    const existing = byCreator.get(order.creator_id) ?? {
      creator_id: order.creator_id,
      creator_name: order.creator_name ?? "—",
      tiktok_id: order.creator_tiktok_id,
      paid_sales_month: 0,
      reward_profit_month: 0,
      reward_amount_month: 0,
      order_count_month: 0,
    };

    existing.paid_sales_month += order.order_amount;
    existing.reward_profit_month += order.reward_base;
    existing.reward_amount_month += order.reward_amount;
    existing.order_count_month += 1;
    byCreator.set(order.creator_id, existing);
  }

  return {
    data: [...byCreator.values()].sort(
      (a, b) => b.reward_amount_month - a.reward_amount_month,
    ),
    error: null,
  };
}

export async function fetchOrderMetricRows(
  supabase: SupabaseClient,
  options: { agencyId?: string | null } = {},
): Promise<{
  data: Array<{
    creator_id: string | null;
    target_month: string;
    order_amount: number;
    commission_base: number;
    payment_status: string | null;
    order_status: string | null;
    shipping_status: string | null;
    cancellation_status: string | null;
    return_status: string | null;
    ordered_at: string | null;
  }>;
  error: string | null;
}> {
  let query = supabase
    .from("orders")
    .select(
      "creator_id, target_month, order_amount, commission_base, payment_status, order_status, shipping_status, cancel_status, refund_status, ordered_at",
    );

  if (options.agencyId) {
    query = query.eq("agency_id", options.agencyId);
  }

  const { data, error } = await query;
  if (error) {
    return { data: [], error: error.message };
  }

  return {
    data: (data ?? []).map((row) => ({
      creator_id: (row.creator_id as string | null) ?? null,
      target_month: row.target_month as string,
      order_amount: Number(row.order_amount),
      commission_base: Number(row.commission_base),
      payment_status: (row.payment_status as string | null) ?? null,
      order_status: (row.order_status as string | null) ?? null,
      shipping_status: (row.shipping_status as string | null) ?? null,
      cancellation_status: (row.cancel_status as string | null) ?? null,
      return_status: (row.refund_status as string | null) ?? null,
      ordered_at: (row.ordered_at as string | null) ?? null,
    })),
    error: null,
  };
}

export async function fetchOrderMetricRowsForCreators(
  supabase: SupabaseClient,
  creatorIds: string[],
): Promise<{
  data: Array<{
    creator_id: string | null;
    target_month: string;
    order_amount: number;
    commission_base: number;
    payment_status: string | null;
    order_status: string | null;
    shipping_status: string | null;
    cancellation_status: string | null;
    return_status: string | null;
    ordered_at: string | null;
  }>;
  error: string | null;
}> {
  if (creatorIds.length === 0) {
    return { data: [], error: null };
  }
  const { data, error } = await supabase
    .from("orders")
    .select(
      "creator_id, target_month, order_amount, commission_base, payment_status, order_status, shipping_status, cancel_status, refund_status, ordered_at",
    )
    .in("creator_id", creatorIds);

  if (error) {
    return { data: [], error: error.message };
  }

  return {
    data: (data ?? []).map((row) => ({
      creator_id: (row.creator_id as string | null) ?? null,
      target_month: row.target_month as string,
      order_amount: Number(row.order_amount),
      commission_base: Number(row.commission_base),
      payment_status: (row.payment_status as string | null) ?? null,
      order_status: (row.order_status as string | null) ?? null,
      shipping_status: (row.shipping_status as string | null) ?? null,
      cancellation_status: (row.cancel_status as string | null) ?? null,
      return_status: (row.refund_status as string | null) ?? null,
      ordered_at: (row.ordered_at as string | null) ?? null,
    })),
    error: null,
  };
}
