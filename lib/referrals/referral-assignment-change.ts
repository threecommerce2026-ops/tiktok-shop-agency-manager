import type { SupabaseClient } from "@supabase/supabase-js";

import { fetchAllFrom } from "@/lib/db/paged-select";
import {
  isValidTargetMonth,
  referralBaseAmount,
  REFERRAL_REWARD_RATE,
  sumReferralAmounts,
} from "@/lib/referrals/referral-reward-engine";
import {
  buildReferralPeriods,
  REFERRAL_RELATION_COLUMNS,
  resolveReferralForMonth,
  type ReferralRelationRow,
} from "@/lib/referrals/referral-period";
import { isTapReferralSourceLine } from "@/lib/referrals/tap-referral-source";

/*
  紹介者・適用期間の変更を「保存前に確かめる」ための単一ソース。

  ■ 画面とサーバーで同じ判定を使う
  プレビューに出す影響範囲・件数・金額と、保存時に見るブロック条件は
  同じ関数から作る。別々に書くと「画面では出せたのに保存で弾かれる」
  （あるいはその逆で、危険な変更が通る）ことになる。

  ■ 何をブロックするか
  紹介報酬は creator_referrals の期間で誰に帰属するかが決まるので、
  期間を動かすと過去月の金額が変わりうる。確定済み・支払処理へ
  進んだ月に影響する変更は保存させない。

      referral_month_settlements.status = 'finalized'
      referral_reward_items.payment_batch_id is not null
      referral_reward_items.payout_id is not null
      referral_reward_items.is_paid = true

  ■ 月次確定は RPC 経由で読む
  referral_month_settlements は authenticated に SELECT が grant されて
  いない。権限を緩めるのではなく、既存の list_referral_month_settlements()
  を使う（security definer / 管理者限定）。

  ■ ここでは報酬を作り直さない
  影響額は参考値として出すだけ。実際の再集計は別の操作
  （syncReferralRewardsForMonth）で行う。保存の副作用で金額が動くと、
  どの操作で変わったのか追えなくなる。
*/

/** 変更の種類。creator_referral_logs.action と同じ語彙 */
export type ReferralChangeAction =
  | "create"
  | "reassign"
  | "change_start_month"
  | "unlink";

export type ReferralChangeBlockReason =
  | "settlement_finalized"
  | "reward_claimed"
  | "reward_paid"
  | "referral_period_conflict";

export const REFERRAL_CHANGE_BLOCK_LABEL: Record<ReferralChangeBlockReason, string> =
  {
    settlement_finalized: "確定済みの月に影響します",
    reward_claimed: "支払明細に組み入れ済みの紹介報酬に影響します",
    reward_paid: "支払済みの紹介報酬に影響します",
    referral_period_conflict: "同じ月に紹介者が2人以上になります",
  };

export type ReferralChangePlan = {
  creatorId: string;
  tiktokId: string;
  action: ReferralChangeAction;

  /** 変更前 */
  previousReferrerId: string | null;
  previousReferrerName: string | null;
  previousStartMonth: string | null;
  previousEndMonth: string | null;

  /** 変更後 */
  referrerId: string | null;
  referrerName: string | null;
  startMonth: string | null;

  /** 紹介報酬の計算が変わりうる範囲 */
  affectedStartMonth: string | null;
  affectedEndMonth: string | null;
  affectedMonths: string[];

  /** 影響範囲の実績（参考値。ここでは再集計しない） */
  tapItemCount: number;
  tapThreeRevenue: number;
  estimatedReferralReward: number;
  affiliateItemCount: number;

  /** 影響範囲の現況 */
  finalizedMonths: string[];
  claimedItemCount: number;
  paidItemCount: number;

  /** 開始月を選ぶときの参考 */
  firstTapMonth: string | null;
  firstAffiliateMonth: string | null;

  blocks: ReferralChangeBlockReason[];
  error: string | null;
};

