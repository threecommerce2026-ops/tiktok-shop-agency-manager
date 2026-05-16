import { agencyRewardFromRevenue } from "@/lib/revenue/calc";
import {
  getOrderRevenueBase,
  isCancelledStatus,
  isPaidPaymentStatus,
  isRefundedStatus,
} from "@/lib/revenue/order-eligibility";

export const DEFAULT_REFERRAL_RATE = 0.05;

export function getReferralPayoutThresholdYen(): number {
  const raw =
    process.env.REFERRAL_MINIMUM_PAYOUT?.trim() ??
    process.env.NEXT_PUBLIC_REFERRAL_MINIMUM_PAYOUT?.trim();
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.round(parsed);
  }
  return 1000;
}

export const REFERRAL_PAYOUT_THRESHOLD_YEN = getReferralPayoutThresholdYen();

export type ReferralOrderFields = {
  payment_status: string | null;
  cancel_status: string | null;
  refund_status: string | null;
  order_amount: number;
  commission_base: number;
};

export function isReferralEligibleOrder(order: ReferralOrderFields): boolean {
  if (!isPaidPaymentStatus(order.payment_status)) {
    return false;
  }
  if (isCancelledStatus(order.cancel_status)) {
    return false;
  }
  if (isRefundedStatus(order.refund_status)) {
    return false;
  }
  return true;
}

export function getReferralBaseAmount(
  order: Pick<ReferralOrderFields, "order_amount" | "commission_base">,
): number {
  return getOrderRevenueBase(order);
}

export function referralRewardFromBase(baseAmount: number, rate: number): number {
  if (!Number.isFinite(baseAmount) || !Number.isFinite(rate)) {
    return 0;
  }
  return Math.round(baseAmount * rate);
}

export function agencyRewardFromEligibleProfit(
  profitAmount: number,
  commissionRatePercent: number,
): number {
  return agencyRewardFromRevenue(profitAmount, commissionRatePercent);
}

export function isReferralMonthActive(
  targetMonth: string,
  startMonth: string,
  endMonth: string | null,
): boolean {
  if (targetMonth < startMonth) {
    return false;
  }
  if (endMonth && targetMonth > endMonth) {
    return false;
  }
  return true;
}

export function resolveReferralPayoutStatus(totalRewardAmount: number): {
  isPayable: boolean;
  status: "unpaid" | "hold";
} {
  if (totalRewardAmount >= REFERRAL_PAYOUT_THRESHOLD_YEN) {
    return { isPayable: true, status: "unpaid" };
  }
  return { isPayable: false, status: "hold" };
}
