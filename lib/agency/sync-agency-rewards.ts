import type { SupabaseClient } from "@supabase/supabase-js";

import { fetchAllFrom } from "@/lib/db/paged-select";
import {
  resolveAgencyAssignments,
  type AgencyAssignment,
} from "@/lib/agency/agency-assignment";
import {
  computeAgencyReward,
  resolveAgencyAnnualState,
  resolveAgencyRewardItemAmount,
  resolveExclusionReason,
  rewardYearOf,
  sumAgencyAmounts,
  type AgencyOrderLine,
} from "@/lib/agency/agency-reward-engine";
import { isAgencyPayoutEligibleOrderLine } from "@/lib/revenue/order-line-status";

/*
  代理店報酬明細の生成。

  代理店報酬額 = AP「エージェンシーの収益総額」(agency_revenue) を100%。
  計算そのものは agency-reward-engine が単一ソース。
  ここは「DBから読む / 所属を解決する / 書き戻す」だけを担当する。

  ・source_row_key を一意キーとするため、何度実行しても二重計上しない
  ・支払い済み明細は一切書き換えない
*/

const ORDER_LINE_COLUMNS =
  "source_row_key, order_id, product_id, creator_id, target_month, commission_base, commission_gmv, creator_revenue_before_split, agency_split_rate, agency_revenue, payment_status, order_status, refund_status";

const UPSERT_CHUNK_SIZE = 500;

/*
  削除は主キー id で行い、チャンクを小さく保つ。
  source_row_key は 150 文字を超え「|」や日本語を含むため、
  数百件を .in() に渡すと URL が巨大になり、エラーも返らないまま
  1件も削除されないことがある。id は 36 文字固定の UUID なので安全。
*/
const DELETE_CHUNK_SIZE = 200;

type AgencyRewardItemRow = {
  id: string;
  source_row_key: string | null;
  agency_id: string;
  target_month: string;
  reward_amount: number | string | null;
  is_paid: boolean;
  payout_id: string | null;
  /** 支払明細（payment_batches）に占有されているか */
  payment_batch_id: string | null;
};

/** 要確認として支払対象から外れたクリエイター */
export type AgencyRewardWarning = {
  creatorId: string;
  targetMonth: string;
  reason: "no_agency_with_split";
  lineCount: number;
  agencyRevenue: number;
  agencySplitRate: number;
};

export type SyncAgencyRewardsResult = {
  targetMonth: string;
  upsertedCount: number;
  /** 対象外になったため削除した明細件数 */
  deletedCount: number;
  skippedPaidCount: number;
  monthRewardAmount: number;
  payoutCount: number;
  warnings: AgencyRewardWarning[];
  error: string | null;
  /** Postgres / PostgREST のエラーコード。原因判定に使う */
  errorCode: string | null;
};

/**
 * 対象月の代理店報酬明細を affiliate_order_lines から再生成する。
 */
