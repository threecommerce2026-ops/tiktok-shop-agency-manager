"use server";

import { revalidatePath } from "next/cache";

import { requireAdminAction } from "@/lib/db/admin-access";
import { isInHouseAgencyRecord } from "@/lib/revenue/in-house-creator";
import { currentMonthKey } from "@/lib/db/dashboard-queries";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { mapSupabaseErrorToJa } from "@/lib/supabase/error-ja";
import {
  markAgencyPayoutPaid,
  markAgencyPayoutUnpaid,
  syncAgencyRewardsForMonth,
} from "@/lib/agency/sync-agency-rewards";
import {
  isValidRewardYear,
  isValidTargetMonth,
  sumAgencyAmounts,
} from "@/lib/agency/agency-reward-engine";
import { expandMonthRange } from "@/lib/referrals/referral-reward-preview";

/*
  代理店報酬の再集計・支払確定。

  紹介者報酬（referral_reward_items / referral_payouts）には一切触れない。

  ■ クライアントの使い分け
  agency_reward_items / agency_payouts は authenticated ロールに SELECT しか
  付与されていないため、明細生成・支払レコード作成は service role で行う。
  管理者判定は requireAdminAction() がサーバー側で担保する。

  RPC（mark_agency_payout_paid_annual / _unpaid_annual）は SECURITY DEFINER で
  内部的に is_app_admin() を検証する。is_app_admin() は auth.uid() に依存するため、
  RPC はログインユーザーのクライアントで呼ぶ必要がある。
*/

export type AgencyActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

const MIGRATION_HINT =
  "代理店報酬テーブルが見つかりません。supabase/migrations/20260916150000_agency_reward_payout_system.sql を適用してください。";

/*
  テーブル未作成を示すコードだけを migration 未適用として扱う。
    42P01   undefined_table
    PGRST205 スキーマキャッシュにテーブルが無い
    PGRST106 スキーマが公開されていない
  権限エラー（42501）などをここで握り潰すと原因が分からなくなる。
*/
const MISSING_TABLE_CODES = new Set(["42P01", "PGRST205", "PGRST106"]);

function describeError(message: string, code: string | null | undefined): string {
  const mapped = mapSupabaseErrorToJa(message);
  return code ? `${mapped}（エラーコード: ${code}）` : mapped;
}

