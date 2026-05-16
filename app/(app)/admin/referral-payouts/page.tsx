import { ReferralPayoutsAdminClient } from "@/app/(app)/admin/referral-payouts/ReferralPayoutsAdminClient";
import {
  fetchReferralPayoutAdminRows,
  fetchReferralRewardItems,
} from "@/lib/db/referral-payout-admin-queries";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { currentMonthKey } from "@/lib/db/dashboard-queries";
import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function ReferralPayoutsAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ referrerId?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/admin/referral-payouts");
  }

  const appUser = await resolveAppUserContext(supabase, user);
  if (!isAdminRole(appUser.data.role)) {
    redirect("/dashboard");
  }

  const month = currentMonthKey();
  const params = await searchParams;
  const selectedReferrerId = params.referrerId?.trim() || null;
  const payoutsResult = await fetchReferralPayoutAdminRows(supabase, month);
  const itemsResult = await fetchReferralRewardItems(supabase, {
    targetMonth: month,
    referrerId: selectedReferrerId,
  });

  const loadError = payoutsResult.error ?? itemsResult.error;

  return (
    <div className="space-y-8">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">親管理画面</p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">紹介者報酬支払い管理</h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-500">
          月次の紹介者報酬を集計し、1,000円以上のみ支払い対象とします。支払い済み明細は二重払いされません。
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

      <ReferralPayoutsAdminClient
        targetMonth={month}
        payouts={payoutsResult.data}
        items={itemsResult.data}
        selectedReferrerId={selectedReferrerId}
      />

      <div className="flex justify-center">
        <Link href="/dashboard" className="text-sm font-medium text-[var(--accent-cyan)] hover:underline">
          ← ダッシュボード
        </Link>
      </div>
    </div>
  );
}
