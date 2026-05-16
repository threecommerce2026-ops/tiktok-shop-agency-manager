import type {
  SellerImportPreviewRow,
  SellerImportSourceRow,
  SellerMatchSnapshot,
} from "@/lib/sellers/import-types";
import { findExistingSellerId, refreshSnapshotRow } from "@/lib/sellers/import-match";
import { validateSellerImportRow } from "@/lib/sellers/import-validate";

export function simulateSellerImport(
  rows: SellerImportSourceRow[],
  dbSnapshot: SellerMatchSnapshot[],
): {
  previewRows: SellerImportPreviewRow[];
  counts: { total: number; new: number; update: number; error: number };
} {
  const snapshot: SellerMatchSnapshot[] = dbSnapshot.map((s) => ({ ...s }));
  const previewRows: SellerImportPreviewRow[] = [];
  let newCount = 0;
  let updateCount = 0;
  let errorCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const seller_name = row.seller_name.trim();
    const shop_name = row.shop_name.trim();
    const contact_person = row.contact_person?.trim() || null;
    const contact_phone = row.contact_phone?.trim() || null;
    const contact_email = row.contact_email?.trim() || null;

    const err = validateSellerImportRow({ ...row, seller_name, shop_name, contact_person, contact_phone, contact_email });
    if (err) {
      previewRows.push({
        index: i,
        seller_name,
        shop_name,
        contact_person,
        contact_phone,
        contact_email,
        status: "error",
        errorMessage: err,
      });
      errorCount++;
      continue;
    }

    const existingId = findExistingSellerId(snapshot, {
      ...row,
      seller_name,
      shop_name,
      contact_person,
      contact_phone,
      contact_email,
    });

    if (existingId) {
      previewRows.push({
        index: i,
        seller_name,
        shop_name,
        contact_person,
        contact_phone,
        contact_email,
        status: "update",
      });
      updateCount++;
      refreshSnapshotRow(snapshot, existingId, {
        seller_name,
        shop_name,
        contact_email,
        contact_phone,
      });
    } else {
      previewRows.push({
        index: i,
        seller_name,
        shop_name,
        contact_person,
        contact_phone,
        contact_email,
        status: "new",
      });
      newCount++;
      snapshot.push({
        id: `__virt__${i}`,
        seller_name,
        shop_name,
        contact_email,
        contact_phone,
      });
    }
  }

  return {
    previewRows,
    counts: { total: rows.length, new: newCount, update: updateCount, error: errorCount },
  };
}
