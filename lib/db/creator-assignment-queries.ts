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
  
  /** TikTok実データ上のエージェンシー側分配率 */
  tiktok_agency_split_rate: number | null;

  /** TikTok実データ上のクリエイター側分配率 */
  tiktok_creator_split_rate: number | null;

  /** 月別の手動補正。クリエイター側の分配率 */
  manual_creator_split_rate: number | null;

  /** 対象月に手動補正が設定されているか */
  has_manual_split_override: boolean;

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


async function attachTikTokSplitRates(
  supabase: SupabaseClient,
  rows: CreatorAssignmentRow[],
  targetMonth: string,
): Promise<CreatorAssignmentRow[]> {
  const ids = rows.map((row) => row.id);
  if (ids.length === 0) return rows;

  const { data, error } = await supabase.rpc(
    "get_creator_latest_split_rates",
    {
      p_creator_ids: ids,
      p_target_month: targetMonth,
    },
  );

  if (error) {
    console.error("Failed to load TikTok split rates:", error.message);
    return rows;
  }

  const latestByCreator = new Map<string, number>();

  for (const item of data ?? []) {
    const creatorId = item.creator_id as string | null;
    const agencyRate = Number(item.agency_split_rate);

    if (!creatorId || !Number.isFinite(agencyRate)) continue;

    latestByCreator.set(
      creatorId,
      Math.max(0, Math.min(100, agencyRate)),
    );
  }

  return rows.map((row) => {
    const agencyRate = latestByCreator.get(row.id);

    if (agencyRate === undefined) {
      return {
        ...row,
        tiktok_agency_split_rate: null,
        tiktok_creator_split_rate: null,
      };
    }

    return {
      ...row,
      tiktok_agency_split_rate: agencyRate,
      tiktok_creator_split_rate: 100 - agencyRate,
    };
  });
}

async function attachMonthlyCommissionRates(
  supabase: SupabaseClient,
  rows: CreatorAssignmentRow[],
  targetMonth: string,
): Promise<CreatorAssignmentRow[]> {
  const ids = rows.map((row) => row.id);
  if (ids.length === 0) return rows;

  const { data, error } = await supabase
    .from("creator_monthly_commission_rates")
    .select("creator_id, commission_rate")
    .in("creator_id", ids)
    .eq("target_month", targetMonth);

  if (error) {
    console.error("Failed to load monthly commission rates:", error.message);
    return rows;
  }

  const byCreator = new Map<string, number>();

  for (const item of data ?? []) {
    const creatorId = item.creator_id as string | null;
    const rate = Number(item.commission_rate);

    if (!creatorId || !Number.isFinite(rate)) continue;

    byCreator.set(
      creatorId,
      Math.max(0, Math.min(100, rate)),
    );
  }

  return rows.map((row) => {
    const manualRate = byCreator.get(row.id);

    return {
      ...row,
      manual_creator_split_rate:
        manualRate === undefined ? null : manualRate,
      has_manual_split_override: manualRate !== undefined,
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
  targetMonth: string,
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
    tiktok_agency_split_rate: null,
    tiktok_creator_split_rate: null,
    manual_creator_split_rate: null,
    has_manual_split_override: false,
    created_at: row.created_at as string,
    registration_status: (row.registration_status as string | null) ?? null,
    official_line_registered: (row.official_line_registered as boolean | null) ?? null,
    sales_month: 0,
    sales_total: 0,
  }));

  const withReferrers = await attachReferrerInfo(supabase, base);
  const withSplitRates = await attachTikTokSplitRates(
    supabase,
    withReferrers,
    targetMonth,
  );

  const withMonthlyRates = await attachMonthlyCommissionRates(
    supabase,
    withSplitRates,
    targetMonth,
  );

  return { data: withMonthlyRates, error: null };
}

export async function fetchUnassignedCreators(
  supabase: SupabaseClient,
  targetMonth: string,
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
    tiktok_agency_split_rate: null,
    tiktok_creator_split_rate: null,
    manual_creator_split_rate: null,
    has_manual_split_override: false,
    created_at: row.created_at as string,
    registration_status: (row.registration_status as string | null) ?? null,
    official_line_registered: (row.official_line_registered as boolean | null) ?? null,
    sales_month: 0,
    sales_total: 0,
  }));

  const withReferrers = await attachReferrerInfo(supabase, base);
  const withSplitRates = await attachTikTokSplitRates(
    supabase,
    withReferrers,
    targetMonth,
  );

  const withMonthlyRates = await attachMonthlyCommissionRates(
    supabase,
    withSplitRates,
    targetMonth,
  );

  return { data: withMonthlyRates, error: null };
}

export async function fetchNewRegistrationCreators(
  supabase: SupabaseClient,
  targetMonth: string,
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
    tiktok_agency_split_rate: null,
    tiktok_creator_split_rate: null,
    manual_creator_split_rate: null,
    has_manual_split_override: false,
    created_at: row.created_at as string,
    registration_status: (row.registration_status as string | null) ?? null,
    official_line_registered: (row.official_line_registered as boolean | null) ?? null,
    sales_month: 0,
    sales_total: 0,
  }));

  const withReferrers = await attachReferrerInfo(supabase, base);
  const withSplitRates = await attachTikTokSplitRates(
    supabase,
    withReferrers,
    targetMonth,
  );

  const withMonthlyRates = await attachMonthlyCommissionRates(
    supabase,
    withSplitRates,
    targetMonth,
  );

  return { data: withMonthlyRates, error: null };
}
