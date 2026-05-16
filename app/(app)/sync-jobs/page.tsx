import { fetchSyncJobs } from "@/lib/db/ops-queries";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";

export default async function SyncJobsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/sync-jobs");
  }

  const appUser = await resolveAppUserContext(supabase, user);
  if (!isAdminRole(appUser.data.role)) {
    redirect("/dashboard");
  }

  const jobs = await fetchSyncJobs(supabase);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          親管理画面
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
          TikTok Shop API 同期ジョブ
        </h1>
        <p className="mt-2 text-sm text-zinc-500">
          TikTok Shop Order API の同期履歴です。注文同期は注文一覧画面から実行できます。
        </p>
      </div>

      {jobs.error ? (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          {jobs.error}
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-2xl border border-white/[0.06]">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead>
            <tr className="border-b border-white/[0.06] bg-surface-1/80 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              <th className="px-4 py-3">同期種別</th>
              <th className="px-4 py-3">実行日時</th>
              <th className="px-4 py-3">ステータス</th>
              <th className="px-4 py-3 text-right">成功件数</th>
              <th className="px-4 py-3 text-right">失敗件数</th>
              <th className="px-4 py-3">エラー内容</th>
            </tr>
          </thead>
          <tbody>
            {jobs.data.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-zinc-500">
                  同期ジョブはまだありません
                </td>
              </tr>
            ) : (
              jobs.data.map((row) => (
                <tr key={row.id} className="border-b border-white/[0.04] align-top">
                  <td className="px-4 py-3 text-zinc-200">{row.sync_type}</td>
                  <td className="px-4 py-3 font-mono text-xs text-zinc-400">
                    {row.executed_at
                      ? new Date(row.executed_at).toLocaleString("ja-JP")
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-zinc-300">{row.status}</td>
                  <td className="px-4 py-3 text-right font-mono">{row.success_count}</td>
                  <td className="px-4 py-3 text-right font-mono">{row.failed_count}</td>
                  <td className="max-w-sm px-4 py-3 whitespace-pre-wrap text-xs text-zinc-500">
                    {row.error_message ?? "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

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
