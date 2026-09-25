"use client";

import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import type {
  AvailableMonth,
  MonthlySalesSummary,
} from "@/lib/db/revenue-queries";
import { formatYen } from "@/lib/revenue/calc";

const thBase =
  "sticky top-0 z-10 whitespace-nowrap border-b border-zinc-800 bg-zinc-950/95 px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-400";

const td = "whitespace-nowrap px-3 py-2 text-xs";

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-surface-1/60 p-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
        {label}
      </p>
      <p className="mt-2 font-mono text-xl font-bold tracking-tight text-zinc-50">
        {value}
      </p>
      {hint ? <p className="mt-1 text-[11px] text-zinc-600">{hint}</p> : null}
    </div>
  );
}

export function SalesTabClient({
  summary,
  months,
  isAdmin,
}: {
  summary: MonthlySalesSummary;
  months: AvailableMonth[];
  isAdmin: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [view, setView] = useState<"creator" | "shop">("creator");
  const [search, setSearch] = useState("");
  const [agencyFilter, setAgencyFilter] = useState("all");

  const agencyOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of summary.creatorRows) {
      if (row.agencyId) map.set(row.agencyId, row.agencyName);
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1], "ja"));
  }, [summary.creatorRows]);

  const creatorRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return summary.creatorRows.filter((row) => {
      if (agencyFilter !== "all" && row.agencyId !== agencyFilter) return false;
      if (!q) return true;
      return (
        row.creatorName.toLowerCase().includes(q) ||
        row.tiktokId.toLowerCase().includes(q) ||
        row.agencyName.toLowerCase().includes(q)
      );
    });
  }, [agencyFilter, search, summary.creatorRows]);

  const shopRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return summary.shopRows;
    return summary.shopRows.filter((row) =>
      row.shopName.toLowerCase().includes(q),
    );
  }, [search, summary.shopRows]);

  function changeMonth(month: string) {
    const next = new URLSearchParams(searchParams.toString());
    next.set("tab", "sales");
    next.set("month", month);
    router.push(`/revenue?${next.toString()}`);
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 rounded-xl border border-white/[0.06] bg-surface-1/40 p-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <label
            htmlFor="revenue-month"
            className="text-[11px] font-medium text-zinc-500"
          >
            対象月
          </label>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <input
              id="revenue-month"
              type="month"
              defaultValue={summary.targetMonth}
              onChange={(e) => {
                if (/^\d{4}-\d{2}$/.test(e.target.value)) {
                  changeMonth(e.target.value);
                }
              }}
              className="rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100 outline-none"
            />
            {months.slice(0, 6).map((m) => (
              <button
                key={m.month}
                type="button"
                onClick={() => changeMonth(m.month)}
                className={`rounded-full border px-3 py-1 font-mono text-xs transition ${
                  m.month === summary.targetMonth
                    ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-200"
                    : "border-white/[0.08] text-zinc-400 hover:bg-white/[0.05]"
                }`}
              >
                {m.month}
              </button>
            ))}
          </div>
        </div>
      </div>

      {summary.error ? (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          {summary.error}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="GMV" value={formatYen(Math.round(summary.totals.gmv))} />
        <Kpi
          label="Commission Base"
          value={formatYen(Math.round(summary.totals.commissionBase))}
          hint={`うち支払確定 ${formatYen(Math.round(summary.totals.paidCommissionBase))}`}
        />
        <Kpi
          label="代理店収益"
          value={formatYen(Math.round(summary.totals.agencyRevenue))}
        />
        <Kpi
          label="注文件数"
          value={summary.totals.orderCount.toLocaleString("ja-JP")}
          hint={`明細 ${summary.totals.lineCount.toLocaleString("ja-JP")} 行`}
        />
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-white/[0.06] bg-surface-1/40 p-4 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label htmlFor="revenue-search" className="text-[11px] font-medium text-zinc-500">
            検索
          </label>
          <input
            id="revenue-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={view === "creator" ? "クリエイター / TikTok ID / 代理店" : "セラー・ショップ名"}
            className="mt-1 w-full rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-cyan-700"
          />
        </div>

        {isAdmin && view === "creator" ? (
          <div className="sm:w-60">
            <label htmlFor="revenue-agency" className="text-[11px] font-medium text-zinc-500">
              代理店
            </label>
            <select
              id="revenue-agency"
              value={agencyFilter}
              onChange={(e) => setAgencyFilter(e.target.value)}
              className="mt-1 w-full rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100"
            >
              <option value="all">すべて</option>
              {agencyOptions.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div className="flex gap-1 rounded-lg border border-white/[0.08] bg-surface-1 p-1">
          {(
            [
              { key: "creator", label: "クリエイター別" },
              { key: "shop", label: "セラー別" },
            ] as const
          ).map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setView(item.key)}
              className={`min-h-[36px] rounded-md px-3 text-xs font-medium transition ${
                view === item.key
                  ? "bg-white/[0.1] text-zinc-50"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950/70">
        <div className="max-h-[min(70vh,780px)] overflow-y-auto">
          {view === "creator" ? (
            <table className="w-full min-w-[860px] border-collapse text-sm">
              <thead>
                <tr>
                  <th className={thBase}>クリエイター</th>
                  <th className={thBase}>TikTok ID</th>
                  <th className={thBase}>代理店</th>
                  <th className={`${thBase} text-right`}>GMV</th>
                  <th className={`${thBase} text-right`}>Commission Base</th>
                  <th className={`${thBase} text-right`}>代理店収益</th>
                  <th className={`${thBase} text-right`}>注文</th>
                  <th className={`${thBase} text-right`}>セラー数</th>
                </tr>
              </thead>
              <tbody>
                {creatorRows.map((row) => (
                  <tr
                    key={row.creatorId ?? row.creatorName}
                    className="border-b border-zinc-800/70"
                  >
                    <td className={`${td} font-medium text-zinc-100`}>{row.creatorName}</td>
                    <td className={`${td} font-mono text-zinc-500`}>{row.tiktokId || "—"}</td>
                    <td className={`${td} text-zinc-300`}>{row.agencyName}</td>
                    <td className={`${td} text-right font-mono text-zinc-200`}>
                      {formatYen(Math.round(row.gmv))}
                    </td>
                    <td className={`${td} text-right font-mono text-zinc-300`}>
                      {formatYen(Math.round(row.commissionBase))}
                    </td>
                    <td className={`${td} text-right font-mono text-cyan-300/90`}>
                      {formatYen(Math.round(row.agencyRevenue))}
                    </td>
                    <td className={`${td} text-right font-mono text-zinc-400`}>
                      {row.orderCount.toLocaleString("ja-JP")}
                    </td>
                    <td className={`${td} text-right font-mono text-zinc-500`}>
                      {row.shopCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table className="w-full min-w-[720px] border-collapse text-sm">
              <thead>
                <tr>
                  <th className={thBase}>セラー / ショップ</th>
                  <th className={`${thBase} text-right`}>GMV</th>
                  <th className={`${thBase} text-right`}>Commission Base</th>
                  <th className={`${thBase} text-right`}>代理店収益</th>
                  <th className={`${thBase} text-right`}>注文</th>
                  <th className={`${thBase} text-right`}>クリエイター数</th>
                </tr>
              </thead>
              <tbody>
                {shopRows.map((row) => (
                  <tr key={row.shopKey} className="border-b border-zinc-800/70">
                    <td className={`${td} font-medium text-zinc-100`}>{row.shopName}</td>
                    <td className={`${td} text-right font-mono text-zinc-200`}>
                      {formatYen(Math.round(row.gmv))}
                    </td>
                    <td className={`${td} text-right font-mono text-zinc-300`}>
                      {formatYen(Math.round(row.commissionBase))}
                    </td>
                    <td className={`${td} text-right font-mono text-cyan-300/90`}>
                      {formatYen(Math.round(row.agencyRevenue))}
                    </td>
                    <td className={`${td} text-right font-mono text-zinc-400`}>
                      {row.orderCount.toLocaleString("ja-JP")}
                    </td>
                    <td className={`${td} text-right font-mono text-zinc-500`}>
                      {row.creatorCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {(view === "creator" ? creatorRows : shopRows).length === 0 ? (
        <p className="rounded-xl border border-zinc-800 py-10 text-center text-sm text-zinc-500">
          {summary.targetMonth} に該当する売上データがありません。
        </p>
      ) : null}
    </div>
  );
}
