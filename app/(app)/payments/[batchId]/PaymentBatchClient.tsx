"use client";

import Link from "next/link";
import { Fragment, useActionState, useState } from "react";

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
import type {
  PaymentBatchDetail,
  PaymentRewardBreakdown,
} from "@/lib/db/payment-queries";
import { formatCutoffLabel } from "@/lib/payments/cutoff-month";
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

  /*
    画面に出す内訳の合計が支払明細のスナップショットと一致しているか。
    ずれているときは誤った数字を根拠として見せず、エラーとして扱う。
  */
  const breakdownTotal =
    Math.round((detail.agencyRewardAmount + detail.referralRewardAmount) * 100) / 100;
  const breakdownMatches =
    detail.totalsMatchBatch &&
    Math.abs(breakdownTotal - batch.paymentAmount) <= 0.005;

  /*
    紹介制度報酬を含んでいるのは、代理店支払へ合算していた旧仕様の支払明細だけ。
    新しい支払明細には入らないので、実際に明細がある場合だけ表示する。
    過去の履歴は隠さない。
  */
  const hasLegacyReferral = detail.referralBreakdown.creators.length > 0;

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
        {/* この支払明細が何月末締めだったかを必ず残す */}
        <p className="mt-2 text-sm">
          <span className="rounded-md border border-[var(--accent-cyan)]/30 bg-[var(--accent-cyan)]/[0.08] px-2 py-0.5 text-xs font-semibold text-[var(--accent-cyan)]">
            締め対象：{formatCutoffLabel(batch.cutoffMonth)}
          </span>
        </p>
        <p className="mt-2 font-mono text-sm text-zinc-500">
          {batch.periodStartMonth === batch.periodEndMonth
            ? batch.periodStartMonth
            : `${batch.periodStartMonth}〜${batch.periodEndMonth}`}
          {" / "}
          {batch.itemCount.toLocaleString("ja-JP")} 件
        </p>

        {/* 振込予定額と、その内訳を最初に見せる */}
        <div className="mt-4 flex flex-wrap items-end gap-x-8 gap-y-2">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              振込予定額
            </p>
            <p className="mt-1 font-mono text-3xl font-bold text-zinc-50">
              {yen(batch.paymentAmount)}
            </p>
          </div>
          <div className="flex gap-6">
            <div>
              <p className="text-[11px] text-zinc-500">代理店分配報酬</p>
              <p className="mt-0.5 font-mono text-base font-semibold text-sky-200">
                {yen(detail.agencyRewardAmount)}
              </p>
            </div>
            {/*
              代理店へ支払うのは代理店分配報酬だけ。
              紹介制度報酬が入っているのは旧仕様で作られた支払明細だけなので、
              実際に含まれているときだけ「旧仕様」として出す（履歴を隠さない）。
            */}
            {hasLegacyReferral ? (
              <div>
                <p className="text-[11px] text-amber-300">旧仕様：紹介制度報酬</p>
                <p className="mt-0.5 font-mono text-base font-semibold text-violet-200">
                  {yen(detail.referralRewardAmount)}
                </p>
              </div>
            ) : null}
          </div>
        </div>
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
          {/* 支払は代理店へ1回だが、会計上の内訳は必ず残す */}
          <dl className="mt-2 space-y-0.5 text-[11px] text-zinc-500">
            <div className="flex justify-between gap-3">
              <dt>代理店分配報酬</dt>
              <dd className="font-mono">{yen(detail.agencyRewardAmount)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>紹介制度報酬</dt>
              <dd className="font-mono">{yen(detail.referralRewardAmount)}</dd>
            </div>
          </dl>
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

      {!breakdownMatches ? (
        <section
          className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-4 text-sm text-red-100"
          role="alert"
        >
          <p className="font-semibold">支払根拠の内訳が支払明細と一致しません</p>
          <p className="mt-1 text-[11px] leading-relaxed">
            内訳の合計 {yen(breakdownTotal)} と支払明細の {yen(batch.paymentAmount)} が
            一致しないため、誤った根拠を表示しないよう内訳を伏せています。
            再集計や明細の変更が入った可能性があります。承認せずに調査してください。
          </p>
        </section>
      ) : null}

      {/*
        支払根拠。代理店分配報酬と紹介制度報酬を完全に別セクションにする。
        最初から注文単位の大量明細を並べず、クリエイター別 → 月別の2階層で出す。
      */}
      {breakdownMatches ? (
        <>
      <RewardBreakdownSection
        breakdown={detail.agencyBreakdown}
        title="代理店分配報酬"
        totalAmount={detail.agencyRewardAmount}
        baseLabel="分配計算基準額"
        baseHint="TikTokの「収益分配前のクリエイター収益」に相当します。"
        rateLabel="分配率"
        amountLabel="代理店分配額"
        amountHint="TikTok側で分配率・明細単位の丸めを反映した実額です。この金額を支払額として採用します。"
        accent="sky"
      />

      {hasLegacyReferral ? (
        <>
          <p className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-[11px] leading-relaxed text-amber-100">
            <span className="font-semibold">旧仕様の支払明細です。</span>
            現在の業務ルールでは紹介制度報酬を代理店へ支払いません。
            この明細は紹介制度報酬を含んでいた当時の記録として表示しています。
          </p>
          <RewardBreakdownSection
            breakdown={detail.referralBreakdown}
            title="旧仕様：紹介制度報酬"
            totalAmount={detail.referralRewardAmount}
            baseLabel="紹介計算基準額"
            baseHint="紹介制度報酬の計算対象となる成果報酬ベースです。"
            rateLabel="紹介率"
            amountLabel="紹介制度報酬"
            amountHint="紹介計算基準額に紹介率を適用した報酬です。現在は代理店へ支払いません。"
            accent="violet"
          />
        </>
      ) : null}

      <section className="rounded-2xl border border-white/[0.08] bg-surface-1/50 px-4 py-4 sm:px-6">
        <h2 className="text-sm font-semibold text-zinc-200">振込予定額の内訳</h2>
        <dl className="mt-3 space-y-1.5 text-sm">
          <div className="flex items-center justify-between gap-4">
            <dt className="text-zinc-400">代理店分配報酬</dt>
            <dd className="font-mono text-zinc-100">{yen(detail.agencyRewardAmount)}</dd>
          </div>
          {hasLegacyReferral ? (
            <div className="flex items-center justify-between gap-4">
              <dt className="text-amber-300">＋ 旧仕様：紹介制度報酬</dt>
              <dd className="font-mono text-zinc-100">{yen(detail.referralRewardAmount)}</dd>
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-4 border-t border-white/[0.08] pt-2">
            <dt className="font-semibold text-zinc-200">＝ 振込予定額</dt>
            <dd className="font-mono text-lg font-bold text-zinc-50">
              {yen(detail.agencyRewardAmount + detail.referralRewardAmount)}
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-[11px] leading-relaxed text-zinc-600">
          代理店へ支払うのは代理店分配報酬だけです。紹介制度報酬は代理店へは支払いません。
          代理店分配報酬は TikTok が注文明細単位で算出した分配実額（AP）の合計で、
          THREE 側で「分配計算基準額 × 分配率」を掛け直して作り直してはいません。
          TAP収益はどちらにも含まれません。
        </p>
      </section>
        </>
      ) : null}

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

/*
  支払根拠のセクション。

  ■ クリエイター別 → 月別の2階層
  注文単位の明細は1代理店で数百件になるため最初から並べない。
  クリエイター単位で畳んで、必要なときだけ月別へ展開する。

  ■ 金額は snapshot をそのまま出す
  基準額 × 率をこの画面で掛け直して金額を作らない。
  率と基準額は「なぜこの金額なのか」を説明するための表示値。
*/
function RewardBreakdownSection({
  breakdown,
  title,
  totalAmount,
  baseLabel,
  baseHint,
  rateLabel,
  amountLabel,
  amountHint,
  accent,
}: {
  breakdown: PaymentRewardBreakdown;
  title: string;
  totalAmount: number;
  baseLabel: string;
  baseHint: string;
  rateLabel: string;
  amountLabel: string;
  amountHint: string;
  accent: "sky" | "violet";
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const badge =
    accent === "sky" ? "bg-sky-500/15 text-sky-200" : "bg-violet-500/15 text-violet-200";
  const isReferral = breakdown.rewardKind === "referral";

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-zinc-200">
          <span className={`mr-2 rounded px-1.5 py-0.5 text-[10px] font-medium ${badge}`}>
            {title}
          </span>
          <span className="text-zinc-500">
            クリエイター {breakdown.creators.length} 名 / 明細{" "}
            {breakdown.itemCount.toLocaleString("ja-JP")} 件
          </span>
        </h2>
        <p className="font-mono text-base font-bold text-zinc-100">{yen(totalAmount)}</p>
      </div>

      {breakdown.creators.length === 0 ? (
        <p className="rounded-xl border border-zinc-800 bg-zinc-950/60 px-4 py-6 text-center text-sm text-zinc-500">
          この支払明細に{title}はありません。
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950/60">
          <table className="min-w-[980px] w-full border-collapse">
            <thead>
              <tr>
                <th className={th}></th>
                {isReferral ? <th className={th}>紹介者</th> : null}
                <th className={th}>クリエイター</th>
                <th className={th}>TikTok ID</th>
                <th className={th}>対象期間</th>
                <th className={`${th} text-right`} title="売上規模を確認するための参考値です。報酬の直接の計算基準ではありません。">
                  GMV（参考）
                </th>
                <th className={`${th} text-right`} title={baseHint}>
                  {baseLabel}
                </th>
                <th className={`${th} text-right`}>{rateLabel}</th>
                <th className={`${th} text-right`} title={amountHint}>
                  {amountLabel}
                </th>
              </tr>
            </thead>
            <tbody>
              {breakdown.creators.map((creator) => {
                const key = `${creator.referrerName ?? ""}:${creator.creatorId}`;
                const open = expanded.has(key);
                return (
                  <Fragment key={key}>
                    <tr className="border-b border-zinc-800/70">
                      <td className={td}>
                        <button
                          type="button"
                          onClick={() => toggle(key)}
                          aria-expanded={open}
                          className="min-h-[28px] min-w-[28px] rounded-md border border-white/[0.12] text-[11px] text-zinc-300 hover:bg-white/[0.06]"
                        >
                          {open ? "−" : "+"}
                        </button>
                      </td>
                      {isReferral ? (
                        <td className={`${td} text-zinc-300`}>{creator.referrerName ?? "—"}</td>
                      ) : null}
                      <td className={`${td} font-medium text-zinc-100`}>{creator.creatorName}</td>
                      <td className={`${td} font-mono text-zinc-500`}>{creator.tiktokId}</td>
                      <td className={`${td} font-mono text-zinc-400`}>
                        {creator.periodStartMonth === creator.periodEndMonth
                          ? creator.periodStartMonth
                          : `${creator.periodStartMonth}〜${creator.periodEndMonth}`}
                      </td>
                      <td className={`${td} text-right font-mono text-zinc-500`}>
                        {yen(creator.gmv)}
                      </td>
                      <td className={`${td} text-right font-mono text-zinc-300`}>
                        {yen(creator.baseAmount)}
                      </td>
                      <td className={`${td} text-right font-mono text-zinc-500`}>—</td>
                      <td className={`${td} text-right font-mono font-semibold text-zinc-100`}>
                        {yen(creator.rewardAmount)}
                      </td>
                    </tr>

                    {open
                      ? creator.months.map((month) => (
                          <tr
                            key={`${key}:${month.targetMonth}`}
                            className="border-b border-zinc-800/40 bg-surface-1/30"
                          >
                            <td className={td}></td>
                            {isReferral ? <td className={td}></td> : null}
                            <td className={`${td} text-zinc-500`} colSpan={2}>
                              <span className="text-[11px]">
                                明細 {month.itemCount.toLocaleString("ja-JP")} 件
                              </span>
                            </td>
                            <td className={`${td} font-mono text-zinc-300`}>
                              {month.targetMonth}
                            </td>
                            <td className={`${td} text-right font-mono text-zinc-500`}>
                              {yen(month.gmv)}
                            </td>
                            <td className={`${td} text-right font-mono text-zinc-300`}>
                              {yen(month.baseAmount)}
                            </td>
                            <td className={`${td} text-right font-mono text-zinc-300`}>
                              {month.ratePct ? `${month.ratePct}%` : "—"}
                            </td>
                            <td className={`${td} text-right font-mono text-zinc-100`}>
                              {yen(month.rewardAmount)}
                            </td>
                          </tr>
                        ))
                      : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
