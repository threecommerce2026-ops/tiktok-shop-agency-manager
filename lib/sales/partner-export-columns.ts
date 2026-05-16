export const PARTNER_SALES_REQUIRED_HEADERS = [
  "Creator nickname",
  "Creator username",
  "Affiliate GMV",
  "Items sold",
  "Est. commission",
  "Commission base",
] as const;

export const PARTNER_SALES_OPTIONAL_HEADERS = [
  "LIVE CTR",
  "LIVE CTOR",
  "LIVE RPM",
  "Video CTR",
  "Video CTOR",
  "Video RPM",
] as const;

export const PARTNER_SALES_TEMPLATE_HEADERS = [
  ...PARTNER_SALES_REQUIRED_HEADERS,
  ...PARTNER_SALES_OPTIONAL_HEADERS,
] as const;

export const CREATOR_NAME_COLUMN_ALIASES = [
  "creator nickname",
  "creator name",
  "creator_name",
  "クリエイター名",
] as const;

export const TIKTOK_ID_COLUMN_ALIASES = [
  "creator username",
  "tiktok id",
  "tiktok_id",
  "creator id",
  "creator_id",
] as const;

export const SALES_AMOUNT_COLUMN_ALIASES = [
  "affiliate gmv",
  "sales_amount",
  "売上金額",
] as const;

export const ORDER_COUNT_COLUMN_ALIASES = ["items sold", "order_count", "注文数"] as const;

export const PROFIT_AMOUNT_COLUMN_ALIASES = [
  "est. commission",
  "est commission",
  "profit_amount",
  "収益金額",
] as const;

export const COMMISSION_BASE_COLUMN_ALIASES = [
  "commission base",
  "commission_base",
] as const;

export const TARGET_MONTH_COLUMN_ALIASES = [
  "対象月",
  "target_month",
  "target month",
] as const;

export const PARTNER_SALES_IMPORT_ERROR =
  "取り込めるデータがありません。TikTok Shop パートナーセンター形式の CSV / XLSX か、TikTok ID と売上金額の列を含むファイルを選択してください。";
