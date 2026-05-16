import type { SellerImportSourceRow } from "@/lib/sellers/import-types";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

export function normalizePhone(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .replace(/[\s\-()（）]/g, "");
}

export function normalizeNamePart(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function isValidEmailFormat(email: string): boolean {
  if (!email) return false;
  return EMAIL_RE.test(email);
}

/** バリデーション失敗時は日本語メッセージ、成功時は null */
export function validateSellerImportRow(row: SellerImportSourceRow): string | null {
  if (!row.seller_name.trim()) {
    return "会社名（セラー名）が空です";
  }
  if (!row.shop_name.trim()) {
    return "SHOP名が空です";
  }
  const email = normalizeEmail(row.contact_email);
  const phone = normalizePhone(row.contact_phone);
  if (!email && !phone) {
    return "メールと電話のどちらかが必要です";
  }
  if (email && !isValidEmailFormat(email)) {
    return "メール形式が不正です";
  }
  return null;
}
