"use server";

import { requireAdminAction } from "@/lib/db/admin-access";
import { mapSupabaseErrorToJa } from "@/lib/supabase/error-ja";
import { revalidatePath } from "next/cache";

export type AdminActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

function readText(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function readOptionalText(formData: FormData, key: string): string | null {
  const value = readText(formData, key);
  return value.length > 0 ? value : null;
}

function readBoolean(formData: FormData, key: string): boolean {
  const value = String(formData.get(key) ?? "").trim().toLowerCase();
  return value === "on" || value === "true" || value === "1";
}

function parsePercent(raw: string): number | null {
  const normalized = raw.trim().replace(/%/g, "").replace(/,/g, "");
  if (!normalized) return null;
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0 || value > 100) return null;
  return value;
}

export async function saveAgencyAction(
  _prev: AdminActionResult | null,
  formData: FormData,
): Promise<AdminActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const agencyId = readOptionalText(formData, "agency_id");
  const name = readText(formData, "name");
  const defaultCommissionRate = parsePercent(String(formData.get("default_commission_rate") ?? ""));
  const isActive = readBoolean(formData, "is_active");

  if (!name) {
    return { ok: false, error: "代理店名は必須です" };
  }
  if (defaultCommissionRate == null) {
    return { ok: false, error: "デフォルト分配率は 0〜100 の数値で入力してください" };
  }

  const payload = {
    name,
    default_commission_rate: defaultCommissionRate,
    is_active: isActive,
  };

  if (agencyId) {
    const { error } = await auth.supabase.from("agencies").update(payload).eq("id", agencyId);
    if (error) return { ok: false, error: mapSupabaseErrorToJa(error.message) };
  } else {
    const { error } = await auth.supabase.from("agencies").insert(payload);
    if (error) return { ok: false, error: mapSupabaseErrorToJa(error.message) };
  }

  revalidatePath("/admin/agencies");
  return { ok: true, message: agencyId ? "代理店を更新しました" : "代理店を追加しました" };
}
