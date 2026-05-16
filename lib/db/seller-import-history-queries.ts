import type { SupabaseClient } from "@supabase/supabase-js";

export type SellerImportHistoryRow = {
  id: string;
  file_name: string | null;
  total_count: number;
  inserted_count: number;
  updated_count: number;
  error_count: number;
  imported_by: string | null;
  created_at: string;
  raw_result: unknown;
};

export async function fetchSellerImportHistories(
  supabase: SupabaseClient,
  limit = 100,
): Promise<{ data: SellerImportHistoryRow[]; error: string | null }> {
  const { data, error } = await supabase
    .from("seller_import_histories")
    .select(
      "id, file_name, total_count, inserted_count, updated_count, error_count, imported_by, created_at, raw_result",
    )
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    return { data: [], error: error.message };
  }

  return {
    data: (data ?? []).map((row) => ({
      id: row.id as string,
      file_name: (row.file_name as string | null) ?? null,
      total_count: Number(row.total_count ?? 0),
      inserted_count: Number(row.inserted_count ?? 0),
      updated_count: Number(row.updated_count ?? 0),
      error_count: Number(row.error_count ?? 0),
      imported_by: (row.imported_by as string | null) ?? null,
      created_at: row.created_at as string,
      raw_result: row.raw_result ?? null,
    })),
    error: null,
  };
}
