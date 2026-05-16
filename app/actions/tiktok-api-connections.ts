"use server";

import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";
import { mapSupabaseErrorToJa } from "@/lib/supabase/error-ja";
import { revalidatePath } from "next/cache";

export type SaveTikTokApiConnectionResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

function readText(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function readOptionalText(formData: FormData, key: string): string | null {
  const value = readText(formData, key);
  return value.length > 0 ? value : null;
}

function readBoolean(formData: FormData, key: string): boolean {
  const value = String(formData.get(key) ?? "").trim().toLowerCase();
  return value === "on" || value === "true" || value === "1";
}

function readDateTime(formData: FormData, key: string): string | null {
  const value = readText(formData, key);
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

async function requireAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false as const, error: "ログインが必要です", supabase, user: null };
  }

  const appUser = await resolveAppUserContext(supabase, user);
  if (!isAdminRole(appUser.data.role)) {
    return {
      ok: false as const,
      error: "この操作は親管理者のみ実行できます",
      supabase,
      user: null,
    };
  }

  return { ok: true as const, supabase, user };
}

export async function saveTikTokApiConnectionAction(
  _prev: SaveTikTokApiConnectionResult | null,
  formData: FormData,
): Promise<SaveTikTokApiConnectionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) {
    return { ok: false, error: auth.error };
  }

  const connectionId = readOptionalText(formData, "connection_id");
  const appKey = readText(formData, "app_key");
  const appSecret = readText(formData, "app_secret");
  const accessToken = readText(formData, "access_token");
  const refreshToken = readOptionalText(formData, "refresh_token");
  const shopCipher = readOptionalText(formData, "shop_cipher");
  const shopId = readText(formData, "shop_id");
  const tokenExpiredAt = readDateTime(formData, "token_expired_at");
  const isActive = readBoolean(formData, "is_active");

  if (!appKey || !appSecret || !accessToken || !shopId) {
    return {
      ok: false,
      error: "app_key / app_secret / access_token / shop_id は必須です",
    };
  }

  const payload = {
    app_key: appKey,
    app_secret: appSecret,
    access_token: accessToken,
    refresh_token: refreshToken,
    shop_cipher: shopCipher,
    shop_id: shopId,
    token_expired_at: tokenExpiredAt,
    is_active: isActive,
    updated_at: new Date().toISOString(),
  };

  if (connectionId) {
    const { error } = await auth.supabase
      .from("tiktok_api_connections")
      .update(payload)
      .eq("id", connectionId);

    if (error) {
      return { ok: false, error: mapSupabaseErrorToJa(error.message) };
    }
  } else {
    const { error } = await auth.supabase.from("tiktok_api_connections").insert(payload);
    if (error) {
      return { ok: false, error: mapSupabaseErrorToJa(error.message) };
    }
  }

  revalidatePath("/admin/api-connections");
  revalidatePath("/admin/api-test-sync");

  return {
    ok: true,
    message: connectionId ? "API 接続設定を更新しました" : "API 接続設定を追加しました",
  };
}

export async function deleteTikTokApiConnectionAction(
  connectionId: string,
): Promise<SaveTikTokApiConnectionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) {
    return { ok: false, error: auth.error };
  }

  if (!connectionId.trim()) {
    return { ok: false, error: "接続 ID が不正です" };
  }

  const { error } = await auth.supabase
    .from("tiktok_api_connections")
    .delete()
    .eq("id", connectionId);

  if (error) {
    return { ok: false, error: mapSupabaseErrorToJa(error.message) };
  }

  revalidatePath("/admin/api-connections");
  revalidatePath("/admin/api-test-sync");

  return { ok: true, message: "API 接続設定を削除しました" };
}
