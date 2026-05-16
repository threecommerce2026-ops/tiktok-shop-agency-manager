import {
  resolveTikTokOAuthCredentials,
  type TikTokOAuthCredentialsDebug,
} from "@/lib/tiktok/resolve-oauth-credentials";
import { buildTikTokAuthorizeUrl, createTikTokOAuthState } from "@/lib/tiktok/oauth";
import { requireAdminApiAccess } from "@/lib/tiktok/require-admin-api";
import {
  ensureRuntimeEnvLoaded,
  readRuntimeEnv,
} from "@/lib/env/load-runtime-env";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const OAUTH_STATE_COOKIE = "tiktok_oauth_state";
const OAUTH_COOKIE_MAX_AGE_SECONDS = 60 * 10;

function buildEnvRuntimeCheck() {
  ensureRuntimeEnvLoaded();
  return {
    hasKey: readRuntimeEnv("TIKTOK_SHOP_APP_KEY") !== undefined,
    hasSecret: readRuntimeEnv("TIKTOK_SHOP_APP_SECRET") !== undefined,
  };
}

function buildDebugPayload(
  credentialsResult: Awaited<ReturnType<typeof resolveTikTokOAuthCredentials>>,
) {
  return {
    ok: credentialsResult.data !== null,
    error: credentialsResult.error,
    source: credentialsResult.data?.source ?? credentialsResult.debug.selectedSource,
    connectionId: credentialsResult.data?.connectionId ?? null,
    appKeyPreview: credentialsResult.data
      ? `${credentialsResult.data.appKey.slice(0, 4)}...`
      : null,
    envRuntime: buildEnvRuntimeCheck(),
    debug: credentialsResult.debug,
  };
}

export async function GET(request: Request) {
  const auth = await requireAdminApiAccess();
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const requestUrl = new URL(request.url);
  const connectionId = requestUrl.searchParams.get("connection_id");
  const debugMode = requestUrl.searchParams.get("debug") === "1";
  const credentialsResult = await resolveTikTokOAuthCredentials(
    auth.supabase,
    connectionId,
  );

  if (debugMode) {
    return NextResponse.json(buildDebugPayload(credentialsResult));
  }

  if (credentialsResult.error || !credentialsResult.data) {
    return NextResponse.json(
      {
        ok: false,
        error: credentialsResult.error ?? "認証情報を取得できませんでした",
        envRuntime: buildEnvRuntimeCheck(),
        debug: credentialsResult.debug,
      },
      { status: 400 },
    );
  }

  const state = createTikTokOAuthState();
  const authorizeUrl = buildTikTokAuthorizeUrl(
    credentialsResult.data.appKey,
    state,
  );
  const response = NextResponse.redirect(authorizeUrl);
  response.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: OAUTH_COOKIE_MAX_AGE_SECONDS,
    path: "/",
  });

  return response;
}

export type { TikTokOAuthCredentialsDebug };
