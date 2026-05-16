import type { SupabaseClient } from "@supabase/supabase-js";

export type TikTokApiConnectionRow = {
  id: string;
  app_key: string;
  app_secret: string;
  access_token: string;
  refresh_token: string | null;
  shop_cipher: string | null;
  shop_id: string;
  token_expired_at: string | null;
  is_active: boolean;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
};

export type TikTokApiConnectionOption = {
  id: string;
  shop_id: string;
  shop_cipher: string | null;
  is_active: boolean;
};

export async function fetchTikTokApiConnections(
  supabase: SupabaseClient,
): Promise<{ data: TikTokApiConnectionRow[]; error: string | null }> {
  const { data, error } = await supabase
    .from("tiktok_api_connections")
    .select(
      "id, app_key, app_secret, access_token, refresh_token, shop_cipher, shop_id, token_expired_at, is_active, last_synced_at, created_at, updated_at",
    )
    .order("updated_at", { ascending: false });

  if (error) {
    return { data: [], error: error.message };
  }

  return {
    data: (data ?? []).map((row) => ({
      id: row.id as string,
      app_key: row.app_key as string,
      app_secret: row.app_secret as string,
      access_token: row.access_token as string,
      refresh_token: (row.refresh_token as string | null) ?? null,
      shop_cipher: (row.shop_cipher as string | null) ?? null,
      shop_id: row.shop_id as string,
      token_expired_at: (row.token_expired_at as string | null) ?? null,
      is_active: Boolean(row.is_active),
      last_synced_at: (row.last_synced_at as string | null) ?? null,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    })),
    error: null,
  };
}

export async function fetchTikTokApiConnectionOptions(
  supabase: SupabaseClient,
): Promise<{ data: TikTokApiConnectionOption[]; error: string | null }> {
  const { data, error } = await supabase
    .from("tiktok_api_connections")
    .select("id, shop_id, shop_cipher, is_active")
    .order("shop_id");

  if (error) {
    return { data: [], error: error.message };
  }

  return {
    data: (data ?? []).map((row) => ({
      id: row.id as string,
      shop_id: row.shop_id as string,
      shop_cipher: (row.shop_cipher as string | null) ?? null,
      is_active: Boolean(row.is_active),
    })),
    error: null,
  };
}
