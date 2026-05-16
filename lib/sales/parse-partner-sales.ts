import type { ImportRowFailure } from "@/lib/csv/import-sales-result";
import {
  COMMISSION_BASE_COLUMN_ALIASES,
  CREATOR_NAME_COLUMN_ALIASES,
  ORDER_COUNT_COLUMN_ALIASES,
  PROFIT_AMOUNT_COLUMN_ALIASES,
  SALES_AMOUNT_COLUMN_ALIASES,
  TARGET_MONTH_COLUMN_ALIASES,
  TIKTOK_ID_COLUMN_ALIASES,
} from "@/lib/sales/partner-export-columns";
import { parseIntegerAmount, parseYenAmount, tryParseYenAmount } from "@/lib/sales/parse-yen";
import { normalizeTargetMonth } from "@/lib/sales/target-month";

export type ParsedSalesRow = {
  rowNumber: number;
  tiktokId: string;
  creatorName: string;
  salesYen: number;
  profitYen: number;
  orderCount: number;
  commissionBase: number;
};

export type PartnerSalesParseResult = {
  rows: ParsedSalesRow[];
  failures: ImportRowFailure[];
};

function normalizeHeaderCell(raw: unknown): string {
  return String(raw ?? "")
    .replace(/^\ufeff/, "")
    .trim()
    .toLowerCase()
    .replace(/_/g, " ");
}

export function normalizeTiktokId(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@/, "");
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQ = !inQ;
    } else if ((ch === "," && !inQ) || ch === "\r") {
      result.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  result.push(cur.trim());
  return result;
}

function rowToStrings(row: unknown[]): string[] {
  return row.map((cell) => String(cell ?? "").trim());
}

function headerIndex(header: string[], aliases: readonly string[]): number {
  const normalized = header.map(normalizeHeaderCell);
  return aliases.reduce(
    (acc, alias) =>
      acc >= 0 ? acc : normalized.findIndex((h) => h === normalizeHeaderCell(alias)),
    -1,
  );
}

function hasMinimumPartnerHeaders(header: string[]): boolean {
  return (
    headerIndex(header, TIKTOK_ID_COLUMN_ALIASES) >= 0 &&
    headerIndex(header, SALES_AMOUNT_COLUMN_ALIASES) >= 0
  );
}

function findHeaderRowIndex(rows: unknown[][]): number {
  for (let i = 0; i < rows.length; i++) {
    const header = rowToStrings(rows[i] ?? []);
    if (hasMinimumPartnerHeaders(header)) return i;
  }
  return -1;
}

export function parsePartnerSalesTable(rows: unknown[][]): PartnerSalesParseResult {
  const failures: ImportRowFailure[] = [];
  if (!rows.length) return { rows: [], failures };

  const headerRowIndex = findHeaderRowIndex(rows);
  if (headerRowIndex < 0) return { rows: [], failures };

  const header = rowToStrings(rows[headerRowIndex] ?? []);
  const nicknameI = headerIndex(header, CREATOR_NAME_COLUMN_ALIASES);
  const usernameI = headerIndex(header, TIKTOK_ID_COLUMN_ALIASES);
  const gmvI = headerIndex(header, SALES_AMOUNT_COLUMN_ALIASES);
  const itemsI = headerIndex(header, ORDER_COUNT_COLUMN_ALIASES);
  const commissionI = headerIndex(header, PROFIT_AMOUNT_COLUMN_ALIASES);
  const baseI = headerIndex(header, COMMISSION_BASE_COLUMN_ALIASES);
  const monthI = headerIndex(header, TARGET_MONTH_COLUMN_ALIASES);

  if (usernameI < 0 || gmvI < 0) {
    return { rows: [], failures };
  }

  const out: ParsedSalesRow[] = [];
  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const rowNumber = i + 1;
    const cols = rowToStrings(rows[i] ?? []);
    if (!cols.some((c) => c.length > 0)) continue;

    if (monthI >= 0) {
      const monthRaw = cols[monthI] ?? "";
      if (monthRaw && !normalizeTargetMonth(monthRaw)) {
        failures.push({ rowNumber, error: "月が不正" });
        continue;
      }
    }

    const tiktokId = normalizeTiktokId(cols[usernameI] ?? "");
    if (!tiktokId) {
      failures.push({ rowNumber, error: "TikTok ID 空欄" });
      continue;
    }

    const salesParsed = tryParseYenAmount(cols[gmvI]);
    if (!salesParsed.ok) {
      failures.push({ rowNumber, error: "売上金額が数値でない" });
      continue;
    }

    const creatorName =
      (nicknameI >= 0 ? (cols[nicknameI] ?? "").trim() : "") || tiktokId;

    out.push({
      rowNumber,
      tiktokId,
      creatorName,
      salesYen: salesParsed.value,
      profitYen:
        commissionI >= 0 ? parseYenAmount(cols[commissionI]) : 0,
      orderCount:
        itemsI >= 0 ? parseIntegerAmount(cols[itemsI]) : 0,
      commissionBase: baseI >= 0 ? parseYenAmount(cols[baseI]) : 0,
    });
  }

  return { rows: out, failures };
}

export function parsePartnerSalesCsv(text: string): PartnerSalesParseResult {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return { rows: [], failures: [] };

  const rows = lines.map((line) => parseCsvLine(line));
  return parsePartnerSalesTable(rows);
}
