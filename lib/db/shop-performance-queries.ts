import type { SupabaseClient } from "@supabase/supabase-js";

export type ShopPerformanceImportRow = {
  id: string;
  identity_key: string;
  shop_name: string;
  shop_name_normalized: string;
  shop_id: string | null;
  seller_id: string | null;
  period_start: string;
  period_end: string;
  target_month: string | null;
  gmv_amount: number;
  currency: string;
  items_sold: number | null;
  live_gmv_amount: number | null;
  video_gmv_amount: number | null;
  affiliate_gmv_amount: number | null;
  avg_customers: number | null;
  refund_amount: number | null;
  impressions: number | null;
  avg_visitors: number | null;
  avg_conversion_rate_pct: number | null;
  source: string;
  import_batch_id: string | null;
  created_at: string;
  updated_at: string;
  seller_name: string | null;
  seller_shop_name: string | null;
  tsp_rate: number | null;
  sellers_shop_id: string | null;
};

export type ShopPerformanceBillingStatus =
  | "ok"
  | "unlinked"
  | "rate_missing";

export type ShopPerformanceBillingView = ShopPerformanceImportRow & {
  billing_status: ShopPerformanceBillingStatus;
  seller_fee: number | null;
  billing_status_label: string;
};

export function computeSellerFee(
  gmvAmount: number,
  tspRate: number | null | undefined,
  sellerId: string | null | undefined,
): { status: ShopPerformanceBillingStatus; fee: number | null; label: string } {
  if (!sellerId) {
    return { status: "unlinked", fee: null, label: "未紐付け" };
  }
  if (tspRate == null || Number.isNaN(Number(tspRate))) {
    return { status: "rate_missing", fee: null, label: "料率未設定" };
  }
  const fee = Math.round((Number(gmvAmount) * Number(tspRate)) / 100);
  return { status: "ok", fee, label: "計算済" };
}

export async function fetchShopPerformanceImportsForAdmin(
  supabase: SupabaseClient,
): Promise<{ data: ShopPerformanceBillingView[]; error: string | null }> {
  const { data, error } = await supabase
    .from("shop_performance_imports")
    .select(
      `
      id,
      identity_key,
      shop_name,
      shop_name_normalized,
      shop_id,
      seller_id,
      period_start,
      period_end,
      target_month,
      gmv_amount,
      currency,
      items_sold,
      live_gmv_amount,
      video_gmv_amount,
      affiliate_gmv_amount,
      avg_customers,
      refund_amount,
      impressions,
      avg_visitors,
      avg_conversion_rate_pct,
      source,
      import_batch_id,
      created_at,
      updated_at,
      sellers (
        seller_name,
        shop_name,
        tsp_rate,
        shop_id
      )
    `,
    )
    .order("period_end", { ascending: false })
    .order("gmv_amount", { ascending: false });

  if (error) {
    return { data: [], error: error.message };
  }

  const rows: ShopPerformanceBillingView[] = (data ?? []).map((row) => {
    const sellerRel = row.sellers as
      | {
          seller_name?: string | null;
          shop_name?: string | null;
          tsp_rate?: number | null;
          shop_id?: string | null;
        }
      | null
      | undefined;

    const seller_id = (row.seller_id as string | null) ?? null;
    const tsp_rate =
      sellerRel?.tsp_rate == null ? null : Number(sellerRel.tsp_rate);
    const gmv_amount = Number(row.gmv_amount ?? 0);
    const billing = computeSellerFee(gmv_amount, tsp_rate, seller_id);

    return {
      id: row.id as string,
      identity_key: row.identity_key as string,
      shop_name: row.shop_name as string,
      shop_name_normalized: row.shop_name_normalized as string,
      shop_id: (row.shop_id as string | null) ?? null,
      seller_id,
      period_start: row.period_start as string,
      period_end: row.period_end as string,
      target_month: (row.target_month as string | null) ?? null,
      gmv_amount,
      currency: (row.currency as string) ?? "JPY",
      items_sold: row.items_sold == null ? null : Number(row.items_sold),
      live_gmv_amount:
        row.live_gmv_amount == null ? null : Number(row.live_gmv_amount),
      video_gmv_amount:
        row.video_gmv_amount == null ? null : Number(row.video_gmv_amount),
      affiliate_gmv_amount:
        row.affiliate_gmv_amount == null
          ? null
          : Number(row.affiliate_gmv_amount),
      avg_customers:
        row.avg_customers == null ? null : Number(row.avg_customers),
      refund_amount:
        row.refund_amount == null ? null : Number(row.refund_amount),
      impressions: row.impressions == null ? null : Number(row.impressions),
      avg_visitors:
        row.avg_visitors == null ? null : Number(row.avg_visitors),
      avg_conversion_rate_pct:
        row.avg_conversion_rate_pct == null
          ? null
          : Number(row.avg_conversion_rate_pct),
      source: String(row.source ?? "csv"),
      import_batch_id: (row.import_batch_id as string | null) ?? null,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      seller_name: sellerRel?.seller_name ?? null,
      seller_shop_name: sellerRel?.shop_name ?? null,
      tsp_rate,
      sellers_shop_id: sellerRel?.shop_id ?? null,
      billing_status: billing.status,
      seller_fee: billing.fee,
      billing_status_label: billing.label,
    };
  });

  return { data: rows, error: null };
}

export async function fetchShopPerformanceBatchesForAdmin(
  supabase: SupabaseClient,
): Promise<{
  data: Array<{
    id: string;
    file_name: string | null;
    period_start: string;
    period_end: string;
    row_total: number;
    upserted_count: number;
    failed_count: number;
    created_at: string;
  }>;
  error: string | null;
}> {
  const { data, error } = await supabase
    .from("shop_performance_import_batches")
    .select(
      "id, file_name, period_start, period_end, row_total, upserted_count, failed_count, created_at",
    )
    .order("created_at", { ascending: false })
    .limit(30);

  if (error) return { data: [], error: error.message };
  return {
    data: (data ?? []).map((row) => ({
      id: row.id as string,
      file_name: (row.file_name as string | null) ?? null,
      period_start: row.period_start as string,
      period_end: row.period_end as string,
      row_total: Number(row.row_total ?? 0),
      upserted_count: Number(row.upserted_count ?? 0),
      failed_count: Number(row.failed_count ?? 0),
      created_at: row.created_at as string,
    })),
    error: null,
  };
}
