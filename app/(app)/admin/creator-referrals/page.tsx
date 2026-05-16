import { CreatorReferralsAdminClient } from "@/app/(app)/admin/creator-referrals/CreatorReferralsAdminClient";
import { fetchCreatorReferralAdminRows, fetchInHouseCreatorOptions } from "@/lib/db/creator-referral-admin-queries";
import { fetchReferrerOptions } from "@/lib/db/referrer-admin-queries";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { currentMonthKey } from "@/lib/db/dashboard-queries";
import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function CreatorReferralsAdminPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/admin/creator-referrals");
  }

  const appUser = await resolveAppUserContext(supabase, user);
  if (!isAdminRole(appUser.data.role)) {
    redirect("/dashboard");
  }

  const month = currentMonthKey();
  const [rowsResult, creatorsResult, referrersResult] = await Promise.all([
    fetchCreatorReferralAdminRows(supabase, month),
    fetchInHouseCreatorOptions(supabase),
    fetchReferrerOptions(supabase),
  ]);

  const loadError = rowsResult.error ?? creatorsResult.error ?? referrersResult.error;

  return (
    <div className="space-y-8">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">親管理画面</p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">自社クリエイター紹介者管理</h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-500">
          THREE.inc 自社クリエイターへの紹介者紐付け、紹介率、開始月・終了月、今月の紹介者報酬を管理します。
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

      <CreatorReferralsAdminClient
        rows={rowsResult.data}
        creators={creatorsResult.data}
        referrers={referrersResult.data}
      />

      <div className="flex justify-center">
        <Link href="/dashboard" className="text-sm font-medium text-[var(--accent-cyan)] hover:underline">
          ← ダッシュボード
        </Link>
      </div>
    </div>
  );
}
