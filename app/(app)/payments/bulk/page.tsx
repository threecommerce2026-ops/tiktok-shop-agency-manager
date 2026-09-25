import { redirect } from "next/navigation";

import { BulkSettlementClient } from "@/app/(app)/payments/bulk/BulkSettlementClient";
import { currentMonthKey } from "@/lib/db/dashboard-queries";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/*
  過去未払いの一括精算（親管理者専用）。

  全未払い抽出 → 支払可能 / 保留の分類 → 支払先ごとに支払明細を作成
  → 振込CSV → 実際に振込 → 振込完了登録。

  作られるのはすべて下書き（draft）で、この画面から支払済みにはならない。
*/
export default async function BulkSettlementPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login?next=/payments/bulk");

  const appUser = await resolveAppUserContext(supabase, user);
  if (!isAdminRole(appUser.data.role)) redirect("/dashboard");

  return <BulkSettlementClient defaultEndMonth={currentMonthKey()} />;
}
