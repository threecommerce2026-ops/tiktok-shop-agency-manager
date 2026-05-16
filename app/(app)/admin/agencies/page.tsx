import { AgenciesAdminClient } from "@/app/(app)/admin/agencies/AgenciesAdminClient";
import {
  fetchAgencyAdminRows,
  fetchAgencyCreators,
  fetchAgencyMonthlyRewards,
} from "@/lib/db/agency-admin-queries";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { currentMonthKey } from "@/lib/db/dashboard-queries";
import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function AgenciesAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ agencyId?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/admin/agencies");
  }

  const appUser = await resolveAppUserContext(supabase, user);
  if (!isAdminRole(appUser.data.role)) {
    redirect("/dashboard");
  }

  const month = currentMonthKey();
  const params = await searchParams;
  const selectedAgencyId = params.agencyId?.trim() || null;
  const agenciesResult = await fetchAgencyAdminRows(supabase, month);
  const creatorsResult = selectedAgencyId
    ? await fetchAgencyCreators(supabase, selectedAgencyId, month)
    : { data: [], error: null };
  const monthlyRewardsResult = selectedAgencyId
    ? await fetchAgencyMonthlyRewards(supabase, selectedAgencyId)
    : { data: [], error: null };

  const loadError =
    agenciesResult.error ?? creatorsResult.error ?? monthlyRewardsResult.error;

  return (
    <div className="space-y-8">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">親管理画面</p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">代理店管理</h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-500">
          代理店の追加・編集、クリエイター数、今月の決済済み売上・収益・代理店報酬を確認します。
        </p>
        <p className="mt-2 text-xs text-zinc-600">
          対象月: <span className="font-mono text-zinc-400">{month}</span>
        </p>
      </div>

      {loadError ? (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100" role="alert">
          <p className="font-semibold">Supabase との通信エラー</p>
          <p className="mt-1 text-amber-200/90">{loadError}</p>
        </div>
      ) : null}

      <AgenciesAdminClient
        agencies={agenciesResult.data}
        selectedAgencyId={selectedAgencyId}
        creators={creatorsResult.data}
        monthlyRewards={monthlyRewardsResult.data}
      />

      <div className="flex justify-center">
        <Link href="/dashboard" className="text-sm font-medium text-[var(--accent-cyan)] hover:underline">
          ← ダッシュボード
        </Link>
      </div>
    </div>
  );
}
