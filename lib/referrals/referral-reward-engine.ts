/*
  紹介者報酬エンジン（Single Source of Truth）

  ■ 計算元
  affiliate_order_lines。base は commission_base。

  ■ 対象明細
  order_status   = 決済済み
  payment_status = 支払い済み
  refund_status != fully_refunded（返金済みでない）
  判定は lib/revenue/order-line-status.ts に集約。

  ■ 対象クリエイター
  account_management_type = 'standard'（通常クリエイター）かつ紹介者あり。
  self_operated（自社運用）と account_lending（アカウント貸出）は5%の対象外。

  ■ 通常紹介料率
  5%。creator_referrals.referral_rate に個別設定があればそちらを優先。

  ■ 一意性
  affiliate_order_lines.source_row_key。
  (order_id, product_id, creator_id) は実データで重複するため使用しない。

  ■ 支払判定
  暦年（1月〜12月）単位の未払い累積が 1,000円以上で支払対象。
  1,000円未満は明細を残したまま翌月へ繰越。

  ■ 検証値（2026-05〜2026-08）
  eligible commission base = 2,309,135 円
  referral reward          =   115,456.75 円
*/

import { isReferralRewardEligibleType } from "@/lib/creators/account-management-type";
import { isPayoutEligibleOrderLine } from "@/lib/revenue/order-line-status";

/** 通常紹介料率 */
export const REFERRAL_REWARD_RATE = 0.05;

const DEFAULT_REFERRAL_PAYOUT_THRESHOLD_YEN = 1000;

/**
 * 支払基準額（暦年の未払い累積に対して判定する）。
 * 既定は 1,000円。REFERRAL_MINIMUM_PAYOUT で上書きできる。
 */
export const REFERRAL_PAYOUT_THRESHOLD_YEN = resolvePayoutThresholdYen();

function resolvePayoutThresholdYen(): number {
  const raw =
    process.env.REFERRAL_MINIMUM_PAYOUT?.trim() ??
    process.env.NEXT_PUBLIC_REFERRAL_MINIMUM_PAYOUT?.trim();
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.round(parsed);
  }
  return DEFAULT_REFERRAL_PAYOUT_THRESHOLD_YEN;
}

export type ReferralOrderLine = {
  source_row_key: string | null;
  order_id: string | null;
  product_id: string | null;
  creator_id: string | null;
  target_month: string | null;
  commission_base: number | string | null;
  payment_status: string | null;
  order_status: string | null;
  refund_status: string | null;
};

export type ReferralCreatorConfig = {
  creatorId: string;
  referrerId: string | null;
  accountManagementType: string | null;
};

/** 紹介者報酬が発生しうるクリエイターか（区分 + 紹介者紐付け） */
export function isReferralTargetCreator(config: ReferralCreatorConfig): boolean {
  if (!config.referrerId) return false;
  return isReferralRewardEligibleType(config.accountManagementType);
}

/**
 * 報酬額。銭単位（小数第2位）まで保持する。
 * 明細ごとに円未満を丸めると検証値と一致しないため四捨五入しない。
 */
export function referralRewardAmount(baseAmount: number, rate: number): number {
  if (!Number.isFinite(baseAmount) || !Number.isFinite(rate)) return 0;
  return Math.round(baseAmount * rate * 100) / 100;
}

/** 銭単位に丸めた合計（浮動小数の誤差蓄積を防ぐ） */
export function sumReferralAmounts(values: number[]): number {
  const total = values.reduce(
    (sum, value) => sum + (Number.isFinite(value) ? value : 0),
    0,
  );
  return Math.round(total * 100) / 100;
}

