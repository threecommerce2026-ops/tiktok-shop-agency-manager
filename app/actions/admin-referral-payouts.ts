"use server";

import { requireAdminAction } from "@/lib/db/admin-access";
import {
  markReferralPayoutPaid,
  markReferralPayoutUnpaid,
  syncReferralRewardsForMonth,
} from "@/lib/referrals/sync-referral-rewards";
import { reconcileReferrerLifetimePaidAmounts } from "@/lib/referrals/reconcile-lifetime-paid";
import { currentMonthKey } from "@/lib/db/dashboard-queries";
import { revalidatePath } from "next/cache";

export type AdminActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

function readText(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

export async function syncReferralRewardsAction(
  _prev: AdminActionResult | null,
  formData: FormData,
): Promise<AdminActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const targetMonth = readText(formData, "target_month") || currentMonthKey();
  const result = await syncReferralRewardsForMonth(auth.supabase, targetMonth);
  if (result.error) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/admin/referral-payouts");
  revalidatePath("/admin/creator-referrals");
  revalidatePath("/admin/referrers");
  revalidatePath("/referrer/dashboard");
  return {
    ok: true,
    message: `${targetMonth} の紹介者報酬を集計しました（明細 ${result.insertedCount} 件 / 支払い ${result.payoutCount} 件）`,
  };
}

export async function markReferralPayoutUnpaidAction(
  payoutId: string,
): Promise<AdminActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  if (!payoutId.trim()) {
    return { ok: false, error: "支払い ID が不正です" };
  }

  const result = await markReferralPayoutUnpaid(auth.supabase, payoutId);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/admin/referral-payouts");
  revalidatePath("/admin/referrers");
  revalidatePath("/referrer/dashboard");
  return { ok: true, message: "支払い済みを取り消しました" };
}

export async function reconcileReferrerLifetimePaidAction(
  _prev: AdminActionResult | null,
): Promise<AdminActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const result = await reconcileReferrerLifetimePaidAmounts(auth.supabase);
  if (result.error) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/admin/referral-payouts");
  revalidatePath("/admin/referrers");
  revalidatePath("/referrer/dashboard");
  return {
    ok: true,
    message: `紹介者×クリエイター別の支払い済み累計を再集計しました（${result.updatedCount} 件）`,
  };
}

export async function markReferralPayoutPaidAction(
  payoutId: string,
): Promise<AdminActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  if (!payoutId.trim()) {
    return { ok: false, error: "支払い ID が不正です" };
  }

  const result = await markReferralPayoutPaid(auth.supabase, payoutId);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/admin/referral-payouts");
  revalidatePath("/admin/referrers");
  revalidatePath("/referrer/dashboard");
  return { ok: true, message: "支払い済みに更新しました" };
}
