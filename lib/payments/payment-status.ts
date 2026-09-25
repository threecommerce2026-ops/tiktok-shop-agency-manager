/*
  支払明細の状態（単一ソース）。

  「支払確定＝支払済み」にしないための状態機械。
  reward item の is_paid を true にしてよいのは paid への遷移だけで、
  それは complete_payment_batch RPC の中でしか起きない。

    draft      支払明細を作成した（金額確定・対象明細を占有済み）
    approved   振込内容を承認した（振込先スナップショット確定・CSV出力可）
    processing 銀行へ送信済み・結果待ち
    paid       振込完了を登録した（ここで初めて支払済みになる）
    failed     振込失敗（占有を解放して未払いへ戻す）
    cancelled  取消（占有を解放して未払いへ戻す）

  遷移表はここが唯一の定義。画面もサーバーアクションもこれを参照する。
  DB 側（RPC）でも同じ条件を検証しているので、UI を迂回しても破れない。
*/

export const PAYMENT_BATCH_STATUSES = [
  "draft",
  "approved",
  "processing",
  "paid",
  "failed",
  "cancelled",
] as const;

export type PaymentBatchStatus = (typeof PAYMENT_BATCH_STATUSES)[number];

export const PAYMENT_BATCH_STATUS_LABEL: Record<PaymentBatchStatus, string> = {
  draft: "下書き",
  approved: "承認済み",
  processing: "振込中",
  paid: "支払済み",
  failed: "振込失敗",
  cancelled: "取消",
};

export const PAYMENT_BATCH_ACTIONS = [
  "created",
  "approved",
  "csv_exported",
  "processing",
  "paid",
  "failed",
  "cancelled",
] as const;

export type PaymentBatchAction = (typeof PAYMENT_BATCH_ACTIONS)[number];

export const PAYMENT_BATCH_ACTION_LABEL: Record<PaymentBatchAction, string> = {
  created: "支払明細を作成",
  approved: "承認",
  csv_exported: "振込CSVを出力",
  processing: "振込中にする",
  paid: "振込完了を登録",
  failed: "振込失敗を登録",
  cancelled: "取消",
};

/** 許可された状態遷移。ここに無い遷移は起こしてはいけない */
const ALLOWED_TRANSITIONS: Record<PaymentBatchStatus, readonly PaymentBatchStatus[]> = {
  draft: ["approved", "cancelled"],
  approved: ["processing", "paid", "failed", "cancelled"],
  processing: ["paid", "failed", "cancelled"],
  // 支払済みからは動かせない。取消も失敗も受け付けない
  paid: [],
  failed: [],
  cancelled: [],
};

export function canTransitionPaymentBatch(
  from: PaymentBatchStatus,
  to: PaymentBatchStatus,
): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

export function allowedPaymentBatchTransitions(
  from: PaymentBatchStatus,
): readonly PaymentBatchStatus[] {
  return ALLOWED_TRANSITIONS[from] ?? [];
}

/**
 * 報酬明細を占有している状態か。
 * この状態の支払明細に入っている明細は、新しい支払明細へ組み入れできない。
 */
export function isOpenPaymentBatchStatus(status: PaymentBatchStatus): boolean {
  return status === "draft" || status === "approved" || status === "processing";
}

/** これ以上遷移しない状態か */
export function isTerminalPaymentBatchStatus(status: PaymentBatchStatus): boolean {
  return status === "paid" || status === "failed" || status === "cancelled";
}

/** 占有を解放して未払いへ戻せる状態か */
export function canReleasePaymentBatch(status: PaymentBatchStatus): boolean {
  return isOpenPaymentBatchStatus(status);
}

export function isPaymentBatchStatus(value: unknown): value is PaymentBatchStatus {
  return PAYMENT_BATCH_STATUSES.includes(value as PaymentBatchStatus);
}

export function paymentBatchStatusLabel(value: string): string {
  return isPaymentBatchStatus(value)
    ? PAYMENT_BATCH_STATUS_LABEL[value]
    : value;
}
