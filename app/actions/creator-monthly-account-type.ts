"use server";

import { revalidatePath } from "next/cache";

import { requireAdminAction } from "@/lib/db/admin-access";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { mapSupabaseErrorToJa } from "@/lib/supabase/error-ja";
import { isValidTargetMonth } from "@/lib/referrals/referral-reward-engine";
import {
  fetchCreatorMonthlyAccountTypes,
  type CreatorMonthlyAccountTypeData,
} from "@/lib/db/creator-monthly-account-type-queries";
import { confirmMonthlyAccountTypes } from "@/lib/creators/confirm-monthly-account-types";

/*
  月別区分の確定・解除。

  ここで変更するのは creator_monthly_account_management_types だけ。
  creators.account_management_type（現在区分）は変更しない。
  現在区分の変更はクリエイターマスタ編集（updateCreatorMasterAction）で行う。

  紹介報酬の再集計はここでは行わない。
  区分変更 → dry-run → 差分確認 → 管理者承認 → sync の順序を保つため、
  確定したら「再集計が必要」と伝えるだけにする。
*/

export type MonthlyAccountTypeActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

function revalidateTypeViews() {
  revalidatePath("/admin/monthly-account-management-types");
  revalidatePath("/payments");
  revalidatePath("/creators");
  revalidatePath("/revenue");
  revalidatePath("/dashboard");
}

/**
 * 選択した月の区分を確定する（1クリエイター分、月ごとに別の区分でよい）。
 * 保存処理は lib/creators/confirm-monthly-account-types.ts を再利用する。
 */
export async function confirmCreatorMonthlyAccountTypesAction(
  _prev: MonthlyAccountTypeActionResult | null,
  formData: FormData,
): Promise<MonthlyAccountTypeActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  /*
    entries は "creatorId|targetMonth|accountManagementType" で受け取る。
    画面で変更された月だけが送られてくる。
  */
  const entries = formData
    .getAll("entries")
    .map((value) => String(value).split("|"))
    .filter((parts) => parts.length === 3)
    .map(([creatorId, targetMonth, accountManagementType]) => ({
      creatorId: creatorId.trim(),
      targetMonth: targetMonth.trim(),
      accountManagementType: accountManagementType.trim(),
    }))
    .filter(
      (entry) =>
        entry.creatorId && entry.targetMonth && entry.accountManagementType,
    );

  if (entries.length === 0) {
    return { ok: false, error: "確定する月を1つ以上選択してください" };
  }

  const result = await confirmMonthlyAccountTypes(
    auth.supabase,
    getSupabaseAdmin(),
    entries,
  );

  if (result.error) {
    return { ok: false, error: mapSupabaseErrorToJa(result.error) };
  }

  if (result.confirmedCount === 0 && result.blocked.length > 0) {
    return {
      ok: false,
      error: `${result.blocked
        .map((entry) => entry.targetMonth)
        .join(", ")} には支払済み（または支払予定中）の紹介報酬があるため区分を変更できません。先に支払いを取り消してください。`,
    };
  }

  revalidateTypeViews();

  const blockedNote =
    result.blocked.length > 0
      ? `（${result.blocked
          .map((entry) => entry.targetMonth)
          .join(", ")} は支払済みのためスキップ）`
      : "";

  return {
    ok: true,
    message: `${result.months.join(", ")} の区分を確定しました（${result.confirmedCount} ヶ月）${blockedNote}。紹介報酬へ反映するには「紹介報酬の再集計」を実行してください（自動では再計算しません）。`,
  };
}

/**
 * 月別確定を解除して、現在区分の暫定判定に戻す。
 */
