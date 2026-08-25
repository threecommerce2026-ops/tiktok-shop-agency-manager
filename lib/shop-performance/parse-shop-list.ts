import {
  normalizeShopName,
  parseConversionRatePct,
  parseIntegerField,
  parseYenAmount,
} from "@/lib/shop-performance/normalize";

export type ShopListParsedRow = {
  shopName: string;
  shopNameNormalized: string;
  gmvAmount: number;
  itemsSold: number | null;
  liveGmvAmount: number | null;
  videoGmvAmount: number | null;
  affiliateGmvAmount: number | null;
  avgCustomers: number | null;
  refundAmount: number | null;
  impressions: number | null;
  avgVisitors: number | null;
  avgConversionRatePct: number | null;
  /** Empty-header column (col index 5). Kept for raw only — never used for billing. */
  unnamedCol6Amount: number | null;
  raw: Record<string, unknown>;
};

export type ShopListParseFailure = {
  rowNumber: number;
  shopName: string | null;
  reason: string;
};

export type ShopListParseResult = {
  rows: ShopListParsedRow[];
  failures: ShopListParseFailure[];
};

const HEADER_ALIASES = {
  shopName: ["shop name"],
  gmv: ["gmv"],
  itemsSold: ["items sold"],
  liveGmv: ["live-attributed gmv", "live attributed gmv"],
  videoGmv: ["video-attributed gmv", "video attributed gmv"],
  affiliateGmv: ["affiliate gmv"],
  avgCustomers: ["avg customers"],
  refunds: ["refunds"],
  impressions: ["impressions"],
  avgVisitors: ["avg visitors"],
  avgConversion: ["avg conversion rate"],
} as const;

function normHeader(h: unknown): string {
  return String(h ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function findCol(headers: string[], aliases: readonly string[]): number {
  for (let i = 0; i < headers.length; i++) {
    if (aliases.includes(headers[i])) return i;
  }
  return -1;
}

/**
 * Parse Partner Center Shop ranking sheet (header row + data).
 * Column index 5 may have empty header with yen values — stored as unnamed_col_6 only.
 */
export function parseShopRankingTable(table: unknown[][]): ShopListParseResult {
  if (!table.length) {
    return { rows: [], failures: [{ rowNumber: 0, shopName: null, reason: "空のシートです" }] };
  }

  const headerCells = (table[0] ?? []).map(normHeader);
  const idx = {
    shopName: findCol(headerCells, HEADER_ALIASES.shopName),
    gmv: findCol(headerCells, HEADER_ALIASES.gmv),
    itemsSold: findCol(headerCells, HEADER_ALIASES.itemsSold),
    liveGmv: findCol(headerCells, HEADER_ALIASES.liveGmv),
    videoGmv: findCol(headerCells, HEADER_ALIASES.videoGmv),
    affiliateGmv: findCol(headerCells, HEADER_ALIASES.affiliateGmv),
    avgCustomers: findCol(headerCells, HEADER_ALIASES.avgCustomers),
    refunds: findCol(headerCells, HEADER_ALIASES.refunds),
    impressions: findCol(headerCells, HEADER_ALIASES.impressions),
    avgVisitors: findCol(headerCells, HEADER_ALIASES.avgVisitors),
    avgConversion: findCol(headerCells, HEADER_ALIASES.avgConversion),
  };

  if (idx.shopName < 0 || idx.gmv < 0) {
    return {
      rows: [],
      failures: [
        {
          rowNumber: 1,
          shopName: null,
          reason: "必須ヘッダー Shop name / GMV が見つかりません",
        },
      ],
    };
  }

  // Empty header at index 5 in known export layout
  let unnamedCol6 = -1;
  for (let i = 0; i < headerCells.length; i++) {
    if (headerCells[i] === "" && i === 5) {
      unnamedCol6 = i;
      break;
    }
  }
  if (unnamedCol6 < 0) {
    for (let i = 0; i < headerCells.length; i++) {
      if (headerCells[i] === "") {
        unnamedCol6 = i;
        break;
      }
    }
  }

  const rows: ShopListParsedRow[] = [];
  const failures: ShopListParseFailure[] = [];

  for (let r = 1; r < table.length; r++) {
    const line = table[r] ?? [];
    const isEmpty = line.every(
      (c) => c == null || String(c).trim() === "",
    );
    if (isEmpty) continue;

    const shopName = String(line[idx.shopName] ?? "").trim();
    const gmvAmount = parseYenAmount(line[idx.gmv]);

    if (!shopName) {
      failures.push({
        rowNumber: r + 1,
        shopName: null,
        reason: "Shop name が空です",
      });
      continue;
    }
    if (gmvAmount == null) {
      failures.push({
        rowNumber: r + 1,
        shopName,
        reason: "GMV を数値に変換できません",
      });
      continue;
    }

    const raw: Record<string, unknown> = {};
    for (let c = 0; c < Math.max(headerCells.length, line.length); c++) {
      const key = headerCells[c] ? headerCells[c] : `unnamed_col_${c}`;
      raw[key] = line[c] ?? null;
    }
    if (unnamedCol6 >= 0) {
      raw.unnamed_col_6 = line[unnamedCol6] ?? null;
    }

    rows.push({
      shopName,
      shopNameNormalized: normalizeShopName(shopName),
      gmvAmount,
      itemsSold:
        idx.itemsSold >= 0 ? parseIntegerField(line[idx.itemsSold]) : null,
      liveGmvAmount:
        idx.liveGmv >= 0 ? parseYenAmount(line[idx.liveGmv]) : null,
      videoGmvAmount:
        idx.videoGmv >= 0 ? parseYenAmount(line[idx.videoGmv]) : null,
      affiliateGmvAmount:
        idx.affiliateGmv >= 0 ? parseYenAmount(line[idx.affiliateGmv]) : null,
      avgCustomers:
        idx.avgCustomers >= 0 ? parseYenAmount(line[idx.avgCustomers]) : null,
      refundAmount:
        idx.refunds >= 0 ? parseYenAmount(line[idx.refunds]) : null,
      impressions:
        idx.impressions >= 0 ? parseIntegerField(line[idx.impressions]) : null,
      avgVisitors:
        idx.avgVisitors >= 0 ? parseYenAmount(line[idx.avgVisitors]) : null,
      avgConversionRatePct:
        idx.avgConversion >= 0
          ? parseConversionRatePct(line[idx.avgConversion])
          : null,
      unnamedCol6Amount:
        unnamedCol6 >= 0 ? parseYenAmount(line[unnamedCol6]) : null,
      raw,
    });
  }

  return { rows, failures };
}

export async function parseShopListFile(file: File): Promise<ShopListParseResult> {
  const name = file.name.toLowerCase();
  const isSheet =
    name.endsWith(".xlsx") ||
    name.endsWith(".xls") ||
    file.type.includes("spreadsheet") ||
    file.type === "application/vnd.ms-excel";

  if (!isSheet) {
    return {
      rows: [],
      failures: [
        {
          rowNumber: 0,
          shopName: null,
          reason: "XLSX / XLS ファイルを指定してください",
        },
      ],
    };
  }

  const buffer = await file.arrayBuffer();
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheetName =
    workbook.SheetNames.find((n) => n.trim().toLowerCase() === "shop ranking") ??
    workbook.SheetNames[0];
  if (!sheetName) {
    return {
      rows: [],
      failures: [{ rowNumber: 0, shopName: null, reason: "シートが見つかりません" }],
    };
  }
  const sheet = workbook.Sheets[sheetName];
  const table = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: "",
    raw: false,
  });
  return parseShopRankingTable(table);
}
