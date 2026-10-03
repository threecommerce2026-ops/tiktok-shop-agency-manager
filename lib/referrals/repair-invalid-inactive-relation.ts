import type { SupabaseClient } from "@supabase/supabase-js";

import { fetchAllFrom } from "@/lib/db/paged-select";
import { isValidTargetMonth } from "@/lib/referrals/referral-reward-engine";
import { fetchFinalizedReferralMonths } from "@/lib/referrals/settlement-sync-guard";
import { isTapReferralSourceLine } from "@/lib/referrals/tap-referral-source";
import {
  buildReferralPeriods,
  resolveReferralForMonth,
  REFERRAL_RELATION_COLUMNS,
  type ReferralRelationRow,
} from "@/lib/referrals/referral-period";

/*
  有効期間を持たない無効 relation の修復。

  ■ 何を直すのか
  紹介者を付け替えると linkCreatorToReferrer が旧関係を無効化し、
  end_month に「新しい開始月の前月」を記録する。
  旧関係と新関係の start_month が同じ月だと end_month が start_month より
  前になり、自己矛盾した行が残る。

  実例（2026-10-03）: odebu888 の「-」関係が
    start_month = 2026-05 / end_month = 2026-04 / is_active = false
  になっていた。buildReferralPeriods はこれを「同月に始まる後続」として
  扱うため、本来正しい（株）3 の関係まで superseded として潰され、
  2026-05〜06 の紹介者が解決されなかった。

  ■ 直し方
  end_month を null へ戻すだけ。
  is_active = false かつ end_month = null は referral-period.ts の
  isUsableForPeriod が既に「誤登録」として期間計算から除外する形なので、
  新しい状態を増やさない。

  start_month は変えない（履歴の捏造になる）。行も消さない（監査が壊れる）。
  紹介者も変えない。

  ■ 対象を極端に狭める
  canRepairRelation が true になるのは
    is_active = false
    かつ end_month != null
    かつ end_month < start_month
  の行だけ。これ以外は一切変更できない。

  ■ 一括修復はしない
  同種の行が他にあっても、1 件ずつ plan を見て確定する。
  紹介報酬の帰属が変わる操作なので、まとめて流さない。
*/

export const REPAIR_ACTION = "repair_invalid_inactive_relation" as const;

export const REPAIR_REASON =
  "invalid inactive referral relation created by prior reassignment" as const;

export type RelationRepairBlockReason =
  | "not_inactive"
  | "end_month_missing"
  | "end_month_not_before_start"
  | "settlement_finalized"
  | "reward_claimed"
  | "reward_paid";

export const RELATION_REPAIR_BLOCK_LABEL: Record<
  RelationRepairBlockReason,
  string
> = {
  not_inactive: "有効な関係は修復対象外です",
  end_month_missing: "終了月が無い関係は修復不要です",
  end_month_not_before_start: "終了月が開始月以降なので異常ではありません",
  settlement_finalized: "確定済みの月に影響します",
  reward_claimed: "支払明細に組み入れ済みの紹介報酬に影響します",
  reward_paid: "支払済みの紹介報酬に影響します",
};

