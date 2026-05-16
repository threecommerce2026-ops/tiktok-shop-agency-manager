import { mapSupabaseErrorToJa } from "@/lib/supabase/error-ja";
import {
  exchangeTikTokAuthCodeForToken,
  fetchTikTokAuthorizedShops,
} from "@/lib/tiktok/oauth";
import { resolveTikTokOAuthCredentials } from "@/lib/tiktok/resolve-oauth-credentials";
import { requireAdminApiAccess } from "@/lib/tiktok/require-admin-api";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const OAUTH_STATE_COOKIE = "tiktok_oauth_state";

function redirectToConnections(request: Request, params: Record<string, string>) {
  const redirectUrl = new URL("/admin/api-connections", request.url);
  for (const [key, value] of Object.entries(params)) {
    redirectUrl.searchParams.set(key, value);
  }
  return NextResponse.redirect(redirectUrl);
}

export async function GET(request: Request) {
  const auth = await requireAdminApiAccess();
  if (!auth.ok) {
    return redirectToConnections(request, { oauth_error: auth.error });
  }

  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code")?.trim();
  const state = requestUrl.searchParams.get("state")?.trim();
  const oauthError = requestUrl.searchParams.get("error")?.trim();

  if (oauthError) {
    return redirectToConnections(request, {
      oauth_error: `TikTok Shop 認証が拒否されました: ${oauthError}`,
    });
  }

  if (!code) {
    return redirectToConnections(request, {
      oauth_error: "認可コードが取得できませんでした",
    });
  }

  const cookieStore = await cookies();
  const expectedState = cookieStore.get(OAUTH_STATE_COOKIE)?.value;
  if (!expectedState || !state || expectedState !== state) {
    return redirectToConnections(request, {
      oauth_error: "OAuth state が一致しません。もう一度接続をやり直してください。",
    });
  }

  const credentialsResult = await resolveTikTokOAuthCredentials(auth.supabase);
  if (credentialsResult.error || !credentialsResult.data) {
    return redirectToConnections(request, {
      oauth_error: credentialsResult.error ?? "認証情報を取得できませんでした",
    });
  }

  try {
    const tokenResult = await exchangeTikTokAuthCodeForToken({
      appKey: credentialsResult.data.appKey,
      appSecret: credentialsResult.data.appSecret,
      code,
    });
    const shops = await fetchTikTokAuthorizedShops({
      appKey: credentialsResult.data.appKey,
      appSecret: credentialsResult.data.appSecret,
      accessToken: tokenResult.data.access_token,
    });

    if (shops.length === 0) {
      return redirectToConnections(request, {
        oauth_error: "認可済みショップを取得できませんでした",
      });
    }

    const now = new Date().toISOString();
    for (const shop of shops) {
      const payload = {
        app_key: credentialsResult.data.appKey,
        app_secret: credentialsResult.data.appSecret,
        access_token: tokenResult.data.access_token,
        refresh_token: tokenResult.data.refresh_token,
        shop_cipher: shop.shop_cipher,
        shop_id: shop.shop_id,
        token_expired_at: tokenResult.tokenExpiredAt,
        is_active: true,
        updated_at: now,
      };

      const { data: existing, error: existingError } = await auth.supabase
        .from("tiktok_api_connections")
        .select("id")
        .eq("shop_id", shop.shop_id)
        .maybeSingle();

      if (existingError) {
        return redirectToConnections(request, {
          oauth_error: mapSupabaseErrorToJa(existingError.message),
        });
      }

      if (existing?.id) {
        const { error } = await auth.supabase
          .from("tiktok_api_connections")
          .update(payload)
          .eq("id", existing.id);
        if (error) {
          return redirectToConnections(request, {
            oauth_error: mapSupabaseErrorToJa(error.message),
          });
        }
        continue;
      }

      const { error } = await auth.supabase.from("tiktok_api_connections").insert(payload);
      if (error) {
        return redirectToConnections(request, {
          oauth_error: mapSupabaseErrorToJa(error.message),
        });
      }
    }

    revalidatePath("/admin/api-connections");
    revalidatePath("/admin/api-test-sync");

    const response = redirectToConnections(request, {
      oauth_success: shops.length === 1 ? shops[0].shop_id : `${shops.length}件`,
    });
    response.cookies.set(OAUTH_STATE_COOKIE, "", {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 0,
      path: "/",
    });
    return response;
  } catch (error) {
    return redirectToConnections(request, {
      oauth_error:
        error instanceof Error ? error.message : "TikTok Shop 認証に失敗しました",
    });
  }
}
