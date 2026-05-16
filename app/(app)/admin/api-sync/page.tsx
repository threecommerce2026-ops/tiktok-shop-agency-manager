import { ApiSyncClient } from "@/app/(app)/admin/api-sync/ApiSyncClient";
import { fetchActiveTikTokApiConnections } from "@/lib/orders/run-tiktok-orders-sync";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function ApiSyncPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/admin/api-sync");
  }

  const appUser = await resolveAppUserContext(supabase, user);
  if (!isAdminRole(appUser.data.role)) {
    redirect("/dashboard");
  }

  const connectionsResult = await fetchActiveTikTokApiConnections(supabase);

  return (
    <div className="space-y-8">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          親管理画面
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
          本番 API 同期
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-500">
          有効な TikTok Shop API 接続から注文を取得し、`orders` と `creators`、
          報酬集計を更新します。定期実行は `/api/cron/sync-orders` を利用できます。
        </p>
        <p className="mt-3 flex flex-wrap gap-4">
          <Link
            href="/admin/api-connections"
            className="text-sm font-medium text-[var(--accent-cyan)] hover:underline"
          >
            API 設定へ →
          </Link>
          <Link
            href="/admin/api-test-sync"
            className="text-sm font-medium text-[var(--accent-cyan)] hover:underline"
          >
            API テスト同期へ →
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
        <SyncErrorAlert error={connectionsResult.error} />
      ) : null}

      <ApiSyncClient connections={connectionsResult.data} />

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

function SyncErrorAlert({ error }: { error: string }) {
  return (
    <div
      className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100"
      role="alert"
    >
      <p className="font-semibold">Supabase との通信エラー</p>
      <p className="mt-1 text-amber-200/90">{error}</p>
    </div>
  );
}
