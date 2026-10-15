import { roundAgencyAmount } from "@/lib/agency/agency-reward-engine";
import {
  CREATOR_LENDING_MINIMUM_PAYOUT_FLOOR,
  CREATOR_LENDING_PAYOUT_THRESHOLD_YEN,
} from "@/lib/payments/minimum-payout";

/*
  端末貸し出し報酬の最低振込額と振込端数の繰越。

  ■ 業務ルールとして確定済み
  次のすべてが確定仕様（最低振込額は 2026-10-11、端数繰越は 2026-10-12 承認）。
    ・最低振込額 1,000円
    ・達しない分は失効・切り捨てせず翌月以降へ全額繰り越す
    ・振込は1円単位で切り捨て
    ・1円未満の端数は本人別の繰越残高として次回へ繰り越す
  画面にもこのルールを明示する。

  ■ なぜ必要か
  報酬は AP × 分配率で銭（小数2桁）まで出る。
      例: AP 3,771 × 0.8 = 3,016.80
  振込は1円単位なので、そのままでは振り込めない。
  四捨五入すると払い過ぎ／払い不足が発生し、合計が報酬額と合わなくなる。

  ■ 決めたこと
      振込額   = floor(明細の合計 + 繰越残高)        1円単位
      次回繰越 = 明細の合計 + 繰越残高 − 振込額       0 以上 1 未満

  切り捨てた端数は消さずに本人別の繰越残高として持ち、次回の振込に乗せる。
  これで「支払った額の累計 + 繰越残高 = 計上した報酬の累計」が常に成り立つ。

  ■ 金額の正式 source は変えない
  creator_lending_reward_items.reward_amount は銭のまま保持する。
  丸めるのは振込額（payment_batches.payment_amount）だけ。

  ■ 最低振込額 1,000円（2026-10-11 確定）
  「未払明細の合計 + 繰越残高」が 1,000円未満なら振り込まない。
  このとき明細は占有せず、繰越残高も消費しない。未払いのまま残し、
  次回の支払候補に合算する（失効も切り捨てもしない）。

      800円        → 振込なし。800円は未払明細として残る
      翌月 +500円   → 合計 1,300円 → 1,300円を振込
      999.80円     → 振込なし。999.80円が残る
      1,500.80円   → 1,500円を振込、0.80円を繰越
      1,000円      → 支払対象

  ■ 下限は 1,000円より下へ設定できない
  CREATOR_LENDING_MINIMUM_PAYOUT で上書きできるのは引き上げだけ。
  この関数に 1,000円未満を渡しても 1,000円へ丸める
  （lib/payments/minimum-payout.ts の CREATOR_LENDING_MINIMUM_PAYOUT_FLOOR）。
  DB 側（claim_payment_batch_items）も greatest で同じ下限を守る。

  ■ 1円未満しか無いときも振り込まない
  floor が 0 になる場合は支払明細を作らない（0円振込を作らない）。
  最低振込額 1,000円のもとでは到達しないが、多層防御として残す。
*/

/** 繰越残高が取り得る上限（これ以上は1円として振込に回る） */
export const CARRYOVER_MAX_EXCLUSIVE = 1;

/** 振込の最小単位（円） */
export const TRANSFER_UNIT_YEN = 1;

/**
 * 振込ルールを画面・ログに出すための文言。
 * 業務ルールとして確定済み（2026-10-11 / 2026-10-12 承認）。
 */
export const CARRYOVER_PROVISIONAL_NOTE =
  `最低振込額 ${CREATOR_LENDING_PAYOUT_THRESHOLD_YEN.toLocaleString("ja-JP")}円。` +
  "未払報酬と繰越残高の合計が最低振込額に達しない月は振り込まず、全額を翌月以降へ繰り越します。" +
  "振込額は1円単位で、1円未満の端数は本人別の繰越残高として次回へ繰り越します。";

export type CarryoverSettlement = {
  /** 明細の合計（銭のまま） */
  itemsAmount: number;
  /** 今回持ち込んだ繰越残高 */
  carryoverIn: number;
  /** 明細の合計 + 繰越残高。最低振込額の判定はこの額で行う */
  grossAmount: number;
  /** 適用した最低振込額 */
  minimumAmount: number;
  /** 実際に振り込む額（1円単位）。振り込めないときは 0 */
  transferAmount: number;
  /**
   * 次回へ持ち越す繰越残高。
   *
   * 振り込むとき      1円未満の端数（0 以上 1 未満）
   * 振り込まないとき  持ち込んだ繰越残高のまま（消費しない）
   */
  carryoverOut: number;
  /** 振込できるか（最低振込額に達し、かつ1円以上） */
  payable: boolean;
  /** 最低振込額に達していないか */
  belowMinimum: boolean;
  /** 最低振込額までの不足額（達していれば 0） */
  shortfallAmount: number;
  /**
   * 次回へ繰り越す総額。
   *
   * 振り込むとき      端数だけ
   * 振り込まないとき  未払明細 + 繰越残高の全額（失効させない）
   */
  carryForwardAmount: number;
};

