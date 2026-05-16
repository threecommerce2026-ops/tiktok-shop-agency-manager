"use server";

import { currentMonthKey } from "@/lib/db/dashboard-queries";
import { mapSupabaseErrorToJa } from "@/lib/supabase/error-ja";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { DEFAULT_REFERRAL_RATE } from "@/lib/referrals/calc";
import { DEFAULT_REFERRER_LIFETIME_PAYOUT_CAP_YEN } from "@/lib/referrals/cap";
import {
  REFERRAL_LINK_CREATOR_SOURCE,
} from "@/lib/creators/referral-registration";
import { normalizeTiktokId } from "@/lib/sales/parse-partner-sales";
import {
  generateReferralCode,
  normalizeReferralCode,
} from "@/lib/referrals/referral-code";
import { buildReferralLink } from "@/lib/referrals/site-url";
import { revalidatePath } from "next/cache";

export type ReferrerPortalActionResult =
  | { ok: true; message: string; referralLink?: string; referralCode?: string }
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

async function createUniqueReferralCode(supabase: ReturnType<typeof createServiceRoleClient>) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const referralCode = generateReferralCode();
    const { data, error } = await supabase
      .from("referrers")
      .select("id")
      .eq("referral_code", referralCode)
      .maybeSingle();
    if (error) {
      throw new Error(error.message);
    }
    if (!data) {
      return referralCode;
    }
  }
  throw new Error("紹介コードの発行に失敗しました");
}

export async function registerReferrerAction(
  _prev: ReferrerPortalActionResult | null,
  formData: FormData,
): Promise<ReferrerPortalActionResult> {
  const name = readText(formData, "name") || readText(formData, "referrer_name");
  const email = readText(formData, "email");
  const phone = readText(formData, "phone");
  const password = readText(formData, "password");
  const bankName = readText(formData, "bank_name");
  const bankBranchName = readText(formData, "bank_branch_name");
  const bankAccountType = readText(formData, "bank_account_type");
  const bankAccountNumber = readText(formData, "bank_account_number");
  const bankAccountHolder = readText(formData, "bank_account_holder");
  const lineId = readOptionalText(formData, "line_id");
  const memo = readOptionalText(formData, "memo");

  if (!name) {
    return { ok: false, error: "本名を入力してください" };
  }
  if (!email || !phone || !password) {
    return { ok: false, error: "メール / 電話 / パスワードは必須です" };
  }
  if (!bankName || !bankBranchName || !bankAccountType || !bankAccountNumber || !bankAccountHolder) {
    return { ok: false, error: "振込先口座情報はすべて必須です" };
  }
  if (password.length < 6) {
    return { ok: false, error: "パスワードは 6 文字以上で入力してください" };
  }

  const supabase = createServiceRoleClient();
  const { data: existingReferrer, error: existingError } = await supabase
    .from("referrers")
    .select("id")
    .ilike("email", email)
    .maybeSingle();
  if (existingError) {
    return { ok: false, error: mapSupabaseErrorToJa(existingError.message) };
  }
  if (existingReferrer) {
    return { ok: false, error: "このメールアドレスは既に登録されています" };
  }

  const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { account_type: "referrer" },
  });
  if (authError || !authUser.user) {
    return {
      ok: false,
      error: mapSupabaseErrorToJa(authError?.message ?? "紹介者アカウントの作成に失敗しました"),
    };
  }

  try {
    const referralCode = await createUniqueReferralCode(supabase);
    const { error: insertError } = await supabase.from("referrers").insert({
      user_id: authUser.user.id,
      name,
      referrer_name: name,
      email,
      phone,
      memo,
      line_id: lineId,
      bank_name: bankName,
      bank_branch_name: bankBranchName,
      bank_account_type: bankAccountType,
      bank_account_number: bankAccountNumber,
      bank_account_holder: bankAccountHolder,
      referral_code: referralCode,
      is_active: true,
    });
    if (insertError) {
      await supabase.auth.admin.deleteUser(authUser.user.id);
      return { ok: false, error: mapSupabaseErrorToJa(insertError.message) };
    }

    const referralLink = await buildReferralLink(referralCode);
    return {
      ok: true,
      message: "紹介者登録が完了しました。ダッシュボードへ移動します。",
      referralLink,
      referralCode,
    };
  } catch (error) {
    await supabase.auth.admin.deleteUser(authUser.user.id);
    return {
      ok: false,
      error: error instanceof Error ? error.message : "紹介者登録に失敗しました",
    };
  }
}

