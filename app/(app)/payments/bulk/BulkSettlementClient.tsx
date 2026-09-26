"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { formatCutoffLabel } from "@/lib/payments/cutoff-month";

import {
  createPaymentBatchesBulkAction,
  previewBulkSettlementAction,
  type BulkSettlementPreviewResult,
  type BulkSettlementPreviewRow,
  type BulkSettlementResult,
} from "@/app/actions/payments";
import {
  PAYEE_KIND_LABEL,
  PAYMENT_HOLD_REASON_HINT,
  PAYMENT_HOLD_REASON_LABEL,
  type PaymentHoldReason,
} from "@/lib/payments/payable";
import { BANK_ACCOUNT_STATE_LABEL } from "@/lib/payments/bank-account";

/*
  過去未払いの一括精算。

  ① 対象期間を決める（サービス開始月 〜 締め月）
  ② READ ONLY プレビューで「支払可能 / 保留」を分ける
  ③ 支払可能分だけ支払明細（draft）を作る
  ④ 支払管理へ戻り、承認 → CSV → 振込 → 振込完了登録

  ③ で支払済みにはしない。
*/

const th =
  "whitespace-nowrap border-b border-zinc-800 bg-surface-1/80 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-500";
const td = "whitespace-nowrap px-3 py-2 text-xs";

const yen = (value: number) => `¥${Math.round(value).toLocaleString("ja-JP")}`;

/** サービス開始より前の月。ここを既定の開始月にする */
const DEFAULT_START_MONTH = "2026-01";

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

