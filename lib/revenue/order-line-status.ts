/*
  affiliate_order_lines / tap_affiliate_order_lines の
  ステータス判定の単一ソース。

  同じ判定をクエリごとに書かないこと。
*/

/** 決済済みと判定する order_status */
const SETTLED_ORDER_STATUSES = new Set(["決済済み", "settled", "completed"]);

/** 実際に支払われたと判定する payment_status */
const PAID_PAYMENT_STATUSES = new Set(["支払い済み", "paid", "settled"]);

/** 返金済みと判定する refund_status */
const REFUNDED_STATUSES = new Set([
  "はい",
  "fully_refunded",
  "refunded",
  "true",
  "yes",
]);

export type OrderLineStatusFields = {
  order_status?: string | null;
  payment_status?: string | null;
  refund_status?: string | null;
};

function matches(set: Set<string>, value: string | null | undefined): boolean {
  const raw = String(value ?? "").trim();
  if (!raw) return false;
  return set.has(raw) || set.has(raw.toLowerCase());
}

function isSettledOrderStatus(value: string | null | undefined): boolean {
  return matches(SETTLED_ORDER_STATUSES, value);
}

function isPaidOrderPaymentStatus(value: string | null | undefined): boolean {
  return matches(PAID_PAYMENT_STATUSES, value);
}

/**
 * 返金判定の共通ヘルパー（このモジュールが唯一の正）。
 *
 * 判定対象の refund_status の値:
 *   "はい" / "fully_refunded" / "refunded" / "true" / "yes"
 * 大文字小文字と前後の空白は無視する。
 *
 * 売上集計（isCountedOrderLine）と代理店報酬
 * （isAgencyPayoutEligibleOrderLine）の両方がこの1関数を使う。
 * 返金判定を各所で書き直さないこと。
 */
export function isRefundedOrderLine(line: OrderLineStatusFields): boolean {
  return isRefundedOrderStatus(line.refund_status);
}

function isRefundedOrderStatus(value: string | null | undefined): boolean {
  return matches(REFUNDED_STATUSES, value);
}

/**
 * 売上・GMV・代理店収益の集計対象となる明細か。
 * 決済済み、かつ返金済みでないもの。
 */
export function isCountedOrderLine(line: OrderLineStatusFields): boolean {
  if (!isSettledOrderStatus(line.order_status)) return false;
  if (isRefundedOrderLine(line)) return false;
  return true;
}

/**
 * 紹介者報酬の計算対象となる明細か。
 * 集計対象であることに加えて、TikTok 側で実際に支払われたもののみ。
 *
 *   order_status   = 決済済み
 *   payment_status = 支払い済み（CAPの AU「支払い状況」）
 *   refund_status != はい / fully_refunded
 *
 * 検証値: 紹介者報酬 115,456.75円（Commission Base 2,309,135円 / 2026-05〜08）
 */
export function isPayoutEligibleOrderLine(line: OrderLineStatusFields): boolean {
  if (!isCountedOrderLine(line)) return false;
  return isPaidOrderPaymentStatus(line.payment_status);
}

/**
 * 代理店報酬の計算対象となる明細か。
 *
 * ■ 業務ルール（2026-09-24 改定）
 *   AU「支払い状況」= 支払い済み  かつ  返金済みではない
 *
 * 改定前は AU のみで判定しており、返金済みの明細も代理店報酬の対象だった。
 * 売上集計と同じく返金分は支払対象外にする方針へ変更した。
 *
 * ■ isCountedOrderLine を再利用しない理由
 * isCountedOrderLine は order_status = 決済済み を必須にする「売上集計」用で、
 * 代理店報酬の条件（AU ベース）とは概念が異なる。
 * 返金判定だけを共通ヘルパー isRefundedOrderLine から借りる。
 *
 * payment_status カラムには CAP の AU「支払い状況」が入る
 * （order_status カラムは CAP の「注文の決済状況」であり AU ではない）。
 *
 * 代理店の特定可否と AP の金額有無は呼び出し側で判定する。
 * 報酬額は AP（agency_revenue）を100%使用し、AK は掛けない。
 *
 * 検証値: 27,456.00円 / 1,549行（改定前・2026-05〜08）
 */
export function isAgencyPayoutEligibleOrderLine(
  line: OrderLineStatusFields,
): boolean {
  if (!isPaidOrderPaymentStatus(line.payment_status)) return false;
  if (isRefundedOrderLine(line)) return false;
  return true;
}
