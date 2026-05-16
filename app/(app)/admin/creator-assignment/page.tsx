import { CreatorAssignmentClient } from "@/app/(app)/admin/creator-assignment/CreatorAssignmentClient";
import {
  fetchAgencyOptions,
  fetchCreatorsForAssignment,
  fetchNewRegistrationCreators,
  fetchUnassignedCreators,
} from "@/lib/db/creator-assignment-queries";
import { currentMonthKey } from "@/lib/db/dashboard-queries";
import {
  aggregateCreatorOrderMetrics,
  createEmptyCreatorOrderMetrics,
} from "@/lib/db/order-metrics";
import { fetchOrderMetricRowsForCreators } from "@/lib/db/orders-queries";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function CreatorAssignmentPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/admin/creator-assignment");
  }

  const appUser = await resolveAppUserContext(supabase, user);
  if (!isAdminRole(appUser.data.role)) {
    redirect("/dashboard");
  }

  const month = currentMonthKey();

  const [agenciesResult, creatorsResult, unassignedResult, pendingResult] = await Promise.all([
    fetchAgencyOptions(supabase),
    fetchCreatorsForAssignment(supabase),
    fetchUnassignedCreators(supabase),
    fetchNewRegistrationCreators(supabase),
  ]);

  const loadError =
    agenciesResult.error ?? creatorsResult.error ?? unassignedResult.error ?? pendingResult.error;

  const unassignedIds = unassignedResult.data.map((r) => r.id);
  const orderSnap =
    unassignedIds.length > 0
      ? await fetchOrderMetricRowsForCreators(supabase, unassignedIds)
      : { data: [], error: null as string | null };

  const commissionMap = new Map(
    unassignedResult.data.map((u) => [u.id, u.commission_rate]),
  );
  const salesByCreator =
    orderSnap.error || unassignedIds.length === 0
      ? new Map<string, ReturnType<typeof createEmptyCreatorOrderMetrics>>()
      : aggregateCreatorOrderMetrics(orderSnap.data, commissionMap, month);

  const sortedUnassigned = [...unassignedResult.data]
    .map((u) => {
      const m = salesByCreator.get(u.id) ?? createEmptyCreatorOrderMetrics();
      return { ...u, sales_month: m.salesMonth, sales_total: m.salesTotal };
    })
    .sort((a, b) => {
      if (b.sales_month !== a.sales_month) return b.sales_month - a.sales_month;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });

  return (
    <div className="space-y-8">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">親管理画面</p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
          クリエイター振り分け管理
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-500">
          未振り分け・新規登録のクリエイターを優先し、代理店・分配率・ステータス・TikTok ID
          をまとめて管理します。売上・紹介報酬の確認は
          <Link href="/creators" className="text-[var(--accent-cyan)] hover:underline">
            クリエイター売上一覧
          </Link>
          をご利用ください。
        </p>
        <p className="mt-3">
          <Link
            href="/admin/creator-assignment-logs"
            className="text-sm font-medium text-[var(--accent-cyan)] hover:underline"
          >
            振り分け変更履歴を見る →
          </Link>
          {" · "}
          <Link
            href="/admin/creator-referrals"
            className="text-sm font-medium text-[var(--accent-cyan)] hover:underline"
          >
            紹介者紐付け（CR紹介者管理）→
          </Link>
        </p>
      </div>

      {loadError || orderSnap.error ? (
        <div
          className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100"
          role="alert"
        >
          <p className="font-semibold">Supabase との通信エラー</p>
          <p className="mt-1 text-amber-200/90">{loadError ?? orderSnap.error}</p>
        </div>
      ) : null}

      <CreatorAssignmentClient
        agencies={agenciesResult.data}
        creators={creatorsResult.data}
        unassignedCreators={sortedUnassigned}
        pendingCreators={pendingResult.data}
      />

      <div className="flex justify-center">
        <Link href="/dashboard" className="text-sm font-medium text-[var(--accent-cyan)] hover:underline">
          ← ダッシュボード
        </Link>
      </div>
    </div>
  );
}
