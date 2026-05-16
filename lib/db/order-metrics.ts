import { agencyRewardFromRevenue } from "@/lib/revenue/calc";
import {
  getOrderRevenueBase,
  isOrderEligibleForAgencyReward,
  type OrderRewardFields,
} from "@/lib/revenue/order-eligibility";

export type OrderMetricRow = OrderRewardFields & {
  creator_id: string | null;
  target_month: string;
  order_amount: number;
  ordered_at: string | null;
};

export type CreatorOrderMetrics = {
  salesMonth: number;
  salesTotal: number;
  profitMonth: number;
  profitTotal: number;
  rewardMonth: number;
  rewardTotal: number;
  lastSalesAt: string | null;
};

export function createEmptyCreatorOrderMetrics(): CreatorOrderMetrics {
  return {
    salesMonth: 0,
    salesTotal: 0,
    profitMonth: 0,
    profitTotal: 0,
    rewardMonth: 0,
    rewardTotal: 0,
    lastSalesAt: null,
  };
}

function laterIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

export function aggregateCreatorOrderMetrics(
  orders: OrderMetricRow[],
  commissionRateByCreator: Map<string, number>,
  month: string,
): Map<string, CreatorOrderMetrics> {
  const byCreator = new Map<string, CreatorOrderMetrics>();

  for (const order of orders) {
    const creatorId = order.creator_id;
    if (!creatorId) continue;

    const metrics = byCreator.get(creatorId) ?? createEmptyCreatorOrderMetrics();
    const orderAmount = Number(order.order_amount);
    const revenueBase = getOrderRevenueBase(order);
    const eligible = isOrderEligibleForAgencyReward(order);

    metrics.salesTotal += orderAmount;
    if (order.target_month === month) {
      metrics.salesMonth += orderAmount;
    }

    if (eligible) {
      metrics.profitTotal += revenueBase;
      if (order.target_month === month) {
        metrics.profitMonth += revenueBase;
      }
    }

    if (orderAmount > 0) {
      const ts = order.ordered_at?.trim() || null;
      if (ts) {
        metrics.lastSalesAt = laterIso(metrics.lastSalesAt, ts);
      }
    }

    byCreator.set(creatorId, metrics);
  }

  for (const [creatorId, metrics] of byCreator) {
    const rate = commissionRateByCreator.get(creatorId) ?? 0;
    metrics.rewardMonth = agencyRewardFromRevenue(metrics.profitMonth, rate);
    metrics.rewardTotal = agencyRewardFromRevenue(metrics.profitTotal, rate);
    byCreator.set(creatorId, metrics);
  }

  return byCreator;
}

export function aggregateMonthlyOrderTrend(
  orders: OrderMetricRow[],
  commissionRateByCreator: Map<string, number>,
): Map<string, { sales: number; profit: number; reward: number }> {
  const byMonth = new Map<string, { sales: number; profit: number; reward: number }>();

  for (const order of orders) {
    const month = order.target_month;
    const agg = byMonth.get(month) ?? { sales: 0, profit: 0, reward: 0 };
    const orderAmount = Number(order.order_amount);
    const revenueBase = getOrderRevenueBase(order);
    const eligible = isOrderEligibleForAgencyReward(order);
    const rate = order.creator_id
      ? commissionRateByCreator.get(order.creator_id) ?? 0
      : 0;

    agg.sales += orderAmount;
    if (eligible) {
      agg.profit += revenueBase;
      agg.reward += agencyRewardFromRevenue(revenueBase, rate);
    }
    byMonth.set(month, agg);
  }

  return byMonth;
}
