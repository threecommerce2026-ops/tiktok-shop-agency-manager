import { PARTNER_SALES_TEMPLATE_HEADERS } from "@/lib/sales/partner-export-columns";

/** UTF-8 BOM 付き（Excel で文字化けしにくい） */
export const CSV_UTF8_BOM = "\uFEFF";

export const SALES_IMPORT_HEADERS = PARTNER_SALES_TEMPLATE_HEADERS;

export function buildSalesImportTemplateCsv(): string {
  return `${CSV_UTF8_BOM}${SALES_IMPORT_HEADERS.join(",")}\n`;
}

/** 実テスト用：パートナーセンター形式の2行サンプル */
export function buildSalesImportSampleCsv(): string {
  const rows = [
    [
      "テスト太郎",
      "demo_alpha",
      "2,281,428円",
      "42",
      "75,000円",
      "2,000,000円",
      "1.2%",
      "0.8%",
      "120",
      "2.1%",
      "1.0%",
      "95",
    ],
    [
      "テスト花子",
      "demo_beta",
      "320,000円",
      "28",
      "48,000円",
      "280,000円",
      "0.9%",
      "0.5%",
      "80",
      "1.5%",
      "0.7%",
      "60",
    ],
  ];
  const body = rows.map((r) => r.join(",")).join("\n");
  return `${CSV_UTF8_BOM}${SALES_IMPORT_HEADERS.join(",")}\n${body}\n`;
}

export function triggerCsvDownload(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
