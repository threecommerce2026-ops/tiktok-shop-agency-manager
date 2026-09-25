import type { SupabaseClient } from "@supabase/supabase-js";

type RateLogCreatorJoin = { creator_name: string; tiktok_id: string };

type RateLogQueryRow = {
  id: string;
  creator_id: string;
  target_month: string;
  from_commission_rate: number | string | null;
  to_commission_rate: number | string | null;
  action: string;
  changed_by: string | null;
  changed_by_email: string | null;
  created_at: string;
  creators: RateLogCreatorJoin | RateLogCreatorJoin[] | null;
};

function unwrapCreator(
  value: RateLogCreatorJoin | RateLogCreatorJoin[] | null,
): RateLogCreatorJoin | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}


export type CreatorMonthlyCommissionRateLogRow = {
  id: string;
  creator_id: string;
  creator_name: string;
  tiktok_id: string;
  target_month: string;
  from_commission_rate: number | null;
  to_commission_rate: number | null;
  action: "save" | "reset";
  changed_by: string;
  changed_by_email: string | null;
  created_at: string;
};

export async function fetchCreatorMonthlyCommissionRateLogs(
  supabase: SupabaseClient,
  options?: {
    limit?: number;
    targetMonth?: string;
    search?: string;
  },
): Promise<{
  data: CreatorMonthlyCommissionRateLogRow[];
  error: string | null;
}> {
  const limit = options?.limit ?? 200;
  const targetMonth = options?.targetMonth?.trim() ?? "";
  const search = options?.search?.trim() ?? "";

  let query = supabase
    .from("creator_monthly_commission_rate_logs")
    .select(`
      id,
      creator_id,
      target_month,
      from_commission_rate,
      to_commission_rate,
      action,
      changed_by,
      changed_by_email,
      created_at,
      creators!inner (
        creator_name,
        tiktok_id
      )
    `);

  if (targetMonth) {
    query = query.eq("target_month", targetMonth);
  }

  if (search) {
    query = query.or(
      `creator_name.ilike.%${search}%,tiktok_id.ilike.%${search}%`,
      { foreignTable: "creators" },
    );
  }

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    return {
      data: [],
      error: error.message,
    };
  }

  const rows: CreatorMonthlyCommissionRateLogRow[] = (
    (data ?? []) as unknown as RateLogQueryRow[]
  ).map((row) => {
    const creator = unwrapCreator(row.creators);
    return {
      id: String(row.id),
      creator_id: String(row.creator_id),
      creator_name: creator?.creator_name ?? "—",
      tiktok_id: creator?.tiktok_id ?? "—",
      target_month: String(row.target_month),
      from_commission_rate:
        row.from_commission_rate == null
          ? null
          : Number(row.from_commission_rate),
      to_commission_rate:
        row.to_commission_rate == null
          ? null
          : Number(row.to_commission_rate),
      action: String(row.action) as CreatorMonthlyCommissionRateLogRow["action"],
      changed_by: row.changed_by ?? "",
      changed_by_email: (row.changed_by_email as string | null) ?? null,
      created_at: String(row.created_at),
    };
  });

  return {
    data: rows,
    error: null,
  };
}

export async function fetchCreatorMonthlyCommissionRateLogMonths(
  supabase: SupabaseClient,
): Promise<{
  data: string[];
  error: string | null;
}> {
  const { data, error } = await supabase
    .from("creator_monthly_commission_rate_logs")
    .select("target_month")
    .order("target_month", { ascending: false });

  if (error) {
    return {
      data: [],
      error: error.message,
    };
  }

  const months = Array.from(
    new Set(
      (data ?? [])
        .map((row) => (row as { target_month?: unknown }).target_month)
        .filter(
          (month: unknown): month is string =>
            typeof month === "string" && /^\d{4}-\d{2}$/.test(month),
        ),
    ),
  ).sort((a, b) => b.localeCompare(a));

  return {
    data: months,
    error: null,
  };
}
