import type { SupabaseClient } from "@supabase/supabase-js";

import {
  computeCreatorLendingReward,
  resolveLendingExclusionReason,
  sumLendingAmounts,
  resolveCreatorLendingRewardItemAmount,
  type LendingExclusionReason,
  type LendingOrderLine,
} from "@/lib/creators/lending-reward-engine";
import { fetchLendingTerms, getLendingTerm } from "@/lib/creators/lending-terms";
import {
  fetchMonthlyAccountTypes,
  monthlyAccountTypeKey,
  resolveMonthlyAccountManagementType,
} from "@/lib/creators/monthly-account-management-type";
import { fetchAllFrom } from "@/lib/db/paged-select";

/*
  端末貸し出し報酬明細の生成（受取人はクリエイター本人）。

  計算そのものは lib/creators/lending-reward-engine.ts が単一ソース。
  ここは「DBから読む / 所属と区分を解決する / 書き戻す」だけを担当する。

  ・source_row_key を一意キーとするため、何度実行しても二重計上しない
  ・支払い済み / 支払予定中の明細は一切書き換えない
  ・所属（creator_monthly_agency_assignments）と
    区分（creator_monthly_account_management_types）と
    AK（affiliate_order_lines.agency_split_rate）は読むだけ。書き換えない
*/

const ORDER_LINE_COLUMNS =
  "source_row_key, order_id, product_id, creator_id, target_month, commission_base, commission_gmv, creator_revenue_before_split, agency_split_rate, agency_revenue, payment_status, order_status, refund_status";

const UPSERT_CHUNK_SIZE = 500;

/*
  削除は主キー id で行う。
  source_row_key は 150 文字を超え「|」や日本語を含むため、
  数百件を .in() に渡すと URL が巨大になり、エラーも返らないまま
  1件も削除されないことがある（代理店報酬 sync と同じ理由）。
*/
const DELETE_CHUNK_SIZE = 200;

type LendingRewardItemRow = {
  id: string;
  source_row_key: string | null;
  creator_id: string;
  target_month: string;
  reward_amount: number | string | null;
  is_paid: boolean;
  payout_id: string | null;
  payment_batch_id: string | null;
};

/** 報酬を作らなかったクリエイター・月。画面で理由を出すために返す */
export type LendingSkipSummary = {
  creatorId: string;
  targetMonth: string;
  reason: LendingExclusionReason;
  lineCount: number;
  agencyRevenue: number;
};

export type SyncLendingRewardsResult = {
  targetMonth: string;
  upsertedCount: number;
  /** 対象外になったため削除した明細件数 */
  deletedCount: number;
  skippedPaidCount: number;
  /** 本人報酬の合計 */
  rewardAmount: number;
  /** 自社取り分の合計 */
  selfShareAmount: number;
  /** AP の合計（本人 + 自社 と一致する） */
  agencyRevenue: number;
  creatorCount: number;
  payoutCount: number;
  skips: LendingSkipSummary[];
  error: string | null;
  errorCode: string | null;
};

/**
 * 対象月の端末貸し出し報酬明細を affiliate_order_lines から再生成する。
 */
