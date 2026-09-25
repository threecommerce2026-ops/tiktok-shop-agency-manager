"use server";

import { revalidatePath } from "next/cache";

import { requireAdminAction } from "@/lib/db/admin-access";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { mapSupabaseErrorToJa } from "@/lib/supabase/error-ja";
import { isValidTargetMonth } from "@/lib/agency/agency-reward-engine";
import {
  fetchCreatorMonthlyAssignments,
  type CreatorMonthlyAssignmentData,
} from "@/lib/db/creator-monthly-assignment-queries";
import { confirmMonthlyAssignments } from "@/lib/agency/confirm-monthly-assignments";

/*
  月別所属の確定・解除。

  ここで変更するのは creator_monthly_agency_assignments（対象月の確定所属）だけ。
  creators.agency_id（現在所属）は変更しない。
  現在所属の変更はクリエイターマスタ編集（updateCreatorMasterAction）で行う。

  ■ 安全装置
  対象月に支払い済みの代理店報酬がある場合は変更を拒否する。
  支払履歴を壊さないため、所属の訂正は支払取消のあとに行う。

  ■ 履歴
  既存 RPC set_creator_monthly_agency_assignment /
  reset_creator_monthly_agency_assignment が
  creator_monthly_agency_assignment_logs へ履歴を残す。
*/

export type MonthlyAssignmentActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

function readText(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function readMonths(formData: FormData): string[] {
  return formData
    .getAll("target_months")
    .map((value) => String(value).trim())
    .filter((value) => isValidTargetMonth(value));
}

function revalidateAssignmentViews() {
  revalidatePath("/creators");
  revalidatePath("/revenue");
  revalidatePath("/admin/monthly-agency-assignments");
  revalidatePath("/admin/monthly-finance");
  revalidatePath("/dashboard");
}

/**
 * 選択した月の所属を、指定した代理店で確定する（1クリエイター分）。
 * 保存処理は lib/agency/confirm-monthly-assignments.ts を再利用する。
 */
export async function confirmCreatorMonthlyAssignmentsAction(
  _prev: MonthlyAssignmentActionResult | null,
  formData: FormData,
): Promise<MonthlyAssignmentActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const creatorId = readText(formData, "creator_id");
  const agencyId = readText(formData, "agency_id");
  const months = readMonths(formData);

  if (!creatorId) {
    return { ok: false, error: "クリエイター ID が不正です" };
  }
  if (!agencyId) {
    return { ok: false, error: "確定する代理店を選択してください" };
  }
  if (months.length === 0) {
    return { ok: false, error: "確定する対象月を1つ以上選択してください" };
  }

  const result = await confirmMonthlyAssignments(
    auth.supabase,
    getSupabaseAdmin(),
    months.map((targetMonth) => ({ creatorId, targetMonth, agencyId })),
  );

  if (result.error) {
    return { ok: false, error: mapSupabaseErrorToJa(result.error) };
  }

  if (result.confirmedCount === 0 && result.blocked.length > 0) {
    return {
      ok: false,
      error: `${result.blocked
        .map((entry) => entry.targetMonth)
        .join(", ")} には支払い済みの代理店報酬があるため所属を変更できません。先に支払いを取り消してください。`,
    };
  }

  revalidateAssignmentViews();

  const blockedNote =
    result.blocked.length > 0
      ? `（${result.blocked.map((entry) => entry.targetMonth).join(", ")} は支払済のためスキップ）`
      : "";

  return {
    ok: true,
    message: `${result.months.join(", ")} の所属を確定しました（${result.confirmedCount} ヶ月）${blockedNote}。代理店報酬へ反映するには「再集計」を実行してください。`,
  };
}

/**
 * 月別確定を解除して、現在所属の暫定フォールバックに戻す。
 */
