import { OrdersListClient } from "@/app/(app)/orders/OrdersListClient";
import {
  fetchCreatorPaidOrderSummaries,
  fetchOrders,
} from "@/lib/db/orders-queries";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function OrdersPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/orders");
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
  const agencyId = isAdmin ? null : appUser.data.agencyId;

  const [ordersResult, summariesResult] = await Promise.all([
    fetchOrders(supabase, { agencyId }),
    fetchCreatorPaidOrderSummaries(supabase, { agencyId }),
  ]);

  const loadError = ordersResult.error ?? summariesResult.error;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          {isAdmin ? "親管理画面" : appUser.data.agencyName}
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
          注文一覧
        </h1>
        <p className="mt-2 text-sm text-zinc-500">
          TikTok Shop Order API の注文を表示します。代理店報酬は決済済みかつ
          キャンセル・返品・配送中を除外した注文のみを対象に計算します。
        </p>
      </div>

      <OrdersListClient
        isAdmin={isAdmin}
        orders={ordersResult.data}
        summaries={summariesResult.data}
        loadError={loadError}
      />

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
