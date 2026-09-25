import type { SupabaseClient } from "@supabase/supabase-js";

import { fetchAllFrom } from "@/lib/db/paged-select";
import { toAmount } from "@/lib/revenue/amount";
import { isAgencyPayoutEligibleOrderLine } from "@/lib/revenue/order-line-status";
import { collectInHouseAgencyIds } from "@/lib/revenue/in-house-creator";
import type { AgencyAssignmentState } from "@/lib/agency/agency-assignment";

/*
  月別所属ボード（クリエイター × 対象月の一覧）。

  ・1行 = クリエイター × 対象月
  ・AP は AU「支払い状況」= 支払い済み の明細のみ集計（代理店報酬と同じ条件）
  ・所属状態は agency-assignment と同じ優先順位で判定する
  ・現在所属を自動で確定はしない。確定は管理者の明示操作のみ。
*/

export type MonthlyAssignmentBoardRow = {
  creatorId: string;
  creatorName: string;
  tiktokId: string;
  targetMonth: string;
  /** クリエイターマスタの現在所属 */
  currentAgencyId: string | null;
  currentAgencyName: string | null;
  /** その月に適用される代理店（月別確定 → 現在所属） */
  effectiveAgencyId: string | null;
  effectiveAgencyName: string | null;
  state: AgencyAssignmentState;
  /** AP = 代理店報酬額 */
  agencyRevenue: number;
  lineCount: number;
  /** 自社（THREE.inc）所属か。外部代理店への支払対象ではない */
  isInHouse: boolean;
  /** 支払い済みの代理店報酬があるか（あれば変更不可） */
  hasPaidReward: boolean;
};

export type MonthlyAssignmentBoardData = {
  year: string;
  rows: MonthlyAssignmentBoardRow[];
  agencies: Array<{ id: string; name: string; isActive: boolean }>;
  months: string[];
  totals: {
    rowCount: number;
    confirmedCount: number;
    provisionalCount: number;
    unassignedCount: number;
    lockedCount: number;
  };
  error: string | null;
};

