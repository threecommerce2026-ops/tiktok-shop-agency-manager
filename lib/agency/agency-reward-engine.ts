/*
  代理店報酬エンジン（Single Source of Truth）

  ■ 代理店報酬額 = AP「エージェンシーの収益総額」を100%そのまま支払う
  DBカラムは affiliate_order_lines.agency_revenue。
  実データで CSV の AP 列と一致することを確認済み。

  ここで金額を作り直してはいけない。禁止例:
    AP × AK
    Commission Base × AK
    AJ × AK
    agency_revenue × agency_split_rate

  AK「エージェンシー成果報酬分配の一部」(agency_split_rate) は、
  TikTok側で既に AP に反映済みの分配率であり、
  「何%分配された結果なのか」を確認・表示するための値。計算には使わない。

  ■ CAP列とDBカラムの対応（本番データで照合済み）
    AD 成果報酬ベース                 → commission_base
    AE 標準成果報酬                   → 未保存（raw_row_json のみ）
    AF ショップ広告の成果報酬         → 未保存（raw_row_json のみ）
    AG TikTok Shopボーナス            → 未保存（raw_row_json のみ）
    AJ 収益分配前のクリエイター収益   → creator_revenue_before_split
    AK エージェンシー成果報酬分配の一部 → agency_split_rate
    AP エージェンシーの収益総額       → agency_revenue      ← 代理店報酬額
    AU 支払い状況                     → payment_status      ← 対象条件
       （注）order_status カラムは CAP の「注文の決済状況」であり AU ではない

  ■ 対象条件（正式仕様）
    AU「支払い状況」= 支払い済み
    かつ 代理店が特定できる（THREE.inc 所属・代理店未設定は対象外）
    かつ AP の金額が存在する

  ■ TAP
  TAP 収益は代理店報酬に含めない。

  ■ 一意性
  affiliate_order_lines.source_row_key。

  ■ 検証値（2026-05〜2026-08）
  代理店報酬 27,456.00 円 = AP合計 / 対象明細 1,549 行 / 15 クリエイター / 9 代理店
*/

import { THREE_INC_AGENCY_NAME } from "@/lib/revenue/in-house-creator";
import type { AgencyAssignment } from "@/lib/agency/agency-assignment";
import { isAgencyPayoutEligibleOrderLine } from "@/lib/revenue/order-line-status";

export { THREE_INC_AGENCY_NAME };

export type AgencyOrderLine = {
  source_row_key: string | null;
  order_id: string | null;
  product_id: string | null;
  creator_id: string | null;
  target_month: string | null;
  commission_base: number | string | null;
  commission_gmv: number | string | null;
  creator_revenue_before_split: number | string | null;
  agency_split_rate: number | string | null;
  agency_revenue: number | string | null;
  payment_status: string | null;
  order_status: string | null;
  refund_status: string | null;
};

/*
  所属の解決結果。lib/agency/agency-assignment.ts が単一ソース。
  ここでは型だけを参照する。
*/
export type { AgencyAssignment } from "@/lib/agency/agency-assignment";

/** 要確認として支払対象から除外する理由 */
export type AgencyRewardExclusionReason =
  | "no_agency_with_split"
  | "no_agency"
  | "in_house";

export type AgencyRewardComputation = {
  sourceRowKey: string;
  targetMonth: string;
  rewardYear: string;
  orderId: string;
  productId: string;
  creatorId: string;
  agencyId: string;
  commissionBase: number;
  commissionGmv: number;
  creatorRevenueBeforeSplit: number;
  agencySplitRate: number;
  rewardAmount: number;
  paymentStatus: string | null;
  orderStatus: string | null;
  refundStatus: string | null;
};

