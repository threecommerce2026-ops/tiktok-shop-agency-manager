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

/*
  端末貸し出し報酬（クリエイター本人）の最低振込額。

  ■ 業務ルール（2026-10-11 確定 / 2026-10-12 下限を保護）
  1,000円。未払報酬と繰越残高の合計が 1,000円未満なら振り込まない。
  達しない分は失効・切り捨てせず、未払明細のまま翌月以降へ繰り越し、
  次回の支払候補に合算する（代理店・紹介者と同じ考え方）。

  判定対象は「未払明細の合計 + 繰越残高」。
  繰越残高は 1円未満の端数（lib/payments/creator-lending-rounding.ts）なので、
  境界では端数まで含めて判定する（例: 明細 999.80 + 繰越 0.30 = 1,000.10 → 支払対象）。

  ■ 1,000円より下へは設定できない
  CREATOR_LENDING_MINIMUM_PAYOUT で上書きできるのは「引き上げ」だけ。
  1,000円未満の値・0・負数・不正な文字列を入れても 1,000円に戻す。
  確定した業務ルールを環境変数の設定ミスで下回らせないため。

  同じ下限を次の3か所で守る。
    ① ここ（TypeScript の定数）
    ② lib/payments/creator-lending-rounding.ts（判定の単一ソース）
    ③ claim_payment_batch_items の creator 分岐（DB 側で greatest で丸める）
  画面・Server Action・RPC のどこから来ても 1,000円未満では支払えない。

  ■ 代理店・紹介者とは別の定数にしておく
  値は同じ 1,000円だが、別制度なので定数を分ける。
  片方だけ変える指示が来たときに巻き込み事故を起こさないため。
  代理店・紹介者側（AGENCY_MINIMUM_PAYOUT / REFERRAL_PAYOUT_THRESHOLD_YEN）の
  挙動はこの変更で何も変わらない（従来どおり引き下げも効く）。
*/

/** 端末貸し出し報酬の最低振込額の下限。これより下へは設定できない */
export const CREATOR_LENDING_MINIMUM_PAYOUT_FLOOR = 1000;

/**
 * 端末貸し出し報酬の最低振込額を解決する。
 *
 * 引き上げだけを受け付け、下限（1,000円）を下回る指定は下限へ丸める。
 * 不正な値（空・非数値・0・負数）も下限になる。
 */
export function resolveCreatorLendingMinimumPayout(
  raw: string | number | undefined | null,
): number {
  const parsed = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());

  if (!Number.isFinite(parsed)) return CREATOR_LENDING_MINIMUM_PAYOUT_FLOOR;

  /* 下回る指定は無効（引き上げのみ許す） */
  return Math.max(CREATOR_LENDING_MINIMUM_PAYOUT_FLOOR, Math.round(parsed));
}

export const CREATOR_LENDING_PAYOUT_THRESHOLD_YEN = resolveCreatorLendingMinimumPayout(
  process.env.CREATOR_LENDING_MINIMUM_PAYOUT ??
    process.env.NEXT_PUBLIC_CREATOR_LENDING_MINIMUM_PAYOUT,
);

/** 「最低支払額未満（¥1,000）」のような表示用ラベル */
export function formatMinimumPayoutLabel(thresholdYen: number): string {
  return `最低支払額未満（¥${thresholdYen.toLocaleString("ja-JP")}）`;
}
