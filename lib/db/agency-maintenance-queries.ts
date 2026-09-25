import type { SupabaseClient } from "@supabase/supabase-js";

import {
  AGENCY_MERGE_TABLES,
  AGENCY_REFERENCE_TABLES,
  referenceKey,
  type AgencyReferenceTable,
} from "@/lib/agency/agency-references";

/*
  代理店マスタ整理（統合 / 削除 / 無効化）用のデータ。

  ・参照件数は実スキーマで確認した全12カラムを個別に数える
  ・削除可否・統合時の衝突は読み取りだけで判定する（DRY RUN）
*/

export type AgencyReferenceCount = {
  key: string;
  label: string;
  table: string;
  column: string;
  count: number;
  onDelete: "cascade" | "set null" | "restrict";
  reassignOnMerge: boolean;
};

export type AgencyMaintenanceRow = {
  id: string;
  name: string;
  isActive: boolean;
  createdAt: string;
  references: AgencyReferenceCount[];
  totalReferences: number;
  /** 統合時に付け替える件数（履歴のみの参照は除く） */
  reassignTotal: number;
  paidRewardItemCount: number;
  paidPayoutCount: number;
  /** すべての参照が0なら物理削除できる */
  canDelete: boolean;
  /** 支払い済みデータがある代理店は自動統合を禁止する */
  mergeBlockedByPaidData: boolean;
};

export type AgencyMaintenanceLog = {
  id: string;
  action: "merge" | "delete" | "deactivate" | "activate";
  agencyId: string;
  agencyName: string;
  targetAgencyId: string | null;
  targetAgencyName: string | null;
  affectedTotal: number;
  changedByEmail: string | null;
  createdAt: string;
};

export type AgencyMaintenanceData = {
  rows: AgencyMaintenanceRow[];
  logs: AgencyMaintenanceLog[];
  error: string | null;
};

async function countReferences(
  supabase: SupabaseClient,
  ref: AgencyReferenceTable,
  agencyId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from(ref.table)
    .select("*", { count: "exact", head: true })
    .eq(ref.column, agencyId);

  // テーブル未作成などは 0 件として扱い、画面を止めない
  return error ? 0 : count ?? 0;
}

async function countPaid(
  supabase: SupabaseClient,
  table: "agency_reward_items" | "agency_payouts",
  agencyId: string,
): Promise<number> {
  const query = supabase
    .from(table)
    .select("*", { count: "exact", head: true })
    .eq("agency_id", agencyId);

  const { count, error } =
    table === "agency_reward_items"
      ? await query.eq("is_paid", true)
      : await query.eq("status", "paid");

  return error ? 0 : count ?? 0;
}

export async function fetchAgencyMaintenanceData(
  supabase: SupabaseClient,
): Promise<AgencyMaintenanceData> {
  const { data: agencies, error } = await supabase
    .from("agencies")
    .select("id, name, is_active, created_at")
    .order("name");

  if (error) {
    return { rows: [], logs: [], error: error.message };
  }

  const rows: AgencyMaintenanceRow[] = [];

  for (const agency of agencies ?? []) {
    const id = agency.id as string;

    const counts = await Promise.all(
      AGENCY_REFERENCE_TABLES.map(async (ref) => ({
        key: referenceKey(ref),
        label: ref.label,
        table: ref.table,
        column: ref.column,
        count: await countReferences(supabase, ref, id),
        onDelete: ref.onDelete,
        reassignOnMerge: ref.reassignOnMerge,
      })),
    );

    const [paidRewardItemCount, paidPayoutCount] = await Promise.all([
      countPaid(supabase, "agency_reward_items", id),
      countPaid(supabase, "agency_payouts", id),
    ]);

    const totalReferences = counts.reduce((sum, ref) => sum + ref.count, 0);
    const reassignTotal = counts
      .filter((ref) => ref.reassignOnMerge)
      .reduce((sum, ref) => sum + ref.count, 0);

    rows.push({
      id,
      name: String(agency.name ?? ""),
      isActive: agency.is_active !== false,
      createdAt: String(agency.created_at ?? ""),
      references: counts,
      totalReferences,
      reassignTotal,
      paidRewardItemCount,
      paidPayoutCount,
      canDelete: totalReferences === 0,
      mergeBlockedByPaidData: paidRewardItemCount > 0 || paidPayoutCount > 0,
    });
  }

  const { data: logs } = await supabase
    .from("agency_maintenance_logs")
    .select(
      "id, action, agency_id, agency_name, target_agency_id, target_agency_name, affected_total, changed_by_email, created_at",
    )
    .order("created_at", { ascending: false })
    .limit(50);

  return {
    rows,
    logs: (logs ?? []).map((row) => ({
      id: row.id as string,
      action: row.action as AgencyMaintenanceLog["action"],
      agencyId: row.agency_id as string,
      agencyName: String(row.agency_name ?? ""),
      targetAgencyId: (row.target_agency_id as string | null) ?? null,
      targetAgencyName: (row.target_agency_name as string | null) ?? null,
      affectedTotal: Number(row.affected_total ?? 0),
      changedByEmail: (row.changed_by_email as string | null) ?? null,
      createdAt: String(row.created_at ?? ""),
    })),
    error: null,
  };
}

