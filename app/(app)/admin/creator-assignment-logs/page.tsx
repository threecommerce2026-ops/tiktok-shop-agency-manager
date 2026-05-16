import { fetchCreatorAssignmentLogs } from "@/lib/db/creator-assignment-log-queries";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { formatPercent } from "@/lib/revenue/calc";
import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

function formatAgencyLabel(name: string | null) {
  return name ?? "未振り分け";
}

export default async function CreatorAssignmentLogsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/admin/creator-assignment-logs");
  }

  const appUser = await resolveAppUserContext(supabase, user);
  if (!isAdminRole(appUser.data.role)) {
    redirect("/dashboard");
  }

  const logs = await fetchCreatorAssignmentLogs(supabase, { limit: 200 });

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          親管理画面
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
          振り分け変更履歴
        </h1>
        <p className="mt-2 text-sm text-zinc-500">
          クリエイターの代理店振り分けと分配率の変更履歴を表示します。
        </p>
        <p className="mt-3">
          <Link
            href="/admin/creator-assignment"
            className="text-sm font-medium text-[var(--accent-cyan)] hover:underline"
          >
            ← クリエイター振り分け管理
          </Link>
        </p>
      </div>

      {logs.error ? (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          {logs.error}
        </div>
      ) : null}

      <div className="hidden overflow-x-auto rounded-2xl border border-white/[0.06] md:block">
        <table className="w-full min-w-[1120px] text-left text-sm">
          <thead>
            <tr className="border-b border-white/[0.06] bg-surface-1/80 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              <th className="px-4 py-3">変更日時</th>
              <th className="px-4 py-3">クリエイター</th>
              <th className="px-4 py-3">TikTok ID</th>
              <th className="px-4 py-3">変更前代理店</th>
              <th className="px-4 py-3">変更後代理店</th>
              <th className="px-4 py-3 text-right">変更前分配率</th>
              <th className="px-4 py-3 text-right">変更後分配率</th>
              <th className="px-4 py-3">変更者</th>
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
                  <td className="px-4 py-3 text-zinc-100">{row.creator_name}</td>
                  <td className="px-4 py-3 font-mono text-xs text-zinc-400">
                    {row.tiktok_id}
                  </td>
                  <td className="px-4 py-3 text-zinc-300">
                    {formatAgencyLabel(row.from_agency_name)}
                  </td>
                  <td className="px-4 py-3 text-zinc-300">
                    {formatAgencyLabel(row.to_agency_name)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-zinc-400">
                    {row.from_commission_rate == null
                      ? "—"
                      : formatPercent(row.from_commission_rate)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-[var(--accent-cyan)]">
                    {formatPercent(row.to_commission_rate)}
                  </td>
                  <td className="px-4 py-3 text-zinc-300">
                    {row.changed_by_email ?? row.changed_by}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <ul className="flex flex-col gap-4 md:hidden">
        {logs.data.map((row) => (
          <li
            key={row.id}
            className="rounded-2xl border border-white/[0.07] bg-surface-1/50 p-4"
          >
            <p className="font-mono text-xs text-zinc-500">
              {new Date(row.created_at).toLocaleString("ja-JP")}
            </p>
            <p className="mt-2 font-semibold text-zinc-100">{row.creator_name}</p>
            <p className="mt-0.5 font-mono text-xs text-zinc-500">{row.tiktok_id}</p>
            <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
              <div>
                <dt className="text-[10px] text-zinc-600">変更前代理店</dt>
                <dd className="text-zinc-300">
                  {formatAgencyLabel(row.from_agency_name)}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] text-zinc-600">変更後代理店</dt>
                <dd className="text-zinc-300">
                  {formatAgencyLabel(row.to_agency_name)}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] text-zinc-600">変更前分配率</dt>
                <dd className="font-mono text-zinc-400">
                  {row.from_commission_rate == null
                    ? "—"
                    : formatPercent(row.from_commission_rate)}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] text-zinc-600">変更後分配率</dt>
                <dd className="font-mono text-[var(--accent-cyan)]">
                  {formatPercent(row.to_commission_rate)}
                </dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-zinc-500">
              変更者: {row.changed_by_email ?? row.changed_by}
            </p>
          </li>
        ))}
      </ul>

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