export function BulkSettlementClient({
  cutoffMonth: initialCutoffMonth,
  cutoffOptions,
  cutoffError,
}: {
  /** 締め対象月。/payments から引き継ぐ */
  cutoffMonth: string;
  cutoffOptions: string[];
  cutoffError: string | null;
}) {
  const [startMonth, setStartMonth] = useState(DEFAULT_START_MONTH);
  const [cutoffMonth, setCutoffMonth] = useState(initialCutoffMonth);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [previewState, previewAction, previewPending] = useActionState(
    previewBulkSettlementAction,
    null as BulkSettlementPreviewResult | null,
  );
  const [createState, createAction, createPending] = useActionState(
    createPaymentBatchesBulkAction,
    null as BulkSettlementResult | null,
  );

  const preview = previewState?.ok ? previewState : null;

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAll = () => {
    setSelected(new Set((preview?.payable ?? []).map((row) => row.payeeKey)));
  };

  const selectedAmount =
    preview?.payable
      .filter((row) => selected.has(row.payeeKey))
      .reduce((sum, row) => sum + row.amount, 0) ?? 0;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/payments" className="text-xs text-zinc-500 hover:underline">
          ← 支払管理
        </Link>
        <h1 className="mt-3 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
          過去未払いの一括精算
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-500">
          指定した期間の未払いをまとめて支払明細にします。
          <span className="font-semibold text-zinc-300">
            作成されるのはすべて下書きです。この画面から支払済みにはなりません。
          </span>
          過去CSVの投入と再集計をすべて終えてから実行してください。
        </p>
      </div>

      {cutoffError ? (
        <p
          className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100"
          role="alert"
        >
          {cutoffError}
          <br />
          <span className="text-[11px]">
            安全側の既定（{formatCutoffLabel(cutoffMonth)}）を選択しています。
          </span>
        </p>
      ) : null}

      <form
        action={previewAction}
        className="flex flex-wrap items-end gap-3 rounded-xl border border-white/[0.08] bg-surface-1/60 p-4"
      >
        <label className="text-[11px] text-zinc-400">
          開始月
          <input
            type="month"
            name="start_month"
            value={startMonth}
            onChange={(event) => setStartMonth(event.target.value)}
            className="mt-1 block min-h-[36px] rounded-lg border border-white/[0.1] bg-surface-1 px-3 text-xs text-zinc-100"
          />
        </label>
        <label className="text-[11px] text-zinc-400">
          締め対象月
          <select
            name="cutoff_month"
            value={cutoffMonth}
            onChange={(event) => setCutoffMonth(event.target.value)}
            className="mt-1 block min-h-[36px] rounded-lg border border-white/[0.1] bg-surface-1 px-3 text-xs text-zinc-100"
          >
            {cutoffOptions.map((month) => (
              <option key={month} value={month}>
                {formatCutoffLabel(month)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={previewPending}
          className="min-h-[40px] rounded-lg bg-[var(--accent-cyan)] px-4 text-sm font-semibold text-black disabled:opacity-50"
        >
          {previewPending ? "集計中…" : "プレビュー（DBは変更しません）"}
        </button>
      </form>

      {previewState && !previewState.ok ? (
        <Banner state={previewState} />
      ) : null}
      <Banner
        state={
          createState == null
            ? null
            : createState.ok
              ? { ok: true, message: createState.message }
              : createState
        }
      />

      {createState?.ok && createState.skipped.length > 0 ? (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-4 py-3 text-[11px] leading-relaxed text-amber-100">
          <p className="font-semibold">作成しなかった支払先（{createState.skipped.length}）</p>
          <ul className="mt-2 space-y-1">
            {createState.skipped.map((item) => (
              <li key={item.payeeName}>
                {item.payeeName}: {item.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {preview ? (
        <>
          <section className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-emerald-400/25 bg-emerald-400/[0.06] px-4 py-4">
              <p className="text-[11px] uppercase tracking-wide text-zinc-500">支払可能</p>
              <p className="mt-2 font-mono text-xl font-bold text-zinc-50">
                {yen(preview.payableAmount)}
              </p>
              <p className="mt-1 text-[11px] text-zinc-500">{preview.payable.length} 件</p>
            </div>
            <div className="rounded-xl border border-amber-400/25 bg-amber-400/[0.06] px-4 py-4">
              <p className="text-[11px] uppercase tracking-wide text-zinc-500">支払保留</p>
              <p className="mt-2 font-mono text-xl font-bold text-zinc-50">
                {yen(preview.heldAmount)}
              </p>
              <p className="mt-1 text-[11px] text-zinc-500">{preview.held.length} 件</p>
            </div>
            <div className="rounded-xl border border-white/[0.08] bg-surface-1 px-4 py-4">
              <p className="text-[11px] uppercase tracking-wide text-zinc-500">選択中</p>
              <p className="mt-2 font-mono text-xl font-bold text-zinc-50">
                {yen(selectedAmount)}
              </p>
              <p className="mt-1 text-[11px] text-zinc-500">{selected.size} 件</p>
            </div>
          </section>

          <form action={createAction} className="space-y-3">
            <input type="hidden" name="start_month" value={preview.startMonth} />
            {/* 実行時もサーバー/RPCで同じ締め対象月を再検証する */}
            <input type="hidden" name="cutoff_month" value={preview.cutoffMonth} />
            {[...selected].map((key) => (
              <input key={key} type="hidden" name="payee_key" value={key} />
            ))}

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={selectAll}
                className="min-h-[36px] rounded-lg border border-white/[0.1] px-3 text-xs font-medium text-zinc-300 hover:bg-white/[0.06]"
              >
                支払可能をすべて選択
              </button>
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="min-h-[36px] rounded-lg border border-white/[0.1] px-3 text-xs font-medium text-zinc-400 hover:bg-white/[0.06]"
              >
                選択を解除
              </button>
              <button
                type="submit"
                disabled={createPending || selected.size === 0}
                className="min-h-[40px] rounded-lg bg-[var(--accent-cyan)] px-4 text-sm font-semibold text-black disabled:opacity-50"
              >
                {createPending
                  ? "作成中…"
                  : `支払可能分のみ支払明細を作成（${selected.size}件 / ${yen(selectedAmount)}）`}
              </button>
            </div>

            <PreviewTable
              title={`支払可能（${preview.payable.length}）`}
              rows={preview.payable}
              selected={selected}
              onToggle={toggle}
              emptyMessage="この期間に支払可能な未払いはありません。"
            />
          </form>

          <PreviewTable
            title={`支払保留（${preview.held.length}）`}
            rows={preview.held}
            emptyMessage="保留中の支払先はありません。"
          />
        </>
      ) : null}
    </div>
  );
}

function PreviewTable({
  title,
  rows,
  selected,
  onToggle,
  emptyMessage,
}: {
  title: string;
  rows: BulkSettlementPreviewRow[];
  selected?: Set<string>;
  onToggle?: (key: string) => void;
  emptyMessage: string;
}) {
  const selectable = selected != null && onToggle != null;

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-zinc-200">{title}</h2>
      <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950/60">
        <table className="min-w-[900px] w-full border-collapse">
          <thead>
            <tr>
              {selectable ? <th className={th}></th> : null}
              <th className={th}>種別</th>
              <th className={th}>支払先</th>
              <th className={`${th} text-right`}>明細数</th>
              <th className={`${th} text-right`}>代理店報酬</th>
              <th className={`${th} text-right`}>紹介報酬</th>
              <th className={`${th} text-right`}>金額</th>
              <th className={th}>振込先状態</th>
              <th className={th}>保留理由</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={selectable ? 9 : 8}
                  className="px-4 py-10 text-center text-sm text-zinc-500"
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.payeeKey} className="border-b border-zinc-800/70">
                  {selectable ? (
                    <td className={td}>
                      <input
                        type="checkbox"
                        checked={selected.has(row.payeeKey)}
                        onChange={() => onToggle(row.payeeKey)}
                        aria-label={`${row.payeeName} を選択`}
                      />
                    </td>
                  ) : null}
                  <td className={`${td} text-zinc-400`}>
                    {PAYEE_KIND_LABEL[row.payeeKind]}
                  </td>
                  <td className={`${td} font-medium text-zinc-100`}>{row.payeeName}</td>
                  <td className={`${td} text-right font-mono text-zinc-400`}>
                    {row.itemCount.toLocaleString("ja-JP")}
                  </td>
                  {/* 支払は代理店へ1回だが、会計上の内訳は保持する */}
                  <td className={`${td} text-right font-mono text-zinc-300`}>
                    {row.agencyRewardAmount > 0 ? yen(row.agencyRewardAmount) : "—"}
                  </td>
                  <td className={`${td} text-right font-mono text-zinc-300`}>
                    {row.referralRewardAmount > 0 ? yen(row.referralRewardAmount) : "—"}
                  </td>
                  <td className={`${td} text-right font-mono font-semibold text-zinc-100`}>
                    {yen(row.amount)}
                  </td>
                  <td className={`${td} text-zinc-400`}>
                    {BANK_ACCOUNT_STATE_LABEL[
                      row.bankState as keyof typeof BANK_ACCOUNT_STATE_LABEL
                    ] ?? row.bankState}
                  </td>
                  <td className={`${td} whitespace-normal`}>
                    {row.holdReasons.length === 0 ? (
                      <span className="text-zinc-500">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {row.holdReasons.map((reason) => (
                          <span
                            key={reason}
                            title={PAYMENT_HOLD_REASON_HINT[reason as PaymentHoldReason]}
                            className="whitespace-nowrap rounded-full border border-amber-400/25 bg-amber-400/10 px-2 py-0.5 text-[11px] text-amber-200"
                          >
                            {PAYMENT_HOLD_REASON_LABEL[reason as PaymentHoldReason]}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
