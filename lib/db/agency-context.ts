import type { SupabaseClient } from "@supabase/supabase-js";

export type AgencyContext = {
  agencyId: string;
  agencyName: string;
};

/**
 * ログインユーザーに紐づく代理店を取得。なければ agencies + profiles を作成。
 */
export async function ensureAgencyForUser(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ data: AgencyContext | null; error: string | null }> {
  const { data: profile, error: pErr } = await supabase
    .from("profiles")
    .select("agency_id")
    .eq("id", userId)
    .maybeSingle();

  if (pErr) {
    return { data: null, error: pErr.message };
  }

  if (profile?.agency_id) {
    const { data: ag, error: aErr } = await supabase
      .from("agencies")
      .select("id, name")
      .eq("id", profile.agency_id)
      .single();
    if (aErr || !ag) {
      return { data: null, error: aErr?.message ?? "代理店が見つかりません" };
    }
    return {
      data: { agencyId: ag.id, agencyName: ag.name },
      error: null,
    };
  }

  const { data: agency, error: iAg } = await supabase
    .from("agencies")
    .insert({ name: "マイ代理店" })
    .select("id, name")
    .single();

  if (iAg || !agency) {
    return {
      data: null,
      error: iAg?.message ?? "代理店の作成に失敗しました（DB マイグレーション済みか確認）",
    };
  }

  if (profile) {
    const { error: uErr } = await supabase
      .from("profiles")
      .update({ agency_id: agency.id })
      .eq("id", userId);

    if (uErr) {
      return { data: null, error: uErr.message };
    }
  } else {
    const { error: iPr } = await supabase.from("profiles").insert({
      id: userId,
      agency_id: agency.id,
      role: "agency",
    });

    if (iPr) {
      return { data: null, error: iPr.message };
    }
  }

  return {
    data: { agencyId: agency.id, agencyName: agency.name },
    error: null,
  };
}