export async function syncAgencyRewardsForMonth(
  supabase: SupabaseClient,
  targetMonth: string,
): Promise<SyncAgencyRewardsResult> {
  const empty: SyncAgencyRewardsResult = {
    targetMonth,
    upsertedCount: 0,
    deletedCount: 0,
    skippedPaidCount: 0,
    monthRewardAmount: 0,
    payoutCount: 0,
    warnings: [],
    error: null,
    errorCode: null,
  };

  const [assignmentsResult, ordersResult, existingResult] = await Promise.all([
    resolveAgencyAssignments(supabase, targetMonth),
    fetchAllFrom<AgencyOrderLine>(
      supabase,
      "affiliate_order_lines",
      ORDER_LINE_COLUMNS,
      (query) => query.eq("target_month", targetMonth),
    ),
    fetchAllFrom<
      Pick<
        AgencyRewardItemRow,
        "id" | "source_row_key" | "is_paid" | "payout_id" | "payment_batch_id"
      >
    >(
      supabase,
      "agency_reward_items",
      "id, source_row_key, is_paid, payout_id, payment_batch_id",
      (query) => query.eq("target_month", targetMonth),
    ),
  ]);

  const loadError =
    assignmentsResult.error ?? ordersResult.error ?? existingResult.error ?? null;

  if (loadError) {
    return {
      ...empty,
      error: loadError,
      errorCode:
        assignmentsResult.errorCode ??
        ordersResult.errorCode ??
        existingResult.errorCode ??
        null,
    };
  }

  /*
    --- 支払い済み / 支払予定中の明細は触らない ---------------------------------

    payment_batch_id が付いている明細は支払明細（draft / approved / processing）
    に組み入れ済みで、金額が確定している。再集計で書き換えると
    支払明細のスナップショットと実額がずれ、振込完了の検証で弾かれる。
  */
  const paidSourceKeys = new Set<string>();

  for (const item of existingResult.data) {
    if (!item.source_row_key) continue;
    if (item.is_paid || item.payout_id != null || item.payment_batch_id != null) {
      paidSourceKeys.add(item.source_row_key);
    }
  }

  const nowIso = new Date().toISOString();
  const upserts: Array<Record<string, unknown>> = [];
  const monthAmounts: number[] = [];
  const warningByCreator = new Map<string, AgencyRewardWarning>();

  for (const line of ordersResult.data) {
    const creatorId = line.creator_id;
    const sourceRowKey = line.source_row_key;

    if (!creatorId || !sourceRowKey) continue;

    const assignment: AgencyAssignment =
      assignmentsResult.data.get(creatorId) ??
      {
        creatorId,
        agencyId: null,
        agencyName: null,
        agencyIsInHouse: false,
        source: "none",
      };

    // 支払対象外の理由を記録する（代理店未設定なのに分配率が付いている明細）
    if (isAgencyPayoutEligibleOrderLine(line)) {
      const splitRate = Number(line.agency_split_rate ?? 0);
      const reason = resolveExclusionReason(assignment, splitRate);

      if (reason === "no_agency_with_split") {
        const current =
          warningByCreator.get(creatorId) ??
          {
            creatorId,
            targetMonth,
            reason: "no_agency_with_split" as const,
            lineCount: 0,
            agencyRevenue: 0,
            agencySplitRate: splitRate,
          };
        current.lineCount += 1;
        current.agencyRevenue += Number(line.agency_revenue ?? 0);
        warningByCreator.set(creatorId, current);
      }
    }

    if (paidSourceKeys.has(sourceRowKey)) continue;

    const computed = computeAgencyReward(line, assignment);
    if (!computed) continue;

    monthAmounts.push(computed.rewardAmount);

    upserts.push({
      source_row_key: computed.sourceRowKey,
      target_month: computed.targetMonth,
      order_id: computed.orderId,
      product_id: computed.productId,
      creator_id: computed.creatorId,
      agency_id: computed.agencyId,
      agency_source: assignment.source,
      commission_base: computed.commissionBase,
      commission_gmv: computed.commissionGmv,
      creator_revenue_before_split: computed.creatorRevenueBeforeSplit,
      agency_split_rate: computed.agencySplitRate,
      reward_amount: computed.rewardAmount,
      payment_status: computed.paymentStatus,
      order_status: computed.orderStatus,
      refund_status: computed.refundStatus,
      is_reward_target: true,
      is_paid: false,
      updated_at: nowIso,
    });
  }

  let upsertedCount = 0;

  for (let i = 0; i < upserts.length; i += UPSERT_CHUNK_SIZE) {
    const chunk = upserts.slice(i, i + UPSERT_CHUNK_SIZE);
    const { error } = await supabase
      .from("agency_reward_items")
      .upsert(chunk, { onConflict: "source_row_key" });

    if (error) {
      return {
        ...empty,
        skippedPaidCount: paidSourceKeys.size,
        warnings: [...warningByCreator.values()],
        error: error.message,
        errorCode: error.code ?? null,
      };
    }

    upsertedCount += chunk.length;
  }

  // 対象でなくなった明細を削除してから支払レコードを作り直す
  const cleanup = await deleteObsoleteRewardItems(
    supabase,
    "agency_reward_items",
    targetMonth,
    new Set<string>(upserts.map((row) => String(row.source_row_key))),
    existingResult.data,
  );

  if (cleanup.error) {
    return {
      ...empty,
      upsertedCount,
      skippedPaidCount: paidSourceKeys.size,
      warnings: [...warningByCreator.values()],
      error: cleanup.error,
    };
  }

  const payoutResult = await refreshAgencyPayoutsForMonth(supabase, targetMonth);

  return {
    targetMonth,
    upsertedCount,
    deletedCount: cleanup.deletedCount,
    skippedPaidCount: paidSourceKeys.size,
    monthRewardAmount: sumAgencyAmounts(monthAmounts),
    payoutCount: payoutResult.payoutCount,
    warnings: [...warningByCreator.values()],
    error: payoutResult.error,
    errorCode: payoutResult.errorCode,
  };
}


/**
 * 対象月のうち、現在のルール・マスタでは報酬対象でなくなった明細を削除する。
 *
 * 明細は source_row_key で upsert しているため、
 * 「対象でなくなった行」は upsert 対象に現れないだけで DB には残り続ける。
 * 削除しないと、紹介者を外したクリエイターの報酬が旧紹介者に付いたまま残る。
 *
 * ■ 絶対に消さないもの
 *   is_paid = true             … 支払い済み
 *   payout_id が設定済み       … 支払レコードに紐付け済み
 *   payment_batch_id が設定済み … 支払明細に組み入れ済み（支払予定中）
 * これらは呼び出し側で paidSourceKeys として除外済みだが、
 * ここでも条件に入れて二重に守る。
 */
