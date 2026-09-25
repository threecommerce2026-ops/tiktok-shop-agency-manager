import { SellersAdminClient } from "@/app/(app)/admin/sellers/SellersAdminClient";
import { ShopIdLinkPanel } from "@/app/(app)/admin/sellers/ShopIdLinkPanel";
import { TspRateBulkPanel } from "@/app/(app)/admin/sellers/TspRateBulkPanel";
import { fetchShopIdCandidateSources } from "@/lib/db/shop-id-candidate-queries";
import { fetchSellersForAdmin } from "@/lib/db/sellers-queries";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function SellersAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ panel?: string }>;
}) {
  // ショップ実績の取込完了画面から ?panel=shop-id で遷移してくる
  const { panel } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/admin/sellers");
  }

  const appUser = await resolveAppUserContext(supabase, user);
  if (!isAdminRole(appUser.data.role)) {
    redirect("/dashboard");
  }

  const [result, candidates, aliasResult] = await Promise.all([
    fetchSellersForAdmin(supabase),
    fetchShopIdCandidateSources(supabase),
    supabase.from("seller_shop_aliases").select("seller_id, alias_normalized"),
  ]);

  const linkSellers = result.data.map((r) => ({
    id: r.id,
    seller_name: r.seller_name,
    shop_name: r.shop_name,
    shop_id: r.shop_id,
  }));

  const aliases = (aliasResult.data ?? []).map((a) => ({
    seller_id: String(a.seller_id),
    alias_normalized: String(a.alias_normalized),
  }));

  return (
    <div className="space-y-8">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">親管理画面</p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">セラー管理</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-500">
          TSP として関与しているセラー情報を社内で管理します。このページは親管理者のみが利用できます。
        </p>
      </div>

      {result.error ? (
        <div
          className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100"
          role="alert"
        >
          <p className="font-semibold">データの取得に失敗しました</p>
          <p className="mt-1 text-amber-200/90">
            {result.error}
            {result.error.includes("relation") || result.error.includes("does not exist") ? (
              <span className="block mt-2 text-xs">
                Supabase に `sellers` テーブルが未作成の可能性があります。`supabase/sql/sellers_schema.sql`
                を実行してください。
              </span>
            ) : null}
          </p>
        </div>
      ) : null}

      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <TspRateBulkPanel rows={result.data} />
          <ShopIdLinkPanel
            sellers={linkSellers}
            sources={candidates.sources}
            sourceError={candidates.error}
            aliases={aliases}
            defaultOpen={panel === "shop-id"}
          />
        </div>
      </div>

      <SellersAdminClient rows={result.data} />

      <div className="flex justify-center">
        <Link href="/dashboard" className="text-sm font-medium text-[var(--accent-cyan)] hover:underline">
          ← ダッシュボード
        </Link>
      </div>
    </div>
  );
}
