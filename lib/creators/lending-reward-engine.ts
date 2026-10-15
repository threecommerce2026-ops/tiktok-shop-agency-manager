/*
  端末貸し出し報酬エンジン（Single Source of Truth）

  ■ 業務ルール（2026-10-10 確定）
  管理区分 account_management_type = 'account_lending' のクリエイターは、
  所属が THREE.inc（自社）のまま、AK（agency_split_rate）も 100% のままで、
  AP（affiliate_order_lines.agency_revenue）を本人と自社で分ける。

      本人      = AP × 分配率（基本 80%）
      THREE.inc = AP − 本人報酬

  受取人はクリエイター本人。代理店ではない。
  本人を代理店マスタへ架空登録したり、THREE.inc の代理店 ID で代用したりはしない。

  紹介者報酬5%とは別制度。account_lending は従来どおり5%の対象外
  （lib/creators/account-management-type.ts の isReferralRewardEligibleType）。

  ■ 計算部品は作り直さない
  対象注文判定・丸め・合算・年間の支払可否は、代理店報酬で使っているものを
  そのまま呼ぶ。ここで独自の丸めや集計を実装しない。

      isAgencyPayoutEligibleOrderLine()  lib/revenue/order-line-status.ts
      roundAgencyAmount()                lib/agency/agency-reward-engine.ts
      sumAgencyAmounts()                 同上
      resolveAgencyAnnualState()         同上

  ■ 4条件すべてを満たさないと報酬を作らない（fail-closed）
      ① 対象月の管理区分が account_lending
      ② 対象月の所属が自社（agencies.is_in_house = true）
      ③ AK（agency_split_rate）= 100
      ④ 分配率が有効（0 < rate <= 1）
  加えて注文が報酬対象（支払い済み・返金なし）で、AP > 0 であること。

  1つでも欠けたら null を返し、理由を別途取得できるようにしてある
  （画面で「対象外の理由」を出すため）。

  ■ 本人 + 自社 = AP
  自社取り分は AP − 本人報酬として求める。先に自社を計算して引き算しない。
  これにより丸め差が出ても合計が必ず AP に一致する。
  DB 側にも同じ制約（creator_lending_reward_items_share_sum_check）がある。

  ■ 検証値（2026-04〜2026-08 / 本番 READ ONLY で確認）
  対象 5 名 / 364 明細 / AP 64,974.00 円
    本人 80%  51,979.20 円
    自社 20%  12,994.80 円
*/

import {
  resolveAgencyAnnualState,
  roundAgencyAmount,
  sumAgencyAmounts,
  type AgencyAnnualState,
} from "@/lib/agency/agency-reward-engine";
import { normalizeAccountManagementType } from "@/lib/creators/account-management-type";
import { isAgencyPayoutEligibleOrderLine } from "@/lib/revenue/order-line-status";

/** 本人の基本分配率。業務ルールで 80%（2026-10-10 確定） */
export const CREATOR_LENDING_SPLIT_RATE = 0.8;

/** AK（エージェンシー分配率）が満たすべき値。100% 以外は対象にしない */
export const REQUIRED_AGENCY_SPLIT_RATE = 100;

export type LendingOrderLine = {
  source_row_key: string | null;
  order_id: string | null;
  product_id: string | null;
  creator_id: string | null;
  target_month: string | null;
  commission_base: number | string | null;
  commission_gmv: number | string | null;
  creator_revenue_before_split: number | string | null;
  /** AK。100% でなければ対象にしない */
  agency_split_rate: number | string | null;
  /** AP。報酬の原資 */
  agency_revenue: number | string | null;
  payment_status: string | null;
  order_status: string | null;
  refund_status: string | null;
};

