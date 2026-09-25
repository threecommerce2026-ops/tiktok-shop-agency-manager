import type { SupabaseClient } from "@supabase/supabase-js";

import { fetchAllFrom } from "@/lib/db/paged-select";
import { toAmount } from "@/lib/revenue/amount";
import { isAgencyPayoutEligibleOrderLine } from "@/lib/revenue/order-line-status";
import {
  collectInHouseAgencyIds,
} from "@/lib/revenue/in-house-creator";
import type { AgencyAssignmentState } from "@/lib/agency/agency-assignment";

/*
  クリエイター1名の「月別所属」パネル用データ。

  実績のある月ごとに
    ・月別確定所属（あれば）
    ・現在所属（暫定フォールバック）
    ・その月の AP（代理店報酬になる金額）
    ・支払い済み報酬の有無（所属変更を禁止するため）
  を返す。
*/

export type CreatorMonthRow = {
  targetMonth: string;
  /** 実際に適用される代理店 */
  effectiveAgencyId: string | null;
  effectiveAgencyName: string | null;
  state: AgencyAssignmentState;
  /** 月別確定として保存されている代理店 */
  monthlyAgencyId: string | null;
  monthlyAgencyName: string | null;
  /** その月の AP 合計（AU=支払い済みの明細のみ） */
  agencyRevenue: number;
  lineCount: number;
  /** 外部代理店への支払対象になるか（自社・未確定は false） */
  isExternalPayable: boolean;
  /** 支払い済みの代理店報酬明細があるか（あれば所属変更不可） */
  hasPaidReward: boolean;
  paidRewardAmount: number;
};

export type CreatorMonthlyAssignmentData = {
  creatorId: string;
  creatorName: string;
  tiktokId: string;
  currentAgencyId: string | null;
  currentAgencyName: string | null;
  rows: CreatorMonthRow[];
  error: string | null;
};

export async function fetchCreatorMonthlyAssignments(
  supabase: SupabaseClient,
  creatorId: string,
): Promise<CreatorMonthlyAssignmentData> {
  const empty: CreatorMonthlyAssignmentData = {
    creatorId,
    creatorName: "",
    tiktokId: "",
    currentAgencyId: null,
    currentAgencyName: null,
    rows: [],
    error: null,
  };

  const [creatorResult, agenciesResult, monthlyResult, linesResult, itemsResult] =
    await Promise.all([
      supabase
        .from("creators")
        .select("id, creator_name, tiktok_id, agency_id")
        .eq("id", creatorId)
        .maybeSingle(),
      supabase.from("agencies").select("id, name, is_in_house"),
      supabase
        .from("creator_monthly_agency_assignments")
        .select("target_month, agency_id")
        .eq("creator_id", creatorId),
      fetchAllFrom<{
        target_month: string | null;
        agency_revenue: number | string | null;
        order_status: string | null;
        payment_status: string | null;
        refund_status: string | null;
      }>(
        supabase,
        "affiliate_order_lines",
        "target_month, agency_revenue, order_status, payment_status, refund_status",
        (query) => query.eq("creator_id", creatorId),
      ),
      fetchAllFrom<{
        target_month: string;
        reward_amount: number | string | null;
        is_paid: boolean;
      }>(
        supabase,
        "agency_reward_items",
        "target_month, reward_amount, is_paid",
        (query) => query.eq("creator_id", creatorId),
      ),
    ]);

  const error =
    creatorResult.error?.message ??
    agenciesResult.error?.message ??
    monthlyResult.error?.message ??
    linesResult.error ??
    // agency_reward_items が未作成でも所属パネル自体は使えるようにする
    null;

  if (error) {
    return { ...empty, error };
  }

  if (!creatorResult.data) {
    return { ...empty, error: "クリエイターが見つかりません" };
  }

  const agencyNameById = new Map<string, string>();
  for (const agency of agenciesResult.data ?? []) {
    agencyNameById.set(agency.id as string, String(agency.name ?? ""));
  }
  // 自社判定は agencies.is_in_house のみを根拠にする（名前では判定しない）
  const inHouseAgencyIds = collectInHouseAgencyIds(agenciesResult.data ?? []);

  const currentAgencyId = (creatorResult.data.agency_id as string | null) ?? null;
  const currentAgencyName = currentAgencyId
    ? agencyNameById.get(currentAgencyId) ?? null
    : null;

  const monthlyByMonth = new Map<string, string | null>();
  for (const row of monthlyResult.data ?? []) {
    monthlyByMonth.set(
      row.target_month as string,
      (row.agency_id as string | null) ?? null,
    );
  }

  // AU=支払い済みの明細だけを月ごとに集計する
  const revenueByMonth = new Map<string, { ap: number; lines: number }>();
  for (const line of linesResult.data) {
    const month = line.target_month;
    if (!month) continue;
    if (!isAgencyPayoutEligibleOrderLine(line)) continue;

    const current = revenueByMonth.get(month) ?? { ap: 0, lines: 0 };
    current.ap += toAmount(line.agency_revenue);
    current.lines += 1;
    revenueByMonth.set(month, current);
  }

  const paidByMonth = new Map<string, number>();
  if (!itemsResult.error) {
    for (const item of itemsResult.data) {
      if (!item.is_paid) continue;
      paidByMonth.set(
        item.target_month,
        (paidByMonth.get(item.target_month) ?? 0) + toAmount(item.reward_amount),
      );
    }
  }

  const months = new Set<string>([
    ...revenueByMonth.keys(),
    ...monthlyByMonth.keys(),
  ]);

  const rows: CreatorMonthRow[] = [...months]
    .sort()
    .map((targetMonth) => {
      const monthlyAgencyId = monthlyByMonth.get(targetMonth) ?? null;
      const effectiveAgencyId = monthlyAgencyId ?? currentAgencyId;
      const effectiveAgencyName = effectiveAgencyId
        ? agencyNameById.get(effectiveAgencyId) ?? null
        : null;

      const state: AgencyAssignmentState = monthlyAgencyId
        ? "monthly"
        : currentAgencyId
          ? "current"
          : "none";

      const revenue = revenueByMonth.get(targetMonth) ?? { ap: 0, lines: 0 };
      const paidRewardAmount = paidByMonth.get(targetMonth) ?? 0;

      return {
        targetMonth,
        effectiveAgencyId,
        effectiveAgencyName,
        state,
        monthlyAgencyId,
        monthlyAgencyName: monthlyAgencyId
          ? agencyNameById.get(monthlyAgencyId) ?? null
          : null,
        agencyRevenue: Math.round(revenue.ap * 100) / 100,
        lineCount: revenue.lines,
        isExternalPayable:
          effectiveAgencyId != null && !inHouseAgencyIds.has(effectiveAgencyId),
        hasPaidReward: paidRewardAmount > 0,
        paidRewardAmount: Math.round(paidRewardAmount * 100) / 100,
      };
    });

  return {
    creatorId,
    creatorName: String(creatorResult.data.creator_name ?? "—"),
    tiktokId: String(creatorResult.data.tiktok_id ?? ""),
    currentAgencyId,
    currentAgencyName,
    rows,
    error: null,
  };
}
