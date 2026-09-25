import type { SupabaseClient } from "@supabase/supabase-js";

import { fetchAllFrom } from "@/lib/db/paged-select";
import { collectInHouseAgencyIds } from "@/lib/revenue/in-house-creator";

/*
  クリエイターの「対象月の所属代理店」を解決する単一ソース。

  代理店報酬の金額は TikTok の AP をそのまま使う（agency-reward-engine）。
  この所属モジュールが決めるのは「その AP をどの代理店へ帰属させるか」だけ。

  ■ 優先順位
    ① creator_monthly_agency_assignments に対象月の確定がある → monthly（確定）
    ② 無ければ creators.agency_id                             → current（暫定）
    ③ どちらも無い                                             → none（未確定）

  ■ 重要
    current（現在所属）は暫定のフォールバックであり、
    「その月の所属を確定した」ことにはしない。保存もしない。
    過去月の正式な帰属は管理者が月別確定として明示的に保存する。
*/

/** 所属の確定状態 */
export type AgencyAssignmentState = "monthly" | "current" | "none";

export type AgencyAssignment = {
  creatorId: string;
  agencyId: string | null;
  agencyName: string | null;
  /** 自社（THREE.inc）の代理店か。agencies.is_in_house が根拠 */
  agencyIsInHouse: boolean;
  /** monthly = 月別確定 / current = 現在所属（暫定） / none = 未確定 */
  source: AgencyAssignmentState;
};

export const ASSIGNMENT_STATE_LABEL: Record<AgencyAssignmentState, string> = {
  monthly: "✓ 月別確定",
  current: "△ 現在所属（暫定）",
  none: "！ 未確定",
};

export const ASSIGNMENT_STATE_DESCRIPTION: Record<AgencyAssignmentState, string> = {
  monthly: "対象月の所属として確定済み。移籍があっても過去の帰属は変わらない。",
  current: "対象月の確定が無いため、クリエイターマスタの現在所属で暫定計算している。",
  none: "所属代理店が不明。支払対象に入れない。",
};

/** 所属が確定済みか（支払前チェックに使う） */
export function isConfirmedAssignment(source: AgencyAssignmentState): boolean {
  return source === "monthly";
}

/** 自社所属か（agencies.is_in_house が唯一の根拠。名前では判定しない） */
export function isInHouseAssignment(assignment: AgencyAssignment): boolean {
  return assignment.agencyIsInHouse;
}

/**
 * 外部代理店への支払対象となる所属か。
 * 自社（THREE.inc）と未確定は対象外。
 * 自社分は会社側の収益であり、外部代理店への支払額とは区別する。
 */
export function isExternalAgencyAssignment(assignment: AgencyAssignment): boolean {
  if (!assignment.agencyId) return false;
  return !isInHouseAssignment(assignment);
}

function emptyAssignment(creatorId: string): AgencyAssignment {
  return {
    creatorId,
    agencyId: null,
    agencyName: null,
    agencyIsInHouse: false,
    source: "none",
  };
}

type CreatorRow = { id: string; agency_id: string | null };
type MonthlyRow = { creator_id: string; target_month: string; agency_id: string | null };

/**
 * 対象月のクリエイター所属を一括解決する。
 */
export async function resolveAgencyAssignments(
  supabase: SupabaseClient,
  targetMonth: string,
): Promise<{
  data: Map<string, AgencyAssignment>;
  error: string | null;
  errorCode: string | null;
}> {
  const result = await resolveAgencyAssignmentsForMonths(supabase, [targetMonth]);

  return {
    data: result.data.get(targetMonth) ?? new Map(),
    error: result.error,
    errorCode: result.errorCode,
  };
}

/**
 * 複数月の所属をまとめて解決する（月 → クリエイター → 所属）。
 */
export async function resolveAgencyAssignmentsForMonths(
  supabase: SupabaseClient,
  targetMonths: string[],
): Promise<{
  data: Map<string, Map<string, AgencyAssignment>>;
  agencyNameById: Map<string, string>;
  error: string | null;
  errorCode: string | null;
}> {
  const empty = {
    data: new Map<string, Map<string, AgencyAssignment>>(),
    agencyNameById: new Map<string, string>(),
  };

  if (targetMonths.length === 0) {
    return { ...empty, error: null, errorCode: null };
  }

  const months = [...targetMonths].sort();

  const [creatorsResult, agenciesResult, monthlyResult] = await Promise.all([
    fetchAllFrom<CreatorRow>(supabase, "creators", "id, agency_id"),
    supabase.from("agencies").select("id, name, is_in_house"),
    fetchAllFrom<MonthlyRow>(
      supabase,
      "creator_monthly_agency_assignments",
      "creator_id, target_month, agency_id",
      (query) =>
        query
          .gte("target_month", months[0])
          .lte("target_month", months[months.length - 1]),
    ),
  ]);

  const error =
    creatorsResult.error ??
    agenciesResult.error?.message ??
    monthlyResult.error ??
    null;

  if (error) {
    return {
      ...empty,
      error,
      errorCode:
        creatorsResult.errorCode ??
        agenciesResult.error?.code ??
        monthlyResult.errorCode ??
        null,
    };
  }

  const agencyNameById = new Map<string, string>();
  for (const agency of agenciesResult.data ?? []) {
    agencyNameById.set(agency.id as string, String(agency.name ?? ""));
  }
  const inHouseAgencyIds = collectInHouseAgencyIds(agenciesResult.data ?? []);

  const monthlyByKey = new Map<string, string>();
  for (const row of monthlyResult.data) {
    if (!row.agency_id) continue;
    monthlyByKey.set(`${row.creator_id}:${row.target_month}`, row.agency_id);
  }

  const byMonth = new Map<string, Map<string, AgencyAssignment>>();

  for (const month of targetMonths) {
    const assignments = new Map<string, AgencyAssignment>();

    for (const creator of creatorsResult.data) {
      const monthlyAgencyId = monthlyByKey.get(`${creator.id}:${month}`) ?? null;
      const currentAgencyId = creator.agency_id ?? null;
      const agencyId = monthlyAgencyId ?? currentAgencyId;

      assignments.set(creator.id, {
        creatorId: creator.id,
        agencyId,
        agencyName: agencyId ? agencyNameById.get(agencyId) ?? null : null,
        agencyIsInHouse: agencyId ? inHouseAgencyIds.has(agencyId) : false,
        source: monthlyAgencyId ? "monthly" : currentAgencyId ? "current" : "none",
      });
    }

    byMonth.set(month, assignments);
  }

  return { data: byMonth, agencyNameById, error: null, errorCode: null };
}

export function getAssignment(
  assignments: Map<string, AgencyAssignment>,
  creatorId: string,
): AgencyAssignment {
  return assignments.get(creatorId) ?? emptyAssignment(creatorId);
}
