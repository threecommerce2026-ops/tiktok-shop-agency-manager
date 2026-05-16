import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { currentMonthKey } from "@/lib/db/dashboard-queries";
import {
  fetchMonthSummaries,
  fetchMonthlyRanking,
} from "@/lib/db/sales-queries";
import { createClient } from "@/lib/supabase/server";
import { formatYen } from "@/lib/revenue/calc";
import Link from "next/link";
import { redirect } from "next/navigation";

export default async function SalesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/sales");
  }

  const appUser = await resolveAppUserContext(supabase, user);
  if (!isAdminRole(appUser.data.role) && !appUser.data.agencyId) {
    return (
      <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-6 text-sm text-red-200">
        {appUser.error ?? "代理店を初期化できませんでした"}
      </div>
    );
  }

  const isAdmin = isAdminRole(appUser.data.role);
  const month = currentMonthKey();
  const [summaries, rankingRes] = await Promise.all([
    fetchMonthSummaries(supabase, isAdmin ? null : appUser.data.agencyId),
    fetchMonthlyRanking(supabase, isAdmin ? null : appUser.data.agencyId, month),
  ]);

  const err = summaries.error ?? rankingRes.error;

  return (
    <div className="space-y-8">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          {isAdmin ? "親管理画面" : appUser.data.agencyName}
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
          売上・収益一覧
        </h1>
        <p className="mt-2 text-sm text-zinc-500">
          CSV 取込データを月別に集計しています。
        </p>
      </div>

      {err ? (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          {err}
        </div>
      ) : null}

      <section>
        <h2 className="text-lg font-semibold text-zinc-200">月別サマリ</h2>
        <div className="mt-4 overflow-x-auto rounded-2xl border border-white/[0.06]">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead>
              <tr className="border-b border-white/[0.06] bg-surface-1/80 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                <th className="px-4 py-3">対象月</th>
                <th className="px-4 py-3 text-right">売上</th>
                <th className="px-4 py-3 text-right">収益</th>
                <th className="px-4 py-3 text-right">代理店報酬</th>
                <th className="px-4 py-3 text-right">注文数</th>
              </tr>
            </thead>
            <tbody>
              {summaries.data.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-zinc-500">
                    データがありません
                  </td>
                </tr>
              ) : (
                summaries.data.map((h) => (
                  <tr key={h.month} className="border-b border-white/[0.04]">
                    <td className="px-4 py-3 font-mono text-zinc-200">{h.month}</td>
                    <td className="px-4 py-3 text-right font-mono">{formatYen(h.sales)}</td>
                    <td className="px-4 py-3 text-right font-mono text-[var(--accent-cyan)]">
                      {formatYen(h.profit)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-gradient-brand">
                      {formatYen(h.reward)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-zinc-400">
                      {h.orders.toLocaleString("ja-JP")}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-zinc-200">今月内訳（{month}）</h2>
        <ul className="mt-4 flex flex-col gap-3 sm:hidden">
          {rankingRes.data.map((r) => (
            <li
              key={r.creator_id}
              className="rounded-2xl border border-white/[0.07] bg-surface-1/50 p-4"
            >
              <p className="font-medium text-zinc-100">{r.creator_name}</p>
              <p className="font-mono text-xs text-zinc-500">{r.tiktok_id}</p>
              <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                <div>
                  <dt className="text-[10px] text-zinc-600">売上</dt>
                  <dd className="font-mono">{formatYen(r.sales)}</dd>
                </div>
                <div>
                  <dt className="text-[10px] text-zinc-600">収益</dt>
                  <dd className="font-mono text-[var(--accent-cyan)]">{formatYen(r.profit)}</dd>
                </div>
                <div>
                  <dt className="text-[10px] text-zinc-600">報酬</dt>
                  <dd className="font-mono text-gradient-brand">{formatYen(r.reward)}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>

        <div className="mt-4 hidden overflow-x-auto rounded-2xl border border-white/[0.06] sm:block">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-white/[0.06] bg-surface-1/80 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                <th className="px-4 py-3">クリエイター</th>
                <th className="px-4 py-3">TikTok ID</th>
                <th className="px-4 py-3 text-right">売上</th>
                <th className="px-4 py-3 text-right">収益</th>
                <th className="px-4 py-3 text-right">代理店報酬</th>
              </tr>
            </thead>
            <tbody>
              {rankingRes.data.map((r) => (
                <tr key={r.creator_id} className="border-b border-white/[0.04]">
                  <td className="px-4 py-3 font-medium text-zinc-100">{r.creator_name}</td>
                  <td className="px-4 py-3 font-mono text-xs text-zinc-500">{r.tiktok_id}</td>
                  <td className="px-4 py-3 text-right font-mono">{formatYen(r.sales)}</td>
                  <td className="px-4 py-3 text-right font-mono text-[var(--accent-cyan)]">
                    {formatYen(r.profit)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-gradient-brand">
                    {formatYen(r.reward)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

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
