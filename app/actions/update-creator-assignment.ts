"use server";

import { insertCreatorAssignmentLog } from "@/lib/db/creator-assignment-log-queries";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";
import { normalizeTiktokId } from "@/lib/sales/parse-partner-sales";
import { mapSupabaseErrorToJa } from "@/lib/supabase/error-ja";
import { revalidatePath } from "next/cache";

export type UpdateCreatorAssignmentResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

function parseCommissionRate(raw: string): number | null {
  const normalized = raw.trim().replace(/%/g, "").replace(/,/g, "");
  if (!normalized) return null;
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0 || value > 100) return null;
  return value;
}

function commissionRatesEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.0001;
}

const REG_STATUSES = new Set(["pending", "assigned", "inactive"]);

export async function updateCreatorAssignmentAction(
  _prev: UpdateCreatorAssignmentResult | null,
  formData: FormData,
): Promise<UpdateCreatorAssignmentResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, error: "ログインが必要です" };
  }

  const appUser = await resolveAppUserContext(supabase, user);
  if (!isAdminRole(appUser.data.role)) {
    return { ok: false, error: "この操作は親管理者のみ実行できます" };
  }

  const creatorId = String(formData.get("creator_id") ?? "").trim();
  const agencyRaw = String(formData.get("agency_id") ?? "").trim();
  const agencyId = agencyRaw.length > 0 ? agencyRaw : null;
  const commissionRate = parseCommissionRate(String(formData.get("commission_rate") ?? ""));

  if (!creatorId) {
    return { ok: false, error: "クリエイター ID が不正です" };
  }

  if (commissionRate == null) {
    return { ok: false, error: "分配率は 0〜100 の数値で入力してください" };
  }

  const { data: current, error: loadError } = await supabase
    .from("creators")
    .select("agency_id, commission_rate, registration_status, tiktok_id")
    .eq("id", creatorId)
    .maybeSingle();

  if (loadError) {
    return { ok: false, error: mapSupabaseErrorToJa(loadError.message) };
  }

  if (!current) {
    return { ok: false, error: "クリエイターが見つかりません" };
  }

  const fromAgencyId = (current.agency_id as string | null) ?? null;
  const fromCommissionRate = Number(current.commission_rate);
  const fromRegistration = (current.registration_status as string | null) ?? null;

  const registrationRaw = String(formData.get("registration_status") ?? "").trim();
  const registrationStatus =
    registrationRaw && REG_STATUSES.has(registrationRaw)
      ? registrationRaw
      : fromRegistration;

  const tiktokNewRaw = String(formData.get("tiktok_id_new") ?? "").trim();
  const tiktokNew = tiktokNewRaw ? normalizeTiktokId(tiktokNewRaw) : "";
  const fromTiktok = normalizeTiktokId(String(current.tiktok_id ?? ""));
  const tiktokChanged = Boolean(tiktokNew) && tiktokNew !== fromTiktok;

  if (
    fromAgencyId === agencyId &&
    commissionRatesEqual(fromCommissionRate, commissionRate) &&
    registrationStatus === fromRegistration &&
    !tiktokChanged
  ) {
    return { ok: true, message: "変更はありません" };
  }

  const updatePayload: Record<string, unknown> = {
    agency_id: agencyId,
    commission_rate: commissionRate,
    registration_status: registrationStatus,
    updated_at: new Date().toISOString(),
  };
  if (tiktokChanged) {
    updatePayload.tiktok_id = tiktokNew;
  }

  const { error } = await supabase.from("creators").update(updatePayload).eq("id", creatorId);

  if (error) {
    return { ok: false, error: mapSupabaseErrorToJa(error.message) };
  }

  if (fromAgencyId !== agencyId || !commissionRatesEqual(fromCommissionRate, commissionRate)) {
    const logResult = await insertCreatorAssignmentLog(supabase, {
      creatorId,
      fromAgencyId,
      toAgencyId: agencyId,
      fromCommissionRate,
      toCommissionRate: commissionRate,
      changedBy: user.id,
      changedByEmail: user.email ?? null,
    });

    if (logResult.error) {
      return {
        ok: false,
        error: mapSupabaseErrorToJa(
          logResult.error ?? "振り分け履歴の保存に失敗しました",
        ),
      };
    }
  }

  revalidatePath("/admin/creator-assignment");
  revalidatePath("/admin/creator-assignment-logs");
  revalidatePath("/admin/creator-referrals");
  revalidatePath("/creators");
  revalidatePath("/rewards");
  revalidatePath("/dashboard");

  return { ok: true, message: "保存しました" };
}
