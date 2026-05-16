/** 代理店報酬 = 収益金額 × (分配率 / 100) */
export function agencyRewardFromRevenue(
  revenueYen: number,
  splitPercent: number,
): number {
  if (!Number.isFinite(revenueYen) || !Number.isFinite(splitPercent)) return 0;
  return Math.round(revenueYen * (splitPercent / 100));
}

export function formatYen(n: number) {
  return `¥${n.toLocaleString("ja-JP")}`;
}

export function formatPercent(n: number) {
  return `${n}%`;
}
