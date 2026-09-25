"use client";

import Link from "next/link";
import { useActionState } from "react";

import {
  approvePaymentBatchAction,
  cancelPaymentBatchAction,
  completePaymentBatchAction,
  exportPaymentCsvAction,
  failPaymentBatchAction,
  setPaymentBatchProcessingAction,
  type PaymentActionResult,
  type PaymentCsvActionResult,
} from "@/app/actions/payments";
import type { PaymentBatchDetail } from "@/lib/db/payment-queries";
import { BankStateBadge } from "@/components/payments/PayeeBankForm";
import { PAYEE_KIND_LABEL } from "@/lib/payments/payable";
import {
  PAYMENT_BATCH_ACTION_LABEL,
  PAYMENT_BATCH_STATUS_LABEL,
  canTransitionPaymentBatch,
  type PaymentBatchAction,
} from "@/lib/payments/payment-status";

/*
  支払明細の詳細と状態遷移。

  ボタンの出し分けは canTransitionPaymentBatch()（単一ソース）に従う。
  同じ条件を RPC 側でも検証しているので、UI を迂回しても壊れない。

  ■ 「振込完了」は実際に銀行振込を終えてから
  この操作で初めて報酬明細が支払済みになる。
*/

const th =
  "whitespace-nowrap border-b border-zinc-800 bg-surface-1/80 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-500";
const td = "whitespace-nowrap px-3 py-2 text-xs";

const yen = (value: number | null | undefined) =>
  value == null ? "—" : `¥${Math.round(value).toLocaleString("ja-JP")}`;

function Banner({
  state,
}: {
  state: { ok: true; message: string } | { ok: false; error: string } | null;
}) {
  if (!state) return null;
  return (
    <p
      className={`rounded-lg border px-3 py-2 text-[11px] leading-relaxed ${
        state.ok
          ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-200"
          : "border-red-500/25 bg-red-500/10 text-red-200"
      }`}
      role="status"
    >
      {state.ok ? state.message : state.error}
    </p>
  );
}

