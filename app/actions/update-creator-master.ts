"use server";

import { revalidatePath } from "next/cache";

import { requireAdminAction } from "@/lib/db/admin-access";
import { mapSupabaseErrorToJa } from "@/lib/supabase/error-ja";
import {
  isAccountManagementType,
  normalizeAccountManagementType,
} from "@/lib/creators/account-management-type";
import { linkCreatorToReferrer } from "@/lib/referrals/link-creator-referrer";

/*
  クリエイターマスタの一括更新。

  ・代理店 / 分配率 / 登録状態 … 既存 RPC update_creator_assignment（履歴付き）
  ・紹介者 / 区分            … creators を更新し creator_master_change_logs に記録

  creator UUID は決して再生成しない。
*/

export type CreatorMasterActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

const REGISTRATION_STATUSES = new Set(["pending", "assigned", "inactive"]);

function readText(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function parseCommissionRate(raw: string): number | null {
  const normalized = raw.replace(/%/g, "").replace(/,/g, "").trim();
  if (!normalized) return null;
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0 || value > 100) return null;
  return value;
}

function ratesEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.0001;
}

export async function updateCreatorMasterAction(
  _prev: CreatorMasterActionResult | null,
  formData: FormData,
): Promise<CreatorMasterActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const supabase = auth.supabase;
  const user = auth.user;

  const creatorId = readText(formData, "creator_id");
  if (!creatorId) {
    return { ok: false, error: "クリエイター ID が不正です" };
  }

  const agencyRaw = readText(formData, "agency_id");
  const agencyId = agencyRaw.length > 0 ? agencyRaw : null;

  const commissionRate = parseCommissionRate(readText(formData, "commission_rate"));
  if (commissionRate == null) {
    return { ok: false, error: "分配率は 0〜100 の数値で入力してください" };
  }

  const referrerRaw = readText(formData, "referrer_id");
  const referrerId = referrerRaw.length > 0 ? referrerRaw : null;

  const typeRaw = readText(formData, "account_management_type");
  if (typeRaw && !isAccountManagementType(typeRaw)) {
    return { ok: false, error: "区分の値が不正です" };
  }

  const { data: current, error: loadError } = await supabase
    .from("creators")
    .select(
      "id, agency_id, commission_rate, registration_status, tiktok_id, referred_by_referrer_id, account_management_type",
    )
    .eq("id", creatorId)
    .maybeSingle();

  if (loadError) {
    return { ok: false, error: mapSupabaseErrorToJa(loadError.message) };
  }
  if (!current) {
    return { ok: false, error: "クリエイターが見つかりません" };
  }

  const fromAgencyId = (current.agency_id as string | null) ?? null;
  const fromRate = Number(current.commission_rate);
  const fromRegistration = (current.registration_status as string | null) ?? null;
  const fromReferrerId = (current.referred_by_referrer_id as string | null) ?? null;
  const fromType = normalizeAccountManagementType(current.account_management_type);

  const registrationRaw = readText(formData, "registration_status");
  const registrationStatus = REGISTRATION_STATUSES.has(registrationRaw)
    ? registrationRaw
    : fromRegistration;

  const nextType = typeRaw ? normalizeAccountManagementType(typeRaw) : fromType;

  const assignmentChanged =
    fromAgencyId !== agencyId ||
    !ratesEqual(fromRate, commissionRate) ||
    registrationStatus !== fromRegistration;
  const referrerChanged = fromReferrerId !== referrerId;
  const typeChanged = fromType !== nextType;

  if (!assignmentChanged && !referrerChanged && !typeChanged) {
    return { ok: true, message: "変更はありません" };
  }

  const changes: string[] = [];

  // --- 代理店 / 分配率 / 登録状態（既存RPC。履歴は creator_assignment_logs）------
  if (assignmentChanged) {
    const { error } = await supabase.rpc("update_creator_assignment", {
      p_creator_id: creatorId,
      p_agency_id: agencyId,
      p_commission_rate: commissionRate,
      p_registration_status: registrationStatus,
      p_tiktok_id: String(current.tiktok_id ?? ""),
      p_changed_by: user?.id ?? null,
      p_changed_by_email: user?.email ?? null,
    });

    if (error) {
      return { ok: false, error: mapSupabaseErrorToJa(error.message) };
    }

    if (fromAgencyId !== agencyId) changes.push("代理店");
    if (!ratesEqual(fromRate, commissionRate)) changes.push("分配率");
    if (registrationStatus !== fromRegistration) changes.push("登録状態");
  }

  // --- 区分 -------------------------------------------------------------------
  if (typeChanged) {
    const { error } = await supabase
      .from("creators")
      .update({
        account_management_type: nextType,
        updated_at: new Date().toISOString(),
      })
      .eq("id", creatorId);

    if (error) {
      return { ok: false, error: mapSupabaseErrorToJa(error.message) };
    }

    await supabase.from("creator_master_change_logs").insert({
      creator_id: creatorId,
      field: "account_management_type",
      from_value: fromType,
      to_value: nextType,
      changed_by: user?.id ?? null,
      changed_by_email: user?.email ?? null,
    });

    changes.push("区分");
  }

  // --- 紹介者（creators と creator_referrals の整合は共通ヘルパが担保）----------
  if (referrerChanged) {
    const linked = await linkCreatorToReferrer(supabase, { creatorId, referrerId });

    if (!linked.ok) {
      return { ok: false, error: mapSupabaseErrorToJa(linked.error) };
    }

    await supabase.from("creator_master_change_logs").insert({
      creator_id: creatorId,
      field: "referrer",
      from_value: fromReferrerId,
      to_value: referrerId,
      changed_by: user?.id ?? null,
      changed_by_email: user?.email ?? null,
    });

    changes.push("紹介者");
  }

  revalidatePath("/creators");
  revalidatePath("/revenue");
  revalidatePath("/dashboard");
  revalidatePath("/admin/creator-assignment");
  revalidatePath("/admin/creator-referrals");

  return { ok: true, message: `保存しました（${changes.join(" / ")}）` };
}
