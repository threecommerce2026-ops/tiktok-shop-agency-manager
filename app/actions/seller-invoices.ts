"use server";

import { revalidatePath } from "next/cache";

import { requireAdminAction } from "@/lib/db/admin-access";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { mapSupabaseErrorToJa } from "@/lib/supabase/error-ja";
import { canCreateInvoice } from "@/lib/billing/seller-invoice";
import { computeInvoiceTax } from "@/lib/billing/invoice-tax";
import { calculateSellerInvoiceDueDate } from "@/lib/billing/due-date";
import { fetchSellerBillingData } from "@/lib/db/seller-billing-queries";

/*
  セラー請求書の作成・発行・入金・取消。

  ■ 請求額の根拠
  ショップ実績CSV（shop_performance_imports の source='csv'）だけを使う。
  計算式は lib/billing/seller-invoice.ts に集約。
    請求対象GMV = B列GMV − I列Refunds
    請求額（税込） = 請求対象GMV × 契約料率(%)
  消費税は加算しない。算出額がそのまま税込請求額。

  ■ 確定済み請求書の保護
  status が issued / paid / cancelled の請求書は、
  再取込・再計算・下書き再生成のいずれでも書き換えない。
  書き換えてよいのは draft だけ。

  ■ 二重請求防止
  seller_invoices は (seller_id, target_month) が UNIQUE。
  同一セラー・同一月に有効な請求書は1件しか作れない。

  ■ 触らないもの
  代理店報酬・紹介者報酬（agency_* / referral_*）には一切アクセスしない。
*/

export type SellerInvoiceActionResult =
  | { ok: true; message: string; invoiceId?: string }
  | { ok: false; error: string };

/** draft 以外は自動更新しない */
const EDITABLE_STATUS = "draft";

function readText(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function revalidateBillingViews() {
  revalidatePath("/admin/seller-billing");
  revalidatePath("/admin/shop-performance");
  revalidatePath("/admin/sellers");
  revalidatePath("/sellers");
}

function statusLabel(status: string): string {
  switch (status) {
    case "draft":
      return "下書き";
    case "issued":
      return "発行済み";
    case "paid":
      return "入金済み";
    case "cancelled":
      return "取消";
    default:
      return status;
  }
}

/**
 * 請求書の下書きを作成（既存 draft は上書き更新）。
 * 発行済み・入金済み・取消済みは拒否する。
 */
export async function createSellerInvoiceDraftAction(
  _prev: SellerInvoiceActionResult | null,
  formData: FormData,
): Promise<SellerInvoiceActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const sellerId = readText(formData, "seller_id");
  const targetMonth = readText(formData, "target_month");

  if (!sellerId || !/^\d{4}-\d{2}$/.test(targetMonth)) {
    return { ok: false, error: "セラーと対象月を指定してください" };
  }

  const admin = getSupabaseAdmin();

  // 請求根拠はサーバー側で計算し直す（画面の値を信用しない）
  const billing = await fetchSellerBillingData(admin, targetMonth);
  if (billing.error) {
    return { ok: false, error: mapSupabaseErrorToJa(billing.error) };
  }

  const row = billing.rows.find((item) => item.sellerId === sellerId);
  if (!row) {
    return {
      ok: false,
      error: `${targetMonth} のショップ実績CSVに、このセラーのデータがありません。`,
    };
  }

  // 辞退・TAP連携のみ は請求対象外。画面を経由しない呼び出しも拒否する。
  if (!row.isBillingEligible) {
    return {
      ok: false,
      error: `${row.sellerName} はTSP請求の対象外です（辞退 / TAP連携のみ）。`,
    };
  }

  if (!canCreateInvoice(row.computation)) {
    return {
      ok: false,
      error: `請求書を作成できません（${row.computation.label}）。`,
    };
  }

  const { data: existing, error: existingError } = await admin
    .from("seller_invoices")
    .select("id, status, invoice_number")
    .eq("seller_id", sellerId)
    .eq("target_month", targetMonth)
    .maybeSingle();

  if (existingError) {
    return { ok: false, error: mapSupabaseErrorToJa(existingError.message) };
  }

  if (existing && existing.status !== EDITABLE_STATUS) {
    return {
      ok: false,
      error: `${targetMonth} の請求書は既に「${statusLabel(existing.status as string)}」です。内容を変更するには先に取消してください。`,
    };
  }

  // 請求書番号は一度採番したら変えない（再ダウンロードで変わらない）
  let invoiceNumber = (existing?.invoice_number as string | null) ?? null;

  if (!invoiceNumber) {
    const { data: generated, error: numberError } = await auth.supabase.rpc(
      "next_seller_invoice_number",
      { p_target_month: targetMonth },
    );

    if (numberError) {
      return {
        ok: false,
        error: `請求書番号を採番できませんでした: ${mapSupabaseErrorToJa(numberError.message)}`,
      };
    }
    invoiceNumber = generated as string;
  }

  const nowIso = new Date().toISOString();

  /*
    税情報は保存時点でスナップショットする。
    invoice_amount は税込のまま。税を足すことはしない。
  */
  const tax = computeInvoiceTax(row.computation.invoiceAmount ?? 0);

  const payload = {
    seller_id: sellerId,
    target_month: targetMonth,
    period_start: row.periodStart,
    period_end: row.periodEnd,
    gmv_amount: row.gmvAmount,
    refund_amount: row.refundAmount,
    billing_gmv_amount: row.computation.billingGmvAmount,
    tsp_rate: row.contractRatePct ?? 0,
    invoice_amount: row.computation.invoiceAmount ?? 0,
    tax_rate_pct: tax.taxRatePct,
    tax_amount: tax.taxAmount,
    invoice_number: invoiceNumber,
    status: EDITABLE_STATUS,
    created_by: auth.user?.id ?? null,
    updated_at: nowIso,
  };

  const { data: saved, error: saveError } = existing
    ? await admin
        .from("seller_invoices")
        .update(payload)
        .eq("id", existing.id)
        .eq("status", EDITABLE_STATUS) // 競合で発行済みになっていたら更新しない
        .select("id")
        .maybeSingle()
    : await admin.from("seller_invoices").insert(payload).select("id").single();

  if (saveError) {
    return { ok: false, error: mapSupabaseErrorToJa(saveError.message) };
  }
  if (!saved?.id) {
    return {
      ok: false,
      error: "請求書を保存できませんでした（他の操作で状態が変わった可能性があります）",
    };
  }

  revalidateBillingViews();

  return {
    ok: true,
    invoiceId: saved.id as string,
    message: `${row.sellerName} の請求書（${invoiceNumber}）を下書き作成しました。`,
  };
}

