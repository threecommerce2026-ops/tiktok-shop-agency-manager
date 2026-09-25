import type { SupabaseClient } from "@supabase/supabase-js";

import { fetchAllFrom } from "@/lib/db/paged-select";
import { collectInHouseReferrerIds } from "@/lib/referrals/in-house-referrer";
import {
  applyReferralRewardCap,
  DEFAULT_REFERRER_LIFETIME_PAYOUT_CAP_YEN,
  pairReferralKey,
} from "@/lib/referrals/cap";
import {
  computeReferralReward,
  isReferralMonthActive,
  REFERRAL_PAYOUT_THRESHOLD_YEN,
  REFERRAL_REWARD_RATE,
  resolveAnnualPayoutState,
  resolveReferralRate,
  resolveRewardItemAmount,
  rewardYearOf,
  sumReferralAmounts,
  type ReferralOrderLine,
} from "@/lib/referrals/referral-reward-engine";

/*
  紹介者報酬明細の生成。

  計算そのものは referral-reward-engine が単一ソース。
  ここは「DBから読む / 上限を適用する / 書き戻す」だけを担当する。
*/

const ORDER_LINE_COLUMNS =
  "source_row_key, order_id, product_id, creator_id, target_month, commission_base, payment_status, order_status, refund_status";

const UPSERT_CHUNK_SIZE = 500;

/*
  削除は主キー id で行い、チャンクを小さく保つ。
  source_row_key は 150 文字を超え「|」や日本語を含むため、
  数百件を .in() に渡すと URL が巨大になり、エラーも返らないまま
  1件も削除されないことがある（実測で 415 件が無言で失敗した）。
  id は 36 文字固定の UUID なので安全。
*/
const DELETE_CHUNK_SIZE = 200;

type ReferralLink = {
  referrerId: string;
  referralRate: number;
  startMonth: string | null;
  endMonth: string | null;
  lifetimePayoutCap: number;
  lifetimePaidAmount: number;
};

type RewardItemRow = {
  source_row_key: string | null;
  creator_id: string;
  referrer_id: string;
  target_month: string;
  reward_amount: number | string | null;
  adjusted_reward_amount: number | string | null;
  is_paid: boolean;
  payout_id: string | null;
  /** 支払明細（payment_batches）に占有されているか */
  payment_batch_id: string | null;
  id: string;
};

export type SyncReferralRewardsResult = {
  targetMonth: string;
  /** 新規作成 + 更新された明細件数 */
  upsertedCount: number;
  /** 対象外になったため削除した明細件数 */
  deletedCount: number;
  /** 支払い済みのため据え置いた明細件数 */
  skippedPaidCount: number;
  /** 対象月に発生した報酬合計 */
  monthRewardAmount: number;
  /** 作成・更新した支払レコード件数 */
  payoutCount: number;
  error: string | null;
};

/**
 * 対象月の紹介者報酬明細を affiliate_order_lines から再生成する。
 *
 * ・source_row_key を一意キーとするため、何度実行しても二重計上しない
 * ・支払い済み明細は一切書き換えない
 * ・支払レコードは暦年の未払い累積で支払可否を判定する
 */
