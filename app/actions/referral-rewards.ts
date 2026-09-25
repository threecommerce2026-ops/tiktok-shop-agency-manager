"use server";

import { revalidatePath } from "next/cache";

import { requireAdminAction } from "@/lib/db/admin-access";
import { isInHouseReferrer } from "@/lib/referrals/in-house-referrer";
import { currentMonthKey } from "@/lib/db/dashboard-queries";
import { mapSupabaseErrorToJa } from "@/lib/supabase/error-ja";
import {
  markReferralPayoutPaid,
  markReferralPayoutUnpaid,
  syncReferralRewardsForMonth,
} from "@/lib/referrals/sync-referral-rewards";
import {
  expandMonthRange,
  previewReferralRewards,
} from "@/lib/referrals/referral-reward-preview";
import { reconcileReferrerLifetimePaidAmounts } from "@/lib/referrals/reconcile-lifetime-paid";
import {
  isValidRewardYear,
  isValidTargetMonth,
  REFERRAL_PAYOUT_THRESHOLD_YEN,
  sumReferralAmounts,
} from "@/lib/referrals/referral-reward-engine";

export type ReferralActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

function readText(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function revalidateReferralViews() {
  revalidatePath("/revenue");
  revalidatePath("/dashboard");
  revalidatePath("/creators");
  revalidatePath("/admin/referral-payouts");
  revalidatePath("/referrer/dashboard");
}

function formatAmount(value: number): string {
  return value.toLocaleString("ja-JP", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * 対象月（または年内の全月）の紹介者報酬明細を再集計する。
 * source_row_key で冪等。支払い済み明細は書き換えない。
 */
export async function syncReferralRewardsAction(
  _prev: ReferralActionResult | null,
  formData: FormData,
): Promise<ReferralActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const scope = readText(formData, "scope");
  const year = readText(formData, "year");
  const month = readText(formData, "target_month");

  let months: string[] = [];

  if (scope === "year" && isValidRewardYear(year)) {
    months = expandMonthRange(`${year}-01`, `${year}-12`).filter(
      (m) => m <= currentMonthKey(),
    );
  } else if (isValidTargetMonth(month)) {
    months = [month];
  } else {
    months = [currentMonthKey()];
  }

  let upserted = 0;
  let deleted = 0;
  let skippedPaid = 0;
  const amounts: number[] = [];

  for (const targetMonth of months) {
    const result = await syncReferralRewardsForMonth(auth.supabase, targetMonth);
    if (result.error) {
      // migration 未適用のときは原因が分かるように案内する
      if (/source_row_key|reward_year/.test(result.error)) {
        return {
          ok: false,
          error:
            "紹介者報酬テーブルのマイグレーションが未適用です。supabase/migrations/20260916120000_referral_reward_annual_payout.sql を適用してください。",
        };
      }
      return { ok: false, error: mapSupabaseErrorToJa(result.error) };
    }
    upserted += result.upsertedCount;
    deleted += result.deletedCount;
    skippedPaid += result.skippedPaidCount;
    amounts.push(result.monthRewardAmount);
  }

  revalidateReferralViews();

  return {
    ok: true,
    message: `${months[0]}〜${months[months.length - 1]} の紹介者報酬を再集計しました（明細 ${upserted} 件 / 対象外削除 ${deleted} 件 / 支払済据置 ${skippedPaid} 件 / 発生額 ${formatAmount(
      sumReferralAmounts(amounts),
    )} 円）`,
  };
}

/**
 * 年間累積で支払いを確定する。
 * 対象月の支払レコードを作ってから RPC を呼ぶ。
 */
export async function payReferralAnnualAction(
  _prev: ReferralActionResult | null,
  formData: FormData,
): Promise<ReferralActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const referrerId = readText(formData, "referrer_id");
  const targetMonth = readText(formData, "target_month");

  if (!referrerId || !isValidTargetMonth(targetMonth)) {
    return { ok: false, error: "紹介者と対象月を指定してください" };
  }

  /*
    自社（（株）3）は報酬実績として集計するが外部への振込対象ではない。
    画面では支払ボタンを出していないが、サーバー側でも必ず拒否する。
    判定は referrers.is_in_house のみ（名前では判定しない）。
  */
  const { data: referrer, error: referrerError } = await auth.supabase
    .from("referrers")
    .select("id, referrer_name, name, is_in_house")
    .eq("id", referrerId)
    .maybeSingle();

  if (referrerError) {
    return { ok: false, error: mapSupabaseErrorToJa(referrerError.message) };
  }
  if (!referrer) {
    return { ok: false, error: "紹介者が見つかりません" };
  }
  if (isInHouseReferrer(referrer)) {
    return {
      ok: false,
      error: `「${referrer.referrer_name ?? referrer.name}」は自社の紹介者です。報酬実績としては集計しますが、外部への支払対象ではありません。`,
    };
  }

  const { data: existing, error: existingError } = await auth.supabase
    .from("referral_payouts")
    .select("id, status")
    .eq("target_month", targetMonth)
    .eq("referrer_id", referrerId)
    .maybeSingle();

  if (existingError) {
    return { ok: false, error: mapSupabaseErrorToJa(existingError.message) };
  }

  if (existing?.status === "paid") {
    return { ok: false, error: "この対象月は既に支払い済みです" };
  }

  let payoutId = existing?.id as string | undefined;

  if (!payoutId) {
    const { data: created, error: createError } = await auth.supabase
      .from("referral_payouts")
      .insert({
        target_month: targetMonth,
        referrer_id: referrerId,
        threshold_amount: REFERRAL_PAYOUT_THRESHOLD_YEN,
        status: "unpaid",
        is_payable: true,
      })
      .select("id")
      .single();

    if (createError || !created) {
      return {
        ok: false,
        error: mapSupabaseErrorToJa(createError?.message ?? "支払レコードを作成できませんでした"),
      };
    }

    payoutId = created.id as string;
  }

  const result = await markReferralPayoutPaid(auth.supabase, payoutId);
  if (!result.ok) {
    if (/mark_referral_payout_paid_annual/.test(result.error)) {
      return {
        ok: false,
        error:
          "支払確定RPCが未作成です。supabase/migrations/20260916120000_referral_reward_annual_payout.sql を適用してください。",
      };
    }
    return { ok: false, error: mapSupabaseErrorToJa(result.error) };
  }

  revalidateReferralViews();
  return { ok: true, message: "年間累積分の支払いを確定しました" };
}

export async function unpayReferralAnnualAction(
  _prev: ReferralActionResult | null,
  formData: FormData,
): Promise<ReferralActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const payoutId = readText(formData, "payout_id");
  if (!payoutId) {
    return { ok: false, error: "支払い ID が不正です" };
  }

  const result = await markReferralPayoutUnpaid(auth.supabase, payoutId);
  if (!result.ok) {
    return { ok: false, error: mapSupabaseErrorToJa(result.error) };
  }

  revalidateReferralViews();
  return { ok: true, message: "支払いを取り消しました" };
}