function downloadCsv(fileName: string, content: string) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function PaymentBatchClient({
  detail,
  today,
}: {
  detail: PaymentBatchDetail;
  today: string;
}) {
  const batch = detail.batch!;

  const [approveState, approveAction, approvePending] = useActionState(
    approvePaymentBatchAction,
    null as PaymentActionResult | null,
  );
  const [processingState, processingAction, processingPending] = useActionState(
    setPaymentBatchProcessingAction,
    null as PaymentActionResult | null,
  );
  const [completeState, completeAction, completePending] = useActionState(
    completePaymentBatchAction,
    null as PaymentActionResult | null,
  );
  const [failState, failAction, failPending] = useActionState(
    failPaymentBatchAction,
    null as PaymentActionResult | null,
  );
  const [cancelState, cancelAction, cancelPending] = useActionState(
    cancelPaymentBatchAction,
    null as PaymentActionResult | null,
  );
  const [csvState, csvAction, csvPending] = useActionState(
    async (prev: PaymentCsvActionResult | null, formData: FormData) => {
      const result = await exportPaymentCsvAction(prev, formData);
      if (result.ok) downloadCsv(result.fileName, result.content);
      return result;
    },
    null as PaymentCsvActionResult | null,
  );

  const canApprove = canTransitionPaymentBatch(batch.status, "approved");
  const canProcess = canTransitionPaymentBatch(batch.status, "processing");
  const canComplete = canTransitionPaymentBatch(batch.status, "paid");
  const canFail = canTransitionPaymentBatch(batch.status, "failed");
  const canCancel = canTransitionPaymentBatch(batch.status, "cancelled");
  const canExportCsv = batch.status === "approved" || batch.status === "processing";

  const amountMatches =
    Math.abs(detail.itemsTotalAmount - batch.paymentAmount) <= 0.005 &&
    detail.items.length === batch.itemCount;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/payments" className="text-xs text-zinc-500 hover:underline">
          ← 支払管理
        </Link>
        <p className="mt-3 text-xs font-medium uppercase tracking-wider text-zinc-500">
          {PAYEE_KIND_LABEL[batch.payeeKind]} / {PAYMENT_BATCH_STATUS_LABEL[batch.status]}
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
          {batch.payeeName}
        </h1>
        <p className="mt-2 font-mono text-sm text-zinc-500">
          {batch.periodStartMonth === batch.periodEndMonth
            ? batch.periodStartMonth
            : `${batch.periodStartMonth}〜${batch.periodEndMonth}`}
          {" / "}
          {batch.itemCount.toLocaleString("ja-JP")} 件
        </p>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-[var(--accent-cyan)]/30 bg-[var(--accent-cyan)]/[0.06] px-4 py-4">
          <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
            今回振込額
          </p>
          <p className="mt-2 font-mono text-xl font-bold text-zinc-50">
            {yen(batch.paymentAmount)}
          </p>
        </div>
        <div className="rounded-xl border border-white/[0.08] bg-surface-1 px-4 py-4">
          <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
            明細の実額合計
          </p>
          <p
            className={`mt-2 font-mono text-xl font-bold ${
              amountMatches ? "text-zinc-50" : "text-red-300"
            }`}
          >
            {yen(detail.itemsTotalAmount)}
          </p>
          <p className="mt-1 text-[11px] text-zinc-500">
            {amountMatches ? "支払明細と一致" : "支払明細と不一致（振込完了は拒否されます）"}
          </p>
        </div>
        <div className="rounded-xl border border-white/[0.08] bg-surface-1 px-4 py-4">
          <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
            作成日時
          </p>
          <p className="mt-2 font-mono text-sm text-zinc-200">
            {batch.createdAt ? batch.createdAt.slice(0, 19).replace("T", " ") : "—"}
          </p>
          <p className="mt-1 text-[11px] text-zinc-500">
            承認 {batch.approvedAt ? batch.approvedAt.slice(0, 10) : "—"}
          </p>
        </div>
        <div className="rounded-xl border border-white/[0.08] bg-surface-1 px-4 py-4">
          <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
            振込日
          </p>
          <p className="mt-2 font-mono text-sm text-zinc-200">{batch.paidOn ?? "—"}</p>
          {batch.failureReason ? (
            <p className="mt-1 text-[11px] text-red-300">{batch.failureReason}</p>
          ) : null}
        </div>
      </section>

      <section className="space-y-2 rounded-xl border border-white/[0.08] bg-surface-1/60 p-4">
        <h2 className="text-sm font-semibold text-zinc-200">振込先</h2>
        {batch.bank ? (
          <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-300">
            <BankStateBadge state={batch.bank.state} />
            <span className="font-mono">
              {batch.bank.bankName}（{batch.bank.bankCode ?? "—"}） /{" "}
              {batch.bank.bankBranchName}（{batch.bank.bankBranchCode ?? "—"}） /{" "}
              {batch.bank.bankAccountType} / {batch.bank.accountNumberMasked} /{" "}
              {batch.bank.bankAccountHolder}
            </span>
          </div>
        ) : (
          <p className="text-[11px] text-zinc-500">
            承認するとこの支払明細に振込先が固定されます。以後マスタ側の口座を変更しても、
            この支払明細の振込先は変わりません。
          </p>
        )}
        <p className="text-[11px] text-zinc-500">
          口座番号は下4桁のみ表示しています。全文は振込CSVにだけ出力されます。
        </p>
      </section>

      <Banner state={approveState} />
      <Banner state={processingState} />
      <Banner state={completeState} />
      <Banner state={failState} />
      <Banner state={cancelState} />
      <Banner
        state={
          csvState == null
            ? null
            : csvState.ok
              ? {
                  ok: true,
                  message: `振込CSVを出力しました（合計 ${yen(csvState.totalAmount)}）。`,
                }
              : csvState
        }
      />

      <section className="space-y-3 rounded-xl border border-white/[0.08] bg-surface-1/60 p-4">
        <h2 className="text-sm font-semibold text-zinc-200">操作</h2>

        <div className="flex flex-wrap items-center gap-2">
          {canApprove ? (
            <form action={approveAction}>
              <input type="hidden" name="batch_id" value={batch.id} />
              <button
                type="submit"
                disabled={approvePending}
                className="min-h-[40px] rounded-lg bg-[var(--accent-cyan)] px-4 text-sm font-semibold text-black disabled:opacity-50"
              >
                {approvePending ? "承認中…" : "承認する（振込先を固定）"}
              </button>
            </form>
          ) : null}

          {canExportCsv ? (
            <form action={csvAction}>
              <input type="hidden" name="batch_id" value={batch.id} />
              <button
                type="submit"
                disabled={csvPending}
                className="min-h-[40px] rounded-lg border border-white/[0.12] px-4 text-sm font-medium text-zinc-100 hover:bg-white/[0.06] disabled:opacity-50"
              >
                {csvPending ? "出力中…" : "振込CSVを出力"}
              </button>
            </form>
          ) : null}

          {canProcess ? (
            <form action={processingAction}>
              <input type="hidden" name="batch_id" value={batch.id} />
              <button
                type="submit"
                disabled={processingPending}
                className="min-h-[40px] rounded-lg border border-white/[0.12] px-4 text-sm font-medium text-zinc-300 hover:bg-white/[0.06] disabled:opacity-50"
              >
                振込中にする
              </button>
            </form>
          ) : null}
        </div>

        {canComplete ? (
          <form
            action={completeAction}
            className="space-y-2 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.05] p-3"
          >
            <input type="hidden" name="batch_id" value={batch.id} />
            <p className="text-[11px] leading-relaxed text-emerald-100">
              実際に銀行振込を終えてから実行してください。
              <span className="font-semibold">
                この操作で初めて {batch.itemCount.toLocaleString("ja-JP")} 件の報酬明細が支払済みになります。
              </span>
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-[11px] text-zinc-400">
                振込日
                <input
                  type="date"
                  name="paid_on"
                  defaultValue={today}
                  max={today}
                  className="mt-1 block min-h-[36px] rounded-lg border border-white/[0.1] bg-surface-1 px-3 text-xs text-zinc-100"
                />
              </label>
              <label className="flex-1 text-[11px] text-zinc-400">
                メモ（任意）
                <input
                  type="text"
                  name="memo"
                  className="mt-1 block min-h-[36px] w-full rounded-lg border border-white/[0.1] bg-surface-1 px-3 text-xs text-zinc-100"
                />
              </label>
              <button
                type="submit"
                disabled={completePending || !amountMatches}
                className="min-h-[40px] rounded-lg bg-emerald-400 px-4 text-sm font-semibold text-black disabled:opacity-50"
              >
                {completePending ? "登録中…" : "振込完了を登録する"}
              </button>
            </div>
          </form>
        ) : null}

        <div className="flex flex-wrap items-end gap-3">
          {canFail ? (
            <form action={failAction} className="flex items-end gap-2">
              <input type="hidden" name="batch_id" value={batch.id} />
              <label className="text-[11px] text-zinc-400">
                失敗理由
                <input
                  type="text"
                  name="reason"
                  placeholder="口座相違 など"
                  className="mt-1 block min-h-[36px] w-48 rounded-lg border border-white/[0.1] bg-surface-1 px-3 text-xs text-zinc-100"
                />
              </label>
              <button
                type="submit"
                disabled={failPending}
                className="min-h-[36px] rounded-lg border border-red-400/30 px-3 text-xs font-medium text-red-200 hover:bg-red-400/10 disabled:opacity-50"
              >
                振込失敗として戻す
              </button>
            </form>
          ) : null}

          {canCancel ? (
            <form action={cancelAction} className="flex items-end gap-2">
              <input type="hidden" name="batch_id" value={batch.id} />
              <label className="text-[11px] text-zinc-400">
                取消理由
                <input
                  type="text"
                  name="reason"
                  className="mt-1 block min-h-[36px] w-48 rounded-lg border border-white/[0.1] bg-surface-1 px-3 text-xs text-zinc-100"
                />
              </label>
              <button
                type="submit"
                disabled={cancelPending}
                className="min-h-[36px] rounded-lg border border-white/[0.12] px-3 text-xs font-medium text-zinc-300 hover:bg-white/[0.06] disabled:opacity-50"
              >
                取り消す
              </button>
            </form>
          ) : null}
        </div>

        {batch.status === "paid" ? (
          <p className="text-[11px] text-zinc-500">
            支払済みです。取消・失敗の登録はできません（対象明細を未払いへ戻すことはしません）。
          </p>
        ) : null}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-zinc-200">
          対象明細（{detail.items.length.toLocaleString("ja-JP")}）
        </h2>
        <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950/60">
          <table className="min-w-[900px] w-full border-collapse">
            <thead>
              <tr>
                <th className={th}>対象月</th>
                <th className={th}>クリエイター</th>
                <th className={th}>TikTok ID</th>
                <th className={`${th} text-right`}>報酬計算元</th>
                <th className={`${th} text-right`}>報酬率</th>
                <th className={`${th} text-right`}>報酬額</th>
                <th className={th}>支払状態</th>
              </tr>
            </thead>
            <tbody>
              {detail.items.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-sm text-zinc-500">
                    対象明細がありません。
                  </td>
                </tr>
              ) : (
                detail.items.map((item) => (
                  <tr key={item.id} className="border-b border-zinc-800/70">
                    <td className={`${td} font-mono text-zinc-300`}>{item.targetMonth}</td>
                    <td className={`${td} text-zinc-100`}>{item.creatorName}</td>
                    <td className={`${td} font-mono text-zinc-500`}>{item.tiktokId}</td>
                    <td className={`${td} text-right font-mono text-zinc-400`}>
                      {yen(item.baseAmount)}
                    </td>
                    <td className={`${td} text-right font-mono text-zinc-400`}>
                      {item.ratePct ? `${item.ratePct}%` : "—"}
                    </td>
                    <td className={`${td} text-right font-mono font-semibold text-zinc-100`}>
                      {yen(item.rewardAmount)}
                    </td>
                    <td className={`${td} text-zinc-400`}>
                      {item.isPaid ? "支払済み" : "未払い（占有中）"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-zinc-500">
          {batch.payeeKind === "agency"
            ? "代理店報酬は agency_reward_items が正式source。報酬率（AK）は表示専用で、金額の計算には使いません。"
            : "紹介者報酬は referral_reward_items が正式source。金額は上限調整後の adjusted_reward_amount です。"}
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-zinc-200">操作履歴</h2>
        <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950/60">
          <table className="min-w-[840px] w-full border-collapse">
            <thead>
              <tr>
                <th className={th}>日時</th>
                <th className={th}>操作</th>
                <th className={th}>状態</th>
                <th className={`${th} text-right`}>件数</th>
                <th className={`${th} text-right`}>金額</th>
                <th className={th}>操作者</th>
                <th className={th}>メモ</th>
              </tr>
            </thead>
            <tbody>
              {detail.auditLogs.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-sm text-zinc-500">
                    操作履歴がありません。
                  </td>
                </tr>
              ) : (
                detail.auditLogs.map((log) => (
                  <tr key={log.id} className="border-b border-zinc-800/70">
                    <td className={`${td} font-mono text-zinc-400`}>
                      {log.createdAt.slice(0, 19).replace("T", " ")}
                    </td>
                    <td className={`${td} text-zinc-200`}>
                      {PAYMENT_BATCH_ACTION_LABEL[log.action as PaymentBatchAction] ??
                        log.action}
                    </td>
                    <td className={`${td} font-mono text-zinc-500`}>
                      {log.fromStatus ?? "—"} → {log.toStatus ?? "—"}
                    </td>
                    <td className={`${td} text-right font-mono text-zinc-400`}>
                      {log.itemCount == null ? "—" : log.itemCount.toLocaleString("ja-JP")}
                    </td>
                    <td className={`${td} text-right font-mono text-zinc-400`}>
                      {yen(log.amount)}
                    </td>
                    <td className={`${td} text-zinc-400`}>{log.actorEmail ?? "—"}</td>
                    <td className={`${td} whitespace-normal text-zinc-400`}>
                      {log.note ?? "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