export async function resetCreatorMonthlyAccountTypeAction(
  _prev: MonthlyAccountTypeActionResult | null,
  formData: FormData,
): Promise<MonthlyAccountTypeActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const creatorId = String(formData.get("creator_id") ?? "").trim();
  const targetMonth = String(formData.get("target_month") ?? "").trim();

  if (!creatorId || !isValidTargetMonth(targetMonth)) {
    return { ok: false, error: "クリエイターと対象月を指定してください" };
  }

  /*
    支払済みの紹介報酬がある月は解除させない。
    確定を外すと現在区分へ落ち、判定が変わりうる。
  */
  const { data: paidRows, error: paidError } = await getSupabaseAdmin()
    .from("referral_reward_items")
    .select("id")
    .eq("creator_id", creatorId)
    .eq("target_month", targetMonth)
    .or("is_paid.eq.true,payout_id.not.is.null,payment_batch_id.not.is.null")
    .limit(1);

  if (paidError && paidError.code !== "42P01" && paidError.code !== "PGRST205") {
    return { ok: false, error: mapSupabaseErrorToJa(paidError.message) };
  }
  if ((paidRows ?? []).length > 0) {
    return {
      ok: false,
      error: `${targetMonth} には支払済み（または支払予定中）の紹介報酬があるため解除できません。先に支払いを取り消してください。`,
    };
  }

  const { error } = await auth.supabase.rpc(
    "reset_creator_monthly_account_management_type",
    { p_creator_id: creatorId, p_target_month: targetMonth },
  );

  if (error) {
    return { ok: false, error: mapSupabaseErrorToJa(error.message) };
  }

  revalidateTypeViews();
  return {
    ok: true,
    message: `${targetMonth} の月別区分を解除しました（現在区分での暫定判定に戻ります）`,
  };
}

/**
 * 一括での月別区分確定（クリエイター × 月 × 区分の組を複数まとめて）。
 *
 * 保存処理は個別パネルと同じ confirmMonthlyAccountTypes を再利用する。
 * creators.account_management_type（現在区分）は変更しない。
 * 紹介報酬（referral_reward_items）も自動では再計算しない。
 */
export async function bulkConfirmMonthlyAccountTypesAction(
  _prev: MonthlyAccountTypeActionResult | null,
  formData: FormData,
): Promise<MonthlyAccountTypeActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  /*
    entries は "creatorId|targetMonth|accountManagementType" で受け取る。
    画面でチェックされた行だけが送られてくる。
  */
  const entries = formData
    .getAll("entries")
    .map((value) => String(value).split("|"))
    .filter((parts) => parts.length === 3)
    .map(([creatorId, targetMonth, accountManagementType]) => ({
      creatorId: creatorId.trim(),
      targetMonth: targetMonth.trim(),
      accountManagementType: accountManagementType.trim(),
    }))
    .filter(
      (entry) =>
        entry.creatorId && entry.targetMonth && entry.accountManagementType,
    );

  if (entries.length === 0) {
    return { ok: false, error: "確定する行を1つ以上選択してください" };
  }

  const result = await confirmMonthlyAccountTypes(
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
      error:
        "支払済み（または支払予定中）の紹介報酬があるため、選択した行はすべて変更できませんでした",
    };
  }

  revalidateTypeViews();

  /*
    ブロックされた行は黙って飲み込まず、どの creator×month かを返す。
    「残りだけ確定して成功」と見せると、確定できていない月に
    気づけないまま再集計へ進んでしまう。
  */
  const blockedNote =
    result.blocked.length > 0
      ? `（支払済みのため ${result.blocked.length} 件をスキップ: ${result.blocked
          .map((entry) => entry.targetMonth)
          .join(", ")}）`
      : "";

  return {
    ok: true,
    message: `${result.confirmedCount} 件の月別区分を確定しました（クリエイター ${result.creatorCount} 名 / 対象月 ${result.months.join(", ")}）${blockedNote}。紹介報酬は再計算していません。`,
  };
}

export type LoadMonthlyAccountTypeResult =
  | { ok: true; data: CreatorMonthlyAccountTypeData }
  | { ok: false; error: string };

/**
 * 月別区分パネル用のデータを取得する（読み取りのみ）。
 */
export async function loadCreatorMonthlyAccountTypeAction(
  creatorId: string,
): Promise<LoadMonthlyAccountTypeResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  if (!creatorId.trim()) {
    return { ok: false, error: "クリエイター ID が不正です" };
  }

  const data = await fetchCreatorMonthlyAccountTypes(
    getSupabaseAdmin(),
    creatorId,
  );

  if (data.error) {
    return { ok: false, error: mapSupabaseErrorToJa(data.error) };
  }

  return { ok: true, data };
}
