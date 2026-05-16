import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { fetchCreatorsWithMetrics } from "@/lib/db/creators-queries";
import { createClient } from "@/lib/supabase/server";
import { formatPercent, formatYen } from "@/lib/revenue/calc";
import Link from "next/link";
import { redirect } from "next/navigation";

export default async function RewardsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/rewards");
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
  const { data: rows, error } = await fetchCreatorsWithMetrics(supabase, {
    agencyId: isAdmin ? null : appUser.data.agencyId,
  });

  const monthTotal = rows.reduce((s, r) => s + r.agency_reward_month, 0);

  return (
    <div className="space-y-8">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          {isAdmin ? "親管理画面" : appUser.data.agencyName}
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
          代理店報酬一覧
        </h1>
        <p className="mt-2 text-sm text-zinc-500">
          報酬 = 決済済み注文の対象収益 × 分配率（%）。未決済・キャンセル・返品・配送中は対象外です。
        </p>
      </div>

      {error ? (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          {error}
        </div>
      ) : null}

      <div className="rounded-2xl border border-white/[0.07] bg-surface-1/60 p-6 ring-glow">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          今月の代理店報酬（合計）
        </p>
        <p className="mt-2 font-mono text-3xl font-bold text-gradient-brand">
          {formatYen(monthTotal)}
        </p>
      </div>

      <div className="hidden overflow-x-auto rounded-2xl border border-white/[0.06] md:block">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead>
            <tr className="border-b border-white/[0.06] bg-surface-1/80 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              <th className="px-4 py-3">クリエイター</th>
              <th className="px-4 py-3">TikTok ID</th>
              <th className="px-4 py-3 text-right">報酬対象収益</th>
              <th className="px-4 py-3 text-right">分配率</th>
              <th className="px-4 py-3 text-right">報酬（予定）</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-white/[0.04]">
                <td className="px-4 py-3 font-medium">{r.creator_name}</td>
                <td className="px-4 py-3 font-mono text-xs text-zinc-500">{r.tiktok_id}</td>
                <td className="px-4 py-3 text-right font-mono text-[var(--accent-cyan)]">
                  {formatYen(r.profitMonth)}
                </td>
                <td className="px-4 py-3 text-right font-mono">
                  {formatPercent(r.commission_rate)}
                </td>
                <td className="px-4 py-3 text-right font-mono font-semibold text-gradient-brand">
                  {formatYen(r.agency_reward_month)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="flex flex-col gap-3 md:hidden" aria-label="代理店報酬（カード）">
        {rows.map((r) => (
          <li
            key={r.id}
            className="rounded-2xl border border-white/[0.07] bg-surface-1/50 p-4"
          >
            <p className="font-semibold text-zinc-100">{r.creator_name}</p>
            <p className="font-mono text-xs text-zinc-500">{r.tiktok_id}</p>
            <dl className="mt-3 space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-zinc-600">報酬対象収益</dt>
                <dd className="font-mono text-[var(--accent-cyan)]">
                  {formatYen(r.profitMonth)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-zinc-600">分配率</dt>
                <dd className="font-mono">{formatPercent(r.commission_rate)}</dd>
              </div>
              <div className="flex justify-between border-t border-white/[0.06] pt-2">
                <dt className="text-zinc-600">報酬</dt>
                <dd className="font-mono font-bold text-gradient-brand">
                  {formatYen(r.agency_reward_month)}
                </dd>
              </div>
            </dl>
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