/** 銭単位への丸め */
export function roundReferralAmount(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

/**
 * referral_reward_items の実支払額。
 * 上限調整済みの adjusted_reward_amount を優先する。
 */
export function resolveRewardItemAmount(item: {
  adjusted_reward_amount?: unknown;
  reward_amount?: unknown;
}): number {
  const adjusted = Number(item.adjusted_reward_amount ?? NaN);
  if (Number.isFinite(adjusted)) return adjusted;
  const raw = Number(item.reward_amount ?? 0);
  return Number.isFinite(raw) ? raw : 0;
}

/** target_month (YYYY-MM) から報酬年度 (YYYY) を取り出す */
export function rewardYearOf(targetMonth: string): string {
  return String(targetMonth ?? "").slice(0, 4);
}

export function isValidTargetMonth(value: string): boolean {
  return /^\d{4}-\d{2}$/.test(value);
}

export function isValidRewardYear(value: string): boolean {
  return /^\d{4}$/.test(value);
}

/** 紹介契約の有効期間内か */
export function isReferralMonthActive(
  targetMonth: string,
  startMonth: string | null,
  endMonth: string | null,
): boolean {
  if (startMonth && targetMonth < startMonth) return false;
  if (endMonth && targetMonth > endMonth) return false;
  return true;
}

export type ReferralAnnualState = {
  /** 年間発生額（対象明細の合計） */
  annualRewardAmount: number;
  /** 年間支払済額 */
  paidAmount: number;
  /** 未払残高（＝今回支払対象候補） */
  unpaidAmount: number;
  /** 未払残高が支払基準額に達しているか */
  isPayable: boolean;
  /** 支払基準額 */
  thresholdAmount: number;
};

/**
 * 暦年の累積での支払可否判定。
 * 1,000円未満は支払わず翌月繰越（明細は消さない）。
 */
export function resolveAnnualPayoutState(params: {
  annualRewardAmount: number;
  paidAmount: number;
  thresholdAmount?: number;
}): ReferralAnnualState {
  const thresholdAmount = params.thresholdAmount ?? REFERRAL_PAYOUT_THRESHOLD_YEN;
  const annualRewardAmount = roundReferralAmount(params.annualRewardAmount);
  const paidAmount = roundReferralAmount(params.paidAmount);
  const unpaidAmount = roundReferralAmount(annualRewardAmount - paidAmount);

  return {
    annualRewardAmount,
    paidAmount,
    unpaidAmount,
    isPayable: unpaidAmount >= thresholdAmount,
    thresholdAmount,
  };
}

export type ReferralRewardComputation = {
  sourceRowKey: string;
  targetMonth: string;
  rewardYear: string;
  orderId: string;
  productId: string;
  creatorId: string;
  referrerId: string;
  baseAmount: number;
  rewardRate: number;
  rewardAmount: number;
  paymentStatus: string | null;
  orderStatus: string | null;
  refundStatus: string | null;
};

/**
 * 注文明細1行から紹介者報酬を計算する。
 * 対象外の場合は null を返す（レコードを作らない）。
 */
export function computeReferralReward(
  line: ReferralOrderLine,
  config: ReferralCreatorConfig,
  rate: number = REFERRAL_REWARD_RATE,
): ReferralRewardComputation | null {
  const { creator_id: creatorId, source_row_key: sourceRowKey, target_month: targetMonth } = line;

  if (!creatorId || !sourceRowKey || !targetMonth) return null;
  if (!isReferralTargetCreator(config)) return null;
  if (!isPayoutEligibleOrderLine(line)) return null;

  const baseAmount = Number(line.commission_base ?? 0);
  if (!Number.isFinite(baseAmount) || baseAmount <= 0) return null;

  return {
    sourceRowKey,
    targetMonth,
    rewardYear: rewardYearOf(targetMonth),
    orderId: String(line.order_id ?? ""),
    productId: String(line.product_id ?? ""),
    creatorId,
    referrerId: config.referrerId as string,
    baseAmount,
    rewardRate: rate,
    rewardAmount: referralRewardAmount(baseAmount, rate),
    paymentStatus: line.payment_status ?? null,
    orderStatus: line.order_status ?? null,
    refundStatus: line.refund_status ?? null,
  };
}

/** creator_referrals.referral_rate を正規化する（未設定は通常料率） */
export function resolveReferralRate(value: unknown): number {
  const rate = Number(value);
  return Number.isFinite(rate) && rate > 0 ? rate : REFERRAL_REWARD_RATE;
}
