import { ReferrersAdminClient } from "@/app/(app)/admin/referrers/ReferrersAdminClient";
import { ReferrerMaintenanceSection } from "@/components/master/ReferrerMaintenanceSection";
import { fetchReferrerMaintenanceData } from "@/lib/db/referrer-maintenance-queries";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  fetchReferrerAdminCreators,
  fetchReferrerAdminRows,
} from "@/lib/db/referrer-admin-queries";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { currentMonthKey } from "@/lib/db/dashboard-queries";
import { buildReferralLink } from "@/lib/referrals/site-url";
import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function ReferrersAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ referrerId?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/admin/referrers");
  }

  const appUser = await resolveAppUserContext(supabase, user);
  if (!isAdminRole(appUser.data.role)) {
    redirect("/dashboard");
  }

  const month = currentMonthKey();
  const params = await searchParams;
  const selectedReferrerId = params.referrerId?.trim() || null;
  const referrersResult = await fetchReferrerAdminRows(supabase, month);
  const referralLinks: Record<string, string> = {};
  for (const referrer of referrersResult.data) {
    if (referrer.referralCode) {
      referralLinks[referrer.id] = await buildReferralLink(referrer.referralCode);
    }
  }

  const creatorsResult = selectedReferrerId
    ? await fetchReferrerAdminCreators(supabase, selectedReferrerId, month)
    : { data: [], error: null };

  // マスタ整理セクション用（名称編集 / 統合 / 無効化 / 削除）
  // RLS が管理者のみのため service role で読む
  const maintenanceData = await fetchReferrerMaintenanceData(getSupabaseAdmin());

  const selectedReferrer = selectedReferrerId
    ? referrersResult.data.find((referrer) => referrer.id === selectedReferrerId) ?? null
    : null;
  const loadError = referrersResult.error ?? creatorsResult.error;

  return (
    <div className="space-y-8">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">親管理画面</p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">紹介者管理</h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-500">
          紹介者マスタ（連絡先・振込先・紹介リンク）の管理画面です。報酬の集計と支払い確定は「売上・報酬 › 紹介者報酬」で行います。
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

      {maintenanceData.error ? (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          {maintenanceData.error}
        </div>
      ) : (
        <ReferrerMaintenanceSection data={maintenanceData} />
      )}

      <ReferrersAdminClient
        referrers={referrersResult.data}
        referralLinks={referralLinks}
        targetMonth={month}
        selectedReferrerId={selectedReferrerId}
        selectedReferrer={selectedReferrer}
        creators={creatorsResult.data}
      />

      <div className="flex justify-center">
        <Link href="/dashboard" className="text-sm font-medium text-[var(--accent-cyan)] hover:underline">
          ← ダッシュボード
        </Link>
      </div>
    </div>
  );
}