function readText(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function revalidateAgencyViews() {
  revalidatePath("/revenue");
  revalidatePath("/dashboard");
  revalidatePath("/admin/agencies");
}

function isMissingTable(code: string | null | undefined): boolean {
  return code != null && MISSING_TABLE_CODES.has(code);
}

function formatAmount(value: number): string {
  return value.toLocaleString("ja-JP", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

/**
 * 対象月（または年内の全月）の代理店報酬明細を再集計する。
 * source_row_key で冪等。支払い済み明細は書き換えない。
 */
export async function syncAgencyRewardsAction(
  _prev: AgencyActionResult | null,
  formData: FormData,
): Promise<AgencyActionResult> {
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
  let warningCount = 0;
  const amounts: number[] = [];

  // 書き込みは service role（管理者判定は requireAdminAction 済み）
  const writeClient = getSupabaseAdmin();

  for (const targetMonth of months) {
    const result = await syncAgencyRewardsForMonth(writeClient, targetMonth);

    if (result.error) {
      if (isMissingTable(result.errorCode)) {
        return { ok: false, error: MIGRATION_HINT };
      }
      return { ok: false, error: describeError(result.error, result.errorCode) };
    }

    upserted += result.upsertedCount;
    deleted += result.deletedCount;
    skippedPaid += result.skippedPaidCount;
    warningCount += result.warnings.length;
    amounts.push(result.monthRewardAmount);
  }

  revalidateAgencyViews();

  const warningNote = warningCount > 0 ? ` / 要確認 ${warningCount} 件` : "";

  return {
    ok: true,
    message: `${months[0]}〜${months[months.length - 1]} の代理店報酬を再集計しました（明細 ${upserted} 件 / 対象外削除 ${deleted} 件 / 支払済据置 ${skippedPaid} 件 / 発生額 ${formatAmount(
      sumAgencyAmounts(amounts),
    )} 円${warningNote}）`,
  };
}

/**
 * 年間累積で支払いを確定する。
 * 対象月の支払レコードを作ってから RPC を呼ぶ。
 */
export async function payAgencyAnnualAction(
  _prev: AgencyActionResult | null,
  formData: FormData,
): Promise<AgencyActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const agencyId = readText(formData, "agency_id");
  const targetMonth = readText(formData, "target_month");

  if (!agencyId || !isValidTargetMonth(targetMonth)) {
    return { ok: false, error: "代理店と対象月を指定してください" };
  }

  const writeClient = getSupabaseAdmin();

  /*
    自社（THREE.inc /（株）3）は外部代理店への支払対象ではない。
    自社には報酬明細が作られないため金額0で弾かれるが、
    設定変更の順序によっては明細が残りうるのでここで明示的に拒否する。
    判定は agencies.is_in_house のみ（名前では判定しない）。
  */
  const { data: agency, error: agencyError } = await writeClient
    .from("agencies")
    .select("id, name, is_in_house")
    .eq("id", agencyId)
    .maybeSingle();

  if (agencyError) {
    return { ok: false, error: describeError(agencyError.message, agencyError.code) };
  }
  if (!agency) {
    return { ok: false, error: "代理店が見つかりません" };
  }
  if (isInHouseAgencyRecord(agency)) {
    return {
      ok: false,
      error: `「${agency.name}」は自社の代理店です。外部代理店への支払対象ではありません。`,
    };
  }

  const { data: existing, error: existingError } = await writeClient
    .from("agency_payouts")
    .select("id, status")
    .eq("target_month", targetMonth)
    .eq("agency_id", agencyId)
    .maybeSingle();

  if (existingError) {
    if (isMissingTable(existingError.code)) {
      return { ok: false, error: MIGRATION_HINT };
    }
    return {
      ok: false,
      error: describeError(existingError.message, existingError.code),
    };
  }

  if (existing?.status === "paid") {
    return { ok: false, error: "この対象月は既に支払い済みです" };
  }

  let payoutId = existing?.id as string | undefined;

  if (!payoutId) {
    const { data: created, error: createError } = await writeClient
      .from("agency_payouts")
      .insert({
        target_month: targetMonth,
        agency_id: agencyId,
        threshold_amount: 0,
        status: "unpaid",
        is_payable: true,
      })
      .select("id")
      .single();

    if (createError || !created) {
      return {
        ok: false,
        error: describeError(
          createError?.message ?? "支払レコードを作成できませんでした",
          createError?.code,
        ),
      };
    }

    payoutId = created.id as string;
  }

  // RPC は is_app_admin() が auth.uid() を参照するためユーザークライアントで呼ぶ
  const result = await markAgencyPayoutPaid(auth.supabase, payoutId);
  if (!result.ok) {
    return { ok: false, error: mapSupabaseErrorToJa(result.error) };
  }

  revalidateAgencyViews();
  return { ok: true, message: "年間累積分の支払いを確定しました" };
}

export async function unpayAgencyAnnualAction(
  _prev: AgencyActionResult | null,
  formData: FormData,
): Promise<AgencyActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const payoutId = readText(formData, "payout_id");
  if (!payoutId) {
    return { ok: false, error: "支払い ID が不正です" };
  }

  const result = await markAgencyPayoutUnpaid(auth.supabase, payoutId);
  if (!result.ok) {
    return { ok: false, error: mapSupabaseErrorToJa(result.error) };
  }

  revalidateAgencyViews();
  return { ok: true, message: "支払いを取り消しました" };
}
