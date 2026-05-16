import type { SupabaseClient } from "@supabase/supabase-js";

export type AgencyOption = {
  id: string;
  name: string;
  default_commission_rate: number;
};

export type CreatorAssignmentRow = {
  id: string;
  creator_name: string;
  tiktok_id: string;
  agency_id: string | null;
  agency_name: string | null;
  commission_rate: number;
  created_at: string;
  registration_status: string | null;
  official_line_registered: boolean | null;
  referrer_name: string | null;
  creator_referral_id: string | null;
  /** 未振り分けパネル用（サーバーで付与） */
  sales_month: number;
  sales_total: number;
};

function unwrapAgency(value: unknown): { name: string } | null {
  if (!value) return null;
  if (Array.isArray(value)) return (value[0] as { name: string }) ?? null;
  return value as { name: string };
}

async function attachReferrerInfo(
  supabase: SupabaseClient,
  rows: Omit<CreatorAssignmentRow, "referrer_name" | "creator_referral_id">[],
): Promise<CreatorAssignmentRow[]> {
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];

  const { data: referrals, error } = await supabase
    .from("creator_referrals")
    .select("id, creator_id, referrers ( referrer_name )")
    .in("creator_id", ids)
    .eq("is_active", true)
    .order("created_at", { ascending: false });

  const byCreator = new Map<string, { referralId: string; name: string }>();
  if (!error) {
    for (const ref of referrals ?? []) {
      const cid = ref.creator_id as string;
      if (byCreator.has(cid)) continue;
      const join = ref.referrers as
        | { referrer_name: string }
        | { referrer_name: string }[]
        | null;
      const r = Array.isArray(join) ? join[0] : join;
      byCreator.set(cid, {
        referralId: ref.id as string,
        name: r?.referrer_name ?? "—",
      });
    }
  }

  return rows.map((row) => {
    const link = byCreator.get(row.id);
    return {
      ...row,
      referrer_name: link?.name ?? null,
      creator_referral_id: link?.referralId ?? null,
    };
  });
}

export async function fetchAgencyOptions(
  supabase: SupabaseClient,
): Promise<{ data: AgencyOption[]; error: string | null }> {
  const { data, error } = await supabase
    .from("agencies")
    .select("id, name, default_commission_rate")
    .order("name");

  if (error) {
    return { data: [], error: error.message };
  }

  return {
    data: (data ?? []).map((row) => ({
      id: row.id as string,
      name: row.name as string,
      default_commission_rate: Number(row.default_commission_rate),
    })),
    error: null,
  };
}

export async function fetchCreatorsForAssignment(
  supabase: SupabaseClient,
): Promise<{ data: CreatorAssignmentRow[]; error: string | null }> {
  const { data, error } = await supabase
    .from("creators")
    .select(
      "id, creator_name, tiktok_id, agency_id, commission_rate, created_at, registration_status, official_line_registered, agencies ( name )",
    )
    .order("creator_name");

  if (error) {
    return { data: [], error: error.message };
  }

  const base = (data ?? []).map((row) => ({
    id: row.id as string,
    creator_name: row.creator_name as string,
    tiktok_id: row.tiktok_id as string,
    agency_id: (row.agency_id as string | null) ?? null,
    agency_name: unwrapAgency(row.agencies)?.name ?? null,
    commission_rate: Number(row.commission_rate),
    created_at: row.created_at as string,
    registration_status: (row.registration_status as string | null) ?? null,
    official_line_registered: (row.official_line_registered as boolean | null) ?? null,
    sales_month: 0,
    sales_total: 0,
  }));

  return { data: await attachReferrerInfo(supabase, base), error: null };
}

export async function fetchUnassignedCreators(
  supabase: SupabaseClient,
): Promise<{ data: CreatorAssignmentRow[]; error: string | null }> {
  const { data, error } = await supabase
    .from("creators")
    .select(
      "id, creator_name, tiktok_id, agency_id, commission_rate, created_at, registration_status, official_line_registered, agencies ( name )",
    )
    .is("agency_id", null)
    .order("created_at", { ascending: false });

  if (error) {
    return { data: [], error: error.message };
  }

  const base = (data ?? []).map((row) => ({
    id: row.id as string,
    creator_name: row.creator_name as string,
    tiktok_id: row.tiktok_id as string,
    agency_id: null as string | null,
    agency_name: null as string | null,
    commission_rate: Number(row.commission_rate),
    created_at: row.created_at as string,
    registration_status: (row.registration_status as string | null) ?? null,
    official_line_registered: (row.official_line_registered as boolean | null) ?? null,
    sales_month: 0,
    sales_total: 0,
  }));

  return { data: await attachReferrerInfo(supabase, base), error: null };
}

export async function fetchNewRegistrationCreators(
  supabase: SupabaseClient,
  limit = 80,
): Promise<{ data: CreatorAssignmentRow[]; error: string | null }> {
  const { data, error } = await supabase
    .from("creators")
    .select(
      "id, creator_name, tiktok_id, agency_id, commission_rate, created_at, registration_status, official_line_registered, agencies ( name )",
    )
    .eq("registration_status", "pending")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    return { data: [], error: error.message };
  }

  const base = (data ?? []).map((row) => ({
    id: row.id as string,
    creator_name: row.creator_name as string,
    tiktok_id: row.tiktok_id as string,
    agency_id: (row.agency_id as string | null) ?? null,
    agency_name: unwrapAgency(row.agencies)?.name ?? null,
    commission_rate: Number(row.commission_rate),
    created_at: row.created_at as string,
    registration_status: (row.registration_status as string | null) ?? null,
    official_line_registered: (row.official_line_registered as boolean | null) ?? null,
    sales_month: 0,
    sales_total: 0,
  }));

  return { data: await attachReferrerInfo(supabase, base), error: null };
}