/** 対象月のクリエイターの状態。所属と区分は正データから解決して渡す */
export type LendingCreatorContext = {
  creatorId: string;
  targetMonth: string;
  /** 対象月の確定区分（月別確定を優先して解決した値） */
  accountManagementType: string | null;
  /** 対象月の所属代理店。自社であることを確かめる */
  agencyId: string | null;
  /** 所属が自社か（agencies.is_in_house が唯一の根拠） */
  agencyIsInHouse: boolean;
  /** 所属が月別確定されているか */
  assignmentConfirmed: boolean;
  /** その月に本人へ分配する運用上の決定。false なら作らない */
  isActive: boolean;
  /** 分配率の個別設定。null なら既定 80% */
  splitRateOverride?: number | string | null;
};

/** 報酬を作らなかった理由。画面で「対象外の理由」を出すために使う */
export type LendingExclusionReason =
  | "missing_key"
  | "not_account_lending"
  | "assignment_unconfirmed"
  | "agency_not_in_house"
  | "agency_split_rate_not_100"
  | "inactive_terms"
  | "invalid_split_rate"
  | "order_not_payable"
  | "ap_not_positive"
  | "reward_not_positive";

export const LENDING_EXCLUSION_LABEL: Record<LendingExclusionReason, string> = {
  missing_key: "明細の識別情報が足りません",
  not_account_lending: "対象月の管理区分がアカウント貸し出しではありません",
  assignment_unconfirmed: "対象月の所属が月別確定されていません",
  agency_not_in_house: "対象月の所属が自社ではありません",
  agency_split_rate_not_100: "エージェンシー分配率（AK）が 100% ではありません",
  inactive_terms: "この月は端末貸し出しの対象として有効化されていません",
  invalid_split_rate: "分配率が不正です（0 より大きく 1 以下で指定してください）",
  order_not_payable: "注文が報酬対象ではありません（未払い / 返金済み）",
  ap_not_positive: "AP（エージェンシー収益）が 0 以下です",
  reward_not_positive: "本人報酬が 0 円になります",
};

export type LendingRewardComputation = {
  sourceRowKey: string;
  targetMonth: string;
  rewardYear: string;
  orderId: string;
  productId: string;
  /** 受取人。クリエイター本人 */
  creatorId: string;
  /** 計算時点の自社所属。監査用の記録で、支払先ではない */
  inHouseAgencyId: string | null;
  commissionBase: number;
  commissionGmv: number;
  creatorRevenueBeforeSplit: number;
  /** AK（記録のみ。100% であることを検証済み） */
  agencySplitRate: number;
  /** AP。報酬の原資 */
  agencyRevenue: number;
  /** 適用した本人の分配率 */
  splitRate: number;
  /** 本人報酬 = round(AP × 分配率) */
  rewardAmount: number;
  /** THREE.inc の取り分 = AP − 本人報酬 */
  selfShareAmount: number;
  paymentStatus: string | null;
  orderStatus: string | null;
  refundStatus: string | null;
};

