"use server";

import type { AdminActionResult } from "@/app/actions/admin-agencies";
import { requireAdminAction } from "@/lib/db/admin-access";
import { mapSupabaseErrorToJa } from "@/lib/supabase/error-ja";
import { revalidatePath } from "next/cache";

const STATUSES = new Set(["active", "pending", "stopped"]);

function readText(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function readOptionalText(formData: FormData, key: string): string | null {
  const value = readText(formData, key);
  return value.length > 0 ? value : null;
}

function readBoolean(formData: FormData, key: string): boolean {
  const value = String(formData.get(key) ?? "").trim().toLowerCase();
  return value === "on" || value === "true" || value === "1" || value === "yes";
}

function parseOptionalRate(raw: string): number | null {
  const normalized = raw.trim().replace(/%/g, "").replace(/,/g, "");
  if (!normalized) return null;
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0 || value > 100) return null;
  return value;
}

function parseSellerPayload(
  formData: FormData,
): { ok: true; payload: Record<string, unknown> } | { ok: false; error: string } {
  const seller_name = readText(formData, "seller_name");
  const shop_name = readText(formData, "shop_name");

  if (!seller_name) {
    return { ok: false, error: "セラー名は必須です" };
  }

  const statusRaw = readText(formData, "status");
  const status = STATUSES.has(statusRaw) ? statusRaw : "pending";

  const tapRaw = String(formData.get("tap_rate") ?? "").trim();
  const tspRaw = String(formData.get("tsp_rate") ?? "").trim();
  const tap_rate = parseOptionalRate(tapRaw);
  const tsp_rate = parseOptionalRate(tspRaw);

  if (tapRaw && tap_rate == null) {
    return { ok: false, error: "TAP料率は 0〜100 の数値で入力するか、空にしてください" };
  }
  if (tspRaw && tsp_rate == null) {
    return { ok: false, error: "TSP料率は 0〜100 の数値で入力するか、空にしてください" };
  }

  const dateRaw = readText(formData, "last_meeting_date");
  const last_meeting_date = dateRaw.length > 0 ? dateRaw : null;

  return {
    ok: true,
    payload: {
      seller_name,
      shop_name: shop_name.length > 0 ? shop_name : "",
      contact_person: readOptionalText(formData, "contact_person"),
      contact_email: readOptionalText(formData, "contact_email"),
      contact_phone: readOptionalText(formData, "contact_phone"),
      category: readOptionalText(formData, "category"),
      sample_condition: readOptionalText(formData, "sample_condition"),
      has_smp: readBoolean(formData, "has_smp"),
      tap_rate,
      tsp_rate,
      last_meeting_date,
      last_meeting_note: readOptionalText(formData, "last_meeting_note"),
      discount_condition: readOptionalText(formData, "discount_condition"),
      seller_live_available: readBoolean(formData, "seller_live_available"),
      status,
      memo: readOptionalText(formData, "memo"),
      import_source: "manual",
    },
  };
}

export async function createSellerAction(
  _prev: AdminActionResult | null,
  formData: FormData,
): Promise<AdminActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const parsed = parseSellerPayload(formData);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const { error } = await auth.supabase.from("sellers").insert(parsed.payload);
  if (error) return { ok: false, error: mapSupabaseErrorToJa(error.message) };

  revalidatePath("/admin/sellers");
  return { ok: true, message: "セラーを追加しました" };
}

export async function updateSellerAction(
  _prev: AdminActionResult | null,
  formData: FormData,
): Promise<AdminActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const id = readText(formData, "id");
  if (!id) {
    return { ok: false, error: "セラー ID が不正です" };
  }

  const parsed = parseSellerPayload(formData);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const { error } = await auth.supabase.from("sellers").update(parsed.payload).eq("id", id);
  if (error) return { ok: false, error: mapSupabaseErrorToJa(error.message) };

  revalidatePath("/admin/sellers");
  return { ok: true, message: "セラーを更新しました" };
}

export async function deleteSellerAction(
  _prev: AdminActionResult | null,
  formData: FormData,
): Promise<AdminActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const id = readText(formData, "id");
  if (!id) {
    return { ok: false, error: "セラー ID が不正です" };
  }

  const { error } = await auth.supabase.from("sellers").delete().eq("id", id);
  if (error) return { ok: false, error: mapSupabaseErrorToJa(error.message) };

  revalidatePath("/admin/sellers");
  return { ok: true, message: "セラーを削除しました" };
}