/**
 * 下書き → 発行済み。
 *
 * 発行日は実行時刻、支払期限は請求対象月から自動計算して記録する。
 *
 * 支払期限のルールは「月末締め・翌月末払い」＝対象月の翌月末日。
 * 発行日を基準にしないので、いつ発行しても対象月が同じなら期限は同じになる。
 * 計算は lib/billing/due-date.ts に集約している。
 *
 * 保存後は再計算しない。将来ルールが変わっても
 * 発行済み請求書の支払期限は変わらない。
 */
export async function issueSellerInvoiceAction(
  _prev: SellerInvoiceActionResult | null,
  formData: FormData,
): Promise<SellerInvoiceActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const invoiceId = readText(formData, "invoice_id");
  if (!invoiceId) return { ok: false, error: "請求書を指定してください" };

  const admin = getSupabaseAdmin();

  const { data: current, error: loadError } = await admin
    .from("seller_invoices")
    .select("id, status, target_month")
    .eq("id", invoiceId)
    .maybeSingle();

  if (loadError) return { ok: false, error: mapSupabaseErrorToJa(loadError.message) };
  if (!current) return { ok: false, error: "請求書が見つかりません" };

  if (current.status !== "draft") {
    return {
      ok: false,
      error: `発行できるのは下書きだけです（現在: ${statusLabel(current.status as string)}）。`,
    };
  }

  const targetMonth = String(current.target_month ?? "");
  const dueDate = calculateSellerInvoiceDueDate(targetMonth);

  if (!dueDate) {
    return {
      ok: false,
      error: `対象月から支払期限を計算できませんでした（target_month: ${targetMonth}）。`,
    };
  }

  const nowIso = new Date().toISOString();

  const { data: updated, error } = await admin
    .from("seller_invoices")
    .update({
      status: "issued",
      issued_at: nowIso,
      due_date: dueDate,
      updated_at: nowIso,
    })
    .eq("id", invoiceId)
    .eq("status", "draft") // 競合していたら何も起きない
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, error: mapSupabaseErrorToJa(error.message) };
  if (!updated?.id) {
    return {
      ok: false,
      error: "状態を更新できませんでした（他の操作で状態が変わった可能性があります）",
    };
  }

  revalidateBillingViews();

  return {
    ok: true,
    message: `請求書を発行しました（支払期限 ${dueDate}）。`,
  };
}

/** 発行済み → 入金済み */
export async function markSellerInvoicePaidAction(
  _prev: SellerInvoiceActionResult | null,
  formData: FormData,
): Promise<SellerInvoiceActionResult> {
  return transitionStatus(formData, {
    from: "issued",
    to: "paid",
    stamp: (nowIso) => ({ paid_at: nowIso }),
    successMessage: "入金済みにしました。",
    rejectMessage: (current) =>
      `入金済みにできるのは発行済みの請求書だけです（現在: ${statusLabel(current)}）。`,
  });
}

