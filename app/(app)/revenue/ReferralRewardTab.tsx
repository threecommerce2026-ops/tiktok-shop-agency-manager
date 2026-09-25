import { ReferralRewardTabClient } from "@/app/(app)/revenue/ReferralRewardTabClient";
import {
  fetchReferralAnnualDetail,
  fetchReferralAnnualSummary,
} from "@/lib/db/referral-annual-queries";
import { currentMonthKey } from "@/lib/db/dashboard-queries";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

/*
  紹介者報酬タブ（管理者専用）。

  ・対象は通常クリエイター（standard）のみ
  ・自社運用 / アカウント貸出は5%の対象外
  ・支払判定は年間未払い累積 1,000円以上
*/
export async function ReferralRewardTab({
  year,
  selectedReferrerId,
}: {
  year: string;
  selectedReferrerId: string | null;
}) {
  const supabase = getSupabaseAdmin();

  const [summary, detail] = await Promise.all([
    fetchReferralAnnualSummary(supabase, year),
    selectedReferrerId
      ? fetchReferralAnnualDetail(supabase, year, selectedReferrerId)
      : Promise.resolve(null),
  ]);

  const currentMonth = currentMonthKey();
  const defaultMonth = currentMonth.startsWith(year) ? currentMonth : `${year}-12`;

  return (
    <ReferralRewardTabClient
      summary={summary}
      detail={detail}
      selectedReferrerId={selectedReferrerId}
      defaultMonth={defaultMonth}
    />
  );
}
