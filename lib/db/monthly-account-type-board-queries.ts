import type { SupabaseClient } from "@supabase/supabase-js";

import { fetchAllFrom } from "@/lib/db/paged-select";
import {
  normalizeAccountManagementType,
  type AccountManagementType,
} from "@/lib/creators/account-management-type";
import {
  MONTHLY_ACCOUNT_TYPE_TABLE,
  resolveMonthlyAccountManagementType,
  type AccountManagementTypeSource,
} from "@/lib/creators/monthly-account-management-type";
import { isTapReferralSourceLine } from "@/lib/referrals/tap-referral-source";
import {
  referralBaseAmount,
  resolveReferralRate,
  sumReferralAmounts,
} from "@/lib/referrals/referral-reward-engine";
import {
  buildReferralPeriods,
  resolveReferralForMonth,
  REFERRAL_RELATION_COLUMNS,
  type ReferralRelationRow,
} from "@/lib/referrals/referral-period";

/*
  月別クリエイター区分ボード（クリエイター × 対象月の一覧）。

  ・1行 = クリエイター × 対象月
  ・母集団は紹介報酬と同じ正式条件（isTapReferralSourceLine）
  ・区分は monthly-account-management-type の優先順位で判定する
    （① 月別確定 → ② creators の現在区分）

  ■ 現在区分を自動で確定はしない
  埋めるのも確定するのも管理者の明示操作だけ。
  creator_master_change_logs の変更日時から過去区分を推測することは
  しない（2026-10-03 確定の業務ルール）。今回 9 月末に行った区分変更は
  実運用の変更日ではなくマスタ訂正なので、変更日を境に過去を
  別の区分として扱うのは誤り。現在区分が対象月の月初から正しい。

  ■ 紹介報酬は再計算しない
  区分を確定しても referral_reward_items は動かない。
  この画面は確定だけを行い、再計算は別操作に委ねる。
  影響額は「再計算プレビュー」として読み取りのみで出す。
*/

export type MonthlyAccountTypeBoardRow = {
  creatorId: string;
  creatorName: string;
  tiktokId: string;
  targetMonth: string;
  /** クリエイターマスタの現在区分 */
  currentType: AccountManagementType;
  /** 月別確定として保存されている区分。無ければ null */
  monthlyType: AccountManagementType | null;
  /** その月に適用される区分（月別確定 → 現在区分） */
  effectiveType: AccountManagementType;
  source: AccountManagementTypeSource;
  /** その月が紹介報酬5%の対象か */
  referralEligible: boolean;
  /** 紹介報酬の算定元（W + X） */
  referralBase: number;
  lineCount: number;
  /** 紹介報酬の実績（referral_reward_items） */
  rewardAmount: number;
  rewardItemCount: number;
  /**
   * 支払済み・支払予定中の紹介報酬があるか。
   * あれば確定処理が拒否する（既存ガード）。
   */
  hasPaidReward: boolean;
  /** 月次確定（finalized）済みの月か。あれば再計算できない */
  settlementFinalized: boolean;
  /** その月に有効な紹介関係があるか（再計算プレビューに使う） */
  hasReferrer: boolean;
  /** その月の料率（紹介関係から。無ければ既定） */
  referralRate: number;
};

export type MonthlyAccountTypeBoardData = {
  rows: MonthlyAccountTypeBoardRow[];
  months: string[];
  totals: {
    rowCount: number;
    creatorCount: number;
    confirmedCount: number;
    provisionalCount: number;
    lockedCount: number;
    /** 区分別の行数（確定済み + 暫定の合計） */
    standardCount: number;
    selfOperatedCount: number;
    accountLendingCount: number;
  };
  /*
    紹介報酬の再計算プレビュー（読み取りのみ）。
    この画面からは実行しない。
  */
  rewardPreview: {
    beforeItemCount: number;
    beforeAmount: number;
    afterItemCount: number;
    afterAmount: number;
    /** creator 別の差額（0 のものは含めない） */
    changes: Array<{
      tiktokId: string;
      creatorName: string;
      beforeAmount: number;
      afterAmount: number;
      diff: number;
    }>;
  };
  error: string | null;
};

const EMPTY_PREVIEW: MonthlyAccountTypeBoardData["rewardPreview"] = {
  beforeItemCount: 0,
  beforeAmount: 0,
  afterItemCount: 0,
  afterAmount: 0,
  changes: [],
};

type TapLine = {
  source_row_key: string | null;
  creator_id: string | null;
  target_month: string | null;
  commission_base: number | string | null;
  partner_estimated_commission: number | string | null;
  partner_shop_ads_estimated_commission: number | string | null;
  payment_status: string | null;
  order_status: string | null;
  refund_status: string | null;
};

type RewardItem = {
  creator_id: string;
  target_month: string;
  reward_amount: number | string | null;
  adjusted_reward_amount: number | string | null;
  is_reward_target: boolean;
  is_paid: boolean;
  payout_id: string | null;
  payment_batch_id: string | null;
};

