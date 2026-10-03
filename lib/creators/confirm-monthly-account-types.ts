import type { SupabaseClient } from "@supabase/supabase-js";

import { isAccountManagementType } from "@/lib/creators/account-management-type";
import { isValidTargetMonth } from "@/lib/referrals/referral-reward-engine";

/*
  月別区分の確定処理（単一ソース）。

  個別UI（TAP実績 / クリエイター画面の月別区分パネル）が
  この関数を使う。保存処理を二重実装しない。

  保存対象は creator_monthly_account_management_types のみ。
  creators.account_management_type（現在区分）は変更しない。
  現在区分の変更はクリエイターマスタ編集が担当する。

  ■ 安全装置
  対象月の紹介報酬が支払済み・支払予定中（is_paid / payout_id /
  payment_batch_id のいずれか）なら変更を拒否する。
  区分を動かすと sync が触れない明細と実額がずれるため、
  区分の訂正は支払取消のあとに行う。

  ■ 履歴
  既存 RPC set_creator_monthly_account_management_type /
  reset_creator_monthly_account_management_type が
  creator_monthly_account_management_type_logs へ履歴を残す。
*/

export type MonthlyAccountTypeEntry = {
  creatorId: string;
  targetMonth: string;
  accountManagementType: string;
};

export type ConfirmMonthlyAccountTypesResult = {
  confirmedCount: number;
  creatorCount: number;
  months: string[];
  /** 支払済みのため変更しなかった月 */
  blocked: Array<{ creatorId: string; targetMonth: string }>;
  error: string | null;
};

const EMPTY: ConfirmMonthlyAccountTypesResult = {
  confirmedCount: 0,
  creatorCount: 0,
  months: [],
  blocked: [],
  error: null,
};

export async function confirmMonthlyAccountTypes(
  /** RPC 実行用。auth.uid() が必要なのでユーザーのクライアントを使う */
  userClient: SupabaseClient,
  /** 支払済みチェック用 */
  adminClient: SupabaseClient,
  entries: MonthlyAccountTypeEntry[],
): Promise<ConfirmMonthlyAccountTypesResult> {
  const valid = entries.filter(
    (entry) =>
      entry.creatorId &&
      isValidTargetMonth(entry.targetMonth) &&
      isAccountManagementType(entry.accountManagementType),
  );

  if (valid.length === 0) {
    return { ...EMPTY, error: "確定する対象がありません" };
  }

  /*
    支払済み・支払予定中の紹介報酬がある creator × month を集める。
    sync はこれらの明細を触らないので、区分だけ変えると
    「区分は対象外なのに報酬が残っている」状態になる。
  */
  const creatorIds = [...new Set(valid.map((entry) => entry.creatorId))];
  const months = [...new Set(valid.map((entry) => entry.targetMonth))];

  const { data: paidRows, error: paidError } = await adminClient
    .from("referral_reward_items")
    .select("creator_id, target_month, is_paid, payout_id, payment_batch_id")
    .in("creator_id", creatorIds)
    .in("target_month", months);

  if (paidError && paidError.code !== "42P01" && paidError.code !== "PGRST205") {
    return { ...EMPTY, error: paidError.message };
  }

  const protectedPairs = new Set<string>();
  for (const row of paidRows ?? []) {
    if (
      row.is_paid === true ||
      row.payout_id != null ||
      row.payment_batch_id != null
    ) {
      protectedPairs.add(`${row.creator_id}|${row.target_month}`);
    }
  }

  const blocked: Array<{ creatorId: string; targetMonth: string }> = [];
  const confirmedMonths = new Set<string>();
  const confirmedCreators = new Set<string>();
  let confirmedCount = 0;

  for (const entry of valid) {
    if (protectedPairs.has(`${entry.creatorId}|${entry.targetMonth}`)) {
      blocked.push({ creatorId: entry.creatorId, targetMonth: entry.targetMonth });
      continue;
    }

    const { error } = await userClient.rpc(
      "set_creator_monthly_account_management_type",
      {
        p_creator_id: entry.creatorId,
        p_target_month: entry.targetMonth,
        p_account_management_type: entry.accountManagementType,
      },
    );

    if (error) {
      return {
        confirmedCount,
        creatorCount: confirmedCreators.size,
        months: [...confirmedMonths].sort(),
        blocked,
        error: error.message,
      };
    }

    confirmedCount += 1;
    confirmedMonths.add(entry.targetMonth);
    confirmedCreators.add(entry.creatorId);
  }

  return {
    confirmedCount,
    creatorCount: confirmedCreators.size,
    months: [...confirmedMonths].sort(),
    blocked,
    error: null,
  };
}
