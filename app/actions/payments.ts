"use server";

import { revalidatePath } from "next/cache";

import {
  EARLIEST_CUTOFF_MONTH,
  formatCutoffLabel,
  isCutoffMonth,
  currentMonthJst,
} from "@/lib/payments/cutoff-month";
import { requireAdminAction } from "@/lib/db/admin-access";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { mapSupabaseErrorToJa } from "@/lib/supabase/error-ja";
import { REFERRAL_PAYOUT_THRESHOLD_YEN } from "@/lib/referrals/referral-reward-engine";
import {
  fetchPaymentBatchCsvSources,
  fetchPaymentOverview,
  type PaymentUnpaidRow,
} from "@/lib/db/payment-queries";
import {
  buildPaymentCsv,
  paymentCsvFileName,
  sumPaymentCsvAmount,
  type PaymentCsvRow,
} from "@/lib/payments/payment-csv";
import {
  describeHoldReasons,
  isPayeeKind,
  PAYEE_KIND_LABEL,
  type PayeeKind,
} from "@/lib/payments/payable";
import {
  PAYMENT_BATCH_STATUS_LABEL,
  isOpenPaymentBatchStatus,
} from "@/lib/payments/payment-status";

/*
  支払管理のサーバーアクション。

  ■ 報酬計算はしない
  金額は既存 Finance Engine が確定させた agency_reward_items /
  referral_reward_items の合計。ここでは再計算も補正もしない。

  ■ クライアントの使い分け
  読み取り（支払先マスタの銀行列を含む）はサービスロール。
  状態遷移は RPC で行い、RPC 内の is_app_admin() が auth.uid() を参照するため
  必ずログインユーザーのクライアントで呼ぶ。

  ■ is_paid を true にするのは completePaymentBatchAction だけ
  作成・承認・CSV出力では絶対に変更しない。
*/

export type PaymentActionResult =
  | { ok: true; message: string; batchId?: string }
  | { ok: false; error: string };

export type PaymentCsvActionResult =
  | { ok: true; fileName: string; content: string; batchCount: number; totalAmount: number }
  | { ok: false; error: string };

const MIGRATION_HINT =
  "支払管理テーブルが見つかりません。supabase/migrations/20260925101000_payment_batches.sql 以降を適用してください。";

const MISSING_TABLE_CODES = new Set(["42P01", "PGRST202", "PGRST205", "PGRST106"]);