export async function registerCreatorViaReferralAction(
  _prev: ReferrerPortalActionResult | null,
  formData: FormData,
): Promise<ReferrerPortalActionResult> {
  const referralCode = normalizeReferralCode(readText(formData, "referral_code"));
  const creatorName = readText(formData, "creator_name");
  const tiktokId = normalizeTiktokId(readText(formData, "tiktok_id"));
  const officialLineRegistered = readBoolean(formData, "official_line_registered");

  if (!referralCode || !creatorName || !tiktokId) {
    return { ok: false, error: "TikTok名と TikTok ID は必須です" };
  }
  if (!officialLineRegistered) {
    return { ok: false, error: "公式LINEへの登録を確認してください" };
  }

  const supabase = createServiceRoleClient();
  const { data: referrer, error: referrerError } = await supabase
    .from("referrers")
    .select("id, referrer_name, is_active")
    .eq("referral_code", referralCode)
    .maybeSingle();
  if (referrerError) {
    return { ok: false, error: mapSupabaseErrorToJa(referrerError.message) };
  }
  if (!referrer?.id || !referrer.is_active) {
    return { ok: false, error: "紹介リンクが無効です" };
  }

  const startMonth = currentMonthKey();
  const { data: creator, error: creatorError } = await supabase
    .from("creators")
    .insert({
      agency_id: null,
      creator_name: creatorName,
      tiktok_id: tiktokId,
      official_line_registered: officialLineRegistered,
      commission_rate: 5,
      registration_status: "pending",
      status: "pending",
      source: REFERRAL_LINK_CREATOR_SOURCE,
      referred_by_referrer_id: referrer.id,
    })
    .select("id")
    .single();
  if (creatorError || !creator?.id) {
    return {
      ok: false,
      error: mapSupabaseErrorToJa(creatorError?.message ?? "クリエイター登録に失敗しました"),
    };
  }

  const { error: referralError } = await supabase.from("creator_referrals").insert({
    creator_id: creator.id,
    referrer_id: referrer.id,
    referral_rate: DEFAULT_REFERRAL_RATE,
    start_month: startMonth,
    end_month: null,
    is_active: true,
    lifetime_payout_cap: DEFAULT_REFERRER_LIFETIME_PAYOUT_CAP_YEN,
    lifetime_paid_amount: 0,
  });
  if (referralError) {
    return { ok: false, error: mapSupabaseErrorToJa(referralError.message) };
  }

  revalidatePath("/referrer/dashboard");
  revalidatePath("/admin/creator-referrals");
  revalidatePath("/admin/referrers");

  return {
    ok: true,
    message: "登録ありがとうございます。公式LINEの案内に従ってください。",
  };
}

export async function fetchPublicReferrerByCodeAction(referralCode: string) {
  const normalized = normalizeReferralCode(referralCode);
  if (!normalized) {
    return { data: null, error: "紹介コードが不正です" };
  }

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("referrers")
    .select("id, referrer_name, referral_code, is_active")
    .eq("referral_code", normalized)
    .maybeSingle();

  if (error) {
    return { data: null, error: error.message };
  }
  if (!data?.id || !data.is_active) {
    return { data: null, error: "紹介リンクが無効です" };
  }

  return {
    data: {
      id: data.id as string,
      referrerName: data.referrer_name as string,
      referralCode: data.referral_code as string,
    },
    error: null,
  };
}
