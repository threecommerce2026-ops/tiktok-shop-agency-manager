import { SalesTabClient } from "@/app/(app)/revenue/SalesTabClient";
import {
  fetchAvailableMonths,
  fetchMonthlySalesSummary,
} from "@/lib/db/revenue-queries";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

/*
  affiliate_order_lines / creators は RLS が管理者のみ SELECT 可のため、
  集計は service role で読み、代理店スコープはサーバー側で必ず絞り込む。
  agencyId はセッションから解決した値のみを渡すこと（クエリ文字列を信用しない）。
*/
export async function SalesTab({
  targetMonth,
  isAdmin,
  agencyId,
}: {
  targetMonth: string;
  isAdmin: boolean;
  agencyId: string | null;
}) {
  const readClient = getSupabaseAdmin();

  const [summary, months] = await Promise.all([
    fetchMonthlySalesSummary(readClient, {
      targetMonth,
      agencyId: isAdmin ? null : agencyId,
    }),
    fetchAvailableMonths(readClient),
  ]);

  return <SalesTabClient summary={summary} months={months} isAdmin={isAdmin} />;
}
