/** 対象月を YYYY-MM に正規化 */
export function normalizeTargetMonth(raw: string): string | null {
  const s = raw.trim().replace(/\//g, "-");
  const m = s.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/);
  if (m) {
    const y = m[1];
    const mo = String(Number(m[2])).padStart(2, "0");
    if (Number(m[2]) >= 1 && Number(m[2]) <= 12) return `${y}-${mo}`;
  }
  const m2 = s.match(/^(\d{4})(\d{2})$/);
  if (m2) {
    const mo = Number(m2[2]);
    if (mo >= 1 && mo <= 12) return `${m2[1]}-${m2[2]}`;
  }
  return null;
}