function readText(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function readList(formData: FormData, key: string): string[] {
  return formData
    .getAll(key)
    .map((value) => String(value).trim())
    .filter(Boolean);
}

function isMonthKey(value: string): boolean {
  return /^\d{4}-\d{2}$/.test(value);
}

function revalidatePaymentViews() {
  revalidatePath("/payments");
  revalidatePath("/payments/bulk");
  revalidatePath("/revenue");
  revalidatePath("/dashboard");
}

function describeRpcError(message: string, code?: string | null): string {
  if (code && MISSING_TABLE_CODES.has(code)) return MIGRATION_HINT;
  if (/function .* does not exist/i.test(message)) return MIGRATION_HINT;
  /*
    RPC が raise exception で返す日本語メッセージはそのまま出す。
    mapSupabaseErrorToJa は英語メッセージ用で、日本語を壊す置換はしない。
  */
  return mapSupabaseErrorToJa(message);
}

/*
  支払基準額。

  代理店の支払明細は「代理店報酬 + 帰属する紹介者報酬」の合算額に対して
  基準額なし（0円）で判定する。紹介者単体の 1,000 円基準は、代理店へ
  正常に帰属している紹介者の支払判定には使わない。

  残る 1,000 円判定は、代理店へ未帰属の紹介者に対する legacy 経路のみ。
  通常UIではそれらは referrer_agency_unassigned で保留されるため、
  ここへは到達しない。
*/
/*
  締め対象月の検証。

  フロントの検証だけに依存しない。RPC 側でも同じ検証をしているが、
  ここで弾いたほうが操作者に分かりやすいエラーを返せる。
  不正な値を近い月へ勝手に丸めることはしない。
*/
function validateCutoff(
  cutoffMonth: string,
  startMonth: string,
): string | null {
  if (!isCutoffMonth(cutoffMonth)) {
    return `締め対象月を YYYY-MM 形式で指定してください: ${cutoffMonth || "(未指定)"}`;
  }
  const current = currentMonthJst();
  if (cutoffMonth > current) {
    return `締め対象月に未来月は指定できません（指定 ${cutoffMonth} / 当月 ${current}）`;
  }
  if (cutoffMonth < EARLIEST_CUTOFF_MONTH) {
    return `締め対象月は ${EARLIEST_CUTOFF_MONTH} 以降で指定してください`;
  }
  if (!isMonthKey(startMonth)) {
    return "開始月を YYYY-MM 形式で指定してください";
  }
  if (startMonth > cutoffMonth) {
    return "開始月が締め対象月より後になっています";
  }
  return null;
}

function thresholdFor(payeeKind: PayeeKind): number {
  return payeeKind === "referrer" ? REFERRAL_PAYOUT_THRESHOLD_YEN : 0;
}

// =============================================================================
// 支払明細の作成
// =============================================================================

/**
 * 支払先1件分の支払明細を作る。
 *
 * 対象明細の占有・件数・金額の確定は RPC 内の1トランザクションで行う。
 * ここでは保留理由を先に見て、分かりやすいエラーを返すだけ。
 */
export async function createPaymentBatchAction(
  _prev: PaymentActionResult | null,
  formData: FormData,
): Promise<PaymentActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const payeeKind = readText(formData, "payee_kind");
  const payeeId = readText(formData, "payee_id");
  /*
    支払の上限は「締め対象月」だけで決める。
    画面に出ている未払い明細の最終月（データ由来）を上限にしない。
    そうしないと代理店ごとに締め月がばらつき、締めていない月まで入る。
  */
  const cutoffMonth = readText(formData, "cutoff_month");
  const startMonth = readText(formData, "start_month") || EARLIEST_CUTOFF_MONTH;
  const memo = readText(formData, "memo") || null;

  if (!isPayeeKind(payeeKind)) {
    return { ok: false, error: "支払先の種別が不正です" };
  }
  if (!payeeId) {
    return { ok: false, error: "支払先を指定してください" };
  }

  const cutoffError = validateCutoff(cutoffMonth, startMonth);
  if (cutoffError) return { ok: false, error: cutoffError };

  const { data, error } = await auth.supabase.rpc("claim_payment_batch_items", {
    p_payee_kind: payeeKind,
    p_payee_id: payeeId,
    p_cutoff_month: cutoffMonth,
    p_period_start_month: startMonth,
    p_min_amount: thresholdFor(payeeKind),
    p_memo: memo,
  });

  if (error) {
    return { ok: false, error: describeRpcError(error.message, error.code) };
  }

  revalidatePaymentViews();

  return {
    ok: true,
    batchId: (data as string) ?? undefined,
    message: `支払明細を作成しました（${formatCutoffLabel(cutoffMonth)}締め）。まだ支払済みにはなっていません。`,
  };
}

export type BulkSettlementResult =
  | {
      ok: true;
      message: string;
      createdCount: number;
      createdAmount: number;
      skipped: Array<{ payeeName: string; reason: string }>;
    }
  | { ok: false; error: string };

/**
 * 過去未払いの一括精算。
 *
 * 支払可能な支払先だけを対象に、支払先ごとに支払明細を1件ずつ作る。
 * 作られるのはすべて draft。ここで支払済みにはしない。
 *
 * 1社の失敗で全体を止めない（支払先ごとに独立した RPC 呼び出し）。
 */
