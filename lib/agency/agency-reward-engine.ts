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

  ■ 端末貸し出し（アカウント貸出）報酬（2026-10-09 確定）
  区分 account_management_type = 'account_lending' のクリエイターは、
  TikTok 側で AK = 100% になっており AP の全額がいったん自社へ入る。
  この AP に分配率を掛けたものを貸し出し先へ支払う。

      貸し出し先 = AP × 分配率（既定 80%）
      自社       = AP − 貸し出し先

  計算元（AP）・対象注文判定・丸め・月次集計・支払経路は
  通常の代理店報酬とまったく同じものを使う。
  違うのは「分配率を掛けるかどうか」だけで、別エンジンは作らない。

  分配率はクリエイターごと・月ごとに
  creator_monthly_agency_assignments.lending_split_rate で上書きできる。
  未設定なら ACCOUNT_LENDING_SPLIT_RATE。
  0 < rate <= 1 に収まらない値は報酬を作らない（既定値へ丸めない）。

  貸し出し先が月別確定されていない月は計算しない。
  暫定の現在所属で支払予定を作ると、分配先を間違えたまま
  振込まで進む可能性があるため。

  紹介者報酬5%とは完全に別制度。account_lending は従来どおり
  5%の対象外（lib/creators/account-management-type.ts）。

  ■ TAP
  TAP 収益は代理店報酬に含めない。
  端末貸し出し報酬も AP だけを基準にし、TAP は混ぜない。

  ■ 一意性
  affiliate_order_lines.source_row_key。

  ■ 検証値（2026-05〜2026-08）
  代理店報酬 27,456.00 円 = AP合計 / 対象明細 1,549 行 / 15 クリエイター / 9 代理店
*/

import { THREE_INC_AGENCY_NAME } from "@/lib/revenue/in-house-creator";
import {
  isConfirmedAssignment,
  type AgencyAssignment,
} from "@/lib/agency/agency-assignment";
import { normalizeAccountManagementType } from "@/lib/creators/account-management-type";
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

/*
  報酬の種類。

  agency          通常の代理店報酬。AP を100%支払う（従来どおり）。
  account_lending 端末貸し出し（アカウント貸出）報酬。
                  同じ AP に分配率を掛けて貸出先へ支払う。

  紹介者報酬5%は referral_reward_items 側の別制度で、ここには入らない。

  ■ lib/db/payment-queries.ts の RewardKind と混同しないこと
  あちらは支払明細の中で
    agency   … agency_reward_items 由来
    referral … referral_reward_items 由来
  という「どのテーブル由来か」の区別。

  こちらは agency_reward_items の中での
    agency          … 通常の代理店報酬
    account_lending … 端末貸し出し報酬
  という区別で、軸が違う。
*/
export const AGENCY_REWARD_KINDS = ["agency", "account_lending"] as const;

export type AgencyRewardKind = (typeof AGENCY_REWARD_KINDS)[number];

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
  /** 通常の代理店報酬か、端末貸し出し報酬か */
  rewardKind: AgencyRewardKind;
  /**
   * 端末貸し出しで実際に適用した分配率（0 < rate <= 1）。
   * 通常の代理店報酬では null。
   * 後から既定値を変えても過去の支払根拠が辿れるよう、明細に残す。
   */
  lendingSplitRate: number | null;
};

/**
 * 1行の計算に渡す、対象月のクリエイター設定。
 *
 * 省略した場合は accountManagementType = 'standard' として扱われ、
 * 従来どおり AP を100%支払う通常の代理店報酬になる。
 * 既存の呼び出しの挙動を変えないため、すべて任意。
 */
export type AgencyRewardOptions = {
  /** 対象月のクリエイター区分。月別確定値を渡すこと */
  accountManagementType?: string | null;
  /** 対象月の分配率の個別設定。未設定なら ACCOUNT_LENDING_SPLIT_RATE */
  lendingSplitRate?: number | string | null;
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

/*
  端末貸し出しの既定分配率。

  ■ 業務ルール（2026-10-09 確定）
  貸し出し先 80% / 自社 20%。

  TikTok 側では AK（agency_split_rate）が 100% になっており、
  AP の全額がいったん自社へ入る。その AP に対してこの率を掛けたものを
  貸し出し先へ支払う。AK は計算に使わない（通常の代理店報酬と同じ方針）。

  クリエイターごと・月ごとに
  creator_monthly_agency_assignments.lending_split_rate で上書きできる。
  未設定ならこの既定値を使う。
*/
export const ACCOUNT_LENDING_SPLIT_RATE = 0.8;

/**
 * 分配率を解決する。
 *
 * 未設定（null / undefined / 空文字）は既定の 80%。
 * それ以外で 0 < rate <= 1 に収まらない値は不正として null を返す。
 *
 * 不正値を既定値へ丸めない。「80」のような % 表記の混入を
 * 0.8 と解釈してしまうと支払額が 100 倍になるため、
 * 計算させずに報酬を作らない（fail-closed）。
 */
export function resolveLendingSplitRate(
  override: number | string | null | undefined,
): number | null {
  if (override == null || override === "") return ACCOUNT_LENDING_SPLIT_RATE;

  const parsed = Number(override);
  if (!Number.isFinite(parsed)) return null;
  if (parsed <= 0 || parsed > 1) return null;

  return parsed;
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
 *
 * options を渡さない呼び出しは従来どおり「AP を100%」の通常代理店報酬。
 * options.accountManagementType = 'account_lending' のときだけ
 * 端末貸し出し報酬（AP × 分配率）になる。
 */
export function computeAgencyReward(
  line: AgencyOrderLine,
  assignment: AgencyAssignment,
  options: AgencyRewardOptions = {},
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
  const apAmount = amount(line.agency_revenue);
  if (apAmount <= 0) return null;

  /*
    区分で報酬の種類を分ける。計算元（AP）と対象判定はどちらも同じ。

      standard         → AP を100%（従来どおり）
      account_lending  → AP × 分配率を貸し出し先へ
      self_operated    → 報酬を作らない
  */
  const accountType = normalizeAccountManagementType(options.accountManagementType);

  if (accountType === "self_operated") return null;

  let rewardKind: AgencyRewardKind = "agency";
  let lendingSplitRate: number | null = null;
  let rewardAmount = apAmount;

  if (accountType === "account_lending") {
    /*
      未確定の貸し出し先へ自動で支払予定を作らない（2026-10-09 確定）。

      通常の代理店報酬は creators.agency_id への暫定フォールバック（current）
      でも計算するが、端末貸し出しは「どこへ分配するか」が収益の帰属そのもの
      なので、対象月の所属が月別確定（monthly）されているときだけ計算する。
    */
    if (!isConfirmedAssignment(assignment.source)) return null;

    const rate = resolveLendingSplitRate(options.lendingSplitRate);
    if (rate == null) return null;

    rewardKind = "account_lending";
    lendingSplitRate = rate;
    rewardAmount = roundAgencyAmount(apAmount * rate);

    if (rewardAmount <= 0) return null;
  }

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
    rewardKind,
    lendingSplitRate,
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