export type MergeCollision = {
  table: string;
  description: string;
  count: number;
  samples: string[];
};

export type MergeDryRunResult = {
  sourceId: string;
  sourceName: string;
  targetId: string;
  targetName: string;
  /** 付け替え対象のテーブル別件数 */
  reassign: Array<{ key: string; label: string; count: number }>;
  reassignTotal: number;
  /** 一意制約の衝突（統合すると重複になる） */
  collisions: MergeCollision[];
  /** 支払い済みデータによる統合禁止 */
  blockedByPaidData: boolean;
  paidRewardItemCount: number;
  paidPayoutCount: number;
  canMerge: boolean;
  error: string | null;
};

/**
 * 統合のDRY RUN。読み取りのみで、実際の付け替えは行わない。
 *
 * 衝突チェック:
 *   agency_payouts は (target_month, agency_id) が一意。
 *   統合元と統合先が同じ対象月の支払レコードを持つ場合、
 *   単純な UPDATE では一意制約に違反する。
 *   金額の合算・どちらを残すかは自動判断せず、衝突として報告する。
 */
export async function dryRunAgencyMerge(
  supabase: SupabaseClient,
  sourceId: string,
  targetId: string,
): Promise<MergeDryRunResult> {
  const base: MergeDryRunResult = {
    sourceId,
    sourceName: "",
    targetId,
    targetName: "",
    reassign: [],
    reassignTotal: 0,
    collisions: [],
    blockedByPaidData: false,
    paidRewardItemCount: 0,
    paidPayoutCount: 0,
    canMerge: false,
    error: null,
  };

  if (sourceId === targetId) {
    return { ...base, error: "統合元と統合先が同じ代理店です" };
  }

  const { data: agencies, error } = await supabase
    .from("agencies")
    .select("id, name")
    .in("id", [sourceId, targetId]);

  if (error) {
    return { ...base, error: error.message };
  }

  const sourceName = agencies?.find((row) => row.id === sourceId)?.name;
  const targetName = agencies?.find((row) => row.id === targetId)?.name;

  if (!sourceName || !targetName) {
    return { ...base, error: "代理店が見つかりません" };
  }

  const reassign = await Promise.all(
    AGENCY_MERGE_TABLES.map(async (ref) => ({
      key: referenceKey(ref),
      label: ref.label,
      count: await countReferences(supabase, ref, sourceId),
    })),
  );

  const [paidRewardItemCount, paidPayoutCount] = await Promise.all([
    countPaid(supabase, "agency_reward_items", sourceId),
    countPaid(supabase, "agency_payouts", sourceId),
  ]);

  // --- agency_payouts (target_month, agency_id) の衝突 -------------------------
  const collisions: MergeCollision[] = [];

  const [sourcePayouts, targetPayouts] = await Promise.all([
    supabase.from("agency_payouts").select("target_month").eq("agency_id", sourceId),
    supabase.from("agency_payouts").select("target_month").eq("agency_id", targetId),
  ]);

  if (!sourcePayouts.error && !targetPayouts.error) {
    const targetMonths = new Set(
      (targetPayouts.data ?? []).map((row) => row.target_month as string),
    );
    const collidingMonths = (sourcePayouts.data ?? [])
      .map((row) => row.target_month as string)
      .filter((month) => targetMonths.has(month))
      .sort();

    if (collidingMonths.length > 0) {
      collisions.push({
        table: "agency_payouts",
        description:
          "同じ対象月の支払レコードが統合元・統合先の両方にあります（target_month + agency_id が一意）。どちらを残すか・金額を合算するかは自動判断できません。",
        count: collidingMonths.length,
        samples: collidingMonths.slice(0, 12),
      });
    }
  }

  const reassignTotal = reassign.reduce((sum, row) => sum + row.count, 0);
  const blockedByPaidData = paidRewardItemCount > 0 || paidPayoutCount > 0;

  return {
    sourceId,
    sourceName: String(sourceName),
    targetId,
    targetName: String(targetName),
    reassign,
    reassignTotal,
    collisions,
    blockedByPaidData,
    paidRewardItemCount,
    paidPayoutCount,
    canMerge: !blockedByPaidData && collisions.length === 0 && reassignTotal >= 0,
    error: null,
  };
}
