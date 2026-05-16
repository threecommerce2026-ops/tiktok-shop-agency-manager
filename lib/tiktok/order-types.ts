export type TikTokOrderApiRecord = {
  order_id: string;
  product_name?: string | null;
  product_id?: string | null;
  sku?: string | null;
  order_amount?: number | string | null;
  commission_base?: number | string | null;
  commission_amount?: number | string | null;
  payment_status?: string | null;
  order_status?: string | null;
  shipping_status?: string | null;
  cancellation_status?: string | null;
  return_status?: string | null;
  creator_tiktok_id: string;
  creator_name?: string | null;
  ordered_at?: string | null;
  paid_at?: string | null;
};

export type TikTokOrderApiResponse = {
  orders?: TikTokOrderApiRecord[];
};
