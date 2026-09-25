import Link from "next/link";
import { redirect } from "next/navigation";

import { SalesTab } from "@/app/(app)/revenue/SalesTab";
import { AgencyRewardTab } from "@/app/(app)/revenue/AgencyRewardTab";
import { ReferralRewardTab } from "@/app/(app)/revenue/ReferralRewardTab";
import { currentMonthKey } from "@/lib/db/dashboard-queries";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";
import { rewardYearOf } from "@/lib/referrals/referral-reward-engine";

export const dynamic = "force-dynamic";

const TABS = [
  { key: "sales", label: "売上" },
  { key: "agency", label: "代理店報酬" },
  { key: "referral", label: "紹介者報酬" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

function resolveTab(value: string | undefined): TabKey {
  return TABS.some((tab) => tab.key === value) ? (value as TabKey) : "sales";
}

export default async function RevenuePage({
  searchParams,
}: {
  searchParams: Promise<{
    tab?: string;
    month?: string;
    year?: string;
    referrerId?: string;
    agencyId?: string;
  }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/revenue");
  }

  const appUser = await resolveAppUserContext(supabase, user);
  const isAdmin = isAdminRole(appUser.data.role);

  if (!isAdmin && !appUser.data.agencyId) {
    return (
      <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-6 text-sm text-red-200">
        {appUser.error ?? "代理店を初期化できませんでした"}
      </div>
    );
  }

  const params = await searchParams;
  // 紹介者報酬タブは管理者のみ
  const requestedTab = resolveTab(params.tab);
  const tab: TabKey = !isAdmin && requestedTab === "referral" ? "sales" : requestedTab;

  const targetMonth =
    params.month && /^\d{4}-\d{2}$/.test(params.month)
      ? params.month
      : currentMonthKey();

  const year =
    params.year && /^\d{4}$/.test(params.year)
      ? params.year
      : rewardYearOf(targetMonth);

  const visibleTabs = TABS.filter((item) => isAdmin || item.key !== "referral");

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          {isAdmin ? "親管理画面" : appUser.data.agencyName}
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
          売上・報酬
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-500">
          売上（affiliate_order_lines）・代理店報酬・紹介者報酬をこの画面に集約しています。
        </p>
      </div>

      <nav
        className="flex gap-1 overflow-x-auto rounded-xl border border-white/[0.06] bg-surface-1/50 p-1"
        aria-label="売上・報酬タブ"
      >
        {visibleTabs.map((item) => {
          const active = item.key === tab;
          const query = new URLSearchParams({ tab: item.key });
          // 代理店報酬・紹介者報酬は年間集計、売上は月次
          if (item.key === "sales") query.set("month", targetMonth);
          else query.set("year", year);

          return (
            <Link
              key={item.key}
              href={`/revenue?${query.toString()}`}
              aria-current={active ? "page" : undefined}
              className={`min-h-[40px] flex-1 whitespace-nowrap rounded-lg px-4 py-2 text-center text-sm transition ${
                active
                  ? "bg-white/[0.1] font-semibold text-zinc-50"
                  : "font-medium text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>

      {tab === "sales" ? (
        <SalesTab
          targetMonth={targetMonth}
          isAdmin={isAdmin}
          agencyId={appUser.data.agencyId}
        />
      ) : null}

      {tab === "agency" ? (
        <AgencyRewardTab
          year={year}
          isAdmin={isAdmin}
          agencyId={appUser.data.agencyId}
          selectedAgencyId={params.agencyId?.trim() || null}
        />
      ) : null}

      {tab === "referral" && isAdmin ? (
        <ReferralRewardTab
          year={year}
          selectedReferrerId={params.referrerId?.trim() || null}
        />
      ) : null}
    </div>
  );
}