function amount(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 銭単位への丸め（AP は TikTok 実額でほぼ整数） */
export function roundAgencyAmount(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

export function sumAgencyAmounts(values: number[]): number {
  const total = values.reduce(
    (sum, value) => sum + (Number.isFinite(value) ? value : 0),
    0,
  );
  return Math.round(total * 100) / 100;
}

/** 自社所属か（agencies.is_in_house が唯一の根拠。名前では判定しない） */
export function isInHouseAgency(assignment: AgencyAssignment): boolean {
  return assignment.agencyIsInHouse;
}

/**
 * 代理店報酬が発生しうる所属か。
 * 自社所属・代理店未設定は対象外。
 */
export function isAgencyRewardTarget(assignment: AgencyAssignment): boolean {
  if (!assignment.agencyId) return false;
  return !isInHouseAgency(assignment);
}

/**
 * 支払対象外の理由を返す。対象なら null。
 * agency_split_rate > 0 なのに代理店未設定のものは要確認として区別する。
 */
export function resolveExclusionReason(
  assignment: AgencyAssignment,
  agencySplitRate: number,
): AgencyRewardExclusionReason | null {
  if (assignment.agencyId) {
    return isInHouseAgency(assignment) ? "in_house" : null;
  }
  return agencySplitRate > 0 ? "no_agency_with_split" : "no_agency";
}

export function rewardYearOf(targetMonth: string): string {
  return String(targetMonth ?? "").slice(0, 4);
}

export function isValidTargetMonth(value: string): boolean {
  return /^\d{4}-\d{2}$/.test(value);
}

export function isValidRewardYear(value: string): boolean {
  return /^\d{4}$/.test(value);
}

/**
 * 注文明細1行から代理店報酬を計算する。
 * 対象外の場合は null を返す（レコードを作らない）。
 */
export function computeAgencyReward(
  line: AgencyOrderLine,
  assignment: AgencyAssignment,
): AgencyRewardComputation | null {
  const { creator_id: creatorId, source_row_key: sourceRowKey, target_month: targetMonth } = line;

  if (!creatorId || !sourceRowKey || !targetMonth) return null;
  if (!isAgencyRewardTarget(assignment)) return null;

  // 対象条件は AU「支払い状況」= 支払い済み のみ
  if (!isAgencyPayoutEligibleOrderLine(line)) return null;

  /*
    AP「エージェンシーの収益総額」をそのまま代理店報酬とする。
    AK（agency_split_rate）は掛けない。
  */
  const rewardAmount = amount(line.agency_revenue);
  if (rewardAmount <= 0) return null;

  return {
    sourceRowKey,
    targetMonth,
    rewardYear: rewardYearOf(targetMonth),
    orderId: String(line.order_id ?? ""),
    productId: String(line.product_id ?? ""),
    creatorId,
    agencyId: assignment.agencyId as string,
    commissionBase: amount(line.commission_base),
    commissionGmv: amount(line.commission_gmv),
    creatorRevenueBeforeSplit: amount(line.creator_revenue_before_split),
    agencySplitRate: amount(line.agency_split_rate),
    rewardAmount,
    paymentStatus: line.payment_status ?? null,
    orderStatus: line.order_status ?? null,
    refundStatus: line.refund_status ?? null,
  };
}

/** agency_reward_items の実支払額 */
export function resolveAgencyRewardItemAmount(item: {
  reward_amount?: unknown;
}): number {
  return amount(item.reward_amount);
}

export type AgencyAnnualState = {
  /** 年間発生額 */
  annualRewardAmount: number;
  /** 年間支払済額 */
  paidAmount: number;
  /** 未払残高 */
  unpaidAmount: number;
  /** 今回支払対象額 */
  payableAmount: number;
  isPayable: boolean;
  /** 支払基準額。代理店報酬は既定 0（下限なし） */
  thresholdAmount: number;
};

/**
 * 暦年の累積での支払可否判定。
 * 代理店報酬には紹介者報酬のような 1,000円下限は設けない（既定 0円）。
 */
export function resolveAgencyAnnualState(params: {
  annualRewardAmount: number;
  paidAmount: number;
  thresholdAmount?: number;
}): AgencyAnnualState {
  const thresholdAmount = params.thresholdAmount ?? 0;
  const annualRewardAmount = roundAgencyAmount(params.annualRewardAmount);
  const paidAmount = roundAgencyAmount(params.paidAmount);
  const unpaidAmount = roundAgencyAmount(annualRewardAmount - paidAmount);
  const isPayable = unpaidAmount > 0 && unpaidAmount >= thresholdAmount;

  return {
    annualRewardAmount,
    paidAmount,
    unpaidAmount,
    payableAmount: isPayable ? unpaidAmount : 0,
    isPayable,
    thresholdAmount,
  };
}
