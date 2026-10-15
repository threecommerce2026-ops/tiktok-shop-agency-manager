import { LendingRewardTabClient } from "@/app/(app)/revenue/LendingRewardTabClient";
import { currentMonthKey } from "@/lib/db/dashboard-queries";
import {
  fetchCreatorBankAccountStatuses,
  fetchCreatorLendingSummary,
} from "@/lib/db/creator-lending-queries";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

/*
  端末貸し出し報酬タブ（管理者専用）。

  受取人はクリエイター本人。代理店ではない。
    対象   所属が自社（THREE.inc）／AK 100%／管理区分がアカウント貸し出し
    本人   AP × 分配率（既定 80%）
    自社   AP − 本人報酬
  紹介者報酬5%の対象外。

  ■ service role で読む理由
  creator_lending_* と creator_bank_accounts は authenticated ロールに
  権限を与えていない（口座情報を含むため）。
  管理者判定は page.tsx 側で済ませてからこのタブを描画する。

  ■ 口座情報
  一覧には「登録済みかどうか」と口座番号の下4桁しか渡さない。
  全桁は画面へ出さない（fetchCreatorBankAccountStatuses が下4桁に切る）。
*/
export async function LendingRewardTab({ year }: { year: string }) {
  const supabase = getSupabaseAdmin();

  const summary = await fetchCreatorLendingSummary(supabase, year);

  const creatorIds = summary.rows.map((row) => row.creatorId);
  const bankStatuses = await fetchCreatorBankAccountStatuses(supabase, creatorIds);

  const currentMonth = currentMonthKey();
  const defaultMonth = currentMonth.startsWith(year) ? currentMonth : `${year}-12`;

  return (
    <LendingRewardTabClient
      summary={summary}
      bankStatuses={[...bankStatuses.data.values()]}
      bankError={bankStatuses.error}
      defaultMonth={defaultMonth}
      year={year}
    />
  );
}