function toNumber(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rewardItemAmount(item: RewardItem): number {
  if (item.adjusted_reward_amount != null) {
    const adjusted = Number(item.adjusted_reward_amount);
    if (Number.isFinite(adjusted)) return adjusted;
  }
  return toNumber(item.reward_amount);
}

function pairKey(creatorId: string, targetMonth: string): string {
  return `${creatorId}|${targetMonth}`;
}

export async function fetchMonthlyAccountTypeBoard(
  supabase: SupabaseClient,
): Promise<MonthlyAccountTypeBoardData> {
  const empty: MonthlyAccountTypeBoardData = {
    rows: [],
    months: [],
    totals: {
      rowCount: 0,
      creatorCount: 0,
      confirmedCount: 0,
      provisionalCount: 0,
      lockedCount: 0,
      standardCount: 0,
      selfOperatedCount: 0,
      accountLendingCount: 0,
    },
    rewardPreview: EMPTY_PREVIEW,
    error: null,
  };

  const [linesResult, creatorsResult, monthlyResult, rewardResult, referralsResult] =
    await Promise.all([
      fetchAllFrom<TapLine>(
        supabase,
        "tap_affiliate_order_lines",
        "source_row_key, creator_id, target_month, commission_base, partner_estimated_commission, partner_shop_ads_estimated_commission, payment_status, order_status, refund_status",
      ),
      fetchAllFrom<{
        id: string;
        tiktok_id: string | null;
        creator_name: string | null;
        account_management_type: string | null;
      }>(
        supabase,
        "creators",
        "id, tiktok_id, creator_name, account_management_type",
      ),
      fetchAllFrom<{
        creator_id: string;
        target_month: string;
        account_management_type: string | null;
      }>(
        supabase,
        MONTHLY_ACCOUNT_TYPE_TABLE,
        "creator_id, target_month, account_management_type",
      ),
      fetchAllFrom<RewardItem>(
        supabase,
        "referral_reward_items",
        "creator_id, target_month, reward_amount, adjusted_reward_amount, is_reward_target, is_paid, payout_id, payment_batch_id",
      ),
      fetchAllFrom<ReferralRelationRow>(
        supabase,
        "creator_referrals",
        REFERRAL_RELATION_COLUMNS,
      ),
    ]);

  const loadError =
    linesResult.error ??
    creatorsResult.error ??
    monthlyResult.error ??
    rewardResult.error ??
    referralsResult.error ??
    null;

  if (loadError) return { ...empty, error: loadError };

  /*
    月次確定済みの月は紹介報酬を再計算できない。
    referral_month_settlements は authenticated / service_role に
    SELECT が grant されていないため、既存 RPC 経由で読む。
    読めない場合は空集合として扱い、画面の表示だけを控えめにする
    （確定処理そのもののガードは確定側が持っている）。
  */
  const finalizedMonths = new Set<string>();
  const settlements = await supabase.rpc("list_referral_month_settlements");
  if (!settlements.error) {
    for (const row of (settlements.data ?? []) as Array<{
      target_month?: string | null;
      status?: string | null;
    }>) {
      if (String(row?.status ?? "").trim() === "finalized") {
        finalizedMonths.add(String(row?.target_month ?? ""));
      }
    }
  }

  const creatorById = new Map<
    string,
    { tiktokId: string; creatorName: string; currentType: AccountManagementType }
  >();
  for (const row of creatorsResult.data) {
    creatorById.set(row.id, {
      tiktokId: String(row.tiktok_id ?? ""),
      creatorName: String(row.creator_name ?? ""),
      currentType: normalizeAccountManagementType(row.account_management_type),
    });
  }

  const monthlyByPair = new Map<string, AccountManagementType>();
  for (const row of monthlyResult.data) {
    const type = String(row.account_management_type ?? "").trim();
    if (!type) continue;
    monthlyByPair.set(
      pairKey(row.creator_id, row.target_month),
      normalizeAccountManagementType(type),
    );
  }

  /*
    母集団は紹介報酬と同じ正式条件。
    条件をここに書き写さない（報酬側と食い違う元になる）。
  */
  const baseByPair = new Map<string, { base: number[]; lines: number }>();
  for (const line of linesResult.data) {
    if (!line.creator_id || !line.target_month) continue;
    if (!isTapReferralSourceLine({ ...line, order_id: null, product_id: null })) {
      continue;
    }
    const key = pairKey(line.creator_id, line.target_month);
    const current = baseByPair.get(key) ?? { base: [], lines: 0 };
    current.base.push(referralBaseAmount(line));
    current.lines += 1;
    baseByPair.set(key, current);
  }

  const rewardByPair = new Map<
    string,
    { amounts: number[]; items: number; locked: boolean }
  >();
  for (const item of rewardResult.data) {
    if (!item.is_reward_target) continue;
    const key = pairKey(item.creator_id, item.target_month);
    const current =
      rewardByPair.get(key) ?? { amounts: [], items: 0, locked: false };
    current.amounts.push(rewardItemAmount(item));
    current.items += 1;
    if (item.is_paid || item.payout_id != null || item.payment_batch_id != null) {
      current.locked = true;
    }
    rewardByPair.set(key, current);
  }

  const referralIndex = buildReferralPeriods(referralsResult.data);

  const rows: MonthlyAccountTypeBoardRow[] = [];
  const months = new Set<string>();
  const creators = new Set<string>();

  for (const [key, base] of baseByPair) {
    const [creatorId, targetMonth] = key.split("|");
    const creator = creatorById.get(creatorId);
    if (!creator) continue;

    const resolved = resolveMonthlyAccountManagementType({
      creatorId,
      targetMonth,
      monthlyType: monthlyByPair.get(key) ?? null,
      currentType: creator.currentType,
    });

    const reward = rewardByPair.get(key) ?? { amounts: [], items: 0, locked: false };
    const relation = resolveReferralForMonth(
      referralIndex.byCreator.get(creatorId),
      targetMonth,
    );

    months.add(targetMonth);
    creators.add(creatorId);

    rows.push({
      creatorId,
      creatorName: creator.creatorName,
      tiktokId: creator.tiktokId,
      targetMonth,
      currentType: creator.currentType,
      monthlyType: monthlyByPair.get(key) ?? null,
      effectiveType: resolved.accountManagementType,
      source: resolved.source,
      referralEligible: resolved.accountManagementType === "standard",
      referralBase: sumReferralAmounts(base.base),
      lineCount: base.lines,
      rewardAmount: sumReferralAmounts(reward.amounts),
      rewardItemCount: reward.items,
      hasPaidReward: reward.locked,
      settlementFinalized: finalizedMonths.has(targetMonth),
      hasReferrer: relation.period?.referrerId != null,
      referralRate: resolveReferralRate(relation.period?.referralRate),
    });
  }

  rows.sort(
    (a, b) =>
      a.tiktokId.localeCompare(b.tiktokId) ||
      a.targetMonth.localeCompare(b.targetMonth),
  );

  return {
    rows,
    months: [...months].sort(),
    totals: {
      rowCount: rows.length,
      creatorCount: creators.size,
      confirmedCount: rows.filter((row) => row.source === "monthly").length,
      provisionalCount: rows.filter((row) => row.source === "current").length,
      lockedCount: rows.filter((row) => row.hasPaidReward).length,
      standardCount: rows.filter((row) => row.effectiveType === "standard").length,
      selfOperatedCount: rows.filter((row) => row.effectiveType === "self_operated")
        .length,
      accountLendingCount: rows.filter(
        (row) => row.effectiveType === "account_lending",
      ).length,
    },
    rewardPreview: buildRewardPreview(rows, rewardResult.data),
    error: null,
  };
}

/*
  紹介報酬の再計算プレビュー。

  いまの区分判定で sync を実行したらどうなるかを読み取りだけで出す。
  実際の生成は sync が行う。この画面からは実行しない。

  AFTER は「その月の区分が standard かつ紹介関係がある行」に
  算定元 × 料率を掛けたもの。sync と同じ条件を使う。
*/
export function buildRewardPreview(
  rows: MonthlyAccountTypeBoardRow[],
  rewardItems: Array<Pick<RewardItem, "creator_id" | "is_reward_target">>,
): MonthlyAccountTypeBoardData["rewardPreview"] {
  const byCreator = new Map<
    string,
    { tiktokId: string; creatorName: string; before: number[]; after: number[] }
  >();

  let beforeItemCount = 0;
  let afterItemCount = 0;

  for (const item of rewardItems) {
    if (item.is_reward_target) beforeItemCount += 1;
  }

  for (const row of rows) {
    const current =
      byCreator.get(row.creatorId) ??
      {
        tiktokId: row.tiktokId,
        creatorName: row.creatorName,
        before: [] as number[],
        after: [] as number[],
      };

    current.before.push(row.rewardAmount);

    if (row.effectiveType === "standard" && row.hasReferrer) {
      current.after.push(row.referralBase * row.referralRate);
      afterItemCount += row.lineCount;
    }

    byCreator.set(row.creatorId, current);
  }

  const changes: MonthlyAccountTypeBoardData["rewardPreview"]["changes"] = [];
  const beforeAmounts: number[] = [];
  const afterAmounts: number[] = [];

  for (const entry of byCreator.values()) {
    const before = sumReferralAmounts(entry.before);
    const after = sumReferralAmounts(entry.after);
    beforeAmounts.push(before);
    afterAmounts.push(after);

    const diff = sumReferralAmounts([after, -before]);
    if (diff !== 0) {
      changes.push({
        tiktokId: entry.tiktokId,
        creatorName: entry.creatorName,
        beforeAmount: before,
        afterAmount: after,
        diff,
      });
    }
  }

  changes.sort((a, b) => a.diff - b.diff);

  return {
    beforeItemCount,
    beforeAmount: sumReferralAmounts(beforeAmounts),
    afterItemCount,
    afterAmount: sumReferralAmounts(afterAmounts),
    changes,
  };
}
