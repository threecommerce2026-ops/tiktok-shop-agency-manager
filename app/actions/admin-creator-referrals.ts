"use server";

import { requireAdminAction } from "@/lib/db/admin-access";
import { mapSupabaseErrorToJa } from "@/lib/supabase/error-ja";
import { DEFAULT_REFERRAL_RATE } from "@/lib/referrals/calc";
import { DEFAULT_REFERRER_LIFETIME_PAYOUT_CAP_YEN } from "@/lib/referrals/cap";
import { isPendingReferralTiktokId } from "@/lib/creators/referral-registration";
import { normalizeTiktokId } from "@/lib/sales/parse-partner-sales";
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

function parseReferralRate(raw: string): number | null {
  const normalized = raw.trim().replace(/%/g, "").replace(/,/g, "");
  if (!normalized) return DEFAULT_REFERRAL_RATE;
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0 || value > 1) return null;
  return value;
}

export async function saveCreatorReferralAction(
  _prev: AdminActionResult | null,
  formData: FormData,
): Promise<AdminActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const referralId = readOptionalText(formData, "referral_id");
  const creatorId = readText(formData, "creator_id");
  const referrerId = readText(formData, "referrer_id");
  const referralRate = parseReferralRate(String(formData.get("referral_rate") ?? ""));
  const startMonth = readText(formData, "start_month");
  const endMonth = readOptionalText(formData, "end_month");

  if (!creatorId || !referrerId || !startMonth) {
    return { ok: false, error: "クリエイター / 紹介者 / 開始月は必須です" };
  }
  if (referralRate == null) {
    return { ok: false, error: "紹介率は 0〜1 の数値で入力してください（0.05 = 5%）" };
  }

  const payload = {
    creator_id: creatorId,
    referrer_id: referrerId,
    referral_rate: referralRate,
    start_month: startMonth,
    end_month: endMonth,
    is_active: true,
    updated_at: new Date().toISOString(),
  };

  if (referralId) {
    const { error } = await auth.supabase
      .from("creator_referrals")
      .update(payload)
      .eq("id", referralId);
    if (error) return { ok: false, error: mapSupabaseErrorToJa(error.message) };
  } else {
    const { error } = await auth.supabase.from("creator_referrals").insert({
      ...payload,
      lifetime_payout_cap: DEFAULT_REFERRER_LIFETIME_PAYOUT_CAP_YEN,
      lifetime_paid_amount: 0,
    });
    if (error) return { ok: false, error: mapSupabaseErrorToJa(error.message) };
  }

  revalidatePath("/admin/creator-referrals");
  revalidatePath("/admin/referrers");
  revalidatePath("/referrer/dashboard");
  return { ok: true, message: referralId ? "紹介者紐付けを更新しました" : "紹介者を紐付けました" };
}

export async function updateCreatorTiktokIdAction(
  _prev: AdminActionResult | null,
  formData: FormData,
): Promise<AdminActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const creatorId = readText(formData, "creator_id");
  const tiktokId = normalizeTiktokId(readText(formData, "tiktok_id"));
  if (!creatorId || !tiktokId) {
    return { ok: false, error: "クリエイター ID と TikTok ID は必須です" };
  }

  const { data: creator, error: creatorError } = await auth.supabase
    .from("creators")
    .select("id, tiktok_id")
    .eq("id", creatorId)
    .maybeSingle();
  if (creatorError) {
    return { ok: false, error: mapSupabaseErrorToJa(creatorError.message) };
  }
  if (!creator?.id) {
    return { ok: false, error: "クリエイターが見つかりません" };
  }
  if (!isPendingReferralTiktokId(creator.tiktok_id as string)) {
    return { ok: false, error: "TikTok ID は既に登録済みです" };
  }

  const { error } = await auth.supabase
    .from("creators")
    .update({ tiktok_id: tiktokId, updated_at: new Date().toISOString() })
    .eq("id", creatorId);
  if (error) {
    return { ok: false, error: mapSupabaseErrorToJa(error.message) };
  }

  revalidatePath("/admin/creator-referrals");
  revalidatePath("/admin/referrers");
  revalidatePath("/referrer/dashboard");
  return { ok: true, message: "TikTok ID を保存しました" };
}