async function deleteObsoleteRewardItems(
  supabase: SupabaseClient,
  table: "agency_reward_items",
  targetMonth: string,
  validSourceRowKeys: Set<string>,
  existingKeys: Array<{
    id: string;
    source_row_key: string | null;
    is_paid: boolean;
    payout_id: string | null;
    payment_batch_id: string | null;
  }>,
): Promise<{ deletedCount: number; error: string | null }> {
  const obsoleteIds = existingKeys
    .filter(
      (item) =>
        item.source_row_key != null &&
        !item.is_paid &&
        item.payout_id == null &&
        item.payment_batch_id == null &&
        !validSourceRowKeys.has(item.source_row_key),
    )
    .map((item) => item.id);

  if (obsoleteIds.length === 0) return { deletedCount: 0, error: null };

  let deletedCount = 0;

  for (let i = 0; i < obsoleteIds.length; i += DELETE_CHUNK_SIZE) {
    const chunk = obsoleteIds.slice(i, i + DELETE_CHUNK_SIZE);
    const { data, error } = await supabase
      .from(table)
      .delete()
      .eq("target_month", targetMonth)
      .eq("is_paid", false)
      .is("payout_id", null)
      .is("payment_batch_id", null)
      .in("id", chunk)
      .select("id");

    if (error) return { deletedCount, error: error.message };
    deletedCount += (data ?? []).length;
  }

  return { deletedCount, error: null };
}

/**
 * 対象月時点の支払レコードを、その暦年の未払い累積で作り直す。
 * 支払い済みレコードは書き換えない。
 */
async function refreshAgencyPayoutsForMonth(
  supabase: SupabaseClient,
  targetMonth: string,
): Promise<{ payoutCount: number; error: string | null; errorCode: string | null }> {
  const rewardYear = rewardYearOf(targetMonth);

  const unpaidResult = await fetchAllFrom<AgencyRewardItemRow>(
    supabase,
    "agency_reward_items",
    "agency_id, target_month, reward_amount",
    (query) =>
      query
        .eq("is_reward_target", true)
        .eq("is_paid", false)
        .gte("target_month", `${rewardYear}-01`)
        .lte("target_month", targetMonth),
  );

  if (unpaidResult.error) {
    return {
      payoutCount: 0,
      error: unpaidResult.error,
      errorCode: unpaidResult.errorCode ?? null,
    };
  }

  const unpaidByAgency = new Map<string, number[]>();

  for (const item of unpaidResult.data) {
    const list = unpaidByAgency.get(item.agency_id) ?? [];
    list.push(resolveAgencyRewardItemAmount(item));
    unpaidByAgency.set(item.agency_id, list);
  }

  if (unpaidByAgency.size === 0) {
    return { payoutCount: 0, error: null, errorCode: null };
  }

  const { data: existingPayouts, error: existingError } = await supabase
    .from("agency_payouts")
    .select("id, agency_id, status")
    .eq("target_month", targetMonth);

  if (existingError) {
    return {
      payoutCount: 0,
      error: existingError.message,
      errorCode: existingError.code ?? null,
    };
  }

  const paidAgencyIds = new Set(
    (existingPayouts ?? [])
      .filter((row) => row.status === "paid")
      .map((row) => row.agency_id as string),
  );

  const nowIso = new Date().toISOString();
  const rows: Array<Record<string, unknown>> = [];

  for (const [agencyId, amounts] of unpaidByAgency) {
    if (paidAgencyIds.has(agencyId)) continue;

    const state = resolveAgencyAnnualState({
      annualRewardAmount: sumAgencyAmounts(amounts),
      paidAmount: 0,
    });

    rows.push({
      target_month: targetMonth,
      agency_id: agencyId,
      total_reward_amount: state.unpaidAmount,
      threshold_amount: state.thresholdAmount,
      is_payable: state.isPayable,
      status: state.isPayable ? "unpaid" : "hold",
      updated_at: nowIso,
    });
  }

  if (rows.length === 0) {
    return { payoutCount: 0, error: null, errorCode: null };
  }

  const { error } = await supabase
    .from("agency_payouts")
    .upsert(rows, { onConflict: "target_month,agency_id" });

  if (error) {
    return { payoutCount: 0, error: error.message, errorCode: error.code ?? null };
  }

  return { payoutCount: rows.length, error: null, errorCode: null };
}

export async function markAgencyPayoutPaid(
  supabase: SupabaseClient,
  payoutId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase.rpc("mark_agency_payout_paid_annual", {
    p_payout_id: payoutId,
  });

  return error ? { ok: false, error: error.message } : { ok: true };
}

export async function markAgencyPayoutUnpaid(
  supabase: SupabaseClient,
  payoutId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase.rpc("mark_agency_payout_unpaid_annual", {
    p_payout_id: payoutId,
  });

  return error ? { ok: false, error: error.message } : { ok: true };
}
