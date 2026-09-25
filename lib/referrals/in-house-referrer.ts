/*
  自社紹介者（（株）3）の判定。

  ■ なぜフラグで持つか
  代理店側は THREE.inc を名前文字列で判定している
  （lib/revenue/in-house-creator.ts）。
  名称変更・紹介者統合で壊れるため、紹介者側では DB のフラグ
  referrers.is_in_house を唯一の根拠にする。

  ■ 自社紹介分の扱い
    報酬実績（referral_reward_items）… 通常どおり作る
    外部への支払（referral_payouts）  … 作らない
    支払対象額・支払可能紹介者数        … 含めない

  報酬計算そのもの（対象明細・料率・金額）は外部紹介者と同じ。
  「実績として集計するが、社外へは振り込まない」という区別だけを行う。
*/

export type InHouseReferrerFields = {
  is_in_house?: boolean | null;
};

/** 自社の紹介者か */
export function isInHouseReferrer(
  referrer: InHouseReferrerFields | null | undefined,
): boolean {
  return referrer?.is_in_house === true;
}

/** 自社紹介者の id 集合を作る（判定を都度書かないための共通処理） */
export function collectInHouseReferrerIds(
  referrers: Array<{ id: string; is_in_house?: boolean | null }>,
): Set<string> {
  const ids = new Set<string>();
  for (const referrer of referrers) {
    if (isInHouseReferrer(referrer)) ids.add(referrer.id);
  }
  return ids;
}