export async function syncReferralRewardsForMonth(
  supabase: SupabaseClient,
  targetMonth: string,
): Promise<SyncReferralRewardsResult> {
  const empty: SyncReferralRewardsResult = {
    targetMonth,
    upsertedCount: 0,
    deletedCount: 0,
    skippedPaidCount: 0,
    monthRewardAmount: 0,
    payoutCount: 0,
    error: null,
  };

  const [creatorsResult, referralsResult, ordersResult, existingResult, otherUnpaidResult] =
    await Promise.all([
      supabase
        .from("creators")
        .select("id, referred_by_referrer_id, account_management_type"),
      supabase
        .from("creator_referrals")
        .select(
          "creator_id, referrer_id, referral_rate, start_month, end_month, is_active, lifetime_payout_cap, lifetime_paid_amount",
        )
        .order("created_at", { ascending: false }),
      fetchAllFrom<ReferralOrderLine>(
        supabase,
        "affiliate_order_lines",
        ORDER_LINE_COLUMNS,
        (query) => query.eq("target_month", targetMonth),
      ),
      fetchAllFrom<
        Pick<
          RewardItemRow,
          "id" | "source_row_key" | "is_paid" | "payout_id" | "payment_batch_id"
        >
      >(
        supabase,
        "referral_reward_items",
        "id, source_row_key, is_paid, payout_id, payment_batch_id",
        (query) => query.eq("target_month", targetMonth),
      ),
      fetchAllFrom<RewardItemRow>(
        supabase,
        "referral_reward_items",
        "creator_id, referrer_id, target_month, reward_amount, adjusted_reward_amount",
        (query) =>
          query
            .eq("is_reward_target", true)
            .eq("is_paid", false)
            .neq("target_month", targetMonth),
      ),
    ]);

  const loadError =
    creatorsResult.error?.message ??
    referralsResult.error?.message ??
    ordersResult.error ??
    existingResult.error ??
    otherUnpaidResult.error ??
    null;

  if (loadError) {
    return { ...empty, error: loadError };
  }

  // --- クリエイター属性（creators が Single Source of Truth）-------------------
  const creatorConfigById = new Map<
    string,
    { referrerId: string | null; accountManagementType: string | null }
  >();

  for (const creator of creatorsResult.data ?? []) {
    creatorConfigById.set(creator.id as string, {
      referrerId: (creator.referred_by_referrer_id as string | null) ?? null,
      accountManagementType:
        (creator.account_management_type as string | null) ?? null,
    });
  }

  // --- 紹介契約（料率・生涯上限は creator_referrals を参照）--------------------
  const referralByCreator = new Map<string, ReferralLink>();

  for (const referral of referralsResult.data ?? []) {
    const creatorId = referral.creator_id as string;
    if (!referral.is_active || referralByCreator.has(creatorId)) continue;

    referralByCreator.set(creatorId, {
      referrerId: referral.referrer_id as string,
      referralRate: resolveReferralRate(referral.referral_rate),
      startMonth: (referral.start_month as string | null) ?? null,
      endMonth: (referral.end_month as string | null) ?? null,
      lifetimePayoutCap: Number(
        referral.lifetime_payout_cap ?? DEFAULT_REFERRER_LIFETIME_PAYOUT_CAP_YEN,
      ),
      lifetimePaidAmount: Number(referral.lifetime_paid_amount ?? 0),
    });
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

  // --- 生涯上限の判定用に、対象月以外の未払い割当額を集計 -----------------------
  const allocatedUnpaidByPair = new Map<string, number>();

  for (const item of otherUnpaidResult.data) {
    const key = pairReferralKey(item.referrer_id, item.creator_id);
    allocatedUnpaidByPair.set(
      key,
      (allocatedUnpaidByPair.get(key) ?? 0) + resolveRewardItemAmount(item),
    );
  }

  // --- 明細生成 ---------------------------------------------------------------
  const nowIso = new Date().toISOString();
  const upserts: Array<Record<string, unknown>> = [];
  const monthAmounts: number[] = [];

  for (const line of ordersResult.data) {
    const creatorId = line.creator_id;
    const sourceRowKey = line.source_row_key;

    if (!creatorId || !sourceRowKey) continue;
    if (paidSourceKeys.has(sourceRowKey)) continue;

    const config = creatorConfigById.get(creatorId);
    if (!config) continue;

    const referral = referralByCreator.get(creatorId);
    const referrerId = config.referrerId ?? referral?.referrerId ?? null;
    if (!referrerId) continue;

    // 紹介契約の有効期間外は対象外
    if (
      referral &&
      !isReferralMonthActive(targetMonth, referral.startMonth, referral.endMonth)
    ) {
      continue;
    }

    const computed = computeReferralReward(
      line,
      {
        creatorId,
        referrerId,
        accountManagementType: config.accountManagementType,
      },
      referral?.referralRate ?? REFERRAL_REWARD_RATE,
    );

    if (!computed) continue;

    // 紹介者×クリエイター単位の生涯上限
    const pairKey = pairReferralKey(referrerId, creatorId);
    const allocated = allocatedUnpaidByPair.get(pairKey) ?? 0;
    const capped = applyReferralRewardCap({
      originalRewardAmount: computed.rewardAmount,
      lifetimePayoutCap:
        referral?.lifetimePayoutCap ?? DEFAULT_REFERRER_LIFETIME_PAYOUT_CAP_YEN,
      lifetimePaidAmount: (referral?.lifetimePaidAmount ?? 0) + allocated,
      eligible: true,
    });

    /*
      上限に達していない通常ケースでは、銭単位の計算値をそのまま採用する。
      applyReferralRewardCap は円単位に丸めるため、上限適用時のみその値を使う。
    */
    const rewardAmount =
      capped.capApplied || capped.capReached
        ? capped.adjustedRewardAmount
        : computed.rewardAmount;

    allocatedUnpaidByPair.set(pairKey, allocated + rewardAmount);
    monthAmounts.push(rewardAmount);

    upserts.push({
      source_row_key: computed.sourceRowKey,
      target_month: computed.targetMonth,
      order_id: computed.orderId,
      product_id: computed.productId,
      creator_id: computed.creatorId,
      referrer_id: computed.referrerId,
      base_amount: computed.baseAmount,
      reward_rate: computed.rewardRate,
      original_reward_amount: computed.rewardAmount,
      adjusted_reward_amount: rewardAmount,
      reward_amount: rewardAmount,
      cap_applied: capped.capApplied,
      cap_reached: capped.capReached,
      payment_status: computed.paymentStatus,
      order_status: computed.orderStatus,
      refund_status: computed.refundStatus,
      is_reward_target: rewardAmount > 0,
      is_paid: false,
      updated_at: nowIso,
    });
  }

  let upsertedCount = 0;

  for (let i = 0; i < upserts.length; i += UPSERT_CHUNK_SIZE) {
    const chunk = upserts.slice(i, i + UPSERT_CHUNK_SIZE);
    const { error } = await supabase
      .from("referral_reward_items")
      .upsert(chunk, { onConflict: "source_row_key" });

    if (error) {
      return {
        ...empty,
        skippedPaidCount: paidSourceKeys.size,
        error: error.message,
      };
    }

    upsertedCount += chunk.length;
  }

  // 対象でなくなった明細を削除してから支払レコードを作り直す
  const cleanup = await deleteObsoleteReferralItems(
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
      error: cleanup.error,
    };
  }

  const payoutResult = await refreshReferralPayoutsForMonth(supabase, targetMonth);

  return {
    targetMonth,
    upsertedCount,
    deletedCount: cleanup.deletedCount,
    skippedPaidCount: paidSourceKeys.size,
    monthRewardAmount: sumReferralAmounts(monthAmounts),
    payoutCount: payoutResult.payoutCount,
    error: payoutResult.error,
  };
}