export async function createPaymentBatchesBulkAction(
  _prev: BulkSettlementResult | null,
  formData: FormData,
): Promise<BulkSettlementResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const cutoffMonth = readText(formData, "cutoff_month");
  const startMonth = readText(formData, "start_month") || EARLIEST_CUTOFF_MONTH;
  const selectedKeys = new Set(readList(formData, "payee_key"));

  const cutoffError = validateCutoff(cutoffMonth, startMonth);
  if (cutoffError) return { ok: false, error: cutoffError };

  if (selectedKeys.size === 0) {
    return { ok: false, error: "支払先を1件以上選択してください" };
  }

  // 対象の再判定はサーバー側で必ずやり直す（画面の値を信用しない）
  const overview = await fetchPaymentOverview(getSupabaseAdmin(), {
    claimStartMonth: startMonth,
    cutoffMonth,
  });
  if (overview.error) {
    return { ok: false, error: mapSupabaseErrorToJa(overview.error) };
  }

  const targets = overview.rows.filter((row) =>
    selectedKeys.has(`${row.payeeKind}:${row.payeeId}`),
  );

  if (targets.length === 0) {
    return { ok: false, error: "選択された支払先が見つかりません" };
  }

  let createdCount = 0;
  const createdAmounts: number[] = [];
  const skipped: Array<{ payeeName: string; reason: string }> = [];

  for (const row of targets) {
    if (!row.isPayable) {
      skipped.push({
        payeeName: row.payeeName,
        reason:
          row.holdReasons.length > 0
            ? describeHoldReasons(row.holdReasons)
            : "支払対象の未払いがありません",
      });
      continue;
    }

    const { error } = await auth.supabase.rpc("claim_payment_batch_items", {
      p_payee_kind: row.payeeKind,
      p_payee_id: row.payeeId,
      p_cutoff_month: cutoffMonth,
      p_period_start_month: startMonth,
      p_min_amount: thresholdFor(row.payeeKind),
      p_memo: `一括精算 ${formatCutoffLabel(cutoffMonth)}締め`,
    });

    if (error) {
      skipped.push({
        payeeName: row.payeeName,
        reason: describeRpcError(error.message, error.code),
      });
      continue;
    }

    createdCount += 1;
    createdAmounts.push(row.unpaidAmount);
  }

  revalidatePaymentViews();

  if (createdCount === 0) {
    return {
      ok: false,
      error: `支払明細を作成できませんでした（${skipped
        .map((item) => `${item.payeeName}: ${item.reason}`)
        .join(" / ")}）`,
    };
  }

  const createdAmount =
    Math.round(createdAmounts.reduce((sum, value) => sum + value, 0) * 100) / 100;

  return {
    ok: true,
    createdCount,
    createdAmount,
    skipped,
    message: `支払明細を ${createdCount} 件（合計 ${createdAmount.toLocaleString("ja-JP")} 円）作成しました。すべて下書きです。振込完了を登録するまで支払済みにはなりません。`,
  };
}

// =============================================================================
// 状態遷移
// =============================================================================

async function callBatchRpc(
  fn: string,
  args: Record<string, unknown>,
  successMessage: string,
): Promise<PaymentActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const batchId = String(args.p_batch_id ?? "");
  if (!batchId) return { ok: false, error: "支払明細を指定してください" };

  const { error } = await auth.supabase.rpc(fn, args);
  if (error) {
    return { ok: false, error: describeRpcError(error.message, error.code) };
  }

  revalidatePaymentViews();
  revalidatePath(`/payments/${batchId}`);
  return { ok: true, message: successMessage, batchId };
}

export async function approvePaymentBatchAction(
  _prev: PaymentActionResult | null,
  formData: FormData,
): Promise<PaymentActionResult> {
  return callBatchRpc(
    "approve_payment_batch",
    { p_batch_id: readText(formData, "batch_id") },
    "支払明細を承認しました。振込先を固定しました。まだ支払済みにはなっていません。",
  );
}

