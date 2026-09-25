import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllFrom } from "@/lib/db/paged-select";
import { isCountedOrderLine } from "@/lib/revenue/order-line-status";

import { fetchCreatorMonthlyFinance } from "@/lib/db/creator-monthly-finance-queries";

export type AgencyMonthlyPayoutRow = {
  agencyId: string;
  agencyName: string;
  creatorCount: number;
  capPayout: number;
  tapPayout: number;
  totalPayout: number;
};

export type AgencyMonthlyPayoutData = {
  targetMonth: string;
  rows: AgencyMonthlyPayoutRow[];
  totals: {
    agencyCount: number;
    creatorCount: number;
    capPayout: number;
    tapPayout: number;
    totalPayout: number;
  };
  unconfirmedCreatorCount: number;
  error: string | null;
};

export async function fetchAgencyMonthlyPayouts(
  supabase: SupabaseClient,
  targetMonth: string,
): Promise<AgencyMonthlyPayoutData> {
  const finance = await fetchCreatorMonthlyFinance(
    supabase,
    targetMonth,
  );

  if (finance.error) {
    return {
      targetMonth,
      rows: [],
      totals: {
        agencyCount: 0,
        creatorCount: 0,
        capPayout: 0,
        tapPayout: 0,
        totalPayout: 0,
      },
      unconfirmedCreatorCount: 0,
      error: finance.error,
    };
  }

  async function fetchActiveCreatorIds(
    tableName: "affiliate_order_lines" | "tap_affiliate_order_lines",
  ) {
    const creatorIds = new Set<string>();

    const result = await fetchAllFrom<{
      creator_id: string | null;
      order_status: string | null;
      refund_status: string | null;
    }>(
      supabase,
      tableName,
      "creator_id, order_status, refund_status",
      (query) => query.eq("target_month", targetMonth),
    );

    if (result.error) {
      throw new Error(result.error);
    }

    for (const row of result.data) {
      if (!row.creator_id) continue;
      if (!isCountedOrderLine(row)) continue;
      creatorIds.add(row.creator_id);
    }

    return creatorIds;
  }

  let activeCreatorIds: Set<string>;

  try {
    const [capCreatorIds, tapCreatorIds] =
      await Promise.all([
        fetchActiveCreatorIds("affiliate_order_lines"),
        fetchActiveCreatorIds("tap_affiliate_order_lines"),
      ]);

    activeCreatorIds = new Set([
      ...capCreatorIds,
      ...tapCreatorIds,
    ]);
  } catch (error) {
    return {
      targetMonth,
      rows: [],
      totals: {
        agencyCount: 0,
        creatorCount: 0,
        capPayout: 0,
        tapPayout: 0,
        totalPayout: 0,
      },
      unconfirmedCreatorCount: 0,
      error:
        error instanceof Error
          ? error.message
          : "対象クリエイターの取得に失敗しました。",
    };
  }

  const confirmedAssignmentsResult = await supabase
    .from("creator_monthly_agency_assignments")
    .select("creator_id")
    .eq("target_month", targetMonth);

  if (confirmedAssignmentsResult.error) {
    return {
      targetMonth,
      rows: [],
      totals: {
        agencyCount: 0,
        creatorCount: 0,
        capPayout: 0,
        tapPayout: 0,
        totalPayout: 0,
      },
      unconfirmedCreatorCount: 0,
      error: confirmedAssignmentsResult.error.message,
    };
  }

  const confirmedCreatorIds = new Set(
    (confirmedAssignmentsResult.data ?? [])
      .map(
        (row: { creator_id: string | null }) =>
          row.creator_id,
      )
      .filter(
        (id: string | null): id is string =>
          id !== null && activeCreatorIds.has(id),
      ),
  );

  const unconfirmedCreatorCount = Math.max(
    activeCreatorIds.size - confirmedCreatorIds.size,
    0,
  );

  const payoutByAgency = new Map<
    string,
    AgencyMonthlyPayoutRow
  >();

  for (const row of finance.rows) {
    if (!row.agencyId) {
      continue;
    }

    // THREE.incなど自社所属は代理店への支払対象外
    if (row.isInHouse) {
      continue;
    }

    const current = payoutByAgency.get(row.agencyId) ?? {
      agencyId: row.agencyId,
      agencyName: row.agencyName ?? "名称未設定",
      creatorCount: 0,
      capPayout: 0,
      tapPayout: 0,
      totalPayout: 0,
    };

    current.creatorCount += 1;

    // 代理店への支払いはCAPのみ。
    // TAP収益は代理店へ支払わず、THREE側に残す。
    current.capPayout += row.agencyPayout;
    current.tapPayout = 0;
    current.totalPayout += row.agencyPayout;

    payoutByAgency.set(row.agencyId, current);
  }

  const rows = Array.from(payoutByAgency.values()).sort(
    (a, b) => b.totalPayout - a.totalPayout,
  );

  const totals = rows.reduce(
    (acc, row) => {
      acc.creatorCount += row.creatorCount;
      acc.capPayout += row.capPayout;
      acc.tapPayout += row.tapPayout;
      acc.totalPayout += row.totalPayout;
      return acc;
    },
    {
      agencyCount: rows.length,
      creatorCount: 0,
      capPayout: 0,
      tapPayout: 0,
      totalPayout: 0,
    },
  );

  totals.agencyCount = rows.length;

  return {
    targetMonth,
    rows,
    totals,
    unconfirmedCreatorCount,
    error: null,
  };
}
