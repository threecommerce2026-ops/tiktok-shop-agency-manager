"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";

import {
  createPaymentBatchAction,
  exportPaymentCsvAction,
  type PaymentActionResult,
  type PaymentCsvActionResult,
} from "@/app/actions/payments";
import { PayeeBankForm } from "@/components/payments/PayeeBankForm";
import type {
  PaymentBatchSummary,
  PaymentOverview,
  PaymentUnpaidRow,
} from "@/lib/db/payment-queries";
import {
  PAYEE_KIND_LABEL,
  PAYMENT_HOLD_REASON_HINT,
  PAYMENT_HOLD_REASON_LABEL,
  type PayeeKind,
} from "@/lib/payments/payable";
import {
  PAYMENT_BATCH_STATUS_LABEL,
  isOpenPaymentBatchStatus,
  type PaymentBatchStatus,
} from "@/lib/payments/payment-status";

/*
  支払管理の一覧。

  ■ 二重表示しない
  payment_batch_id が付いた明細は未払残高から外れているので、
  「未払い」と「支払予定中」が同じ金額で二重に見えることはない。
  占有中の金額は別カラム（支払予定中）で出す。

  ■ 口座番号
  サーバーから来るのはマスク済みの形だけ。全文はこの画面に存在しない。
*/

const th =
  "whitespace-nowrap border-b border-zinc-800 bg-surface-1/80 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-500";
const td = "whitespace-nowrap px-3 py-2 text-xs";

const yen = (value: number | null | undefined) =>
  value == null ? "—" : `¥${Math.round(value).toLocaleString("ja-JP")}`;

