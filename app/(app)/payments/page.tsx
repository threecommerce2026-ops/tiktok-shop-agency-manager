import { redirect } from "next/navigation";

import { PaymentsClient } from "@/app/(app)/payments/PaymentsClient";
import { fetchPaymentOverview } from "@/lib/db/payment-queries";
import {
  cutoffMonthOptions,
  resolveCutoffMonth,
} from "@/lib/payments/cutoff-month";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/*
  支払管理（親管理者専用）。

  未払い → 支払明細作成 → 承認 → 振込CSV → 実際に振込 → 振込完了登録
  という流れをこの画面に集約する。

  ■ 締め対象月
  画面全体を「この月までの未払い」で揃える。支払明細の claim 上限と
  同じ値を使うので、画面に出ている金額と実際に作られる支払明細が一致する。
  既定は JST の前月（締め終わっている直近の月）。当月を既定にすると、
  まだ締めていない当月分を誤って支払える。

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
export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ cutoff?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login?next=/payments");

  const appUser = await resolveAppUserContext(supabase, user);
  if (!isAdminRole(appUser.data.role)) redirect("/dashboard");

  const params = await searchParams;
  const resolved = resolveCutoffMonth(params.cutoff ?? null);
  // 不正な指定は勝手に丸めない。安全側の既定で表示し、理由を画面に出す。
  const cutoffMonth = resolved.ok ? resolved.cutoffMonth : resolved.fallbackMonth;
  const cutoffError = resolved.ok ? null : resolved.error;

  const [overview, allTimeOverview] = await Promise.all([
    fetchPaymentOverview(getSupabaseAdmin(), { cutoffMonth }),
    // 参考表示用。支払判断には使わない
    fetchPaymentOverview(getSupabaseAdmin()),
  ]);

  const allTimeUnpaidAmount =
    Math.round(
      allTimeOverview.rows.reduce((total, row) => total + row.unpaidAmount, 0) * 100,
    ) / 100;

  return (
    <PaymentsClient
      overview={overview}
      cutoffMonth={cutoffMonth}
      cutoffOptions={cutoffMonthOptions()}
      cutoffError={cutoffError}
      allTimeUnpaidAmount={allTimeUnpaidAmount}
    />
  );
}