export type RelationRepairCandidate = {
  relationId: string;
  creatorId: string;
  tiktokId: string;
  creatorName: string;
  referrerId: string | null;
  referrerName: string | null;
  startMonth: string;
  endMonth: string | null;
  isActive: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

export type RelationRepairPlan = {
  candidate: RelationRepairCandidate | null;
  /** 修復で紹介報酬の判定が変わりうる月 */
  affectedMonths: string[];
  /** 修復前/修復後に、その月が誰に解決されるか */
  resolutionBefore: Array<{ targetMonth: string; referrerName: string | null }>;
  resolutionAfter: Array<{ targetMonth: string; referrerName: string | null }>;
  finalizedMonths: string[];
  claimedItemCount: number;
  paidItemCount: number;
  blocks: RelationRepairBlockReason[];
  error: string | null;
};

const EMPTY_PLAN: RelationRepairPlan = {
  candidate: null,
  affectedMonths: [],
  resolutionBefore: [],
  resolutionAfter: [],
  finalizedMonths: [],
  claimedItemCount: 0,
  paidItemCount: 0,
  blocks: [],
  error: null,
};

type RelationRow = ReferralRelationRow & {
  id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

/**
 * 修復できる形かどうか。ここが対象判定の唯一の入口。
 *
 * 呼び出し側でこの条件を書き直さないこと
 * （広げると履歴の改変になりうる）。
 */
export function canRepairRelation(row: {
  is_active?: boolean | null;
  start_month?: string | null;
  end_month?: string | null;
}): boolean {
  return repairBlocksOf(row).length === 0;
}

/** 形の面でのブロック理由（支払・確定は含まない） */
export function repairBlocksOf(row: {
  is_active?: boolean | null;
  start_month?: string | null;
  end_month?: string | null;
}): RelationRepairBlockReason[] {
  const blocks: RelationRepairBlockReason[] = [];

  if (row.is_active !== false) blocks.push("not_inactive");

  const start = String(row.start_month ?? "");
  const end = row.end_month == null ? null : String(row.end_month);

  if (end == null || end === "") {
    blocks.push("end_month_missing");
    return blocks;
  }

  if (!isValidTargetMonth(start) || !isValidTargetMonth(end)) {
    /* 月形式が壊れている行はこの経路では触らない */
    blocks.push("end_month_not_before_start");
    return blocks;
  }

  if (!(end < start)) blocks.push("end_month_not_before_start");

  return blocks;
}

export function canApplyRelationRepair(plan: RelationRepairPlan): boolean {
  return plan.error == null && plan.candidate != null && plan.blocks.length === 0;
}

export function describeRelationRepairBlocks(plan: RelationRepairPlan): string {
  return plan.blocks
    .map((reason) => RELATION_REPAIR_BLOCK_LABEL[reason])
    .join(" / ");
}

/**
 * Production に存在する「有効期間を持たない無効 relation」を全件列挙する
 * （読み取りのみ）。
 *
 * 一括修復はしない。1 件ずつ plan を見て確定させるための一覧。
 */
export async function listInvalidInactiveRelations(
  supabase: SupabaseClient,
): Promise<{ rows: RelationRepairCandidate[]; error: string | null }> {
  const [relResult, creatorsResult, referrersResult] = await Promise.all([
    fetchAllFrom<RelationRow>(
      supabase,
      "creator_referrals",
      `id, ${REFERRAL_RELATION_COLUMNS}, updated_at`,
    ),
    fetchAllFrom<{ id: string; tiktok_id: string | null; creator_name: string | null }>(
      supabase,
      "creators",
      "id, tiktok_id, creator_name",
    ),
    fetchAllFrom<{ id: string; name: string | null }>(
      supabase,
      "referrers",
      "id, name",
    ),
  ]);

  const error = relResult.error ?? creatorsResult.error ?? referrersResult.error;
  if (error) return { rows: [], error };

  const creatorById = new Map(creatorsResult.data.map((c) => [c.id, c]));
  const referrerById = new Map(referrersResult.data.map((r) => [r.id, r]));

  const rows = relResult.data
    .filter((row) => canRepairRelation(row))
    .map((row) => toCandidate(row, creatorById, referrerById))
    .sort(
      (a, b) =>
        a.tiktokId.localeCompare(b.tiktokId) ||
        a.startMonth.localeCompare(b.startMonth),
    );

  return { rows, error: null };
}

function toCandidate(
  row: RelationRow,
  creatorById: Map<string, { tiktok_id: string | null; creator_name: string | null }>,
  referrerById: Map<string, { name: string | null }>,
): RelationRepairCandidate {
  const creator = creatorById.get(String(row.creator_id ?? ""));
  const referrer = row.referrer_id ? referrerById.get(row.referrer_id) : undefined;

  return {
    relationId: String(row.id ?? ""),
    creatorId: String(row.creator_id ?? ""),
    tiktokId: String(creator?.tiktok_id ?? ""),
    creatorName: String(creator?.creator_name ?? ""),
    referrerId: row.referrer_id ?? null,
    referrerName: referrer?.name == null ? null : String(referrer.name),
    startMonth: String(row.start_month ?? ""),
    endMonth: row.end_month == null ? null : String(row.end_month),
    isActive: row.is_active === true,
    createdAt: row.created_at == null ? null : String(row.created_at),
    updatedAt: row.updated_at == null ? null : String(row.updated_at),
  };
}

/**
 * 修復前のプレビュー。
 *
 * ・対象が修復できる形か
 * ・どの月の紹介者判定が変わるか（修復前後の解決結果）
 * ・確定済み / 支払済み / 支払予定中に当たらないか
 *
 * ここでは一切書き込まない。
 */
export async function buildRelationRepairPlan(
  supabase: SupabaseClient,
  relationId: string,
): Promise<RelationRepairPlan> {
  if (!relationId.trim()) {
    return { ...EMPTY_PLAN, error: "対象の関係 ID を指定してください" };
  }

  const { data: target, error: targetError } = await supabase
    .from("creator_referrals")
    .select(`id, ${REFERRAL_RELATION_COLUMNS}, updated_at`)
    .eq("id", relationId)
    .maybeSingle();

  if (targetError) return { ...EMPTY_PLAN, error: targetError.message };
  if (!target) return { ...EMPTY_PLAN, error: "対象の関係が見つかりません" };

  const creatorId = String((target as RelationRow).creator_id ?? "");

  const [creatorsResult, referrersResult, relResult, linesResult, rewardResult] =
    await Promise.all([
      fetchAllFrom<{ id: string; tiktok_id: string | null; creator_name: string | null }>(
        supabase,
        "creators",
        "id, tiktok_id, creator_name",
        (query) => query.eq("id", creatorId),
      ),
      fetchAllFrom<{ id: string; name: string | null }>(
        supabase,
        "referrers",
        "id, name",
      ),
      fetchAllFrom<RelationRow>(
        supabase,
        "creator_referrals",
        `id, ${REFERRAL_RELATION_COLUMNS}, updated_at`,
        (query) => query.eq("creator_id", creatorId),
      ),
      fetchAllFrom<{
        source_row_key: string | null;
        creator_id: string | null;
        target_month: string | null;
        commission_base: number | string | null;
        payment_status: string | null;
        order_status: string | null;
        refund_status: string | null;
      }>(
        supabase,
        "tap_affiliate_order_lines",
        "source_row_key, creator_id, target_month, commission_base, payment_status, order_status, refund_status",
        (query) => query.eq("creator_id", creatorId),
      ),
      fetchAllFrom<{
        target_month: string;
        is_paid: boolean;
        payout_id: string | null;
        payment_batch_id: string | null;
      }>(
        supabase,
        "referral_reward_items",
        "target_month, is_paid, payout_id, payment_batch_id",
        (query) => query.eq("creator_id", creatorId),
      ),
    ]);

  const loadError =
    creatorsResult.error ??
    referrersResult.error ??
    relResult.error ??
    linesResult.error ??
    rewardResult.error ??
    null;
  if (loadError) return { ...EMPTY_PLAN, error: loadError };

  const creatorById = new Map(creatorsResult.data.map((c) => [c.id, c]));
  const referrerById = new Map(referrersResult.data.map((r) => [r.id, r]));
  const candidate = toCandidate(target as RelationRow, creatorById, referrerById);

  const blocks = repairBlocksOf(target as RelationRow);

  /*
    修復で判定が変わりうる月。

    対象関係の開始月以降の TAP 対象月を見る。
    end_month を外すと期間の境界が変わるため、それより前の月は動かない。
  */
  const tapMonths = [
    ...new Set(
      linesResult.data
        .filter((line) =>
          isTapReferralSourceLine({ ...line, order_id: null, product_id: null }),
        )
        .map((line) => String(line.target_month ?? ""))
        .filter((month) => isValidTargetMonth(month)),
    ),
  ].sort();

  const affectedMonths = tapMonths.filter(
    (month) => month >= candidate.startMonth,
  );

  /* 修復前後の解決結果を正式エンジンで出す（ここで判定を書き直さない） */
  const rowsBefore = relResult.data;
  const rowsAfter = relResult.data.map((row) =>
    String(row.id ?? "") === relationId ? { ...row, end_month: null } : row,
  );

  const resolve = (rows: RelationRow[]) => {
    const index = buildReferralPeriods(rows);
    const periods = index.byCreator.get(creatorId);
    return affectedMonths.map((targetMonth) => {
      const resolution = resolveReferralForMonth(periods, targetMonth);
      const referrerId = resolution.period?.referrerId ?? null;
      return {
        targetMonth,
        referrerName:
          referrerId == null
            ? null
            : (referrerById.get(referrerId)?.name ?? referrerId),
      };
    });
  };

  const finalized = await fetchFinalizedReferralMonths(supabase);
  if (finalized.error) return { ...EMPTY_PLAN, candidate, error: finalized.error };

  const finalizedMonths = affectedMonths.filter((month) =>
    finalized.months.has(month),
  );

  const affectedSet = new Set(affectedMonths);
  let claimedItemCount = 0;
  let paidItemCount = 0;

  for (const item of rewardResult.data) {
    if (!affectedSet.has(item.target_month)) continue;
    if (item.is_paid) paidItemCount += 1;
    else if (item.payout_id != null || item.payment_batch_id != null) {
      claimedItemCount += 1;
    }
  }

  if (finalizedMonths.length > 0) blocks.push("settlement_finalized");
  if (claimedItemCount > 0) blocks.push("reward_claimed");
  if (paidItemCount > 0) blocks.push("reward_paid");

  return {
    candidate,
    affectedMonths,
    resolutionBefore: resolve(rowsBefore),
    resolutionAfter: resolve(rowsAfter),
    finalizedMonths,
    claimedItemCount,
    paidItemCount,
    blocks,
    error: null,
  };
}

export type RelationRepairResult =
  | { ok: true; relationId: string }
  | { ok: false; error: string };

/**
 * 修復を実行する。end_month を null へ戻すだけ。
 *
 * ・plan を必ず渡す（プレビューを経ない実行をさせない）
 * ・条件を満たす 1 行だけを対象にする（WHERE で二重に絞る）
 * ・creator_referral_logs へ履歴を残す
 *
 * RPC 実行用のクライアント（auth.uid() が必要）で呼ぶこと。
 */
export async function repairInvalidInactiveReferralRelation(
  supabase: SupabaseClient,
  params: {
    plan: RelationRepairPlan;
    actorId: string;
    actorEmail: string | null;
    note?: string | null;
  },
): Promise<RelationRepairResult> {
  const { plan, actorId, actorEmail } = params;

  if (!canApplyRelationRepair(plan) || !plan.candidate) {
    return {
      ok: false,
      error:
        plan.error ??
        `この関係は修復できません（${describeRelationRepairBlocks(plan)}）`,
    };
  }

  if (!actorId) {
    return { ok: false, error: "操作者が特定できません" };
  }

  const candidate = plan.candidate;

  /*
    更新は条件を満たす 1 行だけ。

    plan を作ってから実行するまでに行が変わっている可能性があるため、
    is_active / end_month / start_month を WHERE でもう一度確かめる。
    別の形になっていれば 0 行更新になり、取り違えて書き換えることがない。
  */
  const { data: updated, error: updateError } = await supabase
    .from("creator_referrals")
    .update({ end_month: null, updated_at: new Date().toISOString() })
    .eq("id", candidate.relationId)
    .eq("is_active", false)
    .eq("start_month", candidate.startMonth)
    .eq("end_month", candidate.endMonth as string)
    .select("id");

  if (updateError) return { ok: false, error: updateError.message };

  if ((updated ?? []).length === 0) {
    return {
      ok: false,
      error:
        "対象の関係が想定した状態ではありませんでした（他の操作で変更された可能性があります）。もう一度プレビューしてください。",
    };
  }

  /*
    履歴を残す。

    紹介者そのものは変えないので referrer_id は変更前と同じ値を入れる。
    変更前後の違いは end_month（previous_end_month → end_month=null）で表す。
    履歴の書き込みに失敗しても関係の修復は成功しているので、
    ここでエラーを返して「失敗した」と思わせない。監査の抜けとして扱う。
  */
  await supabase.from("creator_referral_logs").insert({
    creator_id: candidate.creatorId,
    action: REPAIR_ACTION,
    previous_referrer_id: candidate.referrerId,
    previous_start_month: candidate.startMonth,
    previous_end_month: candidate.endMonth,
    referrer_id: candidate.referrerId,
    start_month: candidate.startMonth,
    end_month: null,
    affected_start_month: plan.affectedMonths[0] ?? null,
    affected_end_month: plan.affectedMonths[plan.affectedMonths.length - 1] ?? null,
    note: params.note ?? REPAIR_REASON,
    changed_by: actorId,
    changed_by_email: actorEmail,
  });

  return { ok: true, relationId: candidate.relationId };
}
