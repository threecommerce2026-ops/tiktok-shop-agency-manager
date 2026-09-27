import {
  isPayoutEligibleOrderLine,
  type OrderLineStatusFields,
} from "@/lib/revenue/order-line-status";

/*
  紹介者報酬の元データを「TAP だけ」に定める。

  ■ 業務ルール（2026-09-27 確定）
  紹介者報酬の正データソースは tap_affiliate_order_lines。
  affiliate_order_lines は紹介者報酬の計算元として使わない。
  両者は同じ注文を別のキーで持っているため、合算すると二重計上になる
  （order_id + product_id + sku_id で 8,606 行が重複していた）。

  ■ 状態の判定は既存の共通関数に任せる
  TAP の値は Production の実データから確認した:
    payment_status : 支払い済み / 未払い
    order_status   : 決済済み
    refund_status  : いいえ / はい
  既存の lib/revenue/order-line-status.ts がこの3つとも解釈できるため、
  ここで文字列を再定義しない。判定を二重に持つと片方だけ直されて食い違う。
*/

/** 紹介者報酬の元になる TAP 明細 */
export type TapReferralSourceLine = OrderLineStatusFields & {
  source_row_key: string | null;
  order_id: string | null;
  product_id: string | null;
  creator_id: string | null;
  target_month: string | null;
  /** 紹介者報酬の計算基準額。TAP の「成果報酬ベース」 */
  commission_base: number | string | null;
};

export type TapLineExclusionReason =
  | "no_creator"
  | "no_source_key"
  | "no_target_month"
  | "not_payout_eligible"
  | "base_not_positive";

/**
 * この TAP 明細を紹介者報酬の対象にしてよいか。
 * 対象外なら理由を返す（黙って落とさず、取込プレビューで件数を見せるため）。
 */
export function tapLineExclusionReason(
  line: TapReferralSourceLine,
): TapLineExclusionReason | null {
  if (!line.creator_id) return "no_creator";
  if (!line.source_row_key) return "no_source_key";
  if (!line.target_month) return "no_target_month";
  // 決済済み・返金なし・支払い済み。判定は共通関数が持つ
  if (!isPayoutEligibleOrderLine(line)) return "not_payout_eligible";

  const base = Number(line.commission_base ?? 0);
  if (!Number.isFinite(base) || base <= 0) return "base_not_positive";

  return null;
}

/** 紹介者報酬の対象となる TAP 明細か */
export function isTapReferralSourceLine(line: TapReferralSourceLine): boolean {
  return tapLineExclusionReason(line) === null;
}

export const TAP_EXCLUSION_LABEL: Record<TapLineExclusionReason, string> = {
  no_creator: "クリエイター未紐付け",
  no_source_key: "明細キーなし",
  no_target_month: "対象月なし",
  not_payout_eligible: "未決済 / 未払い / 返金済み",
  base_not_positive: "成果報酬ベースが0以下",
};
