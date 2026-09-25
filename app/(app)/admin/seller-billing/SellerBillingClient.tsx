"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import {
  cancelSellerInvoiceAction,
  createSellerInvoiceDraftAction,
  createSellerInvoiceDraftsBulkAction,
  issueSellerInvoiceAction,
  markSellerInvoicePaidAction,
  type SellerInvoiceActionResult,
} from "@/app/actions/seller-invoices";
import { formatContractRate } from "@/lib/billing/seller-invoice";
import {
  calculateSellerInvoiceDueDate,
  formatDueDateLabel,
} from "@/lib/billing/due-date";
import type {
  SellerBillingData,
  SellerInvoiceSummary,
} from "@/lib/db/seller-billing-queries";

/*
  セラー請求の操作画面。

  ① 対象月を選ぶ
  ② ショップ実績CSVを取り込む（既存の取込画面へ）
  ③ 請求プレビューを確認する
  ④ 請求書（下書き）を作る
  ⑤ 請求書を開いてPDF化する
  ⑥ 発行 → 入金済み

  発行済み・入金済みの請求書は再作成・再計算で上書きしない
  （サーバー側でも拒否する）。
*/

const th =
  "whitespace-nowrap border-b border-zinc-800 bg-surface-1/80 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-500";
const td = "whitespace-nowrap px-3 py-2 text-xs";

const yen = (value: number | null | undefined) =>
  value == null ? "—" : `¥${Math.round(value).toLocaleString("ja-JP")}`;

const STATUS_LABEL: Record<SellerInvoiceSummary["status"], string> = {
  draft: "下書き",
  issued: "発行済み",
  paid: "入金済み",
  cancelled: "取消",
};

const STATUS_CLASS: Record<SellerInvoiceSummary["status"], string> = {
  draft: "border-white/[0.1] bg-white/[0.04] text-zinc-300",
  issued: "border-cyan-400/25 bg-cyan-400/10 text-cyan-200",
  paid: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  cancelled: "border-red-400/25 bg-red-400/10 text-red-200",
};

