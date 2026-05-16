import type { SupabaseClient } from "@supabase/supabase-js";

export type SellerRow = {
  id: string;
  seller_name: string;
  shop_name: string;
  contact_person: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  category: string | null;
  sample_condition: string | null;
  has_smp: boolean;
  tap_rate: number | null;
  tsp_rate: number | null;
  last_meeting_date: string | null;
  last_meeting_note: string | null;
  discount_condition: string | null;
  seller_live_available: boolean;
  status: string;
  memo: string | null;
  created_at: string;
  updated_at: string;
};

export async function fetchSellersForAdmin(
  supabase: SupabaseClient,
): Promise<{ data: SellerRow[]; error: string | null }> {
  const { data, error } = await supabase
    .from("sellers")
    .select(
      "id, seller_name, shop_name, contact_person, contact_email, contact_phone, category, sample_condition, has_smp, tap_rate, tsp_rate, last_meeting_date, last_meeting_note, discount_condition, seller_live_available, status, memo, created_at, updated_at",
    )
    .order("seller_name", { ascending: true });

  if (error) {
    return { data: [], error: error.message };
  }

  return {
    data: (data ?? []).map((row) => ({
      id: row.id as string,
      seller_name: row.seller_name as string,
      shop_name: (row.shop_name as string) ?? "",
      contact_person: (row.contact_person as string | null) ?? null,
      contact_email: (row.contact_email as string | null) ?? null,
      contact_phone: (row.contact_phone as string | null) ?? null,
      category: (row.category as string | null) ?? null,
      sample_condition: (row.sample_condition as string | null) ?? null,
      has_smp: Boolean(row.has_smp),
      tap_rate: row.tap_rate == null ? null : Number(row.tap_rate),
      tsp_rate: row.tsp_rate == null ? null : Number(row.tsp_rate),
      last_meeting_date: (row.last_meeting_date as string | null) ?? null,
      last_meeting_note: (row.last_meeting_note as string | null) ?? null,
      discount_condition: (row.discount_condition as string | null) ?? null,
      seller_live_available: Boolean(row.seller_live_available),
      status: String(row.status ?? "pending"),
      memo: (row.memo as string | null) ?? null,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    })),
    error: null,
  };
}

export function formatSellerStatusLabel(status: string): string {
  switch (status) {
    case "active":
      return "稼働中";
    case "pending":
      return "保留";
    case "stopped":
      return "停止";
    default:
      return status;
  }
}

export function formatRateDisplay(value: number | null | undefined): string {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return `${Number(value)}%`;
}
