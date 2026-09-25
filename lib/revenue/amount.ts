/**
 * DBから読んだ数値カラムを安全に number へ変換する。
 * null / undefined / 非数値は 0 として扱う。
 */
export function toAmount(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