const TABS = [
  { key: "all", label: "すべて" },
  { key: "agency", label: "代理店" },
  { key: "referrer", label: "代理店未設定の紹介者" },
  { key: "hold", label: "振込保留" },
  { key: "history", label: "支払履歴" },
  { key: "seller", label: "セラー請求" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const BATCH_STATUS_CLASS: Record<PaymentBatchStatus, string> = {
  draft: "border-white/[0.1] bg-white/[0.04] text-zinc-300",
  approved: "border-cyan-400/25 bg-cyan-400/10 text-cyan-200",
  processing: "border-indigo-400/25 bg-indigo-400/10 text-indigo-200",
  paid: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  failed: "border-red-400/25 bg-red-400/10 text-red-200",
  cancelled: "border-zinc-500/25 bg-zinc-500/10 text-zinc-400",
};

const SELLER_STATUS_LABEL: Record<string, string> = {
  draft: "下書き",
  issued: "発行済み",
  paid: "入金済み",
  cancelled: "取消",
};

function BatchStatusBadge({ status }: { status: PaymentBatchStatus }) {
  return (
    <span
      className={`whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] ${BATCH_STATUS_CLASS[status]}`}
    >
      {PAYMENT_BATCH_STATUS_LABEL[status]}
    </span>
  );
}

function Kpi({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "strong" | "muted";
}) {
  return (
    <div
      className={`rounded-xl border px-4 py-4 ${
        tone === "strong"
          ? "border-[var(--accent-cyan)]/30 bg-[var(--accent-cyan)]/[0.06]"
          : tone === "muted"
            ? "border-white/[0.06] bg-surface-1/40"
            : "border-white/[0.08] bg-surface-1"
      }`}
    >
      <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
        {label}
      </p>
      <p className="mt-2 font-mono text-xl font-bold text-zinc-50">{value}</p>
      {hint ? <p className="mt-1 text-[11px] text-zinc-500">{hint}</p> : null}
    </div>
  );
}

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

function HoldReasons({ row }: { row: PaymentUnpaidRow }) {
  if (row.holdReasons.length === 0) return <span className="text-zinc-500">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {row.holdReasons.map((reason) => (
        <span
          key={reason}
          title={PAYMENT_HOLD_REASON_HINT[reason]}
          className="whitespace-nowrap rounded-full border border-amber-400/25 bg-amber-400/10 px-2 py-0.5 text-[11px] text-amber-200"
        >
          {PAYMENT_HOLD_REASON_LABEL[reason]}
        </span>
      ))}
    </div>
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

export function PaymentsClient({
  overview,
  defaultMonth,
}: {
  overview: PaymentOverview;
  defaultMonth: string;
}) {
  const [tab, setTab] = useState<TabKey>("all");
  const [search, setSearch] = useState("");
  const [bankFilter, setBankFilter] = useState<"all" | "registered" | "not_ready">("all");
  const [payableOnly, setPayableOnly] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [createState, createAction, createPending] = useActionState(
    createPaymentBatchAction,
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

  const unpaidRows = useMemo(() => {
    const keyword = search.trim().toLowerCase();

    return overview.rows.filter((row) => {
      if (row.unpaidAmount <= 0 && row.claimedAmount <= 0) return false;
      if (tab === "agency" && row.payeeKind !== "agency") return false;
      if (tab === "referrer" && row.payeeKind !== "referrer") return false;
      if (tab === "hold" && !(row.unpaidAmount > 0 && row.holdReasons.length > 0)) {
        return false;
      }
      if (payableOnly && !row.isPayable) return false;
      if (bankFilter === "registered" && row.bank.state !== "registered") return false;
      if (bankFilter === "not_ready" && row.bank.state === "registered") return false;
      if (keyword && !row.payeeName.toLowerCase().includes(keyword)) return false;
      return true;
    });
  }, [overview.rows, tab, search, payableOnly, bankFilter]);

  const openBatches = overview.batches.filter((batch) =>
    isOpenPaymentBatchStatus(batch.status),
  );
  const historyBatches = overview.batches.filter(
    (batch) => !isOpenPaymentBatchStatus(batch.status),
  );

  const exportableIds = openBatches
    .filter((batch) => batch.status === "approved" || batch.status === "processing")
    .map((batch) => batch.id);

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectedRows = unpaidRows.filter(
    (row) => row.isPayable && selected.has(`${row.payeeKind}:${row.payeeId}`),
  );

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          親管理画面
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
          支払管理
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-500">
          代理店・紹介者への振込を、支払明細の作成 → 承認 → 振込CSV → 振込完了登録
          の順で管理します。
          <span className="font-semibold text-zinc-300">
            「振込完了」を登録するまで報酬明細は支払済みになりません。
          </span>
        </p>
      </div>

      {overview.error ? (
        <p className="rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {overview.error}
        </p>
      ) : null}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Kpi
          label="今回支払予定総額"
          value={yen(overview.totals.scheduledAmount)}
          hint={`支払明細 ${overview.totals.scheduledBatchCount} 件（未振込）`}
          tone="strong"
        />
        <Kpi label="代理店報酬 未払" value={yen(overview.totals.agencyUnpaidAmount)} />
        <Kpi label="紹介報酬 未払" value={yen(overview.totals.referrerUnpaidAmount)} />
        <Kpi
          label="振込保留"
          value={yen(overview.totals.holdAmount)}
          hint={`${overview.totals.holdCount} 件`}
        />
        <Kpi
          label="支払先数"
          value={`${overview.totals.payeeCount} 件`}
          hint="いま支払明細を作れる支払先"
        />
        <Kpi
          label="セラー未入金"
          value={yen(overview.totals.sellerUnpaidAmount)}
          hint={`発行済み ${overview.totals.sellerUnpaidCount} 件・支払総額には含みません`}
          tone="muted"
        />
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <Link
          href="/payments/bulk"
          className="min-h-[40px] rounded-lg border border-white/[0.1] px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-white/[0.06]"
        >
          過去未払いを一括精算
        </Link>
        <Link
          href="/revenue?tab=agency"
          className="min-h-[40px] rounded-lg border border-white/[0.1] px-4 py-2 text-sm font-medium text-zinc-400 hover:bg-white/[0.06]"
        >
          代理店報酬の再集計
        </Link>
        <Link
          href="/revenue?tab=referral"
          className="min-h-[40px] rounded-lg border border-white/[0.1] px-4 py-2 text-sm font-medium text-zinc-400 hover:bg-white/[0.06]"
        >
          紹介者報酬の再集計
        </Link>
      </div>

      <nav
        className="flex gap-1 overflow-x-auto rounded-xl border border-white/[0.06] bg-surface-1/50 p-1"
        aria-label="支払管理タブ"
      >
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            aria-current={item.key === tab ? "page" : undefined}
            className={`min-h-[40px] flex-1 whitespace-nowrap rounded-lg px-4 py-2 text-center text-sm transition ${
              item.key === tab
                ? "bg-white/[0.1] font-semibold text-zinc-50"
                : "font-medium text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100"
            }`}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <Banner state={createState} />
      <Banner
        state={
          csvState == null
            ? null
            : csvState.ok
              ? {
                  ok: true,
                  message: `振込CSVを出力しました（${csvState.batchCount} 件 / 合計 ${yen(csvState.totalAmount)}）。`,
                }
              : csvState
        }
      />

      {tab === "history" ? (
        <BatchTable
          title="支払履歴"
          batches={historyBatches}
          emptyMessage="まだ確定した支払明細はありません。"
        />
      ) : tab === "seller" ? (
        <SellerInvoiceTable overview={overview} />
      ) : (
        <>
          {openBatches.length > 0 ? (
            <section className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-zinc-200">
                  進行中の支払明細（{openBatches.length}）
                </h2>
                {exportableIds.length > 0 ? (
                  <form action={csvAction}>
                    {exportableIds.map((id) => (
                      <input key={id} type="hidden" name="batch_id" value={id} />
                    ))}
                    <button
                      type="submit"
                      disabled={csvPending}
                      className="min-h-[36px] rounded-lg border border-white/[0.1] px-3 text-xs font-medium text-zinc-200 hover:bg-white/[0.06] disabled:opacity-50"
                    >
                      {csvPending
                        ? "出力中…"
                        : `承認済みをまとめて振込CSV出力（${exportableIds.length}件）`}
                    </button>
                  </form>
                ) : null}
              </div>
              <BatchTable
                title=""
                batches={openBatches}
                emptyMessage="進行中の支払明細はありません。"
              />
            </section>
          ) : null}

          <section className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="支払先を検索"
                className="min-h-[36px] w-56 rounded-lg border border-white/[0.1] bg-surface-1 px-3 text-xs text-zinc-100 outline-none focus:border-[var(--accent-cyan)]"
              />
              <select
                value={bankFilter}
                onChange={(event) =>
                  setBankFilter(event.target.value as typeof bankFilter)
                }
                className="min-h-[36px] rounded-lg border border-white/[0.1] bg-surface-1 px-3 text-xs text-zinc-100"
              >
                <option value="all">振込先: すべて</option>
                <option value="registered">振込先: 登録済</option>
                <option value="not_ready">振込先: 未登録 / 不備</option>
              </select>
              <label className="flex items-center gap-2 text-xs text-zinc-400">
                <input
                  type="checkbox"
                  checked={payableOnly}
                  onChange={(event) => setPayableOnly(event.target.checked)}
                />
                支払可能のみ
              </label>
              <span className="text-[11px] text-zinc-500">
                選択 {selectedRows.length} 件
              </span>
            </div>

            <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950/60">
              <table className="min-w-[1280px] w-full border-collapse">
                <thead>
                  <tr>
                    <th className={th}></th>
                    <th className={th}>種別</th>
                    <th className={th}>支払先</th>
                    <th className={th}>対象期間</th>
                    <th className={`${th} text-right`}>発生額</th>
                    <th className={`${th} text-right`}>過去支払済</th>
                    <th className={`${th} text-right`}>支払予定中</th>
                    <th className={`${th} text-right`}>代理店報酬</th>
                    <th className={`${th} text-right`}>紹介報酬</th>
                    <th className={`${th} text-right`}>未払残高</th>
                    <th className={`${th} text-right`}>今回支払額</th>
                    <th className={th}>振込先状態</th>
                    <th className={th}>ステータス</th>
                    <th className={th}>明細</th>
                  </tr>
                </thead>
                <tbody>
                  {unpaidRows.length === 0 ? (
                    <tr>
                      <td colSpan={14} className="px-4 py-10 text-center text-sm text-zinc-500">
                        該当する支払先がありません。
                      </td>
                    </tr>
                  ) : (
                    unpaidRows.map((row) => {
                      const key = `${row.payeeKind}:${row.payeeId}`;
                      return (
                        <tr key={key} className="border-b border-zinc-800/70 align-top">
                          <td className={td}>
                            <input
                              type="checkbox"
                              disabled={!row.isPayable}
                              checked={selected.has(key)}
                              onChange={() => toggle(key)}
                              aria-label={`${row.payeeName} を選択`}
                            />
                          </td>
                          <td className={`${td} text-zinc-400`}>
                            {PAYEE_KIND_LABEL[row.payeeKind]}
                          </td>
                          <td className={`${td} whitespace-normal`}>
                            <div className="font-medium text-zinc-100">{row.payeeName}</div>
                            {/*
                              振込先は代理店側だけで管理する。紹介者報酬は所属代理店へ
                              合算して支払うため、紹介者に口座は登録しない。
                            */}
                            {row.payeeKind === "agency" ? (
                              <div className="mt-2 max-w-md">
                                <PayeeBankForm
                                  payeeKind={row.payeeKind}
                                  payeeId={row.payeeId}
                                  payeeName={row.payeeName}
                                  bank={row.bank}
                                />
                              </div>
                            ) : (
                              <p className="mt-2 max-w-md text-[11px] leading-relaxed text-amber-200">
                                所属代理店が未設定です。紹介者報酬は所属代理店へ合算して
                                支払うため、「紹介者管理」で所属代理店を設定してください。
                              </p>
                            )}
                          </td>
                          <td className={`${td} font-mono text-zinc-300`}>
                            {row.periodStartMonth
                              ? row.periodStartMonth === row.periodEndMonth
                                ? row.periodStartMonth
                                : `${row.periodStartMonth}〜${row.periodEndMonth}`
                              : "—"}
                          </td>
                          <td className={`${td} text-right font-mono text-zinc-400`}>
                            {yen(row.grossAmount)}
                          </td>
                          <td className={`${td} text-right font-mono text-zinc-400`}>
                            {yen(row.paidAmount)}
                          </td>
                          <td className={`${td} text-right font-mono text-indigo-200`}>
                            {row.claimedAmount > 0 ? yen(row.claimedAmount) : "—"}
                          </td>
                          {/* 支払先は代理店へ統合するが、会計上の報酬種別は必ず見せる */}
                          <td className={`${td} text-right font-mono text-zinc-300`}>
                            {row.agencyRewardAmount > 0 ? yen(row.agencyRewardAmount) : "—"}
                          </td>
                          <td className={`${td} text-right font-mono text-zinc-300`}>
                            {row.referralRewardAmount > 0 ? (
                              <>
                                {yen(row.referralRewardAmount)}
                                {row.referrerCount > 0 ? (
                                  <div className="text-[10px] text-zinc-500">
                                    紹介者 {row.referrerCount} 名
                                  </div>
                                ) : null}
                              </>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td className={`${td} text-right font-mono font-semibold text-zinc-100`}>
                            {yen(row.unpaidAmount)}
                          </td>
                          <td className={`${td} text-right`}>
                            {row.isPayable ? (
                              <form action={createAction} className="inline-flex flex-col items-end gap-1">
                                <input type="hidden" name="payee_kind" value={row.payeeKind} />
                                <input type="hidden" name="payee_id" value={row.payeeId} />
                                <input
                                  type="hidden"
                                  name="start_month"
                                  value={row.periodStartMonth ?? defaultMonth}
                                />
                                <input
                                  type="hidden"
                                  name="end_month"
                                  value={row.periodEndMonth ?? defaultMonth}
                                />
                                <span className="font-mono font-semibold text-emerald-300">
                                  {yen(row.unpaidAmount)}
                                </span>
                                <button
                                  type="submit"
                                  disabled={createPending}
                                  className="min-h-[32px] rounded-lg bg-[var(--accent-cyan)] px-3 text-[11px] font-semibold text-black disabled:opacity-50"
                                >
                                  支払明細を作成
                                </button>
                              </form>
                            ) : (
                              <span className="text-zinc-500">—</span>
                            )}
                          </td>
                          <td className={`${td} whitespace-normal`}>
                            <HoldReasons row={row} />
                          </td>
                          <td className={`${td} whitespace-normal`}>
                            {row.openBatches.length === 0 ? (
                              <span className="text-zinc-500">未払い</span>
                            ) : (
                              <div className="flex flex-col gap-1">
                                {row.openBatches.map((batch) => (
                                  <BatchStatusBadge key={batch.id} status={batch.status} />
                                ))}
                              </div>
                            )}
                          </td>
                          <td className={td}>
                            {row.openBatches.length > 0 ? (
                              <div className="flex flex-col gap-1">
                                {row.openBatches.map((batch) => (
                                  <Link
                                    key={batch.id}
                                    href={`/payments/${batch.id}`}
                                    className="text-[11px] font-medium text-[var(--accent-cyan)] hover:underline"
                                  >
                                    支払明細を開く
                                  </Link>
                                ))}
                              </div>
                            ) : (
                              <span className="text-[11px] text-zinc-600">
                                {row.itemCount} 件
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            <p className="text-[11px] leading-relaxed text-zinc-500">
              「未払残高」は、支払明細に組み入れていない明細だけの合計です。
              支払明細を作成すると、その分は「支払予定中」へ移り、未払残高から外れます。
              支払先は代理店に一本化しており、代理店報酬とその代理店に帰属する
              紹介報酬を合算して1回だけ振り込みます。
              二重に支払対象へ現れることはありません。
            </p>
          </section>
        </>
      )}
    </div>
  );
}

function BatchTable({
  title,
  batches,
  emptyMessage,
}: {
  title: string;
  batches: PaymentBatchSummary[];
  emptyMessage: string;
}) {
  return (
    <section className="space-y-2">
      {title ? <h2 className="text-sm font-semibold text-zinc-200">{title}</h2> : null}
      <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950/60">
        <table className="min-w-[960px] w-full border-collapse">
          <thead>
            <tr>
              <th className={th}>種別</th>
              <th className={th}>支払先</th>
              <th className={th}>対象期間</th>
              <th className={`${th} text-right`}>明細数</th>
              <th className={`${th} text-right`}>振込額</th>
              <th className={th}>ステータス</th>
              <th className={th}>振込日</th>
              <th className={th}></th>
            </tr>
          </thead>
          <tbody>
            {batches.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-sm text-zinc-500">
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              batches.map((batch) => (
                <tr key={batch.id} className="border-b border-zinc-800/70">
                  <td className={`${td} text-zinc-400`}>
                    {PAYEE_KIND_LABEL[batch.payeeKind as PayeeKind]}
                  </td>
                  <td className={`${td} font-medium text-zinc-100`}>{batch.payeeName}</td>
                  <td className={`${td} font-mono text-zinc-300`}>
                    {batch.periodStartMonth === batch.periodEndMonth
                      ? batch.periodStartMonth
                      : `${batch.periodStartMonth}〜${batch.periodEndMonth}`}
                  </td>
                  <td className={`${td} text-right font-mono text-zinc-400`}>
                    {batch.itemCount.toLocaleString("ja-JP")}
                  </td>
                  <td className={`${td} text-right font-mono font-semibold text-zinc-100`}>
                    {yen(batch.paymentAmount)}
                  </td>
                  <td className={td}>
                    <BatchStatusBadge status={batch.status} />
                  </td>
                  <td className={`${td} font-mono text-zinc-400`}>{batch.paidOn ?? "—"}</td>
                  <td className={td}>
                    <Link
                      href={`/payments/${batch.id}`}
                      className="text-[11px] font-medium text-[var(--accent-cyan)] hover:underline"
                    >
                      開く
                    </Link>
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

function SellerInvoiceTable({ overview }: { overview: PaymentOverview }) {
  return (
    <section className="space-y-3">
      <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-4 py-3 text-[11px] leading-relaxed text-amber-100">
        セラー請求は
        <span className="font-semibold">「セラー → THREE COMMERCE」への入金</span>
        です。代理店・紹介者への銀行振込とはお金の向きが逆なので、
        支払予定総額には含めていません。
        この画面は読み取り専用です。請求書の作成・発行・入金登録は
        <Link href="/admin/seller-billing" className="ml-1 font-semibold text-amber-200 underline">
          セラー請求画面
        </Link>
        で行ってください。
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950/60">
        <table className="min-w-[1080px] w-full border-collapse">
          <thead>
            <tr>
              <th className={th}>請求書番号</th>
              <th className={th}>セラー</th>
              <th className={th}>対象月</th>
              <th className={`${th} text-right`}>請求対象GMV</th>
              <th className={`${th} text-right`}>TSP料率</th>
              <th className={`${th} text-right`}>請求額（税込）</th>
              <th className={th}>状態</th>
              <th className={th}>支払期限</th>
              <th className={th}>入金日</th>
            </tr>
          </thead>
          <tbody>
            {overview.sellerInvoices.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-10 text-center text-sm text-zinc-500">
                  請求書がまだありません。
                </td>
              </tr>
            ) : (
              overview.sellerInvoices.map((invoice) => (
                <tr key={invoice.invoiceId} className="border-b border-zinc-800/70">
                  <td className={`${td} font-mono text-zinc-300`}>
                    {invoice.invoiceNumber ?? "—"}
                  </td>
                  <td className={`${td} font-medium text-zinc-100`}>{invoice.sellerName}</td>
                  <td className={`${td} font-mono text-zinc-300`}>{invoice.targetMonth}</td>
                  <td className={`${td} text-right font-mono text-zinc-400`}>
                    {yen(invoice.billingGmvAmount)}
                  </td>
                  <td className={`${td} text-right font-mono text-zinc-400`}>
                    {invoice.tspRate}%
                  </td>
                  <td className={`${td} text-right font-mono font-semibold text-zinc-100`}>
                    {yen(invoice.invoiceAmount)}
                  </td>
                  <td className={`${td} text-zinc-300`}>
                    {SELLER_STATUS_LABEL[invoice.status] ?? invoice.status}
                  </td>
                  <td className={`${td} font-mono text-zinc-400`}>{invoice.dueDate ?? "—"}</td>
                  <td className={`${td} font-mono text-zinc-400`}>
                    {invoice.paidAt ? invoice.paidAt.slice(0, 10) : "—"}
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
