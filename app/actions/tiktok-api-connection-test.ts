"use server";

import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { fetchShopOrdersFromConnection } from "@/lib/tiktok/fetch-shop-orders";
import { createClient } from "@/lib/supabase/server";

export type TikTokApiConnectionTestResult =
  | {
      ok: true;
      message: string;
      fetchedCount: number;
    }
  | {
      ok: false;
      error: string;
    };

export async function testTikTokApiConnectionAction(
  connectionId: string,
): Promise<TikTokApiConnectionTestResult> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, error: "ログインが必要です" };
  }

  const appUser = await resolveAppUserContext(supabase, user);

  if (!isAdminRole(appUser.data.role)) {
    return { ok: false, error: "この操作は親管理者のみ実行できます" };
  }

  const { data, error } = await supabase
    .from("tiktok_api_connections")
    .select(
      "id, app_key, app_secret, access_token, refresh_token, shop_cipher, shop_id, token_expired_at, is_active, last_synced_at, created_at, updated_at",
    )
    .eq("id", connectionId)
    .single();

  if (error || !data) {
    return {
      ok: false,
      error: error?.message ?? "API接続情報が見つかりません",
    };
  }

  const fetched = await fetchShopOrdersFromConnection({
    id: data.id as string,
    app_key: data.app_key as string,
    app_secret: data.app_secret as string,
    access_token: data.access_token as string,
    refresh_token: (data.refresh_token as string | null) ?? null,
    shop_cipher: (data.shop_cipher as string | null) ?? null,
    shop_id: data.shop_id as string,
    token_expired_at: (data.token_expired_at as string | null) ?? null,
    is_active: Boolean(data.is_active),
    last_synced_at: (data.last_synced_at as string | null) ?? null,
    created_at: data.created_at as string,
    updated_at: data.updated_at as string,
  });

  if (fetched.error) {
    return {
      ok: false,
      error: fetched.error,
    };
  }

  return {
    ok: true,
    fetchedCount: fetched.records.length,
    message: `Order API 接続成功：${fetched.records.length}件取得しました`,
  };
}