/** 取消（下書き・発行済みのみ。入金済みは取り消さない） */
export async function cancelSellerInvoiceAction(
  _prev: SellerInvoiceActionResult | null,
  formData: FormData,
): Promise<SellerInvoiceActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const invoiceId = readText(formData, "invoice_id");
  if (!invoiceId) return { ok: false, error: "請求書を指定してください" };

  const admin = getSupabaseAdmin();

  const { data: current, error: loadError } = await admin
    .from("seller_invoices")
    .select("id, status")
    .eq("id", invoiceId)
    .maybeSingle();

  if (loadError) return { ok: false, error: mapSupabaseErrorToJa(loadError.message) };
  if (!current) return { ok: false, error: "請求書が見つかりません" };

  if (current.status === "paid") {
    return {
      ok: false,
      error: "入金済みの請求書は取り消せません。経理処理として別途対応してください。",
    };
  }
  if (current.status === "cancelled") {
    return { ok: false, error: "既に取消済みです" };
  }

  const { error } = await admin
    .from("seller_invoices")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", invoiceId)
    .neq("status", "paid");

  if (error) return { ok: false, error: mapSupabaseErrorToJa(error.message) };

  revalidateBillingViews();
  return { ok: true, message: "請求書を取り消しました。金額と請求書番号は履歴として残ります。" };
}

/**
 * 状態遷移の共通処理。
 * 想定した状態からの遷移だけを許可し、条件付き UPDATE で競合も防ぐ。
 */
async function transitionStatus(
  formData: FormData,
  config: {
    from: string;
    to: string;
    stamp: (nowIso: string, dueDate: string | null) => Record<string, unknown>;
    successMessage: string;
    rejectMessage: (current: string) => string;
  },
): Promise<SellerInvoiceActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const invoiceId = readText(formData, "invoice_id");
  const dueDate = readText(formData, "due_date") || null;

  if (!invoiceId) return { ok: false, error: "請求書を指定してください" };

  const admin = getSupabaseAdmin();

  const { data: current, error: loadError } = await admin
    .from("seller_invoices")
    .select("id, status, invoice_number")
    .eq("id", invoiceId)
    .maybeSingle();

  if (loadError) return { ok: false, error: mapSupabaseErrorToJa(loadError.message) };
  if (!current) return { ok: false, error: "請求書が見つかりません" };

  if (current.status !== config.from) {
    return { ok: false, error: config.rejectMessage(current.status as string) };
  }

  const nowIso = new Date().toISOString();

  const { data: updated, error } = await admin
    .from("seller_invoices")
    .update({
      status: config.to,
      ...config.stamp(nowIso, dueDate),
      updated_at: nowIso,
    })
    .eq("id", invoiceId)
    .eq("status", config.from) // 競合していたら何も起きない
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, error: mapSupabaseErrorToJa(error.message) };
  if (!updated?.id) {
    return {
      ok: false,
      error: "状態を更新できませんでした（他の操作で状態が変わった可能性があります）",
    };
  }

  revalidateBillingViews();
  return { ok: true, message: config.successMessage };
}

/** 対象月のプレビュー上、請求可能な全セラーの下書きをまとめて作る */
export async function createSellerInvoiceDraftsBulkAction(
  _prev: SellerInvoiceActionResult | null,
  formData: FormData,
): Promise<SellerInvoiceActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const targetMonth = readText(formData, "target_month");
  if (!/^\d{4}-\d{2}$/.test(targetMonth)) {
    return { ok: false, error: "対象月を指定してください" };
  }

  const admin = getSupabaseAdmin();
  const billing = await fetchSellerBillingData(admin, targetMonth);
  if (billing.error) return { ok: false, error: mapSupabaseErrorToJa(billing.error) };

  let created = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const row of billing.rows) {
    // テスト用セラー・TSP請求対象外は本番の一括請求に含めない（DBからは消さない）
    if (row.isTest || !row.isBillingEligible) {
      skipped += 1;
      continue;
    }
    // 請求できないもの・確定済みのものは触らない
    if (!canCreateInvoice(row.computation)) {
      skipped += 1;
      continue;
    }
    if (row.invoice && row.invoice.status !== EDITABLE_STATUS) {
      skipped += 1;
      continue;
    }

    const single = new FormData();
    single.set("seller_id", row.sellerId);
    single.set("target_month", targetMonth);

    const result = await createSellerInvoiceDraftAction(null, single);
    if (result.ok) created += 1;
    else errors.push(`${row.sellerName}: ${result.error}`);
  }

  revalidateBillingViews();

  if (created === 0 && errors.length > 0) {
    return { ok: false, error: errors.join(" / ") };
  }

  return {
    ok: true,
    message:
      `${targetMonth} の下書きを ${created} 件作成しました` +
      (skipped > 0 ? `（対象外・確定済み・テストデータ ${skipped} 件はスキップ）` : "") +
      (errors.length > 0 ? `。失敗: ${errors.join(" / ")}` : "。"),
  };
}

