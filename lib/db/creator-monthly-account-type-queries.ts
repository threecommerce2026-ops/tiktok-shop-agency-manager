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
import { referralBaseAmount } from "@/lib/referrals/referral-reward-engine";
import { sumReferralAmounts } from "@/lib/referrals/referral-reward-engine";

/*
  クリエイター1名の「月別区分」パネル用データ。

  月別所属パネル（creator-monthly-assignment-queries.ts）と同じ形で、
    ・対象月（TAP の対象行がある月 + 月別確定がある月）
    ・適用される区分と、それが確定か暫定か
    ・その月の紹介報酬の算定元（W + X）と実績
  を返す。

  紹介報酬が既に支払われている月は区分を動かせないので、
  支払済みの有無も返す（判定は呼び出し側の確定処理が行う）。
*/

export type CreatorMonthTypeRow = {
  targetMonth: string;
  /** 実際に適用される区分 */
  effectiveType: AccountManagementType;
  /** monthly = 月別確定 / current = 現在区分（暫定） */
  source: AccountManagementTypeSource;
  /** 月別確定として保存されている区分。無ければ null */
  monthlyType: AccountManagementType | null;
  /** その月が紹介報酬5%の対象か */
  referralEligible: boolean;
  /** 紹介報酬の算定元（W + X） */
  referralBase: number;
  lineCount: number;
  /** 紹介報酬の実績（referral_reward_items） */
  rewardAmount: number;
  rewardItemCount: number;
  /** 支払済み（is_paid / payout_id / payment_batch_id）の紹介報酬があるか */
  hasPaidReward: boolean;
  paidRewardAmount: number;
};

export type CreatorMonthlyAccountTypeData = {
  creatorId: string;
  creatorName: string;
  tiktokId: string;
  /** creators.account_management_type（現在値） */
  currentType: AccountManagementType;
  rows: CreatorMonthTypeRow[];
  error: string | null;
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
  target_month: string;
  reward_amount: number | string | null;
  adjusted_reward_amount: number | string | null;
  is_reward_target: boolean;
  is_paid: boolean;
  payout_id: string | null;
  payment_batch_id: string | null;
};

function toAmount(value: number | string | null): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rewardItemAmount(item: RewardItem): number {
  const adjusted = Number(item.adjusted_reward_amount);
  if (Number.isFinite(adjusted) && item.adjusted_reward_amount != null) {
    return adjusted;
  }
  return toAmount(item.reward_amount);
}

