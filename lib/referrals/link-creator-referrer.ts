import type { SupabaseClient } from "@supabase/supabase-js";

import { previousMonthOf } from "@/lib/payments/cutoff-month";
import { DEFAULT_REFERRER_LIFETIME_PAYOUT_CAP_YEN } from "@/lib/referrals/cap";
import {
  isValidTargetMonth,
  REFERRAL_REWARD_RATE,
} from "@/lib/referrals/referral-reward-engine";
import type { ReferralChangePlan } from "@/lib/referrals/referral-assignment-change";
import type { AssignmentState } from "@/lib/creators/assignment-state";

/*
  クリエイターと紹介者の紐付けを書き込む唯一の入口。

  紹介者の「現在値」は creators.referred_by_referrer_id（Single Source of Truth）。
  creator_referrals は料率・期間・生涯上限・履歴を保持する。
  片方だけを更新すると報酬が発生しなくなるため、必ずこの関数を経由すること。

  ■ 適用開始月は呼び出し側が必ず決める（2026-09-29 確定）
  以前は startMonth 省略時に currentMonthKey() を使っていたため、
  「登録した月」がそのまま「適用開始月」になっていた。
  過去月から実績のあるクリエイターを後から登録すると、その過去分に
  紹介報酬が付かない（__golden_shark__ が 2026-03 から実績があるのに
  2026-09〜 で登録されていた）。

  暗黙の既定を置くと画面ごとに挙動が変わるので、どの画面からでも
  開始月を明示させる。紹介リンクからの新規登録のように
  「登録月＝開始月」が正しい経路も、呼び出し側でその月を渡す。
*/

export type LinkCreatorReferrerParams = {
  creatorId: string;
  /** null を渡すと紹介者なしにする */
  referrerId: string | null;
  referralRate?: number;
  /**
   * 適用開始月（YYYY-MM）。必須。
   * 紹介者を外す場合（referrerId が null）も、旧関係の終了月を
   * 決めるために「いつから紹介者なしにするか」を渡す。
   */
  startMonth: string;
  endMonth?: string | null;
  /**
   * 確認状態。省略時は referrerId から決める
   * （あり → assigned / なし → unconfirmed）。
   * 管理者が「紹介者なし」を選んだ場合だけ "none" を渡すこと。
   */
  assignmentState?: AssignmentState;
  /**
   * 変更履歴（creator_referral_logs）を残す場合に渡す。
   *
   * 紹介報酬は期間で帰属が決まるので、期間を動かすのは金額を
   * 動かすのと同じ重みがある。所属側（creator_monthly_agency_assignment_logs）
   * と同じ粒度で「誰が・いつ・何月分から・どう変えたか」を残す。
   *
   * 省略した場合は履歴を残さない（紹介リンクからの自動登録など、
   * 操作者が居ない経路のため）。
   */
  log?: {
    plan: ReferralChangePlan;
    actorId: string;
    actorEmail: string | null;
    note?: string | null;
  };
};

export async function linkCreatorToReferrer(
  supabase: SupabaseClient,
  params: LinkCreatorReferrerParams,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { creatorId, referrerId } = params;
  const nowIso = new Date().toISOString();

  if (!isValidTargetMonth(params.startMonth)) {
    return {
      ok: false,
      error: `適用開始月を YYYY-MM 形式で指定してください: ${params.startMonth || "(未指定)"}`,
    };
  }

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
  const startMonth = params.startMonth;
  const endMonth = params.endMonth ?? null;

  /*
    旧紐付けは削除せず無効化する（過去の報酬明細との対応を残すため）。

    このとき end_month に「新しい関係の開始月の前月」を記録する。
    記録しないと「いつまで有効だったか」がどこにも残らず、
    過去月の紹介報酬を出すために後続関係から毎回導出することになる
    （lib/referrals/referral-period.ts の復元処理）。

    紹介者を外す場合も、呼び出し側が「いつから紹介者なしにするか」を
    渡すので、その前月を終了月にできる。以前はここを空にしていたため
    「いつまで有効だったか」が残らず、後続関係から毎回導出していた。
  */
  const deactivation: Record<string, unknown> = {
    is_active: false,
    end_month: previousMonthOf(startMonth),
    updated_at: nowIso,
  };

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
    return writeReferralLog(supabase, params);
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

    if (error) return { ok: false, error: error.message };

    return writeReferralLog(supabase, params);
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

  if (error) return { ok: false, error: error.message };

  return writeReferralLog(supabase, params);
}

/*
  履歴を残す。

  履歴の書き込みに失敗しても関係の更新は成功しているので、
  ここでエラーを返して呼び出し側に「失敗した」と思わせない。
  監査の抜けとして扱い、関係の整合は壊さない。
*/
async function writeReferralLog(
  supabase: SupabaseClient,
  params: LinkCreatorReferrerParams,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const log = params.log;
  if (!log) return { ok: true };

  const { plan } = log;

  await supabase.from("creator_referral_logs").insert({
    creator_id: params.creatorId,
    action: plan.action,
    previous_referrer_id: plan.previousReferrerId,
    previous_start_month: plan.previousStartMonth,
    previous_end_month: plan.previousEndMonth,
    referrer_id: params.referrerId,
    start_month: params.referrerId ? params.startMonth : null,
    end_month: params.endMonth ?? null,
    affected_start_month: plan.affectedStartMonth,
    affected_end_month: plan.affectedEndMonth,
    note: log.note ?? null,
    changed_by: log.actorId,
    changed_by_email: log.actorEmail,
  });

  return { ok: true };
}
