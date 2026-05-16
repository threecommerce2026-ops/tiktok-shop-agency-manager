import { ApiConnectionsClient } from "@/app/(app)/admin/api-connections/ApiConnectionsClient";
import { fetchTikTokApiConnections } from "@/lib/db/tiktok-api-connection-queries";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";
import {
  resolveTikTokOAuthCredentials,
  type TikTokOAuthCredentialsDebug,
} from "@/lib/tiktok/resolve-oauth-credentials";
import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

function OAuthCredentialsDebugPanel({
  debug,
  error,
  source,
}: {
  debug: TikTokOAuthCredentialsDebug;
  error: string | null;
  source: "env" | "connection" | null;
}) {
  return (
    <div className="rounded-xl border border-sky-500/25 bg-sky-500/10 px-4 py-3 text-sm text-sky-100">
      <p className="font-semibold">OAuth 認証情報デバッグ</p>
      <p className="mt-1 text-sky-200/90">
        取得順: {debug.resolutionOrder.join(" → ")} / 採用元: {source ?? "なし"}
      </p>
      {error ? <p className="mt-2 text-red-200/90">解決エラー: {error}</p> : null}
      <pre className="mt-3 overflow-x-auto rounded-lg bg-black/30 p-3 text-xs text-sky-50">
        {JSON.stringify(debug, null, 2)}
      </pre>
      <p className="mt-3 text-xs text-sky-200/80">
        API 側の確認は{" "}
        <Link href="/api/tiktok/auth?debug=1" className="underline">
          /api/tiktok/auth?debug=1
        </Link>{" "}
        でも可能です。
      </p>
    </div>
  );
}

export default async function ApiConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<{
    oauth_error?: string;
    oauth_success?: string;
    oauth_debug?: string;
  }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/admin/api-connections");
  }

  const appUser = await resolveAppUserContext(supabase, user);
  if (!isAdminRole(appUser.data.role)) {
    redirect("/dashboard");
  }

  const connectionsResult = await fetchTikTokApiConnections(supabase);
  const oauthParams = await searchParams;
  const oauthError = oauthParams.oauth_error?.trim();
  const oauthSuccess = oauthParams.oauth_success?.trim();
  const oauthDebug = oauthParams.oauth_debug === "1";
  const credentialsDebug = oauthDebug
    ? await resolveTikTokOAuthCredentials(supabase)
    : null;

  return (
    <div className="space-y-8">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          親管理画面
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
          TikTok Shop API 設定
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-500">
          複数ショップの API 接続情報を管理します。まずは接続情報を保存し、
          API テスト同期画面で Order API レスポンス JSON を貼り付けて注文取り込みを確認できます。
        </p>
        <p className="mt-3">
          <Link
            href="/admin/api-test-sync"
            className="text-sm font-medium text-[var(--accent-cyan)] hover:underline"
          >
            API テスト同期へ →
          </Link>
        </p>
      </div>

      {oauthSuccess ? (
        <div
          className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100"
          role="status"
        >
          <p className="font-semibold">TikTok Shop 接続を保存しました</p>
          <p className="mt-1 text-emerald-200/90">
            {oauthSuccess === "1件" || oauthSuccess.endsWith("件")
              ? `${oauthSuccess}のショップ接続を更新しました。`
              : `shop_id ${oauthSuccess} の接続を更新しました。`}
          </p>
        </div>
      ) : null}

      {oauthError ? (
        <div
          className="rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-100"
          role="alert"
        >
          <p className="font-semibold">TikTok Shop 接続に失敗しました</p>
          <p className="mt-1 text-red-200/90">{oauthError}</p>
        </div>
      ) : null}

      {credentialsDebug ? (
        <OAuthCredentialsDebugPanel
          debug={credentialsDebug.debug}
          error={credentialsDebug.error}
          source={credentialsDebug.data?.source ?? credentialsDebug.debug.selectedSource}
        />
      ) : null}

      {connectionsResult.error ? (
        <div
          className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100"
          role="alert"
        >
          <p className="font-semibold">Supabase との通信エラー</p>
          <p className="mt-1 text-amber-200/90">{connectionsResult.error}</p>
        </div>
      ) : null}

      <ApiConnectionsClient connections={connectionsResult.data} />

      <div className="flex justify-center">
        <Link
          href="/dashboard"
          className="text-sm font-medium text-[var(--accent-cyan)] hover:underline"
        >
          ← ダッシュボード
        </Link>
      </div>
    </div>
  );
}
