import { ShopPerformanceClient } from "@/app/(app)/admin/shop-performance/ShopPerformanceClient";
import { fetchSellersForAdmin } from "@/lib/db/sellers-queries";
import {
  fetchShopPerformanceBatchesForAdmin,
  fetchShopPerformanceImportsForAdmin,
} from "@/lib/db/shop-performance-queries";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function ShopPerformanceAdminPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/admin/shop-performance");
  }

  const appUser = await resolveAppUserContext(supabase, user);
  if (!isAdminRole(appUser.data.role)) {
    redirect("/dashboard");
  }

  const [importsResult, batchesResult, sellersResult] = await Promise.all([
    fetchShopPerformanceImportsForAdmin(supabase),
    fetchShopPerformanceBatchesForAdmin(supabase),
    fetchSellersForAdmin(supabase),
  ]);

  const schemaHint =
    importsResult.error?.includes("does not exist") ||
    importsResult.error?.includes("relation") ||
    batchesResult.error?.includes("does not exist");

  return (
    <div className="space-y-8">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          親管理画面
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
          ショップ分析 / TSP請求
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-500">
          Partner Center「分析 → ショップ」の Shop ranking エクスポート（XLSX）を取り込み、ショップ別
          GMV と TSP 請求額（GMV × tsp_rate）を管理します。代理店画面には表示されません。
        </p>
      </div>

      {importsResult.error || batchesResult.error ? (
        <div
          className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100"
          role="alert"
        >
          <p className="font-semibold">データの取得に失敗しました</p>
          <p className="mt-1 text-amber-200/90">
            {importsResult.error ?? batchesResult.error}
            {schemaHint ? (
              <span className="mt-2 block text-xs">
                `supabase/sql/shop_performance_schema.sql` を feature
                環境の Supabase に適用してください（本番適用は別途承認後）。
              </span>
            ) : null}
          </p>
        </div>
      ) : null}

      <ShopPerformanceClient
        rows={importsResult.data}
        batches={batchesResult.data}
        sellers={sellersResult.data.map((s) => ({
          id: s.id,
          seller_name: s.seller_name,
          shop_name: s.shop_name,
          tsp_rate: s.tsp_rate,
        }))}
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
