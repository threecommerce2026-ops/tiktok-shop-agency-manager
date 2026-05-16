import { CreatorsListClient } from "@/app/(app)/creators/CreatorsListClient";
import { fetchCreatorsWithMetrics } from "@/lib/db/creators-queries";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function CreatorsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/creators");
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
  const { data: rows, error, month } = await fetchCreatorsWithMetrics(supabase, {
    agencyId: isAdmin ? null : appUser.data.agencyId,
  });

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          {isAdmin ? "親管理画面" : appUser.data.agencyName}
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
          クリエイター売上一覧
        </h1>
        <p className="mt-2 text-sm text-zinc-500">
          売上・収益・代理店報酬・紹介者報酬の確認と分析用です。代理店の振り分けや分配率の変更は
          {isAdmin ? (
            <>
              {" "}
              <Link href="/admin/creator-assignment" className="text-cyan-400 hover:underline">
                クリエイター振り分け管理
              </Link>
              から行ってください。
            </>
          ) : (
            " 親管理者のクリエイター振り分け管理から行ってください。"
          )}
        </p>
      </div>

      {error ? (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          {error}
        </div>
      ) : null}

      <CreatorsListClient rows={rows} month={month} />

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
