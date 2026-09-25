import { redirect } from "next/navigation";

import { PaymentsClient } from "@/app/(app)/payments/PaymentsClient";
import { fetchPaymentOverview } from "@/lib/db/payment-queries";
import { currentMonthKey } from "@/lib/db/dashboard-queries";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/*
  支払管理（親管理者専用）。

  未払い → 支払明細作成 → 承認 → 振込CSV → 実際に振込 → 振込完了登録
  という流れをこの画面に集約する。

  ■ 金額の正式source
    代理店   agency_reward_items
    紹介者   referral_reward_items
  agency_payouts / referral_payouts の累積スナップショットは使わない。

  ■ セラー請求
  「セラー → THREE COMMERCE」の入金なので、支払予定総額には混ぜない。
  タブは読み取り専用で、操作は /admin/seller-billing へ渡す。

  ■ 読み取りはサービスロール
  payment_batches は RLS が管理者限定、agencies の銀行列は
  authenticated から列単位で外してあるため。
  管理者判定はこのページで先に済ませる。
*/
export default async function PaymentsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login?next=/payments");

  const appUser = await resolveAppUserContext(supabase, user);
  if (!isAdminRole(appUser.data.role)) redirect("/dashboard");

  const overview = await fetchPaymentOverview(getSupabaseAdmin());

  return (
    <PaymentsClient overview={overview} defaultMonth={currentMonthKey()} />
  );
}