function StatusBadge({ status }: { status: SellerInvoiceSummary["status"] }) {
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[11px] ${STATUS_CLASS[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

function Banner({ state }: { state: SellerInvoiceActionResult | null }) {
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

/** 発行・入金・取消の二段階確認ボタン */
function ConfirmAction({
  label,
  confirmLabel,
  description,
  tone,
  pending,
  children,
}: {
  label: string;
  confirmLabel: string;
  description: string;
  tone: "cyan" | "emerald" | "red";
  pending: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  const toneClass =
    tone === "emerald"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20"
      : tone === "red"
        ? "border-red-500/30 bg-red-500/10 text-red-200 hover:bg-red-500/20"
        : "border-cyan-500/30 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20";

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`rounded border px-2.5 py-1.5 text-[11px] font-medium transition ${toneClass}`}
      >
        {label}
      </button>
    );
  }

  return (
    <div className="min-w-[230px] space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.08] p-2">
      <p className="text-[10px] leading-relaxed text-amber-100">{description}</p>
      <div className="flex gap-2">
        {children}
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-amber-400 px-3 py-1.5 text-[11px] font-semibold text-zinc-950 transition hover:bg-amber-300 disabled:opacity-50"
        >
          {pending ? "処理中…" : confirmLabel}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={pending}
          className="rounded border border-white/[0.12] px-3 py-1.5 text-[11px] text-zinc-300 transition hover:bg-white/[0.06] disabled:opacity-50"
        >
          やめる
        </button>
      </div>
    </div>
  );
}

export function SellerBillingClient({
  billing,
  invoices,
  invoiceError,
}: {
  billing: SellerBillingData;
  invoices: SellerInvoiceSummary[];
  invoiceError: string | null;
}) {
  const router = useRouter();
  /* テストデータは既定で非表示。確認したいときだけ明示的に出す */
  const [showTest, setShowTest] = useState(false);

  const [draftState, draftAction, draftPending] = useActionState<
    SellerInvoiceActionResult | null,
    FormData
  >(createSellerInvoiceDraftAction, null);
  const [bulkState, bulkAction, bulkPending] = useActionState<
    SellerInvoiceActionResult | null,
    FormData
  >(createSellerInvoiceDraftsBulkAction, null);
  const [issueState, issueAction, issuePending] = useActionState<
    SellerInvoiceActionResult | null,
    FormData
  >(issueSellerInvoiceAction, null);
  const [paidState, paidAction, paidPending] = useActionState<
    SellerInvoiceActionResult | null,
    FormData
  >(markSellerInvoicePaidAction, null);
  const [cancelState, cancelAction, cancelPending] = useActionState<
    SellerInvoiceActionResult | null,
    FormData
  >(cancelSellerInvoiceAction, null);

  const monthOptions = useMemo(() => {
    const set = new Set(billing.months);
    set.add(billing.targetMonth);
    return [...set].sort((a, b) => b.localeCompare(a));
  }, [billing.months, billing.targetMonth]);

  const visibleRows = useMemo(
    () => billing.rows.filter((row) => showTest || !row.isTest),
    [billing.rows, showTest],
  );

  const monthInvoices = invoices.filter(
    (invoice) =>
      invoice.targetMonth === billing.targetMonth && (showTest || !invoice.isTest),
  );

  return (
    <div className="space-y-6">
      {/* ① 対象月 / ② CSV取込 */}
      <section className="rounded-xl border border-white/[0.06] bg-surface-1/40 p-4">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label htmlFor="billing-month" className="text-[11px] font-medium text-zinc-500">
              ① 対象月
            </label>
            <select
              id="billing-month"
              value={billing.targetMonth}
              onChange={(e) => router.push(`/admin/seller-billing?month=${e.target.value}`)}
              className="mt-1 w-44 rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100"
            >
              {monthOptions.map((month) => (
                <option key={month} value={month}>
                  {month}
                </option>
              ))}
            </select>
          </div>

          <div>
            <p className="text-[11px] font-medium text-zinc-500">② ショップ実績CSV</p>
            <Link
              href="/admin/shop-performance"
              className="mt-1 inline-block rounded-lg border border-white/[0.1] px-3 py-2 text-sm text-zinc-100 transition hover:bg-white/[0.06]"
            >
              CSVを取り込む →
            </Link>
          </div>

          <label className="flex min-h-[38px] cursor-pointer items-center gap-2 rounded-lg border border-white/[0.08] bg-surface-1 px-3 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={showTest}
              onChange={(e) => setShowTest(e.target.checked)}
            />
            テストデータを表示
            {billing.totals.testSellerCount > 0 ? (
              <span className="font-mono text-[11px] text-zinc-500">
                （{billing.totals.testSellerCount}）
              </span>
            ) : null}
          </label>

          <p className="text-[11px] leading-relaxed text-zinc-500">
            ③ 取込結果がこの画面のプレビューに反映されます。
            同じ月のCSVを取り込み直しても、最後の取込内容だけが使われ二重加算しません。
          </p>
        </div>
      </section>

      {/* 集計 */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        {[
          { label: "対象セラー（本番）", value: String(billing.totals.sellerCount) },
          { label: "請求可能", value: String(billing.totals.billableCount) },
          { label: "請求額合計（税込・本番）", value: yen(billing.totals.billableAmount) },
          { label: "要確認", value: String(billing.totals.needsReviewCount + billing.totals.rateMissingCount) },
          { label: "請求書作成済み", value: String(billing.totals.invoicedCount) },
          { label: "請求対象外", value: String(billing.totals.notEligibleCount) },
        ].map((kpi) => (
          <div key={kpi.label} className="rounded-2xl border border-white/[0.07] bg-surface-1/60 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
              {kpi.label}
            </p>
            <p className="mt-2 font-mono text-lg font-bold text-zinc-50">{kpi.value}</p>
          </div>
        ))}
      </div>

      <Banner state={draftState} />
      <Banner state={bulkState} />
      <Banner state={issueState} />
      <Banner state={paidState} />
      <Banner state={cancelState} />

      {/* ④ 請求プレビュー */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-zinc-200">
              ④ 請求プレビュー（{billing.targetMonth}）
            </h2>
            <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
              請求対象GMV = GMV − Refunds ／ 請求額（税込）= 請求対象GMV × 契約料率。
              消費税は加算していません。請求対象GMVがマイナスの場合は「要確認」として請求書を作りません。
            </p>
          </div>
          {billing.totals.billableCount > 0 ? (
            <form action={bulkAction}>
              <input type="hidden" name="target_month" value={billing.targetMonth} />
              <button
                type="submit"
                disabled={bulkPending}
                className="min-h-[38px] rounded-lg border border-white/[0.12] px-4 text-xs font-medium text-zinc-100 transition hover:bg-white/[0.06] disabled:opacity-40"
              >
                {bulkPending ? "作成中…" : "請求可能なセラーの下書きをまとめて作成"}
              </button>
            </form>
          ) : null}
        </div>

        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full min-w-[1200px] text-sm">
            <thead>
              <tr>
                <th className={`${th} min-w-[180px]`}>セラー</th>
                <th className={`${th} text-right`}>GMV（B列）</th>
                <th className={`${th} text-right`}>Refunds（I列）</th>
                <th className={`${th} text-right`}>請求対象GMV</th>
                <th className={`${th} text-right`}>契約料率</th>
                <th className={`${th} text-right`}>請求額（税込）</th>
                <th className={th}>状態</th>
                <th className={`${th} min-w-[280px]`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-xs text-zinc-500">
                    {billing.rows.length === 0
                  ? `${billing.targetMonth} のショップ実績CSVが取り込まれていません。`
                  : "本番の対象セラーがありません（テストデータのみ）。「テストデータを表示」で確認できます。"}
                  </td>
                </tr>
              ) : (
                visibleRows.map((row) => (
                  <tr key={row.sellerId} className="border-b border-zinc-800/60 align-top">
                    <td className={`${td} font-medium text-zinc-100`}>
                      {row.sellerName}
                      {row.isTest ? (
                        <span className="ml-2 rounded-full border border-amber-400/25 bg-amber-400/10 px-1.5 py-0.5 text-[10px] text-amber-200">
                          テスト
                        </span>
                      ) : null}
                      {!row.isBillingEligible ? (
                        <span className="ml-2 rounded-full border border-red-400/25 bg-red-400/10 px-1.5 py-0.5 text-[10px] text-red-200">
                          TSP請求対象外
                        </span>
                      ) : null}
                      <p className="text-[10px] font-normal text-zinc-600">
                        {row.shopName}
                        {row.shopCount > 1 ? `（${row.shopCount}ショップ合算）` : ""}
                      </p>
                    </td>
                    <td className={`${td} text-right font-mono text-zinc-300`}>
                      {yen(row.gmvAmount)}
                    </td>
                    <td className={`${td} text-right font-mono text-zinc-400`}>
                      {yen(row.refundAmount)}
                    </td>
                    <td
                      className={`${td} text-right font-mono ${
                        row.computation.billingGmvAmount < 0 ? "text-red-300" : "text-zinc-200"
                      }`}
                    >
                      {yen(row.computation.billingGmvAmount)}
                    </td>
                    <td className={`${td} text-right font-mono text-zinc-300`}>
                      {formatContractRate(row.contractRatePct)}
                    </td>
                    <td className={`${td} text-right font-mono font-semibold text-zinc-50`}>
                      {row.computation.invoiceAmount == null
                        ? "—"
                        : yen(row.computation.invoiceAmount)}
                    </td>
                    <td className={td}>
                      {row.invoice ? (
                        <StatusBadge status={row.invoice.status} />
                      ) : (
                        <span className="text-[11px] text-zinc-500">{row.computation.label}</span>
                      )}
                    </td>
                    <td className="space-y-2 px-3 py-2">
                      <div className="flex flex-wrap items-start gap-2">
                        {/* ⑤ 請求書作成（下書き） */}
                        {row.computation.status === "ok" &&
                        (!row.invoice || row.invoice.status === "draft") ? (
                          <form action={draftAction}>
                            <input type="hidden" name="seller_id" value={row.sellerId} />
                            <input type="hidden" name="target_month" value={billing.targetMonth} />
                            <button
                              type="submit"
                              disabled={draftPending}
                              className="rounded border border-white/[0.12] px-2.5 py-1.5 text-[11px] text-zinc-100 transition hover:bg-white/[0.06] disabled:opacity-40"
                            >
                              {row.invoice ? "下書きを再計算" : "請求書を作成"}
                            </button>
                          </form>
                        ) : null}

                        {row.invoice ? (
                          <Link
                            href={`/admin/seller-billing/${row.invoice.id}`}
                            className="rounded border border-white/[0.12] px-2.5 py-1.5 text-[11px] text-zinc-100 transition hover:bg-white/[0.06]"
                          >
                            請求書を開く / PDF
                          </Link>
                        ) : null}

                        {/* ⑥ 発行 */}
                        {row.invoice?.status === "draft" ? (
                          <form action={issueAction}>
                            <ConfirmAction
                              label="発行する"
                              confirmLabel="発行を確定"
                              tone="cyan"
                              pending={issuePending}
                              description={`${row.sellerName} へ ${yen(row.invoice.invoiceAmount)}（税込）の請求書を発行します。支払期限：${formatDueDateLabel(
                                calculateSellerInvoiceDueDate(billing.targetMonth),
                              )}（月末締め・翌月末払い）。発行後は再計算で内容が変わりません。`}
                            >
                              <input type="hidden" name="invoice_id" value={row.invoice.id} />
                            </ConfirmAction>
                          </form>
                        ) : null}

                        {/* ⑦ 入金済み */}
                        {row.invoice?.status === "issued" ? (
                          <form action={paidAction}>
                            <ConfirmAction
                              label="入金済みにする"
                              confirmLabel="入金を記録"
                              tone="emerald"
                              pending={paidPending}
                              description={`${row.sellerName} から ${yen(row.invoice.invoiceAmount)}（税込）の入金を記録します。`}
                            >
                              <input type="hidden" name="invoice_id" value={row.invoice.id} />
                            </ConfirmAction>
                          </form>
                        ) : null}

                        {row.invoice &&
                        (row.invoice.status === "draft" || row.invoice.status === "issued") ? (
                          <form action={cancelAction}>
                            <ConfirmAction
                              label="取消"
                              confirmLabel="取消を確定"
                              tone="red"
                              pending={cancelPending}
                              description="請求書を取消にします。金額と請求書番号は履歴として残ります。"
                            >
                              <input type="hidden" name="invoice_id" value={row.invoice.id} />
                            </ConfirmAction>
                          </form>
                        ) : null}
                      </div>

                      {row.invoice && row.invoice.status !== "draft" ? (
                        <p className="text-[10px] text-zinc-600">
                          {row.invoice.invoiceNumber} は確定済みのため、CSV再取込や再計算で変更されません。
                        </p>
                      ) : null}
                      {row.computation.status === "rate_missing" ? (
                        <p className="text-[10px] text-amber-300/80">
                          <Link href="/admin/sellers" className="underline">
                            セラー管理
                          </Link>
                          で契約料率を設定してください（例: 10 と入力すると 10%）。
                        </p>
                      ) : null}
                      {row.computation.status === "needs_review" ? (
                        <p className="text-[10px] text-red-300/80">
                          Refunds が GMV を上回っています。マイナス請求書は作成しません。
                        </p>
                      ) : null}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {billing.unlinkedShops.length > 0 ? (
          <p className="rounded-lg border border-amber-500/25 bg-amber-500/[0.07] px-3 py-2 text-[11px] leading-relaxed text-amber-100">
            セラー未紐付けのショップが {billing.unlinkedShops.length} 件あります（
            {billing.unlinkedShops.slice(0, 5).map((shop) => shop.shopName).join("、")}
            {billing.unlinkedShops.length > 5 ? " ほか" : ""}）。
            ショップ名が似ていても自動で紐付けることはしません。
            <Link href="/admin/shop-performance" className="ml-1 underline">
              ショップ実績画面
            </Link>
            で人が確認して紐付けてください（一度紐付ければ、次回以降は同じ表記のショップが自動で同じセラーに付きます）。
          </p>
        ) : null}
      </section>

      {/* 請求済み管理 */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-zinc-200">
          請求書一覧（{billing.targetMonth} / 全 {invoices.length} 件）
        </h2>
        {invoiceError ? (
          <p className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-100">
            {invoiceError}
          </p>
        ) : null}
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr>
                <th className={th}>請求書番号</th>
                <th className={th}>対象月</th>
                <th className={`${th} min-w-[160px]`}>セラー</th>
                <th className={`${th} text-right`}>請求額（税込）</th>
                <th className={th}>状態</th>
                <th className={th}>発行日</th>
                <th className={th}>入金日</th>
                <th className={th}>請求書</th>
              </tr>
            </thead>
            <tbody>
              {monthInvoices.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-center text-xs text-zinc-500">
                    {billing.targetMonth} の請求書はまだありません。
                  </td>
                </tr>
              ) : (
                monthInvoices.map((invoice) => (
                  <tr key={invoice.id} className="border-b border-zinc-800/60">
                    <td className={`${td} font-mono text-zinc-300`}>
                      {invoice.invoiceNumber ?? "—"}
                    </td>
                    <td className={`${td} font-mono text-zinc-400`}>{invoice.targetMonth}</td>
                    <td className={`${td} text-zinc-100`}>{invoice.sellerName}</td>
                    <td className={`${td} text-right font-mono font-semibold text-zinc-50`}>
                      {yen(invoice.invoiceAmount)}
                    </td>
                    <td className={td}>
                      <StatusBadge status={invoice.status} />
                    </td>
                    <td className={`${td} font-mono text-zinc-500`}>
                      {invoice.issuedAt
                        ? new Date(invoice.issuedAt).toLocaleDateString("ja-JP")
                        : "—"}
                    </td>
                    <td className={`${td} font-mono text-zinc-500`}>
                      {invoice.paidAt
                        ? new Date(invoice.paidAt).toLocaleDateString("ja-JP")
                        : "—"}
                    </td>
                    <td className={td}>
                      <Link
                        href={`/admin/seller-billing/${invoice.id}`}
                        className="text-[var(--accent-cyan)] hover:underline"
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
    </div>
  );
}
