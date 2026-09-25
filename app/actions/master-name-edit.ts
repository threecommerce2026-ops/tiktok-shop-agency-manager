"use server";

import { revalidatePath } from "next/cache";

import { requireAdminAction } from "@/lib/db/admin-access";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { mapSupabaseErrorToJa } from "@/lib/supabase/error-ja";

/*
  代理店名・紹介者名の変更。

  ■ ここで変えるのは「同じ ID の表示名」だけ
  agencies.id / referrers.id は変更しない。
  そのため creators.agency_id / creator_monthly_agency_assignments /
  agency_reward_items / agency_payouts / creator_referrals /
  referral_reward_items / referral_payouts などの紐付けは一切動かない。

  ■ マスタ統合とは別機能
  重複した2つの ID を1つへ寄せる操作はここでは行わない。

  ■ 名称のスナップショット
  DB 調査の結果、代理店名・紹介者名を保持している列は
  agencies.name / referrers.name / referrers.referrer_name のみ。
  実績データ側に当時の名称は保存していないため、
  名称変更は過去の履歴表示にも最新名称として反映される。

  ■ referrers の2列
  name と referrer_name は全件同値で運用されているため、両方を同時に更新する。
*/

export type MasterNameActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

const MIGRATION_HINT =
  "名称変更履歴テーブルが未適用です。supabase/migrations/20260917120000_master_name_change_logs.sql を適用してください。";

function readText(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function isMissingTable(code: string | null | undefined): boolean {
  return code === "42P01" || code === "PGRST205";
}

async function writeNameChangeLog(params: {
  targetType: "agency" | "referrer";
  targetId: string;
  fromName: string | null;
  toName: string;
  changedBy: string | null;
  changedByEmail: string | null;
}): Promise<string | null> {
  const { error } = await getSupabaseAdmin()
    .from("master_name_change_logs")
    .insert({
      target_type: params.targetType,
      target_id: params.targetId,
      from_name: params.fromName,
      to_name: params.toName,
      changed_by: params.changedBy,
      changed_by_email: params.changedByEmail,
    });

  if (error && isMissingTable(error.code)) {
    return MIGRATION_HINT;
  }

  return error ? error.message : null;
}

function revalidateMasterViews() {
  revalidatePath("/admin/agencies");
  revalidatePath("/admin/referrers");
  revalidatePath("/admin/creator-master-editor");
  revalidatePath("/creators");
  revalidatePath("/revenue");
}

/**
 * 代理店名の変更。agency_id は変更しない。
 */
export async function renameAgencyAction(
  _prev: MasterNameActionResult | null,
  formData: FormData,
): Promise<MasterNameActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const agencyId = readText(formData, "agency_id");
  const nextName = readText(formData, "next_name");

  if (!agencyId) {
    return { ok: false, error: "代理店 ID が不正です" };
  }
  if (!nextName) {
    return { ok: false, error: "新しい代理店名を入力してください" };
  }
  if (nextName.length > 100) {
    return { ok: false, error: "代理店名は100文字以内で入力してください" };
  }

  const { data: current, error: loadError } = await auth.supabase
    .from("agencies")
    .select("id, name")
    .eq("id", agencyId)
    .maybeSingle();

  if (loadError) {
    return { ok: false, error: mapSupabaseErrorToJa(loadError.message) };
  }
  if (!current) {
    return { ok: false, error: "代理店が見つかりません" };
  }

  const fromName = String(current.name ?? "");
  if (fromName === nextName) {
    return { ok: false, error: "名称が変わっていません" };
  }

  const { error } = await auth.supabase
    .from("agencies")
    .update({ name: nextName })
    .eq("id", agencyId);

  if (error) {
    return { ok: false, error: mapSupabaseErrorToJa(error.message) };
  }

  const logError = await writeNameChangeLog({
    targetType: "agency",
    targetId: agencyId,
    fromName,
    toName: nextName,
    changedBy: auth.user?.id ?? null,
    changedByEmail: auth.user?.email ?? null,
  });

  revalidateMasterViews();

  return {
    ok: true,
    message: logError
      ? `代理店名を「${fromName}」→「${nextName}」に変更しました（履歴の保存に失敗: ${logError}）`
      : `代理店名を「${fromName}」→「${nextName}」に変更しました。agency_id は変更していないため、クリエイターの紐付け・報酬明細・支払履歴はそのままです。`,
  };
}

/**
 * 紹介者名の変更。referrer_id と紹介者コードは変更しない。
 */
export async function renameReferrerAction(
  _prev: MasterNameActionResult | null,
  formData: FormData,
): Promise<MasterNameActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const referrerId = readText(formData, "referrer_id");
  const nextName = readText(formData, "next_name");

  if (!referrerId) {
    return { ok: false, error: "紹介者 ID が不正です" };
  }
  if (!nextName) {
    return { ok: false, error: "新しい紹介者名を入力してください" };
  }
  if (nextName.length > 100) {
    return { ok: false, error: "紹介者名は100文字以内で入力してください" };
  }

  const { data: current, error: loadError } = await auth.supabase
    .from("referrers")
    .select("id, name, referrer_name")
    .eq("id", referrerId)
    .maybeSingle();

  if (loadError) {
    return { ok: false, error: mapSupabaseErrorToJa(loadError.message) };
  }
  if (!current) {
    return { ok: false, error: "紹介者が見つかりません" };
  }

  const fromName = String(current.referrer_name ?? current.name ?? "");
  if (fromName === nextName) {
    return { ok: false, error: "名称が変わっていません" };
  }

  // name と referrer_name は同値運用のため両方更新する（コードは変更しない）
  const { error } = await auth.supabase
    .from("referrers")
    .update({
      referrer_name: nextName,
      name: nextName,
      updated_at: new Date().toISOString(),
    })
    .eq("id", referrerId);

  if (error) {
    return { ok: false, error: mapSupabaseErrorToJa(error.message) };
  }

  const logError = await writeNameChangeLog({
    targetType: "referrer",
    targetId: referrerId,
    fromName,
    toName: nextName,
    changedBy: auth.user?.id ?? null,
    changedByEmail: auth.user?.email ?? null,
  });

  revalidateMasterViews();

  return {
    ok: true,
    message: logError
      ? `紹介者名を「${fromName}」→「${nextName}」に変更しました（履歴の保存に失敗: ${logError}）`
      : `紹介者名を「${fromName}」→「${nextName}」に変更しました。referrer_id と紹介者コードは変更していないため、紐付け・報酬明細・紹介リンクはそのままです。`,
  };
}
