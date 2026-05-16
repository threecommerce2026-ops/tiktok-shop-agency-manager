import { ApiTestSyncClient } from "@/app/(app)/admin/api-test-sync/ApiTestSyncClient";
import { fetchTikTokApiConnectionOptions } from "@/lib/db/tiktok-api-connection-queries";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function ApiTestSyncPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/admin/api-test-sync");
  }

  const appUser = await resolveAppUserContext(supabase, user);
  if (!isAdminRole(appUser.data.role)) {
    redirect("/dashboard");
  }

  const connectionsResult = await fetchTikTokApiConnectionOptions(supabase);

  return (
    <div className="space-y-8">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          親管理画面
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
          API テスト同期
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-500">
          TikTok Shop Order API のレスポンス JSON を貼り付けて、注文データを
          `orders` テーブルへ upsert します。同期結果は `sync_jobs` にも記録されます。
        </p>
        <p className="mt-3 flex flex-wrap gap-4">
          <Link
            href="/admin/api-connections"
            className="text-sm font-medium text-[var(--accent-cyan)] hover:underline"
          >
            API 設定へ →
          </Link>
          <Link
            href="/orders"
            className="text-sm font-medium text-[var(--accent-cyan)] hover:underline"
          >
            注文一覧へ →
          </Link>
          <Link
            href="/sync-jobs"
            className="text-sm font-medium text-[var(--accent-cyan)] hover:underline"
          >
            同期履歴へ →
          </Link>
        </p>
      </div>

      {connectionsResult.error ? (
        <div
          className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100"
          role="alert"
        >
          <p className="font-semibold">Supabase との通信エラー</p>
          <p className="mt-1 text-amber-200/90">{connectionsResult.error}</p>
        </div>
      ) : null}

      <ApiTestSyncClient connections={connectionsResult.data} />

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
