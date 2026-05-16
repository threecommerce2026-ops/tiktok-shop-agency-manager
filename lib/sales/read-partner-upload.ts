import {
  parsePartnerSalesCsv,
  parsePartnerSalesTable,
  type PartnerSalesParseResult,
} from "@/lib/sales/parse-partner-sales";

function isSpreadsheetFile(file: File): boolean {
  const name = file.name.toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) return true;
  const type = file.type.toLowerCase();
  return (
    type.includes("spreadsheetml") ||
    type === "application/vnd.ms-excel" ||
    type === "application/vnd.ms-excel.sheet.macroenabled.12"
  );
}

export async function parsePartnerSalesFile(
  file: File,
): Promise<PartnerSalesParseResult> {
  if (isSpreadsheetFile(file)) {
    const buffer = await file.arrayBuffer();
    const XLSX = await import("xlsx");
    const workbook = XLSX.read(buffer, { type: "array" });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return { rows: [], failures: [] };
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: "",
      raw: false,
    });
    return parsePartnerSalesTable(rows);
  }

  const text = await file.text();
  return parsePartnerSalesCsv(text);
}