function normalize(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return roundAgencyAmount(parsed);
}

/**
 * 振込額と次回繰越を計算する。
 *
 * 金額はいずれも銭単位（小数2桁）に正規化してから扱う。
 * 浮動小数の誤差で 2,999.9999... を 2,999 にしないため、
 * 切り捨ての前に 1 銭へ丸める。
 */
export function resolveCarryoverSettlement(params: {
  itemsAmount: number;
  carryoverIn?: number | null;
  /**
   * 最低振込額。省略時は業務ルールの 1,000円。
   *
   * 1,000円未満を渡しても 1,000円へ丸める（確定した下限を下回らせない）。
   * 呼び出し側の設定ミスや環境変数の誤設定で支払えてしまわないよう、
   * 判定の単一ソースであるここで必ず守る。
   */
  minimumAmount?: number | null;
}): CarryoverSettlement {
  const itemsAmount = normalize(params.itemsAmount);
  const carryoverIn = normalize(params.carryoverIn);
  const grossAmount = roundAgencyAmount(itemsAmount + carryoverIn);

  const requested =
    params.minimumAmount == null || !Number.isFinite(Number(params.minimumAmount))
      ? CREATOR_LENDING_PAYOUT_THRESHOLD_YEN
      : normalize(params.minimumAmount);

  /* 下限（1,000円）より下へは落とさない */
  const minimumAmount = Math.max(CREATOR_LENDING_MINIMUM_PAYOUT_FLOOR, requested);

  /*
    振り込めない場合は何も動かさない。
    繰越残高は消費せず、未払明細もそのまま残す（次回へ全額繰り越す）。
      ・金額が 0 以下（返金などは別制度で扱う）
      ・最低振込額に達していない
      ・1円未満しか無い
  */
  const notPayable = (): CarryoverSettlement => ({
    itemsAmount,
    carryoverIn,
    grossAmount,
    minimumAmount,
    transferAmount: 0,
    carryoverOut: carryoverIn,
    payable: false,
    belowMinimum: grossAmount < minimumAmount,
    shortfallAmount: roundAgencyAmount(Math.max(0, minimumAmount - grossAmount)),
    /* 未払明細 + 繰越残高をそのまま翌月以降へ回す */
    carryForwardAmount: grossAmount > 0 ? grossAmount : carryoverIn,
  });

  if (grossAmount <= 0) return notPayable();
  if (grossAmount < minimumAmount) return notPayable();

  const transferAmount = Math.floor(grossAmount);
  if (transferAmount < TRANSFER_UNIT_YEN) return notPayable();

  const carryoverOut = roundAgencyAmount(grossAmount - transferAmount);

  return {
    itemsAmount,
    carryoverIn,
    grossAmount,
    minimumAmount,
    transferAmount,
    carryoverOut,
    payable: true,
    belowMinimum: false,
    shortfallAmount: 0,
    /* 振り込むときに次回へ回るのは1円未満の端数だけ */
    carryForwardAmount: carryoverOut,
  };
}

/**
 * 繰越残高が仕様の範囲に収まっているか。
 * 0 以上 1 未満。範囲外なら計上か支払処理のどこかが壊れている。
 */
export function isValidCarryoverBalance(value: number): boolean {
  const amount = normalize(value);
  return amount >= 0 && amount < CARRYOVER_MAX_EXCLUSIVE;
}

/**
 * 「支払った累計 + 繰越残高 = 計上した累計」が成り立つか。
 *
 * 繰越の実装が正しいかを検算するために使う（テストと画面の整合確認）。
 * 許容差は 1 銭（numeric と JavaScript の丸め差を吸収する）。
 */
export function isCarryoverConsistent(params: {
  rewardTotal: number;
  transferredTotal: number;
  carryoverBalance: number;
}): boolean {
  const expected = roundAgencyAmount(
    normalize(params.transferredTotal) + normalize(params.carryoverBalance),
  );
  return Math.abs(expected - normalize(params.rewardTotal)) <= 0.01;
}
