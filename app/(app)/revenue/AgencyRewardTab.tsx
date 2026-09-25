import { AgencyRewardTabClient } from "@/app/(app)/revenue/AgencyRewardTabClient";
import { fetchAgencyAnnualSummary } from "@/lib/db/agency-annual-queries";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

/*
  代理店報酬タブ。

  ・計算元は affiliate_order_lines.agency_revenue（TikTok実額）
  ・分配率は TikTok 実データの agency_split_rate が正
  ・対象は 決済済み + 支払い済み + 返金除外
  ・TAP 収益は含めない
  ・THREE.inc 所属 / 代理店未設定 は 0円

  agency_reward_items / agency_payouts は RLS が管理者と自社代理店のみのため
  読み取りは service role で行い、代理店スコープはサーバー側で必ず絞る。
*/
export async function AgencyRewardTab({
  year,
  isAdmin,
  agencyId,
  selectedAgencyId,
}: {
  year: string;
  isAdmin: boolean;
  agencyId: string | null;
  selectedAgencyId: string | null;
}) {
  const summary = await fetchAgencyAnnualSummary(getSupabaseAdmin(), year, {
    agencyId: isAdmin ? null : agencyId,
  });

  /*
    支払確定はこのタブから行わない（支払管理 /payments へ一本化した）。
    対象月の既定値を渡す必要がなくなったので props からも外している。
  */
  return (
    <AgencyRewardTabClient
      summary={summary}
      isAdmin={isAdmin}
      selectedAgencyId={selectedAgencyId}
    />
  );
}
