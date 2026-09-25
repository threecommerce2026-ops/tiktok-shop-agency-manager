import { notFound, redirect } from "next/navigation";

import { PaymentBatchClient } from "@/app/(app)/payments/[batchId]/PaymentBatchClient";
import { fetchPaymentBatchDetail } from "@/lib/db/payment-queries";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/*
  支払明細の詳細（親管理者専用）。

  対象月 / 対象クリエイター / 報酬計算元 / 報酬率 / 報酬額 まで確認できる。
  正式source は代理店 = agency_reward_items、紹介者 = referral_reward_items。

  振込先はスナップショット（承認時に固定）を表示するが、
  口座番号は下4桁のみ。全文は振込CSVの生成時にしか読まない。
*/
export default async function PaymentBatchPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const { batchId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect(`/login?next=/payments/${batchId}`);

  const appUser = await resolveAppUserContext(supabase, user);
  if (!isAdminRole(appUser.data.role)) redirect("/dashboard");

  const detail = await fetchPaymentBatchDetail(getSupabaseAdmin(), batchId);

  if (detail.error) {
    return (
      <div className="rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-200">
        {detail.error}
      </div>
    );
  }

  if (!detail.batch) notFound();

  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: "Asia/Tokyo",
  });

  return <PaymentBatchClient detail={detail} today={today} />;
}