export async function syncCreatorLendingRewardsForMonth(
  supabase: SupabaseClient,
  targetMonth: string,
): Promise<SyncLendingRewardsResult> {
  const empty: SyncLendingRewardsResult = {
    targetMonth,
    upsertedCount: 0,
    deletedCount: 0,
    skippedPaidCount: 0,
    rewardAmount: 0,
    selfShareAmount: 0,
    agencyRevenue: 0,
    creatorCount: 0,
    payoutCount: 0,
    skips: [],
    error: null,
    errorCode: null,
  };

  const [
    ordersResult,
    existingResult,
    creatorsResult,
    assignmentsResult,
    agenciesResult,
    monthlyTypesResult,
    termsResult,
  ] = await Promise.all([
    fetchAllFrom<LendingOrderLine>(
      supabase,
      "affiliate_order_lines",
      ORDER_LINE_COLUMNS,
      (query) => query.eq("target_month", targetMonth),
    ),
    fetchAllFrom<
      Pick<
        LendingRewardItemRow,
        "id" | "source_row_key" | "is_paid" | "payout_id" | "payment_batch_id"
      >
    >(
      supabase,
      "creator_lending_reward_items",
      "id, source_row_key, is_paid, payout_id, payment_batch_id",
      (query) => query.eq("target_month", targetMonth),
    ),
    /* 区分の現在値。月別確定が無い月のフォールバックに使う */
    fetchAllFrom<{ id: string; account_management_type: string | null }>(
      supabase,
      "creators",
      "id, account_management_type",
    ),
    /*
      対象月の所属。自社であることを確かめるために読むだけで、書き換えない。
      月別確定が無い月は端末貸し出しの対象にしない。
    */
    fetchAllFrom<{ creator_id: string; target_month: string; agency_id: string | null }>(
      supabase,
      "creator_monthly_agency_assignments",
      "creator_id, target_month, agency_id",
      (query) => query.eq("target_month", targetMonth),
    ),
    supabase.from("agencies").select("id, is_in_house"),
    /* 区分は対象月の値で判定する（月別確定を優先） */
    fetchMonthlyAccountTypes(supabase, { targetMonth }),
    /* その月の有効化と分配率 */
    fetchLendingTerms(supabase, { targetMonth }),
  ]);

  const loadError =
    ordersResult.error ??
    existingResult.error ??
    creatorsResult.error ??
    assignmentsResult.error ??
    agenciesResult.error?.message ??
    monthlyTypesResult.error ??
    termsResult.error ??
    null;

  if (loadError) {
    return {
      ...empty,
      error: loadError,
      errorCode:
        ordersResult.errorCode ??
        existingResult.errorCode ??
        creatorsResult.errorCode ??
        assignmentsResult.errorCode ??
        agenciesResult.error?.code ??
        null,
    };
  }

  if (termsResult.tableMissing) {
    return {
      ...empty,
      error:
        "端末貸し出しの分配条件テーブル（creator_lending_terms）がありません。" +
        "20261010100000_creator_lending_reward_tables.sql を適用してください。",
    };
  }

  const currentTypeByCreator = new Map<string, string | null>();
  for (const creator of creatorsResult.data) {
    currentTypeByCreator.set(creator.id, creator.account_management_type ?? null);
  }

  const inHouseAgencyIds = new Set<string>();
  for (const agency of agenciesResult.data ?? []) {
    if (agency.is_in_house === true) inHouseAgencyIds.add(agency.id as string);
  }

  const assignmentByCreator = new Map<string, string | null>();
  for (const row of assignmentsResult.data) {
    assignmentByCreator.set(row.creator_id, row.agency_id ?? null);
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
  const rewardAmounts: number[] = [];
  const selfShareAmounts: number[] = [];
  const apAmounts: number[] = [];
  const creatorIds = new Set<string>();
  const skipByKey = new Map<string, LendingSkipSummary>();

  for (const line of ordersResult.data) {
    const creatorId = line.creator_id;
    const sourceRowKey = line.source_row_key;

    if (!creatorId || !sourceRowKey) continue;

    const resolvedType = resolveMonthlyAccountManagementType({
      creatorId,
      targetMonth,
      monthlyType: monthlyTypesResult.index.get(
        monthlyAccountTypeKey(creatorId, targetMonth),
      ),
      currentType: currentTypeByCreator.get(creatorId) ?? null,
    });

    /*
      区分が貸出でない明細は「対象外の理由」にも出さない。
      通常のクリエイターが毎月大量に並ぶと、本来確認したい
      「貸出なのに作られなかった理由」が埋もれるため。
    */
    if (resolvedType.accountManagementType !== "account_lending") continue;

    const assignedAgencyId = assignmentByCreator.get(creatorId) ?? null;
    const term = getLendingTerm(termsResult.index, creatorId, targetMonth);

    const context = {
      creatorId,
      targetMonth,
      accountManagementType: resolvedType.accountManagementType,
      agencyId: assignedAgencyId,
      agencyIsInHouse: assignedAgencyId ? inHouseAgencyIds.has(assignedAgencyId) : false,
      assignmentConfirmed: assignmentByCreator.has(creatorId) && assignedAgencyId != null,
      isActive: term.isActive,
      splitRateOverride: term.splitRate,
    };

    const reason = resolveLendingExclusionReason(line, context);

    if (reason != null) {
      const key = `${creatorId}|${reason}`;
      const current =
        skipByKey.get(key) ??
        {
          creatorId,
          targetMonth,
          reason,
          lineCount: 0,
          agencyRevenue: 0,
        };
      current.lineCount += 1;
      current.agencyRevenue += Number(line.agency_revenue ?? 0);
      skipByKey.set(key, current);
      continue;
    }

    if (paidSourceKeys.has(sourceRowKey)) continue;

    const computed = computeCreatorLendingReward(line, context);
    if (!computed) continue;

    rewardAmounts.push(computed.rewardAmount);
    selfShareAmounts.push(computed.selfShareAmount);
    apAmounts.push(computed.agencyRevenue);
    creatorIds.add(computed.creatorId);

    upserts.push({
      source_row_key: computed.sourceRowKey,
      target_month: computed.targetMonth,
      order_id: computed.orderId,
      product_id: computed.productId,
      creator_id: computed.creatorId,
      in_house_agency_id: computed.inHouseAgencyId,
      commission_base: computed.commissionBase,
      commission_gmv: computed.commissionGmv,
      creator_revenue_before_split: computed.creatorRevenueBeforeSplit,
      agency_split_rate: computed.agencySplitRate,
      agency_revenue: computed.agencyRevenue,
      split_rate: computed.splitRate,
      reward_amount: computed.rewardAmount,
      self_share_amount: computed.selfShareAmount,
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
      .from("creator_lending_reward_items")
      .upsert(chunk, { onConflict: "source_row_key" });

    if (error) {
      return {
        ...empty,
        skippedPaidCount: paidSourceKeys.size,
        skips: [...skipByKey.values()],
        error: error.message,
        errorCode: error.code ?? null,
      };
    }

    upsertedCount += chunk.length;
  }

  const cleanup = await deleteObsoleteLendingItems(
    supabase,
    targetMonth,
    new Set<string>(upserts.map((row) => String(row.source_row_key))),
    existingResult.data,
  );

  if (cleanup.error) {
    return {
      ...empty,
      upsertedCount,
      skippedPaidCount: paidSourceKeys.size,
      skips: [...skipByKey.values()],
      error: cleanup.error,
    };
  }

  const payoutResult = await refreshLendingPayoutsForMonth(supabase, targetMonth);

  return {
    targetMonth,
    upsertedCount,
    deletedCount: cleanup.deletedCount,
    skippedPaidCount: paidSourceKeys.size,
    rewardAmount: sumLendingAmounts(rewardAmounts),
    selfShareAmount: sumLendingAmounts(selfShareAmounts),
    agencyRevenue: sumLendingAmounts(apAmounts),
    creatorCount: creatorIds.size,
    payoutCount: payoutResult.payoutCount,
    skips: [...skipByKey.values()],
    error: payoutResult.error,
    errorCode: payoutResult.errorCode,
  };
}

/**
 * 対象月のうち、現在のルール・マスタでは報酬対象でなくなった明細を削除する。
 *
 * ■ 絶対に消さないもの
 *   is_paid = true             … 支払い済み
 *   payout_id が設定済み       … 支払レコードに紐付け済み
 *   payment_batch_id が設定済み … 支払明細に組み入れ済み（支払予定中）
 * 呼び出し側で paidSourceKeys として除外済みだが、ここでも条件に入れて二重に守る。
 */
async function deleteObsoleteLendingItems(
  supabase: SupabaseClient,
  targetMonth: string,
  validSourceRowKeys: Set<string>,
  existing: Array<{
    id: string;
    source_row_key: string | null;
    is_paid: boolean;
    payout_id: string | null;
    payment_batch_id: string | null;
  }>,
): Promise<{ deletedCount: number; error: string | null }> {
  const removableIds: string[] = [];

  for (const item of existing) {
    if (item.is_paid) continue;
    if (item.payout_id != null) continue;
    if (item.payment_batch_id != null) continue;
    if (item.source_row_key && validSourceRowKeys.has(item.source_row_key)) continue;
    removableIds.push(item.id);
  }

  if (removableIds.length === 0) return { deletedCount: 0, error: null };

  let deletedCount = 0;

  for (let i = 0; i < removableIds.length; i += DELETE_CHUNK_SIZE) {
    const chunk = removableIds.slice(i, i + DELETE_CHUNK_SIZE);
    const { error } = await supabase
      .from("creator_lending_reward_items")
      .delete()
      .in("id", chunk)
      .eq("target_month", targetMonth)
      .eq("is_paid", false)
      .is("payout_id", null)
      .is("payment_batch_id", null);

    if (error) return { deletedCount, error: error.message };
    deletedCount += chunk.length;
  }

  return { deletedCount, error: null };
}

/**
 * 本人×対象月の支払予定を作り直す。
 *
 * ■ 月別の実額を入れる（年初来累積にしない）
 * 以前は「対象月時点の年初来累積」を入れていた（agency_payouts と同じ方式）。
 * その形は行をまたいで金額が重複し、支払が済んだ後も過去月の行が
 * 「未払い」のまま残るため、月別の債務として読めなかった（M-3）。
 *
 * ここではその月の明細の実額だけを入れ、状態も明細（is_paid）から決める。
 * 画面と支払候補は creator_lending_reward_items を正とするので、
 * このテーブルは会計の記録用に留める。
 *
 * ■ 触らないもの
 * 支払処理（complete_payment_batch）が作った締め月の行は、
 * その月に明細が無ければ更新対象にならない（status='paid' のまま残る）。
 */
async function refreshLendingPayoutsForMonth(
  supabase: SupabaseClient,
  targetMonth: string,
): Promise<{ payoutCount: number; error: string | null; errorCode: string | null }> {
  /* その月の明細だけを読む（累積にしない） */
  const itemsResult = await fetchAllFrom<{
    creator_id: string;
    reward_amount: number | string | null;
    self_share_amount: number | string | null;
    is_paid: boolean;
  }>(
    supabase,
    "creator_lending_reward_items",
    "creator_id, reward_amount, self_share_amount, is_paid",
    (query) => query.eq("is_reward_target", true).eq("target_month", targetMonth),
  );

  if (itemsResult.error) {
    return {
      payoutCount: 0,
      error: itemsResult.error,
      errorCode: itemsResult.errorCode ?? null,
    };
  }

  type Acc = { reward: number[]; self: number[]; unpaid: number[]; paidCount: number; count: number };
  const byCreator = new Map<string, Acc>();

  for (const item of itemsResult.data) {
    const entry =
      byCreator.get(item.creator_id) ??
      { reward: [], self: [], unpaid: [], paidCount: 0, count: 0 };
    const amount = resolveCreatorLendingRewardItemAmount(item);
    entry.reward.push(amount);
    entry.self.push(Number(item.self_share_amount ?? 0));
    entry.count += 1;
    if (item.is_paid) entry.paidCount += 1;
    else entry.unpaid.push(amount);
    byCreator.set(item.creator_id, entry);
  }

  if (byCreator.size === 0) {
    return { payoutCount: 0, error: null, errorCode: null };
  }

  const nowIso = new Date().toISOString();
  const rows: Array<Record<string, unknown>> = [];

  for (const [creatorId, acc] of byCreator) {
    const unpaidAmount = sumLendingAmounts(acc.unpaid);
    /* その月の明細がすべて支払済みなら paid。残っていれば unpaid */
    const allPaid = acc.count > 0 && acc.paidCount === acc.count;

    rows.push({
      target_month: targetMonth,
      creator_id: creatorId,
      /* その月の実額（累積ではない） */
      total_reward_amount: sumLendingAmounts(acc.reward),
      total_self_share_amount: sumLendingAmounts(acc.self),
      threshold_amount: 0,
      is_payable: unpaidAmount > 0,
      status: allPaid ? "paid" : "unpaid",
      updated_at: nowIso,
    });
  }

  const { error } = await supabase
    .from("creator_lending_payouts")
    .upsert(rows, { onConflict: "target_month,creator_id" });

  if (error) {
    return { payoutCount: 0, error: error.message, errorCode: error.code ?? null };
  }

  return { payoutCount: rows.length, error: null, errorCode: null };
}