function emptyPlan(creatorId: string): ReferralChangePlan {
  return {
    creatorId,
    tiktokId: "",
    action: "create",
    previousReferrerId: null,
    previousReferrerName: null,
    previousStartMonth: null,
    previousEndMonth: null,
    referrerId: null,
    referrerName: null,
    startMonth: null,
    affectedStartMonth: null,
    affectedEndMonth: null,
    affectedMonths: [],
    tapItemCount: 0,
    tapThreeRevenue: 0,
    estimatedReferralReward: 0,
    affiliateItemCount: 0,
    finalizedMonths: [],
    claimedItemCount: 0,
    paidItemCount: 0,
    firstTapMonth: null,
    firstAffiliateMonth: null,
    blocks: [],
    error: null,
  };
}

/** start 〜 end の月を並べる */
function monthsBetween(start: string, end: string): string[] {
  if (!isValidTargetMonth(start) || !isValidTargetMonth(end) || start > end) return [];

  const out: string[] = [];
  let [year, month] = start.split("-").map(Number);

  for (let guard = 0; guard < 240; guard += 1) {
    const cursor = `${year}-${String(month).padStart(2, "0")}`;
    out.push(cursor);
    if (cursor >= end) break;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return out;
}

/**
 * 紹介者・適用開始月の変更内容と影響を組み立てる（READ ONLY）。
 *
 * 保存前のプレビューと、保存時のブロック判定の両方がこれを使う。
 */
export async function buildReferralChangePlan(
  supabase: SupabaseClient,
  params: {
    creatorId: string;
    /** null なら紹介者を外す */
    referrerId: string | null;
    /** 紹介者を設定する場合は必須 */
    startMonth: string | null;
  },
): Promise<ReferralChangePlan> {
  const { creatorId, referrerId } = params;
  const startMonth = params.startMonth;
  const empty = emptyPlan(creatorId);

  if (!creatorId) return { ...empty, error: "クリエイターを指定してください" };

  if (referrerId && !isValidTargetMonth(String(startMonth ?? ""))) {
    return {
      ...empty,
      error: `適用開始月を YYYY-MM 形式で指定してください: ${startMonth || "(未指定)"}`,
    };
  }

  const [creatorResult, relationsResult, referrersResult] = await Promise.all([
    supabase.from("creators").select("id, tiktok_id").eq("id", creatorId).maybeSingle(),
    fetchAllFrom<ReferralRelationRow>(
      supabase,
      "creator_referrals",
      REFERRAL_RELATION_COLUMNS,
      (query) => query.eq("creator_id", creatorId),
    ),
    supabase.from("referrers").select("id, name, referrer_name"),
  ]);

  const loadError =
    creatorResult.error?.message ??
    relationsResult.error ??
    referrersResult.error?.message ??
    null;

  if (loadError) return { ...empty, error: loadError };
  if (!creatorResult.data) return { ...empty, error: "クリエイターが見つかりません" };

  const tiktokId = String(
    (creatorResult.data as { tiktok_id?: string | null }).tiktok_id ?? "",
  );

  const referrerNameById = new Map<string, string>();
  for (const row of referrersResult.data ?? []) {
    referrerNameById.set(
      String(row.id),
      String(row.referrer_name ?? row.name ?? "（不明な紹介者）"),
    );
  }

  /*
    変更前の「いま有効な関係」。無効化済みの世代は変更対象ではない。
    複数あることは運用上ないが、あれば最も新しいものを前の状態とみなす。
  */
  const activeRelations = relationsResult.data
    .filter((row) => row.is_active === true)
    .sort((a, b) =>
      String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")),
    );
  const current = activeRelations[0] ?? null;

  const previousReferrerId = current?.referrer_id ?? null;
  const previousStartMonth = current?.start_month ?? null;
  const previousEndMonth = current?.end_month ?? null;

  let action: ReferralChangeAction;
  if (!referrerId) action = "unlink";
  else if (!previousReferrerId) action = "create";
  else if (previousReferrerId !== referrerId) action = "reassign";
  else action = "change_start_month";

  /*
    影響範囲。

    開始月を前倒しすれば前倒しした分から、後ろへずらせば元の開始月から
    帰属が変わる。どちらの向きでも安全側に取るため、新旧の開始月の
    早い方を範囲の始まりにする。

    終わりは、この creator に紹介報酬が存在する最後の月まで。
    報酬がまだ無ければ開始月だけを見る。
  */
  const rewardResult = await fetchAllFrom<{
    target_month: string;
    reward_amount: number | string | null;
    adjusted_reward_amount: number | string | null;
    is_paid: boolean;
    payout_id: string | null;
    payment_batch_id: string | null;
  }>(
    supabase,
    "referral_reward_items",
    "target_month, reward_amount, adjusted_reward_amount, is_paid, payout_id, payment_batch_id",
    (query) => query.eq("creator_id", creatorId),
  );

  if (rewardResult.error) return { ...empty, error: rewardResult.error };

  const candidateStarts = [startMonth, previousStartMonth].filter(
    (value): value is string => isValidTargetMonth(String(value ?? "")),
  );
  const affectedStartMonth =
    candidateStarts.length > 0 ? candidateStarts.slice().sort()[0] : null;

  const rewardMonths = rewardResult.data
    .map((row) => String(row.target_month))
    .filter((value) => isValidTargetMonth(value));

  const candidateEnds = [
    ...rewardMonths,
    previousEndMonth,
    affectedStartMonth,
  ].filter((value): value is string => isValidTargetMonth(String(value ?? "")));
  const affectedEndMonth =
    candidateEnds.length > 0 ? candidateEnds.slice().sort().at(-1) ?? null : null;

  const affectedMonths =
    affectedStartMonth && affectedEndMonth
      ? monthsBetween(affectedStartMonth, affectedEndMonth)
      : [];

  // ---- 影響範囲の実績（参考値）---------------------------------------------
  const [tapResult, affiliateResult, settlementsResult] = await Promise.all([
    fetchAllFrom<{
      source_row_key: string | null;
      order_id: string | null;
      product_id: string | null;
      creator_id: string | null;
      target_month: string | null;
      commission_base: number | string | null;
      partner_estimated_commission: number | string | null;
      partner_shop_ads_estimated_commission: number | string | null;
      payment_status: string | null;
      order_status: string | null;
      refund_status: string | null;
    }>(
      supabase,
      "tap_affiliate_order_lines",
      "source_row_key, order_id, product_id, creator_id, target_month, commission_base, partner_estimated_commission, partner_shop_ads_estimated_commission, payment_status, order_status, refund_status",
      (query) => query.eq("creator_id", creatorId),
    ),
    fetchAllFrom<{ target_month: string | null }>(
      supabase,
      "affiliate_order_lines",
      "target_month",
      (query) => query.eq("creator_id", creatorId),
    ),
    /*
      月次確定は RPC 経由で読む。

      referral_month_settlements は authenticated / service_role に
      SELECT が grant されていない（postgres のみ）。直接 .from() で
      引くと permission denied になる。読み書きとも security definer の
      RPC が唯一の入口という設計なので、ここも既存のものを再利用する。

      行が無い月は未確定として扱われるため、finalized の月だけ拾えばよい。
    */
    supabase.rpc("list_referral_month_settlements"),
  ]);

  const aggregateError =
    tapResult.error ?? affiliateResult.error ?? settlementsResult.error?.message ?? null;
  if (aggregateError) return { ...empty, error: aggregateError };

  const inAffected = (month: string | null | undefined): boolean =>
    month != null &&
    affectedStartMonth != null &&
    affectedEndMonth != null &&
    month >= affectedStartMonth &&
    month <= affectedEndMonth;

  const tapMonths: string[] = [];
  let tapItemCount = 0;
  const threeRevenues: number[] = [];

  for (const line of tapResult.data) {
    if (!isTapReferralSourceLine(line)) continue;
    tapMonths.push(String(line.target_month));
    if (!inAffected(line.target_month)) continue;
    tapItemCount += 1;
    threeRevenues.push(referralBaseAmount(line));
  }

  const affiliateMonths = affiliateResult.data
    .map((row) => String(row.target_month ?? ""))
    .filter((value) => isValidTargetMonth(value));

  const tapThreeRevenue = sumReferralAmounts(threeRevenues);

  // ---- 現況（ブロック判定の材料）-------------------------------------------
  const finalizedMonths = (
    (settlementsResult.data ?? []) as Array<{ target_month: string; status: string }>
  )
    .filter((row) => row.status === "finalized")
    .map((row) => String(row.target_month))
    .filter((month) => inAffected(month))
    .sort();

  let claimedItemCount = 0;
  let paidItemCount = 0;

  for (const item of rewardResult.data) {
    if (!inAffected(item.target_month)) continue;
    if (item.is_paid) paidItemCount += 1;
    else if (item.payment_batch_id != null || item.payout_id != null) {
      claimedItemCount += 1;
    }
  }

  // ---- 変更後に同じ月へ紹介者が2人にならないか -----------------------------
  const conflictRows: ReferralRelationRow[] = relationsResult.data
    .filter((row) => {
      // 置き換わる行は除く
      if (row.is_active === true) return false;
      return true;
    })
    .concat(
      referrerId && startMonth
        ? [
            {
              creator_id: creatorId,
              referrer_id: referrerId,
              referral_rate: null,
              start_month: startMonth,
              end_month: null,
              is_active: true,
              lifetime_payout_cap: null,
              lifetime_paid_amount: 0,
              created_at: new Date().toISOString(),
            },
          ]
        : [],
    );

  const nextIndex = buildReferralPeriods(conflictRows);
  const hasConflict = affectedMonths.some(
    (month) =>
      resolveReferralForMonth(nextIndex.byCreator.get(creatorId), month).conflicts
        .length > 0,
  );

  const blocks: ReferralChangeBlockReason[] = [];
  if (finalizedMonths.length > 0) blocks.push("settlement_finalized");
  if (claimedItemCount > 0) blocks.push("reward_claimed");
  if (paidItemCount > 0) blocks.push("reward_paid");
  if (hasConflict) blocks.push("referral_period_conflict");

  return {
    creatorId,
    tiktokId,
    action,
    previousReferrerId,
    previousReferrerName: previousReferrerId
      ? referrerNameById.get(previousReferrerId) ?? "（不明な紹介者）"
      : null,
    previousStartMonth,
    previousEndMonth,
    referrerId,
    referrerName: referrerId
      ? referrerNameById.get(referrerId) ?? "（不明な紹介者）"
      : null,
    startMonth: referrerId ? startMonth : null,
    affectedStartMonth,
    affectedEndMonth,
    affectedMonths,
    tapItemCount,
    tapThreeRevenue,
    /*
      参考値。正式な計算は referral-reward-engine が明細ごとに行う。
      ここでは合計へ率を掛けるだけなので、実際の再集計とは端数が
      わずかに違いうる。画面にも「参考値」と出す。
    */
    estimatedReferralReward:
      Math.round(tapThreeRevenue * REFERRAL_REWARD_RATE * 100) / 100,
    affiliateItemCount: affiliateMonths.filter((month) => inAffected(month)).length,
    finalizedMonths,
    claimedItemCount,
    paidItemCount,
    firstTapMonth: tapMonths.length > 0 ? tapMonths.slice().sort()[0] : null,
    firstAffiliateMonth:
      affiliateMonths.length > 0 ? affiliateMonths.slice().sort()[0] : null,
    blocks,
    error: null,
  };
}

/** 変更を保存してよいか（ブロックが1つも無いこと） */
export function canApplyReferralChange(plan: ReferralChangePlan): boolean {
  return plan.error == null && plan.blocks.length === 0;
}

/** ブロック理由を人が読める形にする */
export function describeReferralChangeBlocks(
  plan: ReferralChangePlan,
): string {
  return plan.blocks
    .map((reason) => REFERRAL_CHANGE_BLOCK_LABEL[reason])
    .join(" / ");
}