export async function fetchCreatorMonthlyAccountTypes(
  supabase: SupabaseClient,
  creatorId: string,
): Promise<CreatorMonthlyAccountTypeData> {
  const empty: CreatorMonthlyAccountTypeData = {
    creatorId,
    creatorName: "",
    tiktokId: "",
    currentType: "standard",
    rows: [],
    error: null,
  };

  const [creatorResult, monthlyResult, linesResult, rewardResult] =
    await Promise.all([
      supabase
        .from("creators")
        .select("id, creator_name, tiktok_id, account_management_type")
        .eq("id", creatorId)
        .maybeSingle(),
      fetchAllFrom<{ target_month: string; account_management_type: string | null }>(
        supabase,
        MONTHLY_ACCOUNT_TYPE_TABLE,
        "target_month, account_management_type",
        (query) => query.eq("creator_id", creatorId),
      ),
      fetchAllFrom<TapLine>(
        supabase,
        "tap_affiliate_order_lines",
        "source_row_key, creator_id, target_month, commission_base, partner_estimated_commission, partner_shop_ads_estimated_commission, payment_status, order_status, refund_status",
        (query) => query.eq("creator_id", creatorId),
      ),
      fetchAllFrom<RewardItem>(
        supabase,
        "referral_reward_items",
        "target_month, reward_amount, adjusted_reward_amount, is_reward_target, is_paid, payout_id, payment_batch_id",
        (query) => query.eq("creator_id", creatorId),
      ),
    ]);

  if (creatorResult.error) {
    return { ...empty, error: creatorResult.error.message };
  }
  if (!creatorResult.data) {
    return { ...empty, error: "クリエイターが見つかりません" };
  }
  if (monthlyResult.error) return { ...empty, error: monthlyResult.error };
  if (linesResult.error) return { ...empty, error: linesResult.error };
  if (rewardResult.error) return { ...empty, error: rewardResult.error };

  const creator = creatorResult.data;
  const currentType = normalizeAccountManagementType(
    creator.account_management_type,
  );

  const monthlyByMonth = new Map<string, AccountManagementType>();
  for (const row of monthlyResult.data) {
    const type = String(row.account_management_type ?? "").trim();
    if (!type) continue;
    monthlyByMonth.set(row.target_month, normalizeAccountManagementType(type));
  }

  /*
    対象月の算定元。対象行の判定は既存の正式条件をそのまま呼ぶ
    （ここに条件を書き写すと紹介報酬側と食い違う）。
  */
  const baseByMonth = new Map<string, { base: number[]; lines: number }>();
  for (const line of linesResult.data) {
    if (!line.target_month) continue;
    if (
      !isTapReferralSourceLine({
        source_row_key: line.source_row_key,
        order_id: null,
        product_id: null,
        creator_id: line.creator_id,
        target_month: line.target_month,
        commission_base: line.commission_base,
        payment_status: line.payment_status,
        order_status: line.order_status,
        refund_status: line.refund_status,
      })
    ) {
      continue;
    }

    const current = baseByMonth.get(line.target_month) ?? { base: [], lines: 0 };
    current.base.push(referralBaseAmount(line));
    current.lines += 1;
    baseByMonth.set(line.target_month, current);
  }

  const rewardByMonth = new Map<
    string,
    { amounts: number[]; items: number; paid: number[]; hasPaid: boolean }
  >();
  for (const item of rewardResult.data) {
    if (!item.is_reward_target) continue;
    const current =
      rewardByMonth.get(item.target_month) ??
      { amounts: [], items: 0, paid: [], hasPaid: false };
    const amount = rewardItemAmount(item);
    current.amounts.push(amount);
    current.items += 1;

    /*
      支払済み・支払予定中は sync も触らない明細。
      区分を動かすと支払明細のスナップショットと実額がずれるので、
      この月は変更させない。
    */
    if (item.is_paid || item.payout_id != null || item.payment_batch_id != null) {
      current.hasPaid = true;
      current.paid.push(amount);
    }

    rewardByMonth.set(item.target_month, current);
  }

  const months = new Set<string>([
    ...baseByMonth.keys(),
    ...monthlyByMonth.keys(),
    ...rewardByMonth.keys(),
  ]);

  const rows: CreatorMonthTypeRow[] = [...months]
    .sort()
    .map((targetMonth) => {
      const resolved = resolveMonthlyAccountManagementType({
        creatorId,
        targetMonth,
        monthlyType: monthlyByMonth.get(targetMonth) ?? null,
        currentType,
      });

      const base = baseByMonth.get(targetMonth) ?? { base: [], lines: 0 };
      const reward =
        rewardByMonth.get(targetMonth) ??
        { amounts: [], items: 0, paid: [], hasPaid: false };

      return {
        targetMonth,
        effectiveType: resolved.accountManagementType,
        source: resolved.source,
        monthlyType: monthlyByMonth.get(targetMonth) ?? null,
        referralEligible: resolved.accountManagementType === "standard",
        referralBase: sumReferralAmounts(base.base),
        lineCount: base.lines,
        rewardAmount: sumReferralAmounts(reward.amounts),
        rewardItemCount: reward.items,
        hasPaidReward: reward.hasPaid,
        paidRewardAmount: sumReferralAmounts(reward.paid),
      };
    });

  return {
    creatorId,
    creatorName: String(creator.creator_name ?? ""),
    tiktokId: String(creator.tiktok_id ?? ""),
    currentType,
    rows,
    error: null,
  };
}
