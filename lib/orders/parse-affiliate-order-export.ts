import { buildAffiliateOrderSourceRowKey } from "@/lib/orders/affiliate-order-source-key";

export type AffiliateOrderImportRow = {
  rowNumber: number;
  sourceRowKey: string;

  orderId: string;
  skuId: string | null;
  productId: string | null;
  productName: string | null;

  productPrice: number;
  quantity: number;

  isFullyRefunded: boolean;

  creatorTiktokId: string;
  creatorTagId: string | null;

  shopName: string | null;
  shopCode: string | null;
  currency: string | null;

  orderType: string | null;
  paymentStatus: string | null;

  contentType: string | null;
  contentId: string | null;

  factorType: string | null;
  commissionType: string | null;

  standardCommissionRate: number | null;
  shopAdsCommissionRate: number | null;
  tiktokBonusCommissionRate: number | null;
  partnerBonusCommissionRate: number | null;

  commissionGmv: number;
  estimatedCommissionBase: number;
  commissionBase: number;

  creatorRevenueBeforeSplit: number;
  agencySplitRate: number | null;
  agencyRevenueBeforeTax: number;
  agencyRevenue: number;

  invitationId: string | null;

  orderedAt: string | null;
  deliveredAt: string | null;

  paymentId: string | null;
  payoutStatus: string | null;

  targetMonth: string | null;

  raw: Record<string, unknown>;
};

export type AffiliateOrderParseResult = {
  rows: AffiliateOrderImportRow[];
  failures: Array<{
    rowNumber: number;
    error: string;
  }>;
};

const REQUIRED_HEADERS = [
  "注文ID",
  "SKU ID",
  "商品ID",
  "商品名",
  "価格",
  "数量",
  "クリエイターのユーザー名",
  "ショップ名",
  "ショップコード",
  "注文の決済状況",
  "成果報酬GMV",
  "成果報酬ベース",
  "収益分配前のクリエイター収益",
  "エージェンシーの収益総額",
  "作成日時",
  "支払い状況",
] as const;

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function nullableText(value: unknown): string | null {
  const valueText = text(value);
  return valueText || null;
}

