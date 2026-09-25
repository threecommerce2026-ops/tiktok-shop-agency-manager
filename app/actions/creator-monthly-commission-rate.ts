"use server";

import { revalidatePath } from "next/cache";
import { createClient as createSupabaseServerClient } from "@/lib/supabase/server";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";

async function requireAdmin() {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    throw new Error("ログインが必要です。");
  }

  const appUser = await resolveAppUserContext(supabase, user);

  if (!isAdminRole(appUser.data.role)) {
    throw new Error("管理者権限が必要です。");
  }

  return supabase;
}

function validateBaseInput(creatorId: string, targetMonth: string) {
  if (!creatorId) {
    throw new Error("クリエイターIDがありません。");
  }

  if (!/^\d{4}-\d{2}$/.test(targetMonth)) {
    throw new Error("対象月が不正です。");
  }
}

function revalidateCommissionPages() {
  revalidatePath("/admin/monthly-finance");
  revalidatePath("/admin/creator-assignment");
  revalidatePath("/admin/creator-commission-rate-logs");
}

export async function saveCreatorMonthlyCommissionRate(
  formData: FormData,
) {
  const supabase = await requireAdmin();

  const creatorId = String(formData.get("creatorId") ?? "");
  const targetMonth = String(formData.get("targetMonth") ?? "");
  const commissionRateRaw = String(
    formData.get("commissionRate") ?? "",
  ).trim();

  validateBaseInput(creatorId, targetMonth);

  if (!commissionRateRaw) {
    throw new Error("分配率を入力してください。");
  }

  const commissionRate = Number(commissionRateRaw);

  if (
    !Number.isFinite(commissionRate) ||
    commissionRate < 0 ||
    commissionRate > 100
  ) {
    throw new Error("分配率は0〜100%で入力してください。");
  }

  const { error } = await supabase.rpc(
    "set_creator_monthly_commission_rate",
    {
      p_creator_id: creatorId,
      p_target_month: targetMonth,
      p_commission_rate: commissionRate,
    },
  );

  if (error) {
    throw new Error(error.message);
  }

  revalidateCommissionPages();
}

export async function resetCreatorMonthlyCommissionRate(
  formData: FormData,
) {
  const supabase = await requireAdmin();

  const creatorId = String(formData.get("creatorId") ?? "");
  const targetMonth = String(formData.get("targetMonth") ?? "");

  validateBaseInput(creatorId, targetMonth);

  const { error } = await supabase.rpc(
    "reset_creator_monthly_commission_rate",
    {
      p_creator_id: creatorId,
      p_target_month: targetMonth,
    },
  );

  if (error) {
    throw new Error(error.message);
  }

  revalidateCommissionPages();
}
