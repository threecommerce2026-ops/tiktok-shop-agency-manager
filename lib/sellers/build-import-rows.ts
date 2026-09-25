import { applyShopNameOverride } from "@/lib/sellers/shop-name-overrides";
import type { SellerImportSourceRow } from "@/lib/sellers/import-types";
import {
  parseFormCreatedAt,
  resolveImportStatus,
  resolveTspBillingEligible,
} from "@/lib/sellers/tsp-form";

function pickKey(keys: string[], test: (k: string) => boolean): string | undefined {
  return keys.find((k) => test(k.trim()));
}

function cellString(val: unknown): string {
  if (val == null) return "";
  if (val instanceof Date) return Number.isNaN(val.getTime()) ? "" : val.toISOString();
  return String(val).trim();
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
    contract: pickKey(keys, (k) => k.includes("契約書")),
    tspLink: pickKey(keys, (k) => k.toUpperCase().includes("TSP") && k.includes("連携")),
    sales: pickKey(keys, (k) => k.trim() === "販売"),
    initialFee: pickKey(keys, (k) => k.includes("初期費用")),
    payment: pickKey(keys, (k) => k.trim() === "支払い"),
    /*
      備考列はヘッダーが空のため名前で拾えない。
      xlsx が付ける __EMPTY 系のキーのうち、末尾側のものを使う。
      先頭の __EMPTY は回答者名なので除外する。
    */
    note: pickEmptyNoteKey(keys),
  };
}

/** ヘッダーが空の列のうち、先頭（回答者名）以外の最後のものを備考とみなす */
function pickEmptyNoteKey(keys: string[]): string | undefined {
  const empties = keys.filter((k) => /^__EMPTY(_\d+)?$/.test(k.trim()));
  return empties.length >= 2 ? empties[empties.length - 1] : undefined;
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
    /*
      同一ショップと人が確認済みの改称だけ、ここでSHOP名を正の表記へ揃える。
      元の表記は raw_import_json に残る。
    */
    const shopOverride = applyShopNameOverride(seller_name, getVal(row, col.shop));
    const shop_name = shopOverride.shopName;
    const contact_person = getVal(row, col.person) || null;
    const contact_phone = getVal(row, col.phone) || null;
    const contact_email = getVal(row, col.email) || null;
    const parsedDate = col.created
      ? parseFormCreatedAt(row[col.created])
      : { iso: null, unparsable: false };

    const formFields = {
      contract_status: getVal(row, col.contract) || null,
      tsp_link_status: getVal(row, col.tspLink) || null,
      sales_status: getVal(row, col.sales) || null,
      initial_fee_note: getVal(row, col.initialFee) || null,
      payment_status_note: getVal(row, col.payment) || null,
      form_note: getVal(row, col.note) || null,
    };

    return {
      source_created_at: parsedDate.iso,
      source_created_at_unparsable: parsedDate.unparsable,
      seller_name,
      shop_name,
      shop_name_override_from: shopOverride.originalShopName,
      contact_person,
      contact_phone,
      contact_email,
      ...formFields,
      is_tsp_billing_eligible: resolveTspBillingEligible(formFields),
      import_status: resolveImportStatus(formFields),
      raw_import_json,
    };
  });
}