function amount(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function rewardYearOf(targetMonth: string): string {
  return String(targetMonth ?? "").slice(0, 4);
}

/**
 * 分配率を解決する。
 *
 * 未設定（null / undefined / 空文字）は既定の 80%。
 * それ以外で 0 < rate <= 1 に収まらない値は不正として null を返す。
 *
 * 不正値を既定値へ丸めない。「80」のような % 表記の混入を 0.8 と解釈すると
 * 支払額が 100 倍になるため、計算させずに報酬を作らない。
 */
export function resolveCreatorLendingSplitRate(
  override: number | string | null | undefined,
): number | null {
  if (override == null || override === "") return CREATOR_LENDING_SPLIT_RATE;

  const parsed = Number(override);
  if (!Number.isFinite(parsed)) return null;
  if (parsed <= 0 || parsed > 1) return null;

  return parsed;
}

/**
 * 報酬を作らない理由を返す。対象なら null。
 *
 * 画面の「対象外の理由」表示と computeCreatorLendingReward の判定で
 * 同じ関数を使い、表示と計算が食い違わないようにする。
 */
export function resolveLendingExclusionReason(
  line: LendingOrderLine,
  context: LendingCreatorContext,
): LendingExclusionReason | null {
  if (!line.creator_id || !line.source_row_key || !line.target_month) {
    return "missing_key";
  }

  // ① 管理区分
  if (normalizeAccountManagementType(context.accountManagementType) !== "account_lending") {
    return "not_account_lending";
  }

  // ② 所属が自社（月別確定であることも要求する）
  if (!context.assignmentConfirmed || !context.agencyId) {
    return "assignment_unconfirmed";
  }
  if (!context.agencyIsInHouse) {
    return "agency_not_in_house";
  }

  // ③ AK が 100%
  if (amount(line.agency_split_rate) !== REQUIRED_AGENCY_SPLIT_RATE) {
    return "agency_split_rate_not_100";
  }

  // ④ その月が有効化されていること / 分配率が有効であること
  if (!context.isActive) {
    return "inactive_terms";
  }
  if (resolveCreatorLendingSplitRate(context.splitRateOverride) == null) {
    return "invalid_split_rate";
  }

  // 注文が報酬対象（支払い済み・返金なし）であること
  if (!isAgencyPayoutEligibleOrderLine(line)) {
    return "order_not_payable";
  }

  if (amount(line.agency_revenue) <= 0) {
    return "ap_not_positive";
  }

  return null;
}

/**
 * 注文明細1行から本人の端末貸し出し報酬を計算する。
 * 対象外の場合は null を返す（レコードを作らない）。
 */
export function computeCreatorLendingReward(
  line: LendingOrderLine,
  context: LendingCreatorContext,
): LendingRewardComputation | null {
  if (resolveLendingExclusionReason(line, context) != null) return null;

  const splitRate = resolveCreatorLendingSplitRate(context.splitRateOverride);
  if (splitRate == null) return null;

  const agencyRevenue = amount(line.agency_revenue);
  const rewardAmount = roundAgencyAmount(agencyRevenue * splitRate);
  if (rewardAmount <= 0) return null;

  /*
    自社取り分は引き算で求める。
    先に自社を掛け算で出すと、丸め差で 本人 + 自社 ≠ AP になりうる。
  */
  const selfShareAmount = roundAgencyAmount(agencyRevenue - rewardAmount);

  const targetMonth = String(line.target_month);

  return {
    sourceRowKey: String(line.source_row_key),
    targetMonth,
    rewardYear: rewardYearOf(targetMonth),
    orderId: String(line.order_id ?? ""),
    productId: String(line.product_id ?? ""),
    creatorId: String(line.creator_id),
    inHouseAgencyId: context.agencyId,
    commissionBase: amount(line.commission_base),
    commissionGmv: amount(line.commission_gmv),
    creatorRevenueBeforeSplit: amount(line.creator_revenue_before_split),
    agencySplitRate: amount(line.agency_split_rate),
    agencyRevenue,
    splitRate,
    rewardAmount,
    selfShareAmount,
    paymentStatus: line.payment_status ?? null,
    orderStatus: line.order_status ?? null,
    refundStatus: line.refund_status ?? null,
  };
}

/** creator_lending_reward_items の実支払額 */
export function resolveCreatorLendingRewardItemAmount(item: {
  reward_amount?: unknown;
}): number {
  return amount(item.reward_amount);
}

/**
 * 暦年の累積での支払可否判定。
 *
 * ここは「暦年の累積でいくら残っているか」を出すだけで、
 * 支払の下限判定には使わない（既定 0円のまま）。
 * 実際の最低振込額 1,000円は支払経路で判定する
 * （lib/payments/minimum-payout.ts の CREATOR_LENDING_PAYOUT_THRESHOLD_YEN と
 *   claim_payment_batch_items の p_min_amount）。
 */
export function resolveCreatorLendingAnnualState(params: {
  annualRewardAmount: number;
  paidAmount: number;
  thresholdAmount?: number;
}): AgencyAnnualState {
  return resolveAgencyAnnualState(params);
}

/** 合計。既存の合算関数をそのまま使う */
export function sumLendingAmounts(values: number[]): number {
  return sumAgencyAmounts(values);
}
