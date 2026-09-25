import type { SupabaseClient } from "@supabase/supabase-js";

import { isValidTargetMonth } from "@/lib/agency/agency-reward-engine";

/*
  月別所属の確定処理（単一ソース）。

  個別UI（クリエイター画面の月別所属パネル）と
  一括UI（月別所属ボード）の両方がこの関数を使う。保存処理を二重実装しない。

  ■ 保存対象
  creator_monthly_agency_assignments のみ。
  creators.agency_id（現在所属）は変更しない。

  ■ 安全装置
  支払い済みの代理店報酬がある クリエイター×対象月 は変更を拒否する。

  ■ 履歴
  RPC set_creator_monthly_agency_assignment が
  creator_monthly_agency_assignment_logs へ履歴を残す。
*/

export type MonthlyAssignmentEntry = {
  creatorId: string;
  targetMonth: string;
  agencyId: string;
};

export type ConfirmMonthlyAssignmentsResult = {
  confirmedCount: number;
  creatorCount: number;
  months: string[];
  /** 支払い済みのためスキップした クリエイター×月 */
  blocked: Array<{ creatorId: string; targetMonth: string }>;
  error: string | null;
};

function entryKey(entry: { creatorId: string; targetMonth: string }): string {
  return `${entry.creatorId}:${entry.targetMonth}`;
}

/**
 * 支払い済みの代理店報酬がある クリエイター×対象月 を返す。
 * agency_reward_items が未作成の環境では空を返す。
 */
async function findPaidEntries(
  adminClient: SupabaseClient,
  entries: MonthlyAssignmentEntry[],
): Promise<{ paidKeys: Set<string>; error: string | null }> {
  const creatorIds = [...new Set(entries.map((entry) => entry.creatorId))];
  const months = [...new Set(entries.map((entry) => entry.targetMonth))];

  const { data, error } = await adminClient
    .from("agency_reward_items")
    .select("creator_id, target_month")
    .eq("is_paid", true)
    .in("creator_id", creatorIds)
    .in("target_month", months);

  if (error) {
    if (error.code === "42P01" || error.code === "PGRST205") {
      return { paidKeys: new Set(), error: null };
    }
    return { paidKeys: new Set(), error: error.message };
  }

  return {
    paidKeys: new Set(
      (data ?? []).map((row) =>
        entryKey({
          creatorId: row.creator_id as string,
          targetMonth: row.target_month as string,
        }),
      ),
    ),
    error: null,
  };
}

/**
 * 指定した クリエイター×対象月×代理店 の組を月別確定する。
 *
 * @param userClient   RPC 実行用。is_app_admin() が auth.uid() を参照するため
 *                     ログインユーザーのクライアントを渡すこと。
 * @param adminClient  支払い済みチェック用（RLS を跨いで読む）。
 */
export async function confirmMonthlyAssignments(
  userClient: SupabaseClient,
  adminClient: SupabaseClient,
  entries: MonthlyAssignmentEntry[],
): Promise<ConfirmMonthlyAssignmentsResult> {
  const empty: ConfirmMonthlyAssignmentsResult = {
    confirmedCount: 0,
    creatorCount: 0,
    months: [],
    blocked: [],
    error: null,
  };

  // 同じ クリエイター×月 が重複していても1回だけ処理する
  const uniqueEntries = new Map<string, MonthlyAssignmentEntry>();

  for (const entry of entries) {
    if (!entry.creatorId || !entry.agencyId) continue;
    if (!isValidTargetMonth(entry.targetMonth)) continue;
    uniqueEntries.set(entryKey(entry), entry);
  }

  const targets = [...uniqueEntries.values()];

  if (targets.length === 0) {
    return { ...empty, error: "確定する対象がありません" };
  }

  const paid = await findPaidEntries(adminClient, targets);
  if (paid.error) {
    return { ...empty, error: paid.error };
  }

  const blocked: Array<{ creatorId: string; targetMonth: string }> = [];
  const confirmed: MonthlyAssignmentEntry[] = [];

  for (const entry of targets) {
    if (paid.paidKeys.has(entryKey(entry))) {
      blocked.push({ creatorId: entry.creatorId, targetMonth: entry.targetMonth });
      continue;
    }
    confirmed.push(entry);
  }

  for (const entry of confirmed) {
    const { error } = await userClient.rpc(
      "set_creator_monthly_agency_assignment",
      {
        p_creator_id: entry.creatorId,
        p_target_month: entry.targetMonth,
        p_agency_id: entry.agencyId,
      },
    );

    if (error) {
      return { ...empty, blocked, error: error.message };
    }
  }

  return {
    confirmedCount: confirmed.length,
    creatorCount: new Set(confirmed.map((entry) => entry.creatorId)).size,
    months: [...new Set(confirmed.map((entry) => entry.targetMonth))].sort(),
    blocked,
    error: null,
  };
}
