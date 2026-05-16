import type { SellerImportSourceRow, SellerMatchSnapshot } from "@/lib/sellers/import-types";
import { normalizeEmail, normalizeNamePart, normalizePhone } from "@/lib/sellers/import-validate";

/**
 * 重複判定: 1) メール 2) 電話 3) 会社名+SHOP名
 * 同一スナップショット内で最初に一致した id を返す
 */
export function findExistingSellerId(
  snapshot: SellerMatchSnapshot[],
  row: SellerImportSourceRow,
): string | null {
  const email = normalizeEmail(row.contact_email);
  if (email) {
    const byEmail = snapshot.find((s) => normalizeEmail(s.contact_email) === email);
    if (byEmail) return byEmail.id;
  }
  const phone = normalizePhone(row.contact_phone);
  if (phone) {
    const byPhone = snapshot.find((s) => normalizePhone(s.contact_phone) === phone);
    if (byPhone) return byPhone.id;
  }
  const nameKey = `${normalizeNamePart(row.seller_name)}\0${normalizeNamePart(row.shop_name)}`;
  if (nameKey !== "\0") {
    const byName = snapshot.find(
      (s) =>
        `${normalizeNamePart(s.seller_name)}\0${normalizeNamePart(s.shop_name)}` === nameKey,
    );
    if (byName) return byName.id;
  }
  return null;
}

export function upsertSnapshotAfterInsert(
  snapshot: SellerMatchSnapshot[],
  inserted: SellerMatchSnapshot,
): void {
  snapshot.push(inserted);
}

export function refreshSnapshotRow(
  snapshot: SellerMatchSnapshot[],
  id: string,
  patch: Partial<SellerMatchSnapshot>,
): void {
  const i = snapshot.findIndex((s) => s.id === id);
  if (i >= 0) {
    snapshot[i] = { ...snapshot[i], ...patch };
  }
}
