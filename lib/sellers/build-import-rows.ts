import type { SellerImportSourceRow } from "@/lib/sellers/import-types";

function pickKey(keys: string[], test: (k: string) => boolean): string | undefined {
  return keys.find((k) => test(k.trim()));
}

function cellString(val: unknown): string {
  if (val == null) return "";
  if (val instanceof Date) return Number.isNaN(val.getTime()) ? "" : val.toISOString();
  return String(val).trim();
}

/** Excel シリアル日付の粗い判定（1899-12-30 起点） */
function parseSourceCreatedAt(val: unknown): string | null {
  if (val == null || val === "") return null;
  if (val instanceof Date && !Number.isNaN(val.getTime())) {
    return val.toISOString();
  }
  if (typeof val === "number" && Number.isFinite(val)) {
    if (val > 20000 && val < 120000) {
      const excelEpochMs = Date.UTC(1899, 11, 30);
      const d = new Date(excelEpochMs + val * 86400000);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }
  const s = String(val).trim();
  if (!s) return null;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  return null;
}

function resolveColumnKeys(sample: Record<string, unknown>) {
  const keys = Object.keys(sample);
  return {
    created: pickKey(keys, (k) => k.includes("創建") || k.includes("创建")),
    company: pickKey(keys, (k) => k.includes("会社名") || (k.includes("公司") && k.includes("名"))),
    shop: pickKey(keys, (k) => k.toUpperCase().includes("SHOP") && k.includes("名")),
    person: pickKey(keys, (k) => k.includes("担当者")),
    phone: pickKey(keys, (k) => k.includes("電話") || k.includes("电话")),
    email: pickKey(keys, (k) => k.includes("メール") || k.includes("邮件") || k.toLowerCase().includes("mail")),
  };
}

function getVal(row: Record<string, unknown>, key: string | undefined): string {
  if (!key) return "";
  const v = row[key];
  return cellString(v);
}

/**
 * xlsx / CSV の1行1オブジェクト配列から取込行を生成（ヘッダーは1行目のキーから推定）
 */
export function buildSellerImportRowsFromObjects(
  objects: Record<string, unknown>[],
): SellerImportSourceRow[] {
  if (objects.length === 0) return [];
  const col = resolveColumnKeys(objects[0]);
  return objects.map((row) => {
    const raw_import_json: Record<string, unknown> = { ...row };
    const seller_name = getVal(row, col.company);
    const shop_name = getVal(row, col.shop);
    const contact_person = getVal(row, col.person) || null;
    const contact_phone = getVal(row, col.phone) || null;
    const contact_email = getVal(row, col.email) || null;
    let source_created_at: string | null = null;
    if (col.created) {
      const raw = row[col.created];
      source_created_at = parseSourceCreatedAt(raw);
    }
    return {
      source_created_at,
      seller_name,
      shop_name,
      contact_person,
      contact_phone,
      contact_email,
      raw_import_json,
    };
  });
}
