import { agencyRewardFromRevenue } from "@/lib/revenue/calc";

/*
  紹介・代理店まわりの補助定数。

  紹介者報酬の計算そのものは
  lib/referrals/referral-reward-engine.ts が単一ソース。
  ここに計算ロジックを増やさないこと。
*/

export function agencyRewardFromEligibleProfit(
  profitAmount: number,
  commissionRatePercent: number,
): number {
  return agencyRewardFromRevenue(profitAmount, commissionRatePercent);
}
