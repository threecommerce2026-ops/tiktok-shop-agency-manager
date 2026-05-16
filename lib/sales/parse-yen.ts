function normalizeYenInput(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .replace(/\u00a5/g, "")
    .replace(/[¥￥]/g, "")
    .replace(/円/g, "")
    .replace(/,/g, "")
    .replace(/\s/g, "");
}

/** 「2,281,428円」や数値セルなどを金額として解釈 */
export function parseYenAmount(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  const normalized = normalizeYenInput(raw);
  if (!normalized) return 0;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : 0;
}

export function parseIntegerAmount(raw: unknown): number {
  return Math.round(parseYenAmount(raw));
}

export function tryParseYenAmount(
  raw: unknown,
): { ok: true; value: number } | { ok: false } {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return { ok: true, value: raw };
  }
  const source = String(raw ?? "").trim();
  if (!source) return { ok: false };
  const normalized = normalizeYenInput(raw);
  if (!normalized) return { ok: false };
  const value = Number(normalized);
  if (!Number.isFinite(value)) return { ok: false };
  return { ok: true, value };
}