export async function setPaymentBatchProcessingAction(
  _prev: PaymentActionResult | null,
  formData: FormData,
): Promise<PaymentActionResult> {
  return callBatchRpc(
    "set_payment_batch_processing",
    { p_batch_id: readText(formData, "batch_id") },
    "振込中にしました。",
  );
}

/**
 * 振込完了の登録。
 * 実際に銀行振込を終えた後にだけ実行する。ここで初めて支払済みになる。
 */
export async function completePaymentBatchAction(
  _prev: PaymentActionResult | null,
  formData: FormData,
): Promise<PaymentActionResult> {
  const paidOn = readText(formData, "paid_on");

  if (paidOn && !/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) {
    return { ok: false, error: "振込日は YYYY-MM-DD 形式で指定してください" };
  }

  return callBatchRpc(
    "complete_payment_batch",
    {
      p_batch_id: readText(formData, "batch_id"),
      p_paid_on: paidOn || null,
      p_memo: readText(formData, "memo") || null,
    },
    "振込完了を登録しました。対象の報酬明細を支払済みにしました。",
  );
}

export async function failPaymentBatchAction(
  _prev: PaymentActionResult | null,
  formData: FormData,
): Promise<PaymentActionResult> {
  return callBatchRpc(
    "fail_payment_batch",
    {
      p_batch_id: readText(formData, "batch_id"),
      p_reason: readText(formData, "reason") || null,
    },
    "振込失敗として記録し、対象明細を未払いへ戻しました。",
  );
}

export async function cancelPaymentBatchAction(
  _prev: PaymentActionResult | null,
  formData: FormData,
): Promise<PaymentActionResult> {
  return callBatchRpc(
    "cancel_payment_batch",
    {
      p_batch_id: readText(formData, "batch_id"),
      p_reason: readText(formData, "reason") || null,
    },
    "支払明細を取り消し、対象明細を未払いへ戻しました。",
  );
}

// =============================================================================
// 振込CSV
// =============================================================================

/**
 * 振込用CSVを生成する。
 *
 * ■ 口座番号の全文を扱う唯一のアクション
 * 生成した文字列だけを返し、口座番号を画面のデータとして渡さない。
 * 出力したことは監査ログ（csv_exported）へ必ず残す。
 */
