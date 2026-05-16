import { fetchNotificationLogs } from "@/lib/db/ops-queries";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";

export default async function NotificationsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/notifications");
  }

  const appUser = await resolveAppUserContext(supabase, user);
  if (!isAdminRole(appUser.data.role)) {
    redirect("/dashboard");
  }

  const logs = await fetchNotificationLogs(supabase);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          親管理画面
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
          LINE 通知ログ
        </h1>
        <p className="mt-2 text-sm text-zinc-500">
          将来の LINE 通知連携用テーブルです。現時点では送信処理は行いません。
        </p>
      </div>

      {logs.error ? (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          {logs.error}
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-2xl border border-white/[0.06]">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead>
            <tr className="border-b border-white/[0.06] bg-surface-1/80 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              <th className="px-4 py-3">通知先</th>
              <th className="px-4 py-3">通知内容</th>
              <th className="px-4 py-3">通知タイプ</th>
              <th className="px-4 py-3">送信ステータス</th>
              <th className="px-4 py-3">作成日時</th>
            </tr>
          </thead>
          <tbody>
            {logs.data.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-zinc-500">
                  通知ログはまだありません
                </td>
              </tr>
            ) : (
              logs.data.map((row) => (
                <tr key={row.id} className="border-b border-white/[0.04] align-top">
                  <td className="px-4 py-3 text-zinc-200">{row.destination}</td>
                  <td className="max-w-sm px-4 py-3 whitespace-pre-wrap text-zinc-400">
                    {row.body}
                  </td>
                  <td className="px-4 py-3 text-zinc-300">{row.notification_type}</td>
                  <td className="px-4 py-3 text-zinc-300">{row.status}</td>
                  <td className="px-4 py-3 font-mono text-xs text-zinc-400">
                    {new Date(row.created_at).toLocaleString("ja-JP")}
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
