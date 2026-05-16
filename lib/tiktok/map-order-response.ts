import { currentMonthKey } from "@/lib/db/dashboard-queries";
import {
  getOrderRevenueBase,
  isOrderEligibleForAgencyReward,
} from "@/lib/revenue/order-eligibility";
import type { TikTokOrderApiRecord } from "@/lib/tiktok/order-types";

function toNumber(value: number | string | null | undefined): number {
  if (value == null || value === "") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toMonthKey(iso: string | null | undefined): string {
  if (!iso) return currentMonthKey();
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return currentMonthKey();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export type OrderUpsertInput = {
  order_id: string;
  creator_id: string | null;
  agency_id: string | null;
  target_month: string;
  product_name: string | null;
  product_id: string | null;
  sku: string | null;
  order_amount: number;
  commission_base: number;
  commission_amount: number;
  payment_status: string | null;
  order_status: string | null;
  shipping_status: string | null;
  cancel_status: string | null;
  refund_status: string | null;
  is_commission_target: boolean;
  creator_tiktok_id: string;
  creator_name: string | null;
  ordered_at: string | null;
  paid_at: string | null;
  raw_json: Record<string, unknown>;
};

export function mapTikTokOrderToUpsert(
  record: TikTokOrderApiRecord,
  options: {
    creatorId: string | null;
    agencyId: string | null;
  },
): OrderUpsertInput | null {
  const tiktokOrderId = String(record.order_id ?? "").trim();
  const creatorTiktokId = String(record.creator_tiktok_id ?? "").trim().toLowerCase();
  if (!tiktokOrderId || !creatorTiktokId) return null;

  const orderedAt = record.ordered_at ?? null;
  const paidAt = record.paid_at ?? null;

  const orderAmount = toNumber(record.order_amount);
  const commissionBase = toNumber(record.commission_base);
  const commissionAmount = toNumber(record.commission_amount);
  const paymentStatus = record.payment_status?.trim() || null;
  const orderStatus = record.order_status?.trim() || null;
  const shippingStatus = record.shipping_status?.trim() || null;
  const cancelStatus = record.cancellation_status?.trim() || null;
  const refundStatus = record.return_status?.trim() || null;
  const rewardFields = {
    payment_status: paymentStatus,
    cancellation_status: cancelStatus,
    return_status: refundStatus,
    order_amount: orderAmount,
    commission_base: commissionBase,
  };

  return {
    order_id: tiktokOrderId,
    creator_id: options.creatorId,
    agency_id: options.agencyId,
    target_month: toMonthKey(paidAt ?? orderedAt),
    product_name: record.product_name?.trim() || null,
    product_id: record.product_id?.trim() || null,
    sku: record.sku?.trim() || null,
    order_amount: orderAmount,
    commission_base: commissionBase,
    commission_amount: commissionAmount,
    payment_status: paymentStatus,
    order_status: orderStatus,
    shipping_status: shippingStatus,
    cancel_status: cancelStatus,
    refund_status: refundStatus,
    is_commission_target: isOrderEligibleForAgencyReward(rewardFields),
    creator_tiktok_id: creatorTiktokId,
    creator_name: record.creator_name?.trim() || null,
    ordered_at: orderedAt,
    paid_at: paidAt,
    raw_json: record as Record<string, unknown>,
  };
}