export async function exportPaymentCsvAction(
  _prev: PaymentCsvActionResult | null,
  formData: FormData,
): Promise<PaymentCsvActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const batchIds = readList(formData, "batch_id");
  if (batchIds.length === 0) {
    return { ok: false, error: "支払明細を1件以上選択してください" };
  }

  const sources = await fetchPaymentBatchCsvSources(getSupabaseAdmin(), batchIds);
  if (sources.error) {
    return { ok: false, error: mapSupabaseErrorToJa(sources.error) };
  }
  if (sources.data.length === 0) {
    return { ok: false, error: "支払明細が見つかりません" };
  }

  /*
    出力してよいのは承認後だけ。
    下書きは振込先スナップショットが確定していないため、
    マスタ変更でCSVの内容が変わってしまう。
  */
  const notApproved = sources.data.filter(
    (source) => source.status !== "approved" && source.status !== "processing",
  );

  if (notApproved.length > 0) {
    return {
      ok: false,
      error: `承認済み / 振込中の支払明細だけがCSV出力できます（${notApproved
        .map((source) => `${source.payeeName}: ${source.status}`)
        .join(" / ")}）`,
    };
  }

  const rows: PaymentCsvRow[] = sources.data.map((source) => ({
    payeeKind: source.payeeKind,
    payeeName: source.payeeName,
    periodStartMonth: source.periodStartMonth,
    periodEndMonth: source.periodEndMonth,
    paymentAmount: source.paymentAmount,
    bankName: source.bank.bankName,
    bankCode: source.bank.bankCode,
    bankBranchName: source.bank.bankBranchName,
    bankBranchCode: source.bank.bankBranchCode,
    bankAccountType: source.bank.bankAccountType,
    bankAccountNumber: source.bank.bankAccountNumber,
    bankAccountHolder: source.bank.bankAccountHolder,
  }));

  // 出力の記録。失敗しても CSV は返す（監査の欠落は後から追える）
  for (const source of sources.data) {
    await auth.supabase.rpc("log_payment_batch_csv_export", {
      p_batch_id: source.id,
    });
  }

  const stamp = new Date()
    .toLocaleDateString("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
    .replace(/\//g, "");

  const suffix =
    rows.length === 1 ? PAYEE_KIND_LABEL[rows[0].payeeKind] : `${rows.length}ken`;

  return {
    ok: true,
    fileName: paymentCsvFileName(stamp, suffix),
    content: buildPaymentCsv(rows),
    batchCount: rows.length,
    totalAmount: sumPaymentCsvAmount(rows),
  };
}

// =============================================================================
// 一括精算プレビュー（READ ONLY）
// =============================================================================

export type BulkSettlementPreviewRow = {
  payeeKey: string;
  payeeKind: PayeeKind;
  payeeName: string;
  itemCount: number;
  amount: number;
  /** 内訳: 代理店報酬ぶん */
  agencyRewardAmount: number;
  /** 内訳: この支払先へ合算した紹介報酬ぶん */
  referralRewardAmount: number;
  bankState: string;
  holdReasons: string[];
  isPayable: boolean;
};

export type BulkSettlementPreviewResult =
  | {
      ok: true;
      startMonth: string;
      /** 締め対象月。この月までの未払いだけが payable / held に入る */
      cutoffMonth: string;
      payable: BulkSettlementPreviewRow[];
      held: BulkSettlementPreviewRow[];
      payableAmount: number;
      heldAmount: number;
    }
  | { ok: false; error: string };

/**
 * 一括精算のプレビュー。DBへ書き込まない。
 *
 * 期間で絞った金額を出すため、未払い一覧とは別に明細を読み直す。
 */
export async function previewBulkSettlementAction(
  _prev: BulkSettlementPreviewResult | null,
  formData: FormData,
): Promise<BulkSettlementPreviewResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const cutoffMonth = readText(formData, "cutoff_month");
  const startMonth = readText(formData, "start_month") || EARLIEST_CUTOFF_MONTH;

  const cutoffError = validateCutoff(cutoffMonth, startMonth);
  if (cutoffError) return { ok: false, error: cutoffError };

  /*
    締め対象月までの明細だけで集計し直す。
    全期間の未払いをそのまま出すと、実際に作られる支払明細の金額と
    ずれてしまう（締めていない月が混ざる）。
  */
  const overview = await fetchPaymentOverview(getSupabaseAdmin(), {
    claimStartMonth: startMonth,
    cutoffMonth,
  });
  if (overview.error) {
    return { ok: false, error: mapSupabaseErrorToJa(overview.error) };
  }

  const toPreviewRow = (row: PaymentUnpaidRow): BulkSettlementPreviewRow => ({
    payeeKey: `${row.payeeKind}:${row.payeeId}`,
    payeeKind: row.payeeKind,
    payeeName: row.payeeName,
    itemCount: row.itemCount,
    amount: row.unpaidAmount,
    agencyRewardAmount: row.agencyRewardAmount,
    referralRewardAmount: row.referralRewardAmount,
    bankState: row.bank.state,
    holdReasons: row.holdReasons,
    isPayable: row.isPayable,
  });

  const candidates = overview.rows.filter((row) => row.unpaidAmount > 0);

  const payable = candidates.filter((row) => row.isPayable).map(toPreviewRow);
  const held = candidates.filter((row) => !row.isPayable).map(toPreviewRow);

  const sum = (rows: BulkSettlementPreviewRow[]) =>
    Math.round(rows.reduce((total, row) => total + row.amount, 0) * 100) / 100;

  return {
    ok: true,
    startMonth,
    cutoffMonth,
    payable,
    held,
    payableAmount: sum(payable),
    heldAmount: sum(held),
  };
}

