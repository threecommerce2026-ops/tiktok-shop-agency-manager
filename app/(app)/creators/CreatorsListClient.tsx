"use client";

import type { CreatorListRow } from "@/lib/db/creators-queries";
import { formatCreatorSalesStatusLabel } from "@/lib/db/creators-queries";
import { formatOfficialLineRegisteredLabel } from "@/lib/creators/referral-registration";
import { formatYen } from "@/lib/revenue/calc";
import Link from "next/link";
import { useMemo, useState } from "react";

const ALL = "all";
const PAGE_SIZE = 50;

type SortKey = "salesMonth" | "profitMonth" | "referralRewardMonth" | "salesTotal";

type Props = {
  rows: CreatorListRow[];
  month: string;
};

const thBase =
  "sticky top-0 z-20 whitespace-nowrap border-b border-zinc-800 bg-zinc-950/98 px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-400 shadow-[0_1px_0_0_rgba(0,0,0,0.4)]";

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit" });
}

function downloadCsv(filename: string, header: string[], lines: Array<Array<string | number>>) {
  const escape = (cell: string | number) => {
    const s = String(cell);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const body = [header.map(escape).join(","), ...lines.map((row) => row.map(escape).join(","))].join(
    "\n",
  );
  const blob = new Blob(["\uFEFF", body], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function matchesSearch(row: CreatorListRow, query: string) {
  if (!query.trim()) return true;
  const n = query.trim().toLowerCase();
  return (
    row.creator_name.toLowerCase().includes(n) ||
    row.tiktok_id.toLowerCase().includes(n) ||
    (row.referrer_name?.toLowerCase().includes(n) ?? false)
  );
}

export function CreatorsListClient({ rows, month }: Props) {
  const [search, setSearch] = useState("");
  const [salesOnly, setSalesOnly] = useState(false);
  const [agencyId, setAgencyId] = useState(ALL);
  const [referrerName, setReferrerName] = useState(ALL);
  const [sortKey, setSortKey] = useState<SortKey>("salesMonth");
  const [page, setPage] = useState(0);

  const agencyOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) {
      if (r.agency_id) m.set(r.agency_id, r.agency_name);
    }
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1], "ja"));
  }, [rows]);

  const referrerOptions = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) {
      if (r.referrer_name) s.add(r.referrer_name);
    }
    return [...s].sort((a, b) => a.localeCompare(b, "ja"));
  }, [rows]);

  const filtered = useMemo(() => {
    return rows.filter((row) => {
      if (!matchesSearch(row, search)) return false;
      if (salesOnly && row.salesMonth <= 0 && row.salesTotal <= 0) return false;
      if (agencyId !== ALL && row.agency_id !== agencyId) return false;
      if (referrerName !== ALL && row.referrer_name !== referrerName) return false;
      return true;
    });
  }, [agencyId, referrerName, rows, salesOnly, search]);

  const sorted = useMemo(() => {
    const list = [...filtered];
    const dir = -1;
    list.sort((a, b) => {
      let av = 0;
      let bv = 0;
      switch (sortKey) {
        case "salesMonth":
          av = a.salesMonth;
          bv = b.salesMonth;
          break;
        case "profitMonth":
          av = a.profitMonth;
          bv = b.profitMonth;
          break;
        case "referralRewardMonth":
          av = a.referral_reward_month;
          bv = b.referral_reward_month;
          break;
        case "salesTotal":
          av = a.salesTotal;
          bv = b.salesTotal;
          break;
        default:
          av = a.salesMonth;
          bv = b.salesMonth;
      }
      if (av !== bv) return dir * (av - bv);
      return a.creator_name.localeCompare(b.creator_name, "ja");
    });
    return list;
  }, [filtered, sortKey]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = sorted.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const exportCsv = () => {
    const header = [
      "クリエイター名",
      "TikTok ID",
      "代理店",
      "紹介者",
      "今月売上",
      "累計売上",
      "今月収益",
      "累計収益",
      "代理店報酬(今月)",
      "代理店報酬(累計)",
      "紹介者報酬(今月)",
      "紹介者報酬(累計)",
      "LINE登録",
      "状態",
      "最終売上日",
    ];
    const lines = sorted.map((r) => [
      r.creator_name,
      r.tiktok_id,
      r.agency_name,
      r.referrer_name ?? "",
      r.salesMonth,
      r.salesTotal,
      r.profitMonth,
      r.profitTotal,
      r.agency_reward_month,
      r.agency_reward_total,
      r.referral_reward_month,
      r.referral_reward_total,
      formatOfficialLineRegisteredLabel(r.official_line_registered),
      formatCreatorSalesStatusLabel({
        agency_id: r.agency_id,
        registration_status: r.registration_status,
      }),
      r.last_sales_at ?? "",
    ]);
    downloadCsv(`creator_sales_${month}.csv`, header, lines);
  };

  function SortTh({ label, k }: { label: string; k: SortKey }) {
    const active = sortKey === k;
    return (
      <th className={thBase}>
        <button
          type="button"
          onClick={() => {
            setSortKey(k);
            setPage(0);
          }}
          className={`flex w-full items-center gap-1 text-left hover:text-zinc-200 ${active ? "text-cyan-300" : ""}`}
        >
          {label}
          <span className="font-mono text-[10px] text-zinc-600">↓</span>
        </button>
      </th>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-950/80 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Sales</p>
          <p className="text-xs text-zinc-500">
            対象月 <span className="font-mono text-zinc-400">{month}</span> · 表示{" "}
            <span className="font-mono text-zinc-300">{filtered.length}</span> / {rows.length}
          </p>
        </div>
        <button
          type="button"
          onClick={exportCsv}
          className="rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800"
        >
          CSV出力
        </button>
      </div>

      <section className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="text-[11px] font-medium text-zinc-500" htmlFor="cs-search">
              検索
            </label>
            <input
              id="cs-search"
              type="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
              placeholder="名前 / TikTok ID / 紹介者"
              className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-cyan-700"
            />
          </div>
          <div>
            <label className="text-[11px] font-medium text-zinc-500" htmlFor="cs-agency">
              代理店
            </label>
            <select
              id="cs-agency"
              value={agencyId}
              onChange={(e) => {
                setAgencyId(e.target.value);
                setPage(0);
              }}
              className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
            >
              <option value={ALL}>すべて</option>
              {agencyOptions.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[11px] font-medium text-zinc-500" htmlFor="cs-ref">
              紹介者
            </label>
            <select
              id="cs-ref"
              value={referrerName}
              onChange={(e) => {
                setReferrerName(e.target.value);
                setPage(0);
              }}
              className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
            >
              <option value={ALL}>すべて</option>
              {referrerOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end">
            <label className="flex min-h-[40px] w-full cursor-pointer items-center gap-2 rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-400">
              <input
                type="checkbox"
                checked={salesOnly}
                onChange={(e) => {
                  setSalesOnly(e.target.checked);
                  setPage(0);
                }}
                className="rounded border-zinc-600"
              />
              売上ありのみ
            </label>
          </div>
        </div>
      </section>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-zinc-800 py-10 text-center text-sm text-zinc-500">
          データがありません。
        </p>
      ) : filtered.length === 0 ? (
        <p className="rounded-lg border border-zinc-800 py-10 text-center text-sm text-zinc-500">
          条件に一致する行がありません。
        </p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950/80">
            <div className="max-h-[min(75vh,880px)] overflow-y-auto">
              <table className="min-w-[1200px] w-full border-collapse text-sm">
                <thead>
                  <tr>
                    <th className={`${thBase} sticky left-0 z-30 min-w-[140px] border-r border-zinc-800 bg-zinc-950`}>
                      クリエイター名
                    </th>
                    <th className={thBase}>TikTok ID</th>
                    <th className={thBase}>代理店</th>
                    <th className={thBase}>紹介者</th>
                    <SortTh label="今月売上" k="salesMonth" />
                    <SortTh label="累計売上" k="salesTotal" />
                    <SortTh label="今月収益" k="profitMonth" />
                    <th className={thBase}>累計収益</th>
                    <th className={thBase}>代理店報酬(今月)</th>
                    <th className={thBase}>代理店報酬(累計)</th>
                    <SortTh label="紹介者報酬(今月)" k="referralRewardMonth" />
                    <th className={thBase}>紹介者報酬(累計)</th>
                    <th className={thBase}>LINE登録</th>
                    <th className={thBase}>状態</th>
                    <th className={thBase}>最終売上日</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((r) => (
                    <tr key={r.id} className="border-b border-zinc-800/80 bg-zinc-950/40">
                      <td className="sticky left-0 z-10 border-r border-zinc-800/80 bg-zinc-950 px-3 py-2 font-medium text-zinc-100">
                        <Link href={`/creators/${r.id}`} className="text-cyan-400 hover:underline">
                          {r.creator_name}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-zinc-400">{r.tiktok_id}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs text-zinc-300">{r.agency_name}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs text-zinc-300">{r.referrer_name ?? "—"}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs text-zinc-200">
                        {formatYen(r.salesMonth)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs text-zinc-300">
                        {formatYen(r.salesTotal)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs text-cyan-300/90">
                        {formatYen(r.profitMonth)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs text-zinc-400">
                        {formatYen(r.profitTotal)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs text-zinc-200">
                        {formatYen(r.agency_reward_month)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs text-zinc-400">
                        {formatYen(r.agency_reward_total)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs text-amber-200/90">
                        {formatYen(r.referral_reward_month)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs text-zinc-400">
                        {formatYen(r.referral_reward_total)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs text-zinc-300">
                        {formatOfficialLineRegisteredLabel(r.official_line_registered)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs text-zinc-300">
                        {formatCreatorSalesStatusLabel({
                          agency_id: r.agency_id,
                          registration_status: r.registration_status,
                        })}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-zinc-500">
                        {formatDate(r.last_sales_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
            <span>
              {safePage + 1} / {pageCount} ページ（{PAGE_SIZE}件／ページ）
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={safePage <= 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                className="rounded border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-900 disabled:opacity-40"
              >
                前へ
              </button>
              <button
                type="button"
                disabled={safePage >= pageCount - 1}
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                className="rounded border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-900 disabled:opacity-40"
              >
                次へ
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
