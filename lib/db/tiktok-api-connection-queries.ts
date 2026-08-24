import type { SupabaseClient } from "@supabase/supabase-js";
import { hasSecretValue, isTokenExpired } from "@/lib/tiktok/secret-display";

/**
 * サーバー専用の行型。app_secret / access_token / refresh_token を含むため、
 * Client Component の props やレスポンス JSON に渡してはいけない。
 * （同期処理 lib/orders/run-tiktok-orders-sync.ts, lib/tiktok/fetch-shop-orders.ts が使用）
 */
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

/**
 * 画面表示用の型。秘密情報そのものは含めず、「設定済みかどうか」だけを持つ。
 * Client Component へ渡してよいのはこちら。
 */
export type TikTokApiConnectionSummary = {
  id: string;
  app_key: string;
  shop_cipher: string | null;
  shop_id: string;
  token_expired_at: string | null;
  is_active: boolean;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
  has_app_secret: boolean;
  has_access_token: boolean;
  has_refresh_token: boolean;
  is_token_expired: boolean;
};

/**
 * 秘密情報を落として表示用サマリへ変換する。
 * 秘密の値はこの関数の内側で捨てられ、戻り値には一切含まれない。
 */
export function toTikTokApiConnectionSummary(
  row: TikTokApiConnectionRow,
): TikTokApiConnectionSummary {
  return {
    id: row.id,
    app_key: row.app_key,
    shop_cipher: row.shop_cipher,
    shop_id: row.shop_id,
    token_expired_at: row.token_expired_at,
    is_active: row.is_active,
    last_synced_at: row.last_synced_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    has_app_secret: hasSecretValue(row.app_secret),
    has_access_token: hasSecretValue(row.access_token),
    has_refresh_token: hasSecretValue(row.refresh_token),
    is_token_expired: isTokenExpired(row.token_expired_at),
  };
}

export async function fetchTikTokApiConnections(
  supabase: SupabaseClient,
): Promise<{ data: TikTokApiConnectionSummary[]; error: string | null }> {
  const { data, error } = await supabase
    .from("tiktok_api_connections")
    .select(
      "id, app_key, app_secret, access_token, refresh_token, shop_cipher, shop_id, token_expired_at, is_active, last_synced_at, created_at, updated_at",
    )
    .order("updated_at", { ascending: false });

  if (error) {
    return { data: [], error: error.message };
  }

  // 秘密の値はここで真偽値に畳み込み、呼び出し元へは返さない。
  return {
    data: (data ?? []).map((row) => {
      const tokenExpiredAt = (row.token_expired_at as string | null) ?? null;
      return {
        id: row.id as string,
        app_key: row.app_key as string,
        shop_cipher: (row.shop_cipher as string | null) ?? null,
        shop_id: row.shop_id as string,
        token_expired_at: tokenExpiredAt,
        is_active: Boolean(row.is_active),
        last_synced_at: (row.last_synced_at as string | null) ?? null,
        created_at: row.created_at as string,
        updated_at: row.updated_at as string,
        has_app_secret: hasSecretValue(row.app_secret as string | null),
        has_access_token: hasSecretValue(row.access_token as string | null),
        has_refresh_token: hasSecretValue(row.refresh_token as string | null),
        is_token_expired: isTokenExpired(tokenExpiredAt),
      };
    }),
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
