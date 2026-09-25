"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import type { SellerOverviewData } from "@/lib/db/seller-overview-queries";
import { formatYen } from "@/lib/revenue/calc";
import { formatContractRate } from "@/lib/billing/seller-invoice";

/** 請求ステータスの表示 */
const INVOICE_STATUS_LABEL = {
  draft: "下書き",
  issued: "発行済み",
  paid: "入金済み",
  cancelled: "取消",
} as const;

const INVOICE_STATUS_CLASS = {
  draft: "border-white/[0.1] bg-white/[0.04] text-zinc-300",
  issued: "border-cyan-400/25 bg-cyan-400/10 text-cyan-200",
  paid: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  cancelled: "border-red-400/25 bg-red-400/10 text-red-200",
} as const;

const thBase =
  "sticky top-0 z-10 whitespace-nowrap border-b border-zinc-800 bg-zinc-950/95 px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-400";

const td = "whitespace-nowrap px-3 py-2 text-xs";

function statusLabel(row: { status: string; hasMonthData: boolean; isUnregistered: boolean }) {
  if (row.isUnregistered) {
    return { label: "マスタ未登録", className: "border-amber-400/25 bg-amber-400/10 text-amber-200" };
  }
  if (row.hasMonthData) {
    return { label: "実績あり", className: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300" };
  }
  return { label: "実績なし", className: "border-white/[0.08] bg-white/[0.03] text-zinc-500" };
}

export function SellerOverviewClient({
  data,
  isAdmin,
}: {
  data: SellerOverviewData;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [activeOnly, setActiveOnly] = useState(false);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return data.rows.filter((row) => {
      if (activeOnly && !row.hasMonthData) return false;
      if (!q) return true;
      return (
        row.sellerName.toLowerCase().includes(q) ||
        row.shopName.toLowerCase().includes(q) ||
        (row.shopId?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [activeOnly, data.rows, search]);

  const maxTrendGmv = Math.max(1, ...data.monthlyTrend.map((point) => point.gmv));

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 rounded-xl border border-white/[0.06] bg-surface-1/40 p-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <label htmlFor="seller-month" className="text-[11px] font-medium text-zinc-500">
            対象月
          </label>
          <input
            id="seller-month"
            type="month"
            defaultValue={data.month}
            onChange={(e) => {
              if (/^\d{4}-\d{2}$/.test(e.target.value)) {
                router.push(`/sellers?month=${e.target.value}`);
              }
            }}
            className="mt-1 block rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100 outline-none"
          />
        </div>

        <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-end sm:justify-end">
          <div className="sm:w-72">
            <label htmlFor="seller-search" className="text-[11px] font-medium text-zinc-500">
              検索
            </label>
            <input
              id="seller-search"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="セラー名 / ショップ名 / Shop ID"
              className="mt-1 w-full rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-cyan-700"
            />
          </div>
          <label className="flex min-h-[40px] cursor-pointer items-center gap-2 rounded-lg border border-white/[0.08] bg-surface-1 px-3 text-sm text-zinc-400">
            <input
              type="checkbox"
              checked={activeOnly}
              onChange={(e) => setActiveOnly(e.target.checked)}
            />
            実績ありのみ
          </label>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-2xl border border-white/[0.07] bg-surface-1/60 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
            セラー数
          </p>
          <p className="mt-2 font-mono text-xl font-bold text-zinc-50">
            {data.totals.sellerCount}
          </p>
          <p className="mt-1 text-[11px] text-zinc-600">
            当月実績あり {data.totals.connectedCount}
          </p>
        </div>
        <div className="rounded-2xl border border-white/[0.07] bg-surface-1/60 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
            GMV（{data.month}）
          </p>
          <p className="mt-2 font-mono text-xl font-bold text-zinc-50">
            {formatYen(Math.round(data.totals.gmvMonth))}
          </p>
        </div>
        <div className="rounded-2xl border border-white/[0.07] bg-surface-1/60 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
            代理店収益（{data.month}）
          </p>
          <p className="mt-2 font-mono text-xl font-bold text-zinc-50">
            {formatYen(Math.round(data.totals.agencyRevenueMonth))}
          </p>
        </div>
        <div className="rounded-2xl border border-white/[0.07] bg-surface-1/60 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
            注文件数（{data.month}）
          </p>
          <p className="mt-2 font-mono text-xl font-bold text-zinc-50">
            {data.totals.orderCountMonth.toLocaleString("ja-JP")}
          </p>
        </div>
      </div>

      {data.monthlyTrend.length > 0 ? (
        <section className="rounded-xl border border-white/[0.06] bg-surface-1/40 p-4">
          <h2 className="text-sm font-semibold text-zinc-300">月別GMV推移（全セラー）</h2>
          <ul className="mt-3 space-y-2">
            {data.monthlyTrend.map((point) => (
              <li key={point.month} className="flex items-center gap-3">
                <span className="w-16 shrink-0 font-mono text-[11px] text-zinc-500">
                  {point.month}
                </span>
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-white/[0.05]">
                  <span
                    className="block h-full rounded-full bg-gradient-to-r from-[var(--accent-cyan)]/70 to-[var(--accent-magenta)]/70"
                    style={{ width: `${Math.max(2, (point.gmv / maxTrendGmv) * 100)}%` }}
                  />
                </span>
                <span className="w-28 shrink-0 text-right font-mono text-[11px] text-zinc-300">
                  {formatYen(point.gmv)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950/70">
        <div className="max-h-[min(70vh,780px)] overflow-y-auto">
          <table className="w-full min-w-[980px] border-collapse text-sm">
            <thead>
              <tr>
                <th className={thBase}>セラー名</th>
                <th className={thBase}>ショップ</th>
                <th className={thBase}>Shop ID</th>
                <th className={thBase}>状態</th>
                <th className={`${thBase} text-right`}>GMV（当月）</th>
                <th className={`${thBase} text-right`}>GMV（累計）</th>
                <th className={`${thBase} text-right`}>注文</th>
                <th className={`${thBase} text-right`}>クリエイター</th>
                <th className={`${thBase} text-right`}>代理店収益</th>
                {isAdmin ? (
                  <th className={`${thBase} text-right`}>契約料率</th>
                ) : null}
                {isAdmin ? <th className={thBase}>最新請求</th> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const status = statusLabel(row);
                return (
                  <tr
                    key={row.sellerId ?? `shop-${row.shopName}`}
                    className="border-b border-zinc-800/70"
                  >
                    <td className={`${td} font-medium text-zinc-100`}>{row.sellerName}</td>
                    <td className={`${td} text-zinc-400`}>{row.shopName || "—"}</td>
                    <td className={`${td} font-mono text-zinc-500`}>{row.shopId || "—"}</td>
                    <td className={td}>
                      <span className={`rounded-full border px-2 py-0.5 text-[11px] ${status.className}`}>
                        {status.label}
                      </span>
                    </td>
                    <td className={`${td} text-right font-mono text-zinc-200`}>
                      {formatYen(Math.round(row.gmvMonth))}
                    </td>
                    <td className={`${td} text-right font-mono text-zinc-400`}>
                      {formatYen(Math.round(row.gmvTotal))}
                    </td>
                    <td className={`${td} text-right font-mono text-zinc-400`}>
                      {row.orderCountMonth.toLocaleString("ja-JP")}
                    </td>
                    <td className={`${td} text-right font-mono text-zinc-400`}>
                      {row.creatorCountMonth}
                    </td>
                    <td className={`${td} text-right font-mono text-cyan-300/90`}>
                      {formatYen(Math.round(row.agencyRevenueMonth))}
                    </td>
                    {isAdmin ? (
                      <td
                        className={`${td} text-right font-mono ${
                          row.tspRate == null ? "text-amber-300/80" : "text-zinc-300"
                        }`}
                        title="セラー請求に使う契約料率（sellers.tsp_rate）"
                      >
                        {formatContractRate(row.tspRate)}
                      </td>
                    ) : null}
                    {isAdmin ? (
                      <td className={td}>
                        {row.latestInvoice ? (
                          <Link
                            href={`/admin/seller-billing/${row.latestInvoice.id}`}
                            className="inline-flex flex-wrap items-center gap-1.5 hover:underline"
                          >
                            <span
                              className={`rounded-full border px-2 py-0.5 text-[11px] ${
                                INVOICE_STATUS_CLASS[row.latestInvoice.status]
                              }`}
                            >
                              {INVOICE_STATUS_LABEL[row.latestInvoice.status]}
                            </span>
                            <span className="font-mono text-[10px] text-zinc-500">
                              {row.latestInvoice.targetMonth}
                            </span>
                            <span className="font-mono text-[11px] text-zinc-300">
                              {formatYen(Math.round(row.latestInvoice.invoiceAmount))}
                            </span>
                          </Link>
                        ) : (
                          <span className="text-[11px] text-zinc-600">—</span>
                        )}
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-xl border border-zinc-800 py-10 text-center text-sm text-zinc-500">
          条件に一致するセラーがありません。
        </p>
      ) : null}
    </div>
  );
}
