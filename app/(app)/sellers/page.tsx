import Link from "next/link";
import { redirect } from "next/navigation";

import { SellerOverviewClient } from "@/app/(app)/sellers/SellerOverviewClient";
import { currentMonthKey } from "@/lib/db/dashboard-queries";
import { fetchSellerOverview } from "@/lib/db/seller-overview-queries";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export default async function SellersPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/sellers");
  }

  const appUser = await resolveAppUserContext(supabase, user);
  const isAdmin = isAdminRole(appUser.data.role);

  const params = await searchParams;
  const month =
    params.month && /^\d{4}-\d{2}$/.test(params.month)
      ? params.month
      : currentMonthKey();

  /*
    sellers / affiliate_order_lines は RLS が管理者のみ SELECT 可のため
    読み取りは service role で行い、代理店スコープはサーバー側で必ず絞る。
  */
  const data = await fetchSellerOverview(getSupabaseAdmin(), {
    month,
    agencyId: isAdmin ? null : appUser.data.agencyId,
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
            {isAdmin ? "親管理画面" : appUser.data.agencyName}
          </p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
            セラー
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-500">
            セラーマスタと実績（GMV・注文件数・クリエイター数・代理店収益）をまとめて確認できます。
          </p>
        </div>

        {isAdmin ? (
          <div className="flex flex-wrap gap-2">
            <Link
              href="/admin/sellers"
              className="inline-flex min-h-[40px] items-center rounded-lg border border-white/[0.1] px-4 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.06]"
            >
              セラー情報を編集
            </Link>
            <Link
              href="/admin/shop-performance"
              className="inline-flex min-h-[40px] items-center rounded-lg border border-white/[0.1] px-4 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.06]"
            >
              ショップ実績CSV取込
            </Link>
            <Link
              href="/admin/partner-center-import"
              className="inline-flex min-h-[40px] items-center rounded-lg border border-white/[0.1] px-4 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.06]"
            >
              Partner Center取込
            </Link>
            <Link
              href="/admin/seller-billing"
              className="inline-flex min-h-[40px] items-center rounded-lg bg-white px-4 text-sm font-semibold text-zinc-950 transition hover:bg-zinc-200"
            >
              セラー請求
            </Link>
          </div>
        ) : null}
      </div>

      {data.error ? (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          {data.error}
        </div>
      ) : null}

      <SellerOverviewClient data={data} isAdmin={isAdmin} />
    </div>
  );
}
