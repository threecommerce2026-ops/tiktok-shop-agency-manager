import {
  fetchCreatorMonthlyCommissionRateLogMonths,
  fetchCreatorMonthlyCommissionRateLogs,
} from "@/lib/db/creator-monthly-commission-rate-log-queries";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

function formatRate(rate: number | null) {
  return rate === null ? "自動" : `${rate}%`;
}

export default async function CreatorCommissionRateLogsPage({
  searchParams,
}: {
  searchParams: Promise<{
    month?: string;
    q?: string;
  }>;
}) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/admin/creator-commission-rate-logs");
  }

  const appUser = await resolveAppUserContext(supabase, user);

  if (!isAdminRole(appUser.data.role)) {
    redirect("/dashboard");
  }

  const params = await searchParams;
  const month = params.month?.trim() ?? "";
  const q = params.q?.trim() ?? "";

  const [logs, months] = await Promise.all([
    fetchCreatorMonthlyCommissionRateLogs(supabase, {
      limit: 200,
      targetMonth: month,
      search: q,
    }),
    fetchCreatorMonthlyCommissionRateLogMonths(supabase),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          親管理画面
        </p>

        <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
          分配率変更履歴
        </h1>

        <p className="mt-2 text-sm text-zinc-500">
          クリエイターの月別手動分配率の変更履歴を表示します。
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

      <form
        method="get"
        className="grid gap-3 rounded-2xl border border-white/[0.06] bg-surface-1/40 p-4 sm:grid-cols-[180px_minmax(0,1fr)_auto_auto]"
      >
        <div>
          <label
            htmlFor="month"
            className="text-[11px] font-medium uppercase tracking-wider text-zinc-500"
          >
            対象月
          </label>

          <select
            id="month"
            name="month"
            defaultValue={month}
            className="mt-1.5 w-full rounded-xl border border-white/[0.08] bg-surface-0/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-[var(--accent-cyan)]/40"
          >
            <option value="">すべての月</option>
            {months.data.map((monthValue) => {
              const [year, monthNumber] = monthValue.split("-");

              return (
                <option key={monthValue} value={monthValue}>
                  {year}年{Number(monthNumber)}月
                </option>
              );
            })}
          </select>
        </div>

        <div>
          <label
            htmlFor="q"
            className="text-[11px] font-medium uppercase tracking-wider text-zinc-500"
          >
            クリエイター検索
          </label>

          <input
            id="q"
            name="q"
            type="search"
            defaultValue={q}
            placeholder="クリエイター名 / TikTok ID"
            className="mt-1.5 w-full rounded-xl border border-white/[0.08] bg-surface-0/60 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-[var(--accent-cyan)]/40"
          />
        </div>

        <div className="flex items-end">
          <button
            type="submit"
            className="min-h-[42px] rounded-xl bg-[var(--accent-cyan)] px-4 py-2.5 text-sm font-semibold text-zinc-950 transition hover:opacity-90"
          >
            絞り込み
          </button>
        </div>

        <div className="flex items-end">
          <Link
            href="/admin/creator-commission-rate-logs"
            className="inline-flex min-h-[42px] items-center rounded-xl border border-white/[0.08] px-4 py-2.5 text-sm font-medium text-zinc-300 transition hover:bg-white/[0.04] hover:text-zinc-100"
          >
            リセット
          </Link>
        </div>
      </form>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-zinc-500">
          表示件数:{" "}
          <span className="font-mono text-zinc-300">
            {logs.data.length}
          </span>
          件
        </p>

        {month || q ? (
          <p className="text-xs text-zinc-600">
            {month ? `対象月: ${month}` : "全期間"}
            {q ? ` / 検索: ${q}` : ""}
          </p>
        ) : null}
      </div>

      {logs.error ? (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          {logs.error}
        </div>
      ) : null}

      <div className="hidden overflow-x-auto rounded-2xl border border-white/[0.06] md:block">
        <table className="w-full min-w-[1100px] text-left text-sm">
          <thead>
            <tr className="border-b border-white/[0.06] bg-surface-1/80 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              <th className="px-4 py-3">変更日時</th>
              <th className="px-4 py-3">対象月</th>
              <th className="px-4 py-3">クリエイター</th>
              <th className="px-4 py-3">TikTok ID</th>
              <th className="px-4 py-3">変更前</th>
              <th className="px-4 py-3">変更後</th>
              <th className="px-4 py-3">変更者</th>
            </tr>
          </thead>

          <tbody>
            {logs.data.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-10 text-center text-zinc-500"
                >
                  条件に一致する履歴がありません
                </td>
              </tr>
            ) : (
              logs.data.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-white/[0.04] align-top"
                >
                  <td className="px-4 py-3 font-mono text-xs text-zinc-400">
                    {new Date(row.created_at).toLocaleString("ja-JP")}
                  </td>

                  <td className="px-4 py-3 font-mono text-xs text-zinc-300">
                    {row.target_month}
                  </td>

                  <td className="px-4 py-3 text-zinc-100">
                    {row.creator_name}
                  </td>

                  <td className="px-4 py-3 font-mono text-xs text-zinc-400">
                    {row.tiktok_id}
                  </td>

                  <td className="px-4 py-3 font-mono text-zinc-300">
                    {formatRate(row.from_commission_rate)}
                  </td>

                  <td className="px-4 py-3 font-mono font-semibold text-zinc-100">
                    {formatRate(row.to_commission_rate)}
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
            <div className="flex items-center justify-between gap-3">
              <p className="font-mono text-xs text-zinc-500">
                {new Date(row.created_at).toLocaleString("ja-JP")}
              </p>

              <span className="rounded-full border border-white/[0.08] px-2 py-0.5 font-mono text-[10px] text-zinc-400">
                {row.target_month}
              </span>
            </div>

            <p className="mt-2 font-semibold text-zinc-100">
              {row.creator_name}
            </p>

            <p className="mt-0.5 font-mono text-xs text-zinc-500">
              {row.tiktok_id}
            </p>

            <div className="mt-3 flex items-center gap-2 text-sm">
              <span className="font-mono text-zinc-400">
                {formatRate(row.from_commission_rate)}
              </span>

              <span className="text-zinc-600">→</span>

              <span className="font-mono font-semibold text-zinc-100">
                {formatRate(row.to_commission_rate)}
              </span>
            </div>

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
