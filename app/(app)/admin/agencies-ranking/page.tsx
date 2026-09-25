import { AgencyRankingCards } from "@/components/dashboard/AgencyRankingCards";
import { fetchAgencyRanking } from "@/lib/db/admin-dashboard-queries";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import Link from "next/link";
import { redirect } from "next/navigation";

type PageProps = {
  searchParams?: Promise<{
    month?: string;
  }>;
};

function normalizeMonth(value?: string) {
  if (!value) return undefined;
  return /^\d{4}-\d{2}$/.test(value) ? value : undefined;
}

export default async function AgenciesRankingPage({
  searchParams,
}: PageProps) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/admin/agencies-ranking");
  }

  const appUser = await resolveAppUserContext(supabase, user);

  if (!isAdminRole(appUser.data.role)) {
    redirect("/dashboard");
  }

  const params = await searchParams;
  const targetMonth = normalizeMonth(params?.month);

  const ranking = await fetchAgencyRanking(
    supabase,
    getSupabaseAdmin(),
    targetMonth,
  );

  return (
    <div className="space-y-8">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          親管理画面
        </p>

        <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
          代理店ランキング
        </h1>

        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-500">
          全代理店を対象月のCAP代理店収益が多い順に表示します。
          月別の確定所属とFinance EngineのCAP実績を集計しています。
        </p>
      </div>

      <form
        method="get"
        className="flex flex-wrap items-end gap-3 rounded-2xl border border-white/[0.07] bg-surface-1/50 p-4"
      >
        <label className="flex flex-col gap-2 text-sm text-zinc-400">
          対象月
          <input
            type="month"
            name="month"
            defaultValue={ranking.month}
            className="rounded-xl border border-white/[0.1] bg-black/30 px-3 py-2 text-zinc-100 outline-none"
          />
        </label>

        <button
          type="submit"
          className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-zinc-200"
        >
          表示
        </button>
      </form>

      <p className="text-xs text-zinc-600">
        対象月:{" "}
        <span className="font-mono text-zinc-400">{ranking.month}</span>
      </p>

      {ranking.dbError ? (
        <div
          className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100"
          role="alert"
        >
          <p className="font-semibold">Supabase との通信エラー</p>
          <p className="mt-1 text-amber-200/90">{ranking.dbError}</p>
        </div>
      ) : null}

      <AgencyRankingCards rows={ranking.rows} />

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
