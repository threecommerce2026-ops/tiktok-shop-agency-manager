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

/**
 * 銭単位まで表示する金額表記。
 * 紹介者報酬は円未満を切り捨てずに保持するため、こちらを使う。
 */
export function formatYenPrecise(n: number) {
  const value = Number.isFinite(n) ? n : 0;
  const hasFraction = Math.abs(value - Math.round(value)) > 0.0001;
  return `¥${value.toLocaleString("ja-JP", {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
}
