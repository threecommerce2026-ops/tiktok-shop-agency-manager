/*
  支払の最低金額（最低支払額）。

  ■ 判定対象は「単月」ではなく「締め月までの未払い累積」
  例: 6月 600円 + 7月 600円 なら 7月末の累積は 1,200円なので支払対象になる。
  基準額に達しない分は消さず、達した時点でまとめて支払う。

  ■ 代理店にも同じ基準を適用する
  代理店分配報酬も未払い累積が 1,000円未満なら支払わず翌月へ繰り越す。
  以前は代理店だけ 0円（下限なし）だった。

  ■ 紹介制度報酬は代理店の累積に含めない
  代理店へ支払うのは代理店分配報酬だけ。判定額も agency_reward_items だけで作る。

  ■ 1000 をあちこちへ直接書かない
  画面の支払可否・支払明細の作成（claim）・承認の検証が同じ値を見るように、
  この1箇所から供給する。RPC 側は SQL なので定数を共有できないため、
  scripts/test-minimum-payout.mjs が migration の値と一致することを検証する。
*/

/** 支払の最低金額。業務ルールとして 1,000円 */
export const DEFAULT_MINIMUM_PAYOUT_YEN = 1000;

function resolveMinimumPayoutYen(raw: string | undefined): number {
  const parsed = Number(raw?.trim());
  if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed);
  return DEFAULT_MINIMUM_PAYOUT_YEN;
}

/**
 * 代理店への最低支払額。
 * AGENCY_MINIMUM_PAYOUT で上書きできる（既定 1,000円）。
 */
export const AGENCY_PAYOUT_THRESHOLD_YEN = resolveMinimumPayoutYen(
  process.env.AGENCY_MINIMUM_PAYOUT ?? process.env.NEXT_PUBLIC_AGENCY_MINIMUM_PAYOUT,
);

/** 「最低支払額未満（¥1,000）」のような表示用ラベル */
export function formatMinimumPayoutLabel(thresholdYen: number): string {
  return `最低支払額未満（¥${thresholdYen.toLocaleString("ja-JP")}）`;
}