export async function resetCreatorMonthlyAssignmentAction(
  _prev: MonthlyAssignmentActionResult | null,
  formData: FormData,
): Promise<MonthlyAssignmentActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const creatorId = readText(formData, "creator_id");
  const targetMonth = readText(formData, "target_month");

  if (!creatorId || !isValidTargetMonth(targetMonth)) {
    return { ok: false, error: "クリエイターと対象月を指定してください" };
  }

  const { data: paidRows, error: paidError } = await getSupabaseAdmin()
    .from("agency_reward_items")
    .select("id")
    .eq("creator_id", creatorId)
    .eq("target_month", targetMonth)
    .eq("is_paid", true)
    .limit(1);

  if (paidError && paidError.code !== "42P01" && paidError.code !== "PGRST205") {
    return { ok: false, error: mapSupabaseErrorToJa(paidError.message) };
  }
  if ((paidRows ?? []).length > 0) {
    return {
      ok: false,
      error: `${targetMonth} には支払い済みの代理店報酬があるため解除できません。先に支払いを取り消してください。`,
    };
  }

  const { error } = await auth.supabase.rpc(
    "reset_creator_monthly_agency_assignment",
    {
      p_creator_id: creatorId,
      p_target_month: targetMonth,
    },
  );

  if (error) {
    return { ok: false, error: mapSupabaseErrorToJa(error.message) };
  }

  revalidateAssignmentViews();
  return {
    ok: true,
    message: `${targetMonth} の月別確定を解除しました（現在所属での暫定計算に戻ります）`,
  };
}

export type LoadMonthlyAssignmentResult =
  | {
      ok: true;
      data: CreatorMonthlyAssignmentData;
      agencies: Array<{ id: string; name: string; isActive: boolean }>;
    }
  | { ok: false; error: string };

/**
 * 月別所属パネル用のデータを取得する（読み取りのみ）。
 * クリエイター行を開いたときに必要な分だけ読む。
 */
export async function loadCreatorMonthlyAssignmentAction(
  creatorId: string,
): Promise<LoadMonthlyAssignmentResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  if (!creatorId.trim()) {
    return { ok: false, error: "クリエイター ID が不正です" };
  }

  const admin = getSupabaseAdmin();

  const [data, agenciesResult] = await Promise.all([
    fetchCreatorMonthlyAssignments(admin, creatorId),
    admin.from("agencies").select("id, name, is_active").order("name"),
  ]);

  if (data.error) {
    return { ok: false, error: mapSupabaseErrorToJa(data.error) };
  }
  if (agenciesResult.error) {
    return { ok: false, error: mapSupabaseErrorToJa(agenciesResult.error.message) };
  }

  return {
    ok: true,
    data,
    agencies: (agenciesResult.data ?? []).map((row) => ({
      id: row.id as string,
      name: String(row.name ?? ""),
      isActive: row.is_active !== false,
    })),
  };
}

/**
 * 一括での月別所属確定。
 * クリエイター・月・代理店の組を複数まとめて確定する。
 *
 * 保存処理は個別UIと同じ confirmMonthlyAssignments を再利用する。
 * 現在所属（creators.agency_id）は変更しない。
 */
export async function bulkConfirmMonthlyAssignmentsAction(
  _prev: MonthlyAssignmentActionResult | null,
  formData: FormData,
): Promise<MonthlyAssignmentActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  /*
    entries は "creatorId|targetMonth|agencyId" 形式で受け取る。
    画面でチェックされた行だけが送られてくる。
  */
  const entries = formData
    .getAll("entries")
    .map((value) => String(value).split("|"))
    .filter((parts) => parts.length === 3)
    .map(([creatorId, targetMonth, agencyId]) => ({
      creatorId: creatorId.trim(),
      targetMonth: targetMonth.trim(),
      agencyId: agencyId.trim(),
    }))
    .filter((entry) => entry.creatorId && entry.targetMonth && entry.agencyId);

  if (entries.length === 0) {
    return { ok: false, error: "確定する行を1つ以上選択してください" };
  }

  const result = await confirmMonthlyAssignments(
    auth.supabase,
    getSupabaseAdmin(),
    entries,
  );

  if (result.error) {
    return { ok: false, error: mapSupabaseErrorToJa(result.error) };
  }

  if (result.confirmedCount === 0) {
    return {
      ok: false,
      error: "支払い済みのため、選択した行はすべて変更できませんでした",
    };
  }

  revalidateAssignmentViews();

  const blockedNote =
    result.blocked.length > 0
      ? `（支払済のため ${result.blocked.length} 件をスキップ）`
      : "";

  return {
    ok: true,
    message: `${result.confirmedCount} 件の月別所属を確定しました（クリエイター ${result.creatorCount} 名 / 対象月 ${result.months.join(", ")}）${blockedNote}。代理店報酬へ反映するには「売上・報酬 › 代理店報酬」で再集計してください。`,
  };
}