export async function fetchMonthlyAssignmentBoard(
  supabase: SupabaseClient,
  year: string,
): Promise<MonthlyAssignmentBoardData> {
  const empty: MonthlyAssignmentBoardData = {
    year,
    rows: [],
    agencies: [],
    months: [],
    totals: {
      rowCount: 0,
      confirmedCount: 0,
      provisionalCount: 0,
      unassignedCount: 0,
      lockedCount: 0,
    },
    error: null,
  };

  const [creatorsResult, agenciesResult, monthlyResult, linesResult, itemsResult] =
    await Promise.all([
      fetchAllFrom<{
        id: string;
        creator_name: string | null;
        tiktok_id: string | null;
        agency_id: string | null;
      }>(supabase, "creators", "id, creator_name, tiktok_id, agency_id"),
      supabase.from("agencies").select("id, name, is_active, is_in_house").order("name"),
      fetchAllFrom<{
        creator_id: string;
        target_month: string;
        agency_id: string | null;
      }>(
        supabase,
        "creator_monthly_agency_assignments",
        "creator_id, target_month, agency_id",
        (query) =>
          query.gte("target_month", `${year}-01`).lte("target_month", `${year}-12`),
      ),
      fetchAllFrom<{
        creator_id: string | null;
        target_month: string | null;
        agency_revenue: number | string | null;
        order_status: string | null;
        payment_status: string | null;
        refund_status: string | null;
      }>(
        supabase,
        "affiliate_order_lines",
        "creator_id, target_month, agency_revenue, order_status, payment_status, refund_status",
        (query) =>
          query.gte("target_month", `${year}-01`).lte("target_month", `${year}-12`),
      ),
      fetchAllFrom<{
        creator_id: string;
        target_month: string;
        is_paid: boolean;
      }>(
        supabase,
        "agency_reward_items",
        "creator_id, target_month, is_paid",
        (query) =>
          query.gte("target_month", `${year}-01`).lte("target_month", `${year}-12`),
      ),
    ]);

  const error =
    creatorsResult.error ??
    agenciesResult.error?.message ??
    monthlyResult.error ??
    linesResult.error ??
    null;

  if (error) {
    return { ...empty, error };
  }

  const agencyNameById = new Map<string, string>();
  // 自社判定は agencies.is_in_house のみを根拠にする（名前では判定しない）
  const inHouseAgencyIds = collectInHouseAgencyIds(agenciesResult.data ?? []);

  const agencies = (agenciesResult.data ?? []).map((row) => {
    agencyNameById.set(row.id as string, String(row.name ?? ""));
    return {
      id: row.id as string,
      name: String(row.name ?? ""),
      isActive: row.is_active !== false,
    };
  });

  const creatorById = new Map(
    creatorsResult.data.map((row) => [
      row.id,
      {
        creatorName: String(row.creator_name ?? "—"),
        tiktokId: String(row.tiktok_id ?? ""),
        agencyId: row.agency_id ?? null,
      },
    ]),
  );

  const monthlyByKey = new Map<string, string>();
  for (const row of monthlyResult.data) {
    if (!row.agency_id) continue;
    monthlyByKey.set(`${row.creator_id}:${row.target_month}`, row.agency_id);
  }

  /*
    行は CAP 明細がある クリエイター×月 すべてに作る。

    以前は AU=支払い済み の明細がある組だけを行にしていたため、
    支払い未済・返金済みの明細しか無い組が画面に出ず、
    所属の確定漏れが起きていた（2026-08 の11名）。

    AP 金額と対象明細数は従来どおり
    isAgencyPayoutEligibleOrderLine（AU=支払い済み かつ 未返金）
    を満たす明細だけを集計する。報酬計算の条件は変えない。
  */
  const revenueByKey = new Map<string, { ap: number; lines: number }>();
  for (const line of linesResult.data) {
    if (!line.creator_id || !line.target_month) continue;

    const key = `${line.creator_id}:${line.target_month}`;
    const current = revenueByKey.get(key) ?? { ap: 0, lines: 0 };

    if (isAgencyPayoutEligibleOrderLine(line)) {
      current.ap += toAmount(line.agency_revenue);
      current.lines += 1;
    }

    // 支払い済み明細が無くても、所属確定の対象として行は作る
    revenueByKey.set(key, current);
  }

  const paidKeys = new Set<string>();
  if (!itemsResult.error) {
    for (const item of itemsResult.data) {
      if (item.is_paid) {
        paidKeys.add(`${item.creator_id}:${item.target_month}`);
      }
    }
  }

  // 実績がある組 + 既に確定済みの組を行にする
  const keys = new Set<string>([...revenueByKey.keys(), ...monthlyByKey.keys()]);
  const months = new Set<string>();
  const rows: MonthlyAssignmentBoardRow[] = [];

  for (const key of keys) {
    const separator = key.indexOf(":");
    const creatorId = key.slice(0, separator);
    const targetMonth = key.slice(separator + 1);

    const creator = creatorById.get(creatorId);
    if (!creator) continue;

    const monthlyAgencyId = monthlyByKey.get(key) ?? null;
    const currentAgencyId = creator.agencyId;
    const effectiveAgencyId = monthlyAgencyId ?? currentAgencyId;
    const effectiveAgencyName = effectiveAgencyId
      ? agencyNameById.get(effectiveAgencyId) ?? null
      : null;

    const revenue = revenueByKey.get(key) ?? { ap: 0, lines: 0 };
    months.add(targetMonth);

    rows.push({
      creatorId,
      creatorName: creator.creatorName,
      tiktokId: creator.tiktokId,
      targetMonth,
      currentAgencyId,
      currentAgencyName: currentAgencyId
        ? agencyNameById.get(currentAgencyId) ?? null
        : null,
      effectiveAgencyId,
      effectiveAgencyName,
      state: monthlyAgencyId ? "monthly" : currentAgencyId ? "current" : "none",
      agencyRevenue: Math.round(revenue.ap * 100) / 100,
      lineCount: revenue.lines,
      isInHouse: effectiveAgencyId != null && inHouseAgencyIds.has(effectiveAgencyId),
      hasPaidReward: paidKeys.has(key),
    });
  }

  rows.sort(
    (a, b) =>
      a.targetMonth.localeCompare(b.targetMonth) ||
      b.agencyRevenue - a.agencyRevenue ||
      a.tiktokId.localeCompare(b.tiktokId),
  );

  return {
    year,
    rows,
    agencies,
    months: [...months].sort(),
    totals: {
      rowCount: rows.length,
      confirmedCount: rows.filter((row) => row.state === "monthly").length,
      provisionalCount: rows.filter((row) => row.state === "current").length,
      unassignedCount: rows.filter((row) => row.state === "none").length,
      lockedCount: rows.filter((row) => row.hasPaidReward).length,
    },
    error: null,
  };
}
