import { redirect } from "next/navigation";

import { BulkSettlementClient } from "@/app/(app)/payments/bulk/BulkSettlementClient";
import {
  cutoffMonthOptions,
  resolveCutoffMonth,
} from "@/lib/payments/cutoff-month";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/*
  過去未払いの一括精算（親管理者専用）。

  締め対象月までの未払い抽出 → 支払可能 / 保留の分類 →
  支払先ごとに支払明細を作成 → 振込CSV → 実際に振込 → 振込完了登録。

  作られるのはすべて下書き（draft）で、この画面から支払済みにはならない。
*/
export default async function BulkSettlementPage({
  searchParams,
}: {
  searchParams: Promise<{ cutoff?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login?next=/payments/bulk");

  const appUser = await resolveAppUserContext(supabase, user);
  if (!isAdminRole(appUser.data.role)) redirect("/dashboard");

  /*
    締め対象月は /payments から引き継ぐ。
    この画面だけが独自に「当月」を既定にすると、締めていない月まで
    一括で支払ってしまう。
  */
  const params = await searchParams;
  const resolved = resolveCutoffMonth(params.cutoff ?? null);

  return (
    <BulkSettlementClient
      cutoffMonth={resolved.ok ? resolved.cutoffMonth : resolved.fallbackMonth}
      cutoffOptions={cutoffMonthOptions()}
      cutoffError={resolved.ok ? null : resolved.error}
    />
  );
}