export type ReferralPreviewActionResult =
  | {
      ok: true;
      months: string[];
      totalBaseAmount: number;
      totalRewardAmount: number;
      rows: Array<{
        referrerName: string;
        creatorName: string;
        tiktokId: string;
        baseAmount: number;
        rewardAmount: number;
      }>;
    }
  | { ok: false; error: string };

/**
 * DBへ書き込まずに紹介者報酬を再計算して返す（検証用）。
 */
export async function previewReferralRewardsAction(
  _prev: ReferralPreviewActionResult | null,
  formData: FormData,
): Promise<ReferralPreviewActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const fromMonth = readText(formData, "from_month");
  const toMonth = readText(formData, "to_month");

  const months = expandMonthRange(fromMonth, toMonth);
  if (months.length === 0) {
    return { ok: false, error: "対象期間を YYYY-MM 形式で指定してください" };
  }

  const result = await previewReferralRewards(auth.supabase, months);
  if (result.error) {
    return { ok: false, error: mapSupabaseErrorToJa(result.error) };
  }

  return {
    ok: true,
    months: result.months,
    totalBaseAmount: result.totalBaseAmount,
    totalRewardAmount: result.totalRewardAmount,
    rows: result.rows.map((row) => ({
      referrerName: row.referrerName,
      creatorName: row.creatorName,
      tiktokId: row.tiktokId,
      baseAmount: row.baseAmount,
      rewardAmount: row.rewardAmount,
    })),
  };
}

/**
 * 紹介者×クリエイター別の累計支払い額（creator_referrals.lifetime_paid_amount）を
 * 支払い済み明細から再集計する。生涯上限の判定がずれたときの復旧用。
 */
export async function reconcileReferrerLifetimePaidAction(
  _prev: ReferralActionResult | null,
): Promise<ReferralActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const result = await reconcileReferrerLifetimePaidAmounts(auth.supabase);
  if (result.error) {
    return { ok: false, error: mapSupabaseErrorToJa(result.error) };
  }

  revalidateReferralViews();
  return {
    ok: true,
    message: `累計支払い額を再集計しました（${result.updatedCount} 件）`,
  };
}
