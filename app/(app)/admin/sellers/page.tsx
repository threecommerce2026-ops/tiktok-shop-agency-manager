import { SellersAdminClient } from "@/app/(app)/admin/sellers/SellersAdminClient";
import { fetchSellersForAdmin } from "@/lib/db/sellers-queries";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function SellersAdminPage() {
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

  const result = await fetchSellersForAdmin(supabase);

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

      <SellersAdminClient rows={result.data} />

      <div className="flex justify-center">
        <Link href="/dashboard" className="text-sm font-medium text-[var(--accent-cyan)] hover:underline">
          ← ダッシュボード
        </Link>
      </div>
    </div>
  );
}
