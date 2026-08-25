/** Shop name / identity helpers for Partner Center ShopList imports. */

export function normalizeShopName(raw: string): string {
  return raw
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function identityKeyForName(normalizedShopName: string): string {
  return `name:${normalizedShopName}`;
}

export function identityKeyForSeller(sellerId: string): string {
  return `seller:${sellerId}`;
}

/** Strip yen symbol / commas / spaces → number. Returns null if empty/invalid. */
export function parseYenAmount(raw: unknown): number | null {
  if (raw == null) return null;
  const s = String(raw)
    .trim()
    .replace(/円/g, "")
    .replace(/,/g, "")
    .replace(/\s/g, "")
    .replace(/￥/g, "")
    .replace(/¥/g, "");
  if (!s || s === "-" || s === "—") return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return n;
}

export function parseIntegerField(raw: unknown): number | null {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/,/g, "").replace(/\s/g, "");
  if (!s || s === "-" || s === "—") return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

/**
 * Avg conversion rate from export is already percent (e.g. 28.73 = 28.73%).
 * Do NOT divide by 100 for storage.
 */
export function parseConversionRatePct(raw: unknown): number | null {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/%/g, "").replace(/,/g, "");
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return n;
}

/** Parse ShopList_YYYY-MM-DD_YYYY-MM-DD from filename. */
export function parsePeriodFromShopListFilename(
  fileName: string,
): { periodStart: string; periodEnd: string } | null {
  const base = fileName.split(/[/\\]/).pop() ?? fileName;
  const m = base.match(
    /ShopList_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})/i,
  );
  if (!m) return null;
  return { periodStart: m[1], periodEnd: m[2] };
}

export function targetMonthFromPeriodEnd(periodEnd: string): string {
  return periodEnd.slice(0, 7);
}