/**
 * 対象月のうち、現在のクリエイターマスタでは報酬対象でなくなった明細を削除する。
 *
 * 明細は source_row_key で upsert しているため、
 * 「対象でなくなった行」は upsert 対象に現れないだけで DB には残り続ける。
 * 削除しないと、紹介者を外したクリエイターの報酬が旧紹介者に付いたまま残る。
 *
 * ■ 絶対に消さないもの
 *   is_paid = true              … 支払い済み
 *   payout_id が設定済み        … 支払レコードに紐付け済み
 *   payment_batch_id が設定済み … 支払明細に組み入れ済み（支払予定中）
 */
async function deleteObsoleteReferralItems(
  supabase: SupabaseClient,
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
      .from("referral_reward_items")
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
async function refreshReferralPayoutsForMonth(
  supabase: SupabaseClient,
  targetMonth: string,
): Promise<{ payoutCount: number; error: string | null }> {
  const rewardYear = rewardYearOf(targetMonth);

  const unpaidResult = await fetchAllFrom<RewardItemRow>(
    supabase,
    "referral_reward_items",
    "referrer_id, target_month, reward_amount, adjusted_reward_amount",
    (query) =>
      query
        .eq("is_reward_target", true)
        .eq("is_paid", false)
        .gte("target_month", `${rewardYear}-01`)
        .lte("target_month", targetMonth),
  );

  if (unpaidResult.error) {
    return { payoutCount: 0, error: unpaidResult.error };
  }

  /*
    自社の紹介者（（株）3）には支払レコードを作らない。
    報酬明細は通常どおり作られ実績として集計されるが、
    外部への振込対象ではないため payout を持たせない。
  */
  const inHouseResult = await supabase
    .from("referrers")
    .select("id, is_in_house")
    .eq("is_in_house", true);

  if (inHouseResult.error) {
    return { payoutCount: 0, error: inHouseResult.error.message };
  }

  const inHouseReferrerIds = collectInHouseReferrerIds(inHouseResult.data ?? []);

  const unpaidByReferrer = new Map<string, number[]>();

  for (const item of unpaidResult.data) {
    if (inHouseReferrerIds.has(item.referrer_id)) continue;
    const list = unpaidByReferrer.get(item.referrer_id) ?? [];
    list.push(resolveRewardItemAmount(item));
    unpaidByReferrer.set(item.referrer_id, list);
  }

  const { data: existingPayouts, error: existingError } = await supabase
    .from("referral_payouts")
    .select("id, referrer_id, status")
    .eq("target_month", targetMonth);

  if (existingError) {
    return { payoutCount: 0, error: existingError.message };
  }

  /*
    未払残高が無くなった紹介者の支払レコードを削除する。

    紹介者を付け替えたり外したりすると、旧紹介者の未払残高は 0 になるが、
    以前に作られた payout はそのまま残り「支払予定額」として見えてしまう。
    実際に無い報酬を振り込んでしまうため必ず消す。
    自社（（株）3）も unpaidByReferrer に入らないのでここで消える。

    支払い済み（status='paid'）は絶対に触らない。
  */
  const obsoletePayoutIds = (existingPayouts ?? [])
    .filter(
      (row) =>
        row.status !== "paid" &&
        !unpaidByReferrer.has(row.referrer_id as string),
    )
    .map((row) => row.id as string);

  if (obsoletePayoutIds.length > 0) {
    for (let i = 0; i < obsoletePayoutIds.length; i += DELETE_CHUNK_SIZE) {
      const chunk = obsoletePayoutIds.slice(i, i + DELETE_CHUNK_SIZE);
      const { error } = await supabase
        .from("referral_payouts")
        .delete()
        .neq("status", "paid")
        .in("id", chunk);

      if (error) return { payoutCount: 0, error: error.message };
    }
  }

  if (unpaidByReferrer.size === 0) {
    return { payoutCount: 0, error: null };
  }

  const paidReferrerIds = new Set(
    (existingPayouts ?? [])
      .filter((row) => row.status === "paid")
      .map((row) => row.referrer_id as string),
  );

  const nowIso = new Date().toISOString();
  const rows: Array<Record<string, unknown>> = [];

  for (const [referrerId, amounts] of unpaidByReferrer) {
    // 支払い済みの月次レコードは再同期で上書きしない
    if (paidReferrerIds.has(referrerId)) continue;

    const state = resolveAnnualPayoutState({
      annualRewardAmount: sumReferralAmounts(amounts),
      paidAmount: 0,
    });

    rows.push({
      target_month: targetMonth,
      referrer_id: referrerId,
      total_reward_amount: state.unpaidAmount,
      threshold_amount: REFERRAL_PAYOUT_THRESHOLD_YEN,
      is_payable: state.isPayable,
      status: state.isPayable ? "unpaid" : "hold",
      updated_at: nowIso,
    });
  }

  if (rows.length === 0) {
    return { payoutCount: 0, error: null };
  }

  const { error } = await supabase
    .from("referral_payouts")
    .upsert(rows, { onConflict: "target_month,referrer_id" });

  if (error) {
    return { payoutCount: 0, error: error.message };
  }

  return { payoutCount: rows.length, error: null };
}

export async function markReferralPayoutPaid(
  supabase: SupabaseClient,
  payoutId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase.rpc("mark_referral_payout_paid_annual", {
    p_payout_id: payoutId,
  });

  return error ? { ok: false, error: error.message } : { ok: true };
}

export async function markReferralPayoutUnpaid(
  supabase: SupabaseClient,
  payoutId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase.rpc("mark_referral_payout_unpaid_annual", {
    p_payout_id: payoutId,
  });

  return error ? { ok: false, error: error.message } : { ok: true };
}