/** 占有中の支払明細があるか（画面の注意表示用） */
export async function hasOpenPaymentBatches(): Promise<boolean> {
  const overview = await fetchPaymentOverview(getSupabaseAdmin());
  return overview.batches.some((batch) => isOpenPaymentBatchStatus(batch.status));
}

// =============================================================================
// 支払明細の一括承認
// =============================================================================

export type BulkApproveResult =
  | { ok: true; message: string; approvedCount: number; approvedAmount: number }
  | { ok: false; error: string };

/**
 * 選択した支払明細をまとめて承認する。
 *
 * 承認の判定・振込先の固定・監査ログは RPC 内の1トランザクションで行う。
 * 1件でも検証に失敗したら全件ロールバックされるので、部分的に承認された
 * 状態にはならない。
 *
 * ブラウザから来た選択内容は信用しない。存在・状態・締め月の再確認はサーバー側で
 * やり直す。金額・振込先・明細整合性の最終判定は RPC 側が行う。
 */
export async function approvePaymentBatchesBulkAction(
  _prev: BulkApproveResult | null,
  formData: FormData,
): Promise<BulkApproveResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const batchIds = [...new Set(readList(formData, "batch_id"))].filter(
    (id) => id.length > 0,
  );

  if (batchIds.length === 0) {
    return { ok: false, error: "支払明細を1件以上選択してください" };
  }

  /*
    画面の値を信用せず、承認対象をサーバー側で取り直して先に検証する。
    RPC 側でも同じ検証をしているが、ここで弾いたほうが
    「どの代理店の何が原因か」を分かりやすく返せる。
  */
  const overview = await fetchPaymentOverview(getSupabaseAdmin());
  if (overview.error) {
    return { ok: false, error: mapSupabaseErrorToJa(overview.error) };
  }

  const selected = overview.batches.filter((batch) => batchIds.includes(batch.id));

  if (selected.length !== batchIds.length) {
    return {
      ok: false,
      error: "選択した支払明細が見つかりません。画面を再読み込みしてください。",
    };
  }

  const notDraft = selected.filter((batch) => batch.status !== "draft");
  if (notDraft.length > 0) {
    return {
      ok: false,
      error: `下書き以外の支払明細が含まれています（${notDraft
        .map((b) => `${b.payeeName}：${PAYMENT_BATCH_STATUS_LABEL[b.status]}`)
        .join(" / ")}）。承認された支払明細はありません。`,
    };
  }

  const cutoffMonths = [...new Set(selected.map((batch) => batch.cutoffMonth))];
  if (cutoffMonths.length > 1) {
    return {
      ok: false,
      error: `締め対象月が異なる支払明細は同時に承認できません（${cutoffMonths
        .map(formatCutoffLabel)
        .join(" / ")}）。承認された支払明細はありません。`,
    };
  }

  const { data, error } = await auth.supabase.rpc("approve_payment_batches_bulk", {
    p_batch_ids: batchIds,
  });

  if (error) {
    return {
      ok: false,
      error: `一括承認できませんでした。${describeRpcError(
        error.message,
        error.code,
      )} 承認された支払明細はありません。`,
    };
  }

  revalidatePaymentViews();
  for (const id of batchIds) revalidatePath(`/payments/${id}`);

  const approvedCount = Number(data ?? batchIds.length);
  const approvedAmount =
    Math.round(
      selected.reduce((total, batch) => total + batch.paymentAmount, 0) * 100,
    ) / 100;

  return {
    ok: true,
    approvedCount,
    approvedAmount,
    message: `${approvedCount} 件の支払明細を承認しました（${formatCutoffLabel(
      cutoffMonths[0],
    )}締め）。振込先を固定しました。まだ支払済みにはなっていません。`,
  };
}