function numberValue(value: unknown): number {
  const normalized = text(value)
    .replace(/[￥¥円,\s]/g, "")
    .replace(/[^\d.-]/g, "");

  if (!normalized) return 0;

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableRate(value: unknown): number | null {
  const raw = text(value);
  if (!raw) return null;

  const normalized = raw.replace("%", "").replace(/,/g, "").trim();
  const parsed = Number(normalized);

  return Number.isFinite(parsed) ? parsed : null;
}

function japaneseDateToIso(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;

  // Partner Center: DD/MM/YYYY HH:mm:ss
  const match = raw.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/,
  );

  if (!match) {
    const fallback = new Date(raw);
    return Number.isNaN(fallback.getTime()) ? null : fallback.toISOString();
  }

  const [, dd, mm, yyyy, hh, min, ss] = match;

  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}T${hh.padStart(
    2,
    "0",
  )}:${min}:${ss}+09:00`;
}

function monthKeyFromIso(iso: string | null): string | null {
  if (!iso) return null;

  const match = iso.match(/^(\d{4})-(\d{2})-/);
  return match ? `${match[1]}-${match[2]}` : null;
}

function buildHeaderIndex(header: unknown[]): Map<string, number> {
  const map = new Map<string, number>();

  header.forEach((cell, index) => {
    const key = text(cell);
    if (key) map.set(key, index);
  });

  return map;
}

function readCell(
  row: unknown[],
  headerIndex: Map<string, number>,
  header: string,
): unknown {
  const index = headerIndex.get(header);
  return index == null ? "" : row[index];
}

export function parseAffiliateOrderTable(
  table: unknown[][],
): AffiliateOrderParseResult {
  if (table.length === 0) {
    return { rows: [], failures: [] };
  }

  const header = table[0] ?? [];
  const headerIndex = buildHeaderIndex(header);

  const missing = REQUIRED_HEADERS.filter(
    (headerName) => !headerIndex.has(headerName),
  );

  if (missing.length > 0) {
    return {
      rows: [],
      failures: [
        {
          rowNumber: 1,
          error: `必須列がありません: ${missing.join(", ")}`,
        },
      ],
    };
  }

  const rows: AffiliateOrderImportRow[] = [];
  const failures: AffiliateOrderParseResult["failures"] = [];

  for (let i = 1; i < table.length; i += 1) {
    const source = table[i] ?? [];
    const rowNumber = i + 1;

    const orderId = text(readCell(source, headerIndex, "注文ID"));
    const skuId = nullableText(readCell(source, headerIndex, "SKU ID"));
    const productId = nullableText(readCell(source, headerIndex, "商品ID"));
    const productName = nullableText(readCell(source, headerIndex, "商品名"));

    const creatorTiktokId = text(
      readCell(source, headerIndex, "クリエイターのユーザー名"),
    ).toLowerCase();

    const contentId = nullableText(
      readCell(source, headerIndex, "コンテンツID"),
    );

    const invitationId = nullableText(
      readCell(source, headerIndex, "Invitation ID"),
    );

    if (!orderId) {
      failures.push({
        rowNumber,
        error: "注文IDがありません",
      });
      continue;
    }

    if (!creatorTiktokId) {
      failures.push({
        rowNumber,
        error: "クリエイターのユーザー名がありません",
      });
      continue;
    }

    const orderedAt = japaneseDateToIso(
      readCell(source, headerIndex, "作成日時"),
    );

    const deliveredAt = japaneseDateToIso(
      readCell(source, headerIndex, "注文配達日時"),
    );

    /*
      キー生成は lib/orders/affiliate-order-source-key.ts に集約した。
      ブラウザ側の解析とサーバー側の再検証で同じ関数を使うため。
      出力は従来と同一（trim 済み文字列を "|" で連結）。
    */
    const sourceRowKey = buildAffiliateOrderSourceRowKey({
      orderId,
      skuId,
      productId,
      creatorTiktokId,
      contentId,
      invitationId,
      factorType: text(readCell(source, headerIndex, "要因のタイプ")),
      commissionType: text(readCell(source, headerIndex, "成果報酬のタイプ")),
    });

    const raw: Record<string, unknown> = {};

    for (const [headerName, index] of headerIndex.entries()) {
      raw[headerName] = source[index] ?? null;
    }

    rows.push({
      rowNumber,
      sourceRowKey,

      orderId,
      skuId,
      productId,
      productName,

      productPrice: numberValue(
        readCell(source, headerIndex, "価格"),
      ),

      quantity: Math.max(
        0,
        Math.trunc(numberValue(readCell(source, headerIndex, "数量"))),
      ),

      isFullyRefunded:
        text(
          readCell(source, headerIndex, "すべて返品または返金済み"),
        ) === "はい",

      creatorTiktokId,

      creatorTagId: nullableText(
        readCell(source, headerIndex, "クリエイターのタグID"),
      ),

      shopName: nullableText(
        readCell(source, headerIndex, "ショップ名"),
      ),

      shopCode: nullableText(
        readCell(source, headerIndex, "ショップコード"),
      ),

      currency: nullableText(
        readCell(source, headerIndex, "通貨"),
      ),

      orderType: nullableText(
        readCell(source, headerIndex, "注文タイプ"),
      ),

      paymentStatus: nullableText(
        readCell(source, headerIndex, "注文の決済状況"),
      ),

      contentType: nullableText(
        readCell(source, headerIndex, "コンテンツタイプ"),
      ),

      contentId,

      factorType: nullableText(
        readCell(source, headerIndex, "要因のタイプ"),
      ),

      commissionType: nullableText(
        readCell(source, headerIndex, "成果報酬のタイプ"),
      ),

      standardCommissionRate: nullableRate(
        readCell(source, headerIndex, "標準成果報酬率"),
      ),

      shopAdsCommissionRate: nullableRate(
        readCell(source, headerIndex, "ショップ広告成果報酬率"),
      ),

      tiktokBonusCommissionRate: nullableRate(
        readCell(source, headerIndex, "TikTok Shopボーナス成果報酬率"),
      ),

      partnerBonusCommissionRate: nullableRate(
        readCell(source, headerIndex, "パートナーボーナス成果報酬率"),
      ),

      commissionGmv: numberValue(
        readCell(source, headerIndex, "成果報酬GMV"),
      ),

      estimatedCommissionBase: numberValue(
        readCell(source, headerIndex, "推定ベース成果報酬額"),
      ),

      commissionBase: numberValue(
        readCell(source, headerIndex, "成果報酬ベース"),
      ),

      creatorRevenueBeforeSplit: numberValue(
        readCell(source, headerIndex, "収益分配前のクリエイター収益"),
      ),

      agencySplitRate: nullableRate(
        readCell(source, headerIndex, "エージェンシー成果報酬分配の一部"),
      ),

      agencyRevenueBeforeTax: numberValue(
        readCell(source, headerIndex, "課税前のエージェンシーの収益総額"),
      ),

      agencyRevenue: numberValue(
        readCell(source, headerIndex, "エージェンシーの収益総額"),
      ),

      invitationId,

      orderedAt,
      deliveredAt,

      paymentId: nullableText(
        readCell(source, headerIndex, "支払いID"),
      ),

      payoutStatus: nullableText(
        readCell(source, headerIndex, "支払い状況"),
      ),

      targetMonth: monthKeyFromIso(orderedAt),

      raw,
    });
  }

  return {
    rows,
    failures,
  };
}

export async function parseAffiliateOrderFile(
  file: File,
): Promise<AffiliateOrderParseResult> {
  const name = file.name.toLowerCase();

  if (!name.endsWith(".xlsx") && !name.endsWith(".xls")) {
    return {
      rows: [],
      failures: [
        {
          rowNumber: 0,
          error: "Partner Center の XLSX / XLS ファイルを選択してください",
        },
      ],
    };
  }

  const buffer = await file.arrayBuffer();

  const XLSX = await import("xlsx");

  const workbook = XLSX.read(buffer, {
    type: "array",
  });

  const sheetName = workbook.SheetNames[0];

  if (!sheetName) {
    return {
      rows: [],
      failures: [
        {
          rowNumber: 0,
          error: "Excelにシートがありません",
        },
      ],
    };
  }

  const sheet = workbook.Sheets[sheetName];

  const table = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: "",
    raw: false,
  });

  return parseAffiliateOrderTable(table);
}
