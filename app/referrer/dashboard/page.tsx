import { ReferrerDashboardClient } from "@/app/referrer/dashboard/ReferrerDashboardClient";
import { ReferrerPageShell } from "@/components/referrer/ReferrerPageShell";
import { fetchReferrerProfileByUser } from "@/lib/db/referrer-access";
import { fetchReferrerDashboardData } from "@/lib/db/referrer-dashboard-queries";
import { REFERRAL_PAYOUT_THRESHOLD_YEN } from "@/lib/referrals/calc";
import { buildReferralLink } from "@/lib/referrals/site-url";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function ReferrerDashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/referrer/login?next=/referrer/dashboard");
  }

  const profileResult = await fetchReferrerProfileByUser(supabase, user);
  if (!profileResult.data) {
    redirect("/referrer/register");
  }
  if (!profileResult.data.isActive) {
    redirect("/referrer/login");
  }

  const dashboardResult = await fetchReferrerDashboardData(supabase, profileResult.data.id);
  const referralLink = await buildReferralLink(profileResult.data.referralCode);

  return (
    <ReferrerPageShell title="紹介者ダッシュボード" description="紹介クリエイターの獲得収益と報酬を確認できます">
      {dashboardResult.error ? (
        <div className="mb-6 rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100" role="alert">
          {dashboardResult.error}
        </div>
      ) : null}
      <ReferrerDashboardClient
        referrerName={profileResult.data.referrerName}
        referralLink={referralLink}
        dashboard={dashboardResult.data}
        payoutThresholdYen={REFERRAL_PAYOUT_THRESHOLD_YEN}
      />
    </ReferrerPageShell>
  );
}
