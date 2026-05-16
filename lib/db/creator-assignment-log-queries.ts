import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAgencyOptions } from "@/lib/db/creator-assignment-queries";

export type CreatorAssignmentLogRow = {
  id: string;
  creator_id: string;
  creator_name: string;
  tiktok_id: string;
  from_agency_name: string | null;
  to_agency_name: string | null;
  from_commission_rate: number | null;
  to_commission_rate: number;
  changed_by_email: string | null;
  changed_by: string;
  created_at: string;
};

function unwrapOne<T>(value: unknown): T | null {
  if (!value) return null;
  if (Array.isArray(value)) return (value[0] as T) ?? null;
  return value as T;
}

export async function fetchCreatorAssignmentLogs(
  supabase: SupabaseClient,
  options: { limit?: number } = {},
): Promise<{ data: CreatorAssignmentLogRow[]; error: string | null }> {
  const limit = options.limit ?? 100;

  const [agenciesResult, logsResult] = await Promise.all([
    fetchAgencyOptions(supabase),
    supabase
      .from("creator_assignment_logs")
      .select(
        `
        id,
        creator_id,
        from_agency_id,
        to_agency_id,
        from_commission_rate,
        to_commission_rate,
        changed_by,
        changed_by_email,
        created_at,
        creators ( creator_name, tiktok_id )
      `,
      )
      .order("created_at", { ascending: false })
      .limit(limit),
  ]);

  if (agenciesResult.error) {
    return { data: [], error: agenciesResult.error };
  }

  if (logsResult.error) {
    return { data: [], error: logsResult.error.message };
  }

  const agencyNameById = new Map(
    agenciesResult.data.map((agency) => [agency.id, agency.name]),
  );

  return {
    data: (logsResult.data ?? []).map((row) => {
      const creator = unwrapOne<{ creator_name: string; tiktok_id: string }>(
        row.creators,
      );
      const fromAgencyId = row.from_agency_id as string | null;
      const toAgencyId = row.to_agency_id as string | null;

      return {
        id: row.id as string,
        creator_id: row.creator_id as string,
        creator_name: creator?.creator_name ?? "—",
        tiktok_id: creator?.tiktok_id ?? "—",
        from_agency_name: fromAgencyId
          ? (agencyNameById.get(fromAgencyId) ?? "—")
          : null,
        to_agency_name: toAgencyId
          ? (agencyNameById.get(toAgencyId) ?? "—")
          : null,
        from_commission_rate:
          row.from_commission_rate == null
            ? null
            : Number(row.from_commission_rate),
        to_commission_rate: Number(row.to_commission_rate),
        changed_by_email: (row.changed_by_email as string | null) ?? null,
        changed_by: row.changed_by as string,
        created_at: row.created_at as string,
      };
    }),
    error: null,
  };
}

export async function insertCreatorAssignmentLog(
  supabase: SupabaseClient,
  input: {
    creatorId: string;
    fromAgencyId: string | null;
    toAgencyId: string | null;
    fromCommissionRate: number;
    toCommissionRate: number;
    changedBy: string;
    changedByEmail: string | null;
  },
): Promise<{ error: string | null }> {
  const { error } = await supabase.from("creator_assignment_logs").insert({
    creator_id: input.creatorId,
    from_agency_id: input.fromAgencyId,
    to_agency_id: input.toAgencyId,
    from_commission_rate: input.fromCommissionRate,
    to_commission_rate: input.toCommissionRate,
    changed_by: input.changedBy,
    changed_by_email: input.changedByEmail,
  });

  return { error: error?.message ?? null };
}
