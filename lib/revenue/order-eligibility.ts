export type OrderRewardFields = {
  payment_status: string | null;
  cancellation_status: string | null;
  return_status: string | null;
  order_amount: number;
  commission_base: number;
};

const PAID_PAYMENT_STATUSES = new Set(["paid", "completed", "settled"]);

function normalizeStatus(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function isTruthyStatus(value: string | null | undefined): boolean {
  const normalized = normalizeStatus(value);
  if (!normalized) return false;
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

export function isPaidPaymentStatus(paymentStatus: string | null | undefined): boolean {
  return PAID_PAYMENT_STATUSES.has(normalizeStatus(paymentStatus));
}

export function isCancelledStatus(cancelStatus: string | null | undefined): boolean {
  return isTruthyStatus(cancelStatus);
}

export function isRefundedStatus(refundStatus: string | null | undefined): boolean {
  return isTruthyStatus(refundStatus);
}

export function isOrderEligibleForAgencyReward(order: OrderRewardFields): boolean {
  if (!isPaidPaymentStatus(order.payment_status)) return false;
  if (isCancelledStatus(order.cancellation_status)) return false;
  if (isRefundedStatus(order.return_status)) return false;
  return true;
}

export function getOrderRevenueBase(
  order: Pick<OrderRewardFields, "order_amount" | "commission_base">,
): number {
  const commissionBase = Number(order.commission_base);
  if (Number.isFinite(commissionBase) && commissionBase > 0) {
    return commissionBase;
  }
  const orderAmount = Number(order.order_amount);
  return Number.isFinite(orderAmount) ? orderAmount : 0;
}
