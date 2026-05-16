import { fetchCsvImportLogs } from "@/lib/db/csv-import-log-queries";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";

export default async function CsvLogsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/csv-logs");
  }

  const appUser = await resolveAppUserContext(supabase, user);
  if (!isAdminRole(appUser.data.role)) {
    redirect("/dashboard");
  }

  const logs = await fetchCsvImportLogs(supabase, {
    agencyId: null,
    limit: 100,
  });

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          親管理画面
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
          CSV 履歴管理
        </h1>
        <p className="mt-2 text-sm text-zinc-500">
          全代理店の CSV / XLSX 取込履歴を表示します。
        </p>
      </div>

      {logs.error ? (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          {logs.error}
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-2xl border border-white/[0.06]">
        <table className="w-full min-w-[960px] text-left text-sm">
          <thead>
            <tr className="border-b border-white/[0.06] bg-surface-1/80 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              <th className="px-4 py-3">アップロード日時</th>
              <th className="px-4 py-3">アップロード者</th>
              <th className="px-4 py-3">対象月</th>
              <th className="px-4 py-3">ファイル名</th>
              <th className="px-4 py-3 text-right">成功</th>
              <th className="px-4 py-3 text-right">失敗</th>
              <th className="px-4 py-3">失敗理由</th>
              <th className="px-4 py-3">対象代理店</th>
            </tr>
          </thead>
          <tbody>
            {logs.data.length === 0 ? (
              <tr>
                <td
                  colSpan={8}
                  className="px-4 py-10 text-center text-zinc-500"
                >
                  履歴がありません
                </td>
              </tr>
            ) : (
              logs.data.map((row) => (
                <tr key={row.id} className="border-b border-white/[0.04] align-top">
                  <td className="px-4 py-3 font-mono text-xs text-zinc-400">
                    {new Date(row.created_at).toLocaleString("ja-JP")}
                  </td>
                  <td className="px-4 py-3 text-zinc-300">
                    {row.uploader_email ?? row.uploaded_by}
                  </td>
                  <td className="px-4 py-3 font-mono text-zinc-200">{row.target_month}</td>
                  <td className="px-4 py-3 font-mono text-xs text-zinc-400">{row.file_name}</td>
                  <td className="px-4 py-3 text-right font-mono text-emerald-300">
                    {row.success_count}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-red-300">
                    {row.failed_count}
                  </td>
                  <td className="max-w-xs px-4 py-3 whitespace-pre-wrap text-xs text-zinc-500">
                    {row.failure_reasons ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-zinc-300">{row.agency_name}</td>
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
