import type { SupabaseClient } from "@supabase/supabase-js";

import { currentMonthKey } from "@/lib/db/dashboard-queries";
import { previousMonthOf } from "@/lib/payments/cutoff-month";
import { DEFAULT_REFERRER_LIFETIME_PAYOUT_CAP_YEN } from "@/lib/referrals/cap";
import { REFERRAL_REWARD_RATE } from "@/lib/referrals/referral-reward-engine";
import type { AssignmentState } from "@/lib/creators/assignment-state";

/*
  クリエイターと紹介者の紐付けを書き込む唯一の入口。

  紹介者の「現在値」は creators.referred_by_referrer_id（Single Source of Truth）。
  creator_referrals は料率・期間・生涯上限・履歴を保持する。
  片方だけを更新すると報酬が発生しなくなるため、必ずこの関数を経由すること。
*/

export type LinkCreatorReferrerParams = {
  creatorId: string;
  /** null を渡すと紹介者なしにする */
  referrerId: string | null;
  referralRate?: number;
  startMonth?: string;
  endMonth?: string | null;
  /**
   * 確認状態。省略時は referrerId から決める
   * （あり → assigned / なし → unconfirmed）。
   * 管理者が「紹介者なし」を選んだ場合だけ "none" を渡すこと。
   */
  assignmentState?: AssignmentState;
};

export async function linkCreatorToReferrer(
  supabase: SupabaseClient,
  params: LinkCreatorReferrerParams,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { creatorId, referrerId } = params;
  const nowIso = new Date().toISOString();

  const assignmentState =
    params.assignmentState ?? (referrerId ? "assigned" : "unconfirmed");

  const { error: creatorError } = await supabase
    .from("creators")
    .update({
      referred_by_referrer_id: referrerId,
      referrer_assignment_state: assignmentState,
      updated_at: nowIso,
    })
    .eq("id", creatorId);

  if (creatorError) {
    return { ok: false, error: creatorError.message };
  }

  const referralRate = params.referralRate ?? REFERRAL_REWARD_RATE;
  const startMonth = params.startMonth ?? currentMonthKey();
  const endMonth = params.endMonth ?? null;

  /*
    旧紐付けは削除せず無効化する（過去の報酬明細との対応を残すため）。

    このとき end_month に「新しい関係の開始月の前月」を記録する。
    記録しないと「いつまで有効だったか」がどこにも残らず、
    過去月の紹介報酬を出すために後続関係から毎回導出することになる
    （lib/referrals/referral-period.ts の復元処理）。

    新しい紹介者が決まっていない場合（referrerId が null）は境界が無いので
    end_month を書かない。ここで無効化した日から推測すると、
    DB に無い事実を作ってしまう。
  */
  const deactivation: Record<string, unknown> = {
    is_active: false,
    updated_at: nowIso,
  };

  if (referrerId) {
    deactivation.end_month = previousMonthOf(startMonth);
  }

  const deactivate = supabase
    .from("creator_referrals")
    .update(deactivation)
    .eq("creator_id", creatorId)
    .eq("is_active", true);

  const { error: deactivateError } = referrerId
    ? await deactivate.neq("referrer_id", referrerId)
    : await deactivate;

  if (deactivateError) {
    return { ok: false, error: deactivateError.message };
  }

  if (!referrerId) {
    return { ok: true };
  }

  const { data: existing, error: existingError } = await supabase
    .from("creator_referrals")
    .select("id")
    .eq("creator_id", creatorId)
    .eq("referrer_id", referrerId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingError) {
    return { ok: false, error: existingError.message };
  }

  if (existing?.id) {
    const { error } = await supabase
      .from("creator_referrals")
      .update({
        referral_rate: referralRate,
        start_month: startMonth,
        end_month: endMonth,
        is_active: true,
        updated_at: nowIso,
      })
      .eq("id", existing.id);

    return error ? { ok: false, error: error.message } : { ok: true };
  }

  const { error } = await supabase.from("creator_referrals").insert({
    creator_id: creatorId,
    referrer_id: referrerId,
    referral_rate: referralRate,
    start_month: startMonth,
    end_month: endMonth,
    is_active: true,
    lifetime_payout_cap: DEFAULT_REFERRER_LIFETIME_PAYOUT_CAP_YEN,
    lifetime_paid_amount: 0,
  });

  return error ? { ok: false, error: error.message } : { ok: true };
}
