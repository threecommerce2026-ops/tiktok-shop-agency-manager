"use server";

import { requireAdminAction } from "@/lib/db/admin-access";
import { mapSupabaseErrorToJa } from "@/lib/supabase/error-ja";
import { generateReferralCode } from "@/lib/referrals/referral-code";
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

export async function saveReferrerAction(
  _prev: AdminActionResult | null,
  formData: FormData,
): Promise<AdminActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const referrerId = readOptionalText(formData, "referrer_id");
  const referrerName = readText(formData, "referrer_name");
  const email = readOptionalText(formData, "email");
  const phone = readOptionalText(formData, "phone");
  const memo = readOptionalText(formData, "memo");
  const isActive = readBoolean(formData, "is_active");

  if (!referrerName) {
    return { ok: false, error: "紹介者名は必須です" };
  }

  const payload = {
    referrer_name: referrerName,
    email,
    phone,
    memo,
    is_active: isActive,
    updated_at: new Date().toISOString(),
  };

  if (referrerId) {
    const { error } = await auth.supabase.from("referrers").update(payload).eq("id", referrerId);
    if (error) return { ok: false, error: mapSupabaseErrorToJa(error.message) };
  } else {
    let referralCode = generateReferralCode();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const { data: existing } = await auth.supabase
        .from("referrers")
        .select("id")
        .eq("referral_code", referralCode)
        .maybeSingle();
      if (!existing) break;
      referralCode = generateReferralCode();
    }
    const { error } = await auth.supabase.from("referrers").insert({
      ...payload,
      name: referrerName,
      referrer_name: referrerName,
      referral_code: referralCode,
    });
    if (error) return { ok: false, error: mapSupabaseErrorToJa(error.message) };
  }

  revalidatePath("/admin/referrers");
  revalidatePath("/admin/creator-referrals");
  return { ok: true, message: referrerId ? "紹介者を更新しました" : "紹介者を追加しました" };
}
