"use server";

import { requireAdminAction } from "@/lib/db/admin-access";
import { mapSupabaseErrorToJa } from "@/lib/supabase/error-ja";
import { REFERRAL_REWARD_RATE } from "@/lib/referrals/referral-reward-engine";
import { linkCreatorToReferrer } from "@/lib/referrals/link-creator-referrer";
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
  if (!normalized) return REFERRAL_REWARD_RATE;
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

  /*
    creators.referred_by_referrer_id と creator_referrals を必ず同時に更新する。
    片方だけだと紹介者報酬が発生しなくなる。
  */
  const linked = await linkCreatorToReferrer(auth.supabase, {
    creatorId,
    referrerId,
    referralRate,
    startMonth,
    endMonth,
  });

  if (!linked.ok) {
    return { ok: false, error: mapSupabaseErrorToJa(linked.error) };
  }

  revalidatePath("/admin/creator-referrals");
  revalidatePath("/admin/referrers");
  revalidatePath("/referrer/dashboard");
  return { ok: true, message: "紹介者を紐付けました" };
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
