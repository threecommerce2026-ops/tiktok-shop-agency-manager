import { AgencyRankingTable } from "@/components/dashboard/AgencyRankingTable";
import { MonthlyTrendChart } from "@/components/dashboard/MonthlyTrendChart";
import { SignOutButton } from "@/components/app/SignOutButton";
import { fetchAdminDashboardData } from "@/lib/db/admin-dashboard-queries";
import {
  fetchDashboardData,
  type MonthlyTrendPoint,
} from "@/lib/db/dashboard-queries";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";
import { formatYen } from "@/lib/revenue/calc";
import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

function Kpi({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-surface-1/60 p-5 ring-glow">
      <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-zinc-500">
        {label}
      </p>
      <p className="mt-3 font-mono text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
        {value}
      </p>
      {hint ? <p className="mt-2 text-xs text-zinc-600">{hint}</p> : null}
    </div>
  );
}

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const appUser = await resolveAppUserContext(supabase, user);
  const isAdmin = isAdminRole(appUser.data.role);

  if (isAdmin) {
    const stats = await fetchAdminDashboardData(supabase);

    return (
      <div className="space-y-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
              親管理画面
            </p>
            <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
              全体ダッシュボード
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-zinc-500">
              全代理店の売上・収益・報酬を横断集計します。詳細な代理店ランキングは専用ページで確認できます。
            </p>
            <p className="mt-1 text-xs text-zinc-600">
              ログイン:{" "}
              <span className="break-all font-mono text-zinc-500">{user.email}</span>
            </p>
          </div>
          <SignOutButton />
        </div>

        {stats.dbError ? (
          <div
            className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100"
            role="alert"
          >
            <p className="font-semibold">Supabase との通信エラー</p>
            <p className="mt-1 text-amber-200/90">{stats.dbError}</p>
          </div>
        ) : null}

        <section aria-labelledby="admin-kpi-heading">
          <h2 id="admin-kpi-heading" className="sr-only">
            全体指標
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Kpi label="全体総売上（今月）" value={formatYen(stats.totalSales)} />
            <Kpi label="全体総収益（今月）" value={formatYen(stats.totalProfit)} />
            <Kpi
              label="全体代理店報酬（今月）"
              value={formatYen(stats.totalReward)}
              hint={`対象月: ${stats.month}`}
            />
            <Kpi label="全代理店数" value={`${stats.agencyCount}`} />
            <Kpi label="全クリエイター数" value={`${stats.creatorCount}`} />
          </div>
        </section>

        <section aria-labelledby="admin-ranking-heading">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <h2 id="admin-ranking-heading" className="text-lg font-semibold text-zinc-200">
              代理店ランキング（{stats.month}）
            </h2>
            <Link
              href="/admin/agencies-ranking"
              className="text-sm font-medium text-[var(--accent-cyan)] hover:underline"
            >
              ランキング専用ページを開く
            </Link>
          </div>
          <div className="mt-4">
            <AgencyRankingTable rows={stats.agencyRanking} />
          </div>
        </section>

        <section aria-labelledby="admin-chart-heading">
          <h2 id="admin-chart-heading" className="sr-only">
            全体月別推移
          </h2>
          <MonthlyTrendChart data={stats.monthlyTrend} />
        </section>

        <div className="flex flex-wrap gap-3">
          <Link
            href="/creators"
            className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-white/[0.1] px-5 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.06]"
          >
            クリエイター売上一覧
          </Link>
          <Link
            href="/csv-logs"
            className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-white/[0.1] px-5 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.06]"
          >
            CSV 履歴
          </Link>
        </div>
      </div>
    );
  }

  const stats =
    appUser.data.agencyId != null
      ? await fetchDashboardData(
          supabase,
          appUser.data.agencyId,
          appUser.data.agencyName ?? "—",
        )
      : {
          agencyName: "—",
          month: "",
          totalSales: 0,
          totalProfit: 0,
          totalReward: 0,
          creatorCount: 0,
          activeCreatorCount: 0,
          monthlyTrend: [] as MonthlyTrendPoint[],
          dbError: appUser.error,
        };

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
            {stats.agencyName}
          </p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
            代理店ダッシュボード
          </h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-zinc-500">
            自社の紹介クリエイターと売上データのみを表示します。
          </p>
          <p className="mt-1 text-xs text-zinc-600">
            ログイン:{" "}
            <span className="break-all font-mono text-zinc-500">{user.email}</span>
          </p>
        </div>
        <SignOutButton />
      </div>

      {stats.dbError ? (
        <div
          className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100"
          role="alert"
        >
          <p className="font-semibold">Supabase との通信エラー</p>
          <p className="mt-1 text-amber-200/90">{stats.dbError}</p>
        </div>
      ) : null}

      <section aria-labelledby="agency-kpi-heading">
        <h2 id="agency-kpi-heading" className="sr-only">
          自社指標
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Kpi
            label="紹介クリエイター数"
            value={`${stats.creatorCount}`}
            hint="登録済みの紹介クリエイター"
          />
          <Kpi label="今月売上" value={formatYen(stats.totalSales)} />
          <Kpi label="今月収益" value={formatYen(stats.totalProfit)} />
          <Kpi
            label="代理店報酬"
            value={formatYen(stats.totalReward)}
            hint={`対象月: ${stats.month}`}
          />
          <Kpi
            label="稼働クリエイター数"
            value={`${stats.activeCreatorCount}`}
            hint="今月に売上または収益がある人数"
          />
        </div>
      </section>

      <section aria-labelledby="agency-chart-heading">
        <h2 id="agency-chart-heading" className="sr-only">
          売上推移
        </h2>
        <MonthlyTrendChart data={stats.monthlyTrend} />
      </section>

      <div className="flex flex-wrap gap-3">
        <Link
          href="/creators"
          className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-white/[0.1] px-5 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.06]"
        >
          クリエイター売上一覧
        </Link>
        <Link
          href="/sales"
          className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-white/[0.1] px-5 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.06]"
        >
          売上・収益
        </Link>
        <Link
          href="/rewards"
          className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-white/[0.1] px-5 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.06]"
        >
          代理店報酬
        </Link>
      </div>
    </div>
  );
}
