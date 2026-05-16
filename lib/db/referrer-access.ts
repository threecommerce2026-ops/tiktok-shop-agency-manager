import type { SupabaseClient, User } from "@supabase/supabase-js";

export type ReferrerProfile = {
  id: string;
  referrerName: string;
  email: string | null;
  phone: string | null;
  referralCode: string;
  isActive: boolean;
};

export async function fetchReferrerProfileByUser(
  supabase: SupabaseClient,
  user: User,
): Promise<{ data: ReferrerProfile | null; error: string | null }> {
  const { data, error } = await supabase
    .from("referrers")
    .select("id, referrer_name, email, phone, referral_code, is_active")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    return { data: null, error: error.message };
  }

  if (!data?.id || !data.referral_code) {
    return { data: null, error: null };
  }

  return {
    data: {
      id: data.id as string,
      referrerName: data.referrer_name as string,
      email: (data.email as string | null) ?? null,
      phone: (data.phone as string | null) ?? null,
      referralCode: data.referral_code as string,
      isActive: Boolean(data.is_active),
    },
    error: null,
  };
}

export async function fetchReferrerProfileByCode(
  supabase: SupabaseClient,
  referralCode: string,
): Promise<{ data: ReferrerProfile | null; error: string | null }> {
  const { data, error } = await supabase
    .from("referrers")
    .select("id, referrer_name, email, phone, referral_code, is_active")
    .eq("referral_code", referralCode)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    return { data: null, error: error.message };
  }

  if (!data?.id || !data.referral_code) {
    return { data: null, error: null };
  }

  return {
    data: {
      id: data.id as string,
      referrerName: data.referrer_name as string,
      email: (data.email as string | null) ?? null,
      phone: (data.phone as string | null) ?? null,
      referralCode: data.referral_code as string,
      isActive: Boolean(data.is_active),
    },
    error: null,
  };
}
