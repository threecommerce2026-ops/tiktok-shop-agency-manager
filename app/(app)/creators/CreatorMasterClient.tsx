"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";

import {
  updateCreatorMasterAction,
  type CreatorMasterActionResult,
} from "@/app/actions/update-creator-master";
import {
  ACCOUNT_MANAGEMENT_TYPE_OPTIONS,
  accountManagementTypeLabel,
  type AccountManagementType,
} from "@/lib/creators/account-management-type";
import { MonthlyAssignmentLauncher } from "@/components/agency/MonthlyAssignmentLauncher";
import type { CreatorMasterRow } from "@/lib/db/creator-master-queries";
import { formatCreatorRegistrationStatusLabel } from "@/lib/creators/referral-registration";
import { formatYen, formatYenPrecise } from "@/lib/revenue/calc";

const ALL = "all";
const PAGE_SIZE = 50;

const thBase =
  "sticky top-0 z-20 whitespace-nowrap border-b border-zinc-800 bg-zinc-950/98 px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-400";

const td = "whitespace-nowrap px-3 py-2 text-xs";

type Agency = {
  id: string;
  name: string;
  defaultCommissionRate: number;
  isActive: boolean;
};
type Referrer = { id: string; name: string; isActive: boolean };

function typeBadgeClass(type: AccountManagementType): string {
  switch (type) {
    case "self_operated":
      return "border-violet-400/25 bg-violet-400/10 text-violet-200";
    case "account_lending":
      return "border-amber-400/25 bg-amber-400/10 text-amber-200";
    default:
      return "border-white/[0.08] bg-white/[0.03] text-zinc-400";
  }
}

function formatDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit" });
}

function downloadCsv(filename: string, header: string[], lines: Array<Array<string | number>>) {
  const escape = (cell: string | number) => {
    const s = String(cell);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [
    header.map(escape).join(","),
    ...lines.map((row) => row.map(escape).join(",")),
  ].join("\n");
  const blob = new Blob(["﻿", body], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function EditPanel({
  row,
  agencies,
  referrers,
  onClose,
}: {
  row: CreatorMasterRow;
  agencies: Agency[];
  referrers: Referrer[];
  onClose: () => void;
}) {
  const [state, formAction, pending] = useActionState<
    CreatorMasterActionResult | null,
    FormData
  >(updateCreatorMasterAction, null);

  return (
    <form
      action={formAction}
      className="space-y-3 rounded-xl border border-cyan-500/20 bg-cyan-500/[0.04] p-4"
    >
      <input type="hidden" name="creator_id" value={row.id} />

      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-zinc-100">{row.creatorName}</p>
          <p className="font-mono text-xs text-zinc-500">{row.tiktokIdLabel}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-zinc-500 hover:text-zinc-300"
        >
          閉じる
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label
            htmlFor={`agency-${row.id}`}
            className="text-[11px] font-medium text-zinc-500"
          >
            所属代理店
          </label>
          <select
            id={`agency-${row.id}`}
            name="agency_id"
            defaultValue={row.agencyId ?? ""}
            className="mt-1 w-full rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100"
          >
            <option value="">未振り分け</option>
            {agencies
              .filter((agency) => agency.isActive || agency.id === row.agencyId)
              .map((agency) => (
                <option key={agency.id} value={agency.id}>
                  {agency.name}
                  {agency.isActive ? "" : "（無効）"}
                </option>
              ))}
          </select>
        </div>

        <div>
          <label
            htmlFor={`referrer-${row.id}`}
            className="text-[11px] font-medium text-zinc-500"
          >
            紹介者
          </label>
          <select
            id={`referrer-${row.id}`}
            name="referrer_id"
            defaultValue={row.referrerId ?? ""}
            className="mt-1 w-full rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100"
          >
            <option value="">なし</option>
            {/* 無効な紹介者は新規選択から除外する（現在値のときだけ残す） */}
            {referrers
              .filter((referrer) => referrer.isActive || referrer.id === row.referrerId)
              .map((referrer) => (
                <option key={referrer.id} value={referrer.id}>
                  {referrer.name}
                  {referrer.isActive ? "" : "（無効）"}
                </option>
              ))}
          </select>
        </div>

        <div>
          <label
            htmlFor={`type-${row.id}`}
            className="text-[11px] font-medium text-zinc-500"
          >
            区分
          </label>
          <select
            id={`type-${row.id}`}
            name="account_management_type"
            defaultValue={row.accountManagementType}
            className="mt-1 w-full rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100"
          >
            {ACCOUNT_MANAGEMENT_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label
            htmlFor={`rate-${row.id}`}
            className="text-[11px] font-medium text-zinc-500"
          >
            分配率（代理店側 %）
          </label>
          <input
            id={`rate-${row.id}`}
            name="commission_rate"
            type="number"
            step="0.1"
            min="0"
            max="100"
            defaultValue={row.commissionRate}
            className="mt-1 w-full rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 font-mono text-sm text-zinc-100"
          />
        </div>

        <div>
          <label
            htmlFor={`status-${row.id}`}
            className="text-[11px] font-medium text-zinc-500"
          >
            登録状態
          </label>
          <select
            id={`status-${row.id}`}
            name="registration_status"
            defaultValue={row.registrationStatus ?? "pending"}
            className="mt-1 w-full rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100"
          >
            <option value="pending">仮登録</option>
            <option value="assigned">運用中</option>
            <option value="inactive">無効</option>
          </select>
        </div>
      </div>

      <p className="text-[11px] leading-relaxed text-zinc-600">
        自社運用・アカウント貸出に設定したクリエイターには、通常の紹介者報酬5%は発生しません。
      </p>

      <div className="rounded-lg border border-white/[0.08] bg-surface-0/50 p-3">
        <p className="text-[11px] font-semibold text-zinc-300">
          この編集フォームは「現在所属」を変更します
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
          過去月の代理店報酬の帰属先は「月別所属」で確定します。
          現在所属を変えても、月別確定済みの過去月の帰属は変わりません。
        </p>
        <div className="mt-2">
          <MonthlyAssignmentLauncher
            creatorId={row.id}
            label="月別所属を確認・確定する"
            className="rounded-lg border border-white/[0.12] px-3 py-2 text-xs font-medium text-zinc-100 transition hover:bg-white/[0.06] disabled:opacity-50"
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="min-h-[40px] rounded-lg bg-white px-5 text-sm font-semibold text-zinc-950 transition hover:bg-zinc-200 disabled:opacity-50"
        >
          {pending ? "保存中…" : "保存"}
        </button>

        {state ? (
          <span
            className={`text-xs ${state.ok ? "text-emerald-300" : "text-red-300"}`}
            role="status"
          >
            {state.ok ? state.message : state.error}
          </span>
        ) : null}
      </div>
    </form>
  );
}

export function CreatorMasterClient({
  rows,
  agencies,
  referrers,
  month,
  isAdmin,
}: {
  rows: CreatorMasterRow[];
  agencies: Agency[];
  referrers: Referrer[];
  month: string;
  isAdmin: boolean;
}) {
  const [search, setSearch] = useState("");
  const [agencyId, setAgencyId] = useState(ALL);
  const [referrerId, setReferrerId] = useState(ALL);
  const [typeFilter, setTypeFilter] = useState(ALL);
  const [linkFilter, setLinkFilter] = useState(ALL);
  const [page, setPage] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (agencyId !== ALL) {
        if (agencyId === "none" ? row.agencyId !== null : row.agencyId !== agencyId) {
          return false;
        }
      }
      if (referrerId !== ALL) {
        if (referrerId === "none" ? row.referrerId !== null : row.referrerId !== referrerId) {
          return false;
        }
      }
      if (typeFilter !== ALL && row.accountManagementType !== typeFilter) return false;
      if (linkFilter !== ALL && row.linkState !== linkFilter) return false;
      if (!q) return true;
      return (
        row.creatorName.toLowerCase().includes(q) ||
        row.tiktokId.toLowerCase().includes(q) ||
        (row.referrerName?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [agencyId, linkFilter, referrerId, rows, search, typeFilter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  const editingRow = rows.find((row) => row.id === editingId) ?? null;

  function exportCsv() {
    downloadCsv(
      `creators_${month}.csv`,
      [
        "TikTok ID",
        "クリエイター名",
        "リンク状態",
        "所属代理店",
        "紹介者",
        "区分",
        "分配率",
        "今月売上",
        "累計売上",
        "今月紹介報酬",
        "登録日",
      ],
      filtered.map((row) => [
        row.tiktokIdLabel,
        row.creatorName,
        row.linkState === "linked" ? "連携済み" : "未連携",
        row.agencyName,
        row.referrerName ?? "",
        accountManagementTypeLabel(row.accountManagementType),
        row.commissionRate,
        Math.round(row.salesMonth),
        Math.round(row.salesTotal),
        row.referralRewardMonth,
        formatDate(row.createdAt),
      ]),
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-xl border border-white/[0.06] bg-surface-1/40 p-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-zinc-500">
          対象月 <span className="font-mono text-zinc-300">{month}</span> · 表示{" "}
          <span className="font-mono text-zinc-200">{filtered.length}</span> / {rows.length} 名
        </p>
        <button
          type="button"
          onClick={exportCsv}
          className="min-h-[36px] rounded-lg border border-white/[0.1] px-3 text-xs font-medium text-zinc-200 transition hover:bg-white/[0.06]"
        >
          CSV出力
        </button>
      </div>

      <section className="rounded-xl border border-white/[0.06] bg-surface-1/40 p-4">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-5">
          <div>
            <label htmlFor="cm-search" className="text-[11px] font-medium text-zinc-500">
              検索
            </label>
            <input
              id="cm-search"
              type="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
              placeholder="TikTok ID / クリエイター名"
              className="mt-1 w-full rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-cyan-700"
            />
          </div>

          <div>
            <label htmlFor="cm-agency" className="text-[11px] font-medium text-zinc-500">
              代理店
            </label>
            <select
              id="cm-agency"
              value={agencyId}
              onChange={(e) => {
                setAgencyId(e.target.value);
                setPage(0);
              }}
              className="mt-1 w-full rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100"
            >
              <option value={ALL}>すべて</option>
              <option value="none">未振り分け</option>
              {agencies.map((agency) => (
                <option key={agency.id} value={agency.id}>
                  {agency.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="cm-referrer" className="text-[11px] font-medium text-zinc-500">
              紹介者
            </label>
            <select
              id="cm-referrer"
              value={referrerId}
              onChange={(e) => {
                setReferrerId(e.target.value);
                setPage(0);
              }}
              className="mt-1 w-full rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100"
            >
              <option value={ALL}>すべて</option>
              <option value="none">なし</option>
              {/* 絞り込みは既存データを見るためのものなので無効紹介者も出す */}
              {referrers.map((referrer) => (
                <option key={referrer.id} value={referrer.id}>
                  {referrer.name}
                  {referrer.isActive ? "" : "【無効】"}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="cm-type" className="text-[11px] font-medium text-zinc-500">
              区分
            </label>
            <select
              id="cm-type"
              value={typeFilter}
              onChange={(e) => {
                setTypeFilter(e.target.value);
                setPage(0);
              }}
              className="mt-1 w-full rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100"
            >
              <option value={ALL}>すべて</option>
              {ACCOUNT_MANAGEMENT_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="cm-link" className="text-[11px] font-medium text-zinc-500">
              リンク状態
            </label>
            <select
              id="cm-link"
              value={linkFilter}
              onChange={(e) => {
                setLinkFilter(e.target.value);
                setPage(0);
              }}
              className="mt-1 w-full rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100"
            >
              <option value={ALL}>すべて</option>
              <option value="linked">連携済み</option>
              <option value="pending">未連携</option>
            </select>
          </div>
        </div>
      </section>

      {isAdmin && editingRow ? (
        <EditPanel
          key={editingRow.id}
          row={editingRow}
          agencies={agencies}
          referrers={referrers}
          onClose={() => setEditingId(null)}
        />
      ) : null}

      {filtered.length === 0 ? (
        <p className="rounded-xl border border-zinc-800 py-10 text-center text-sm text-zinc-500">
          条件に一致するクリエイターがいません。
        </p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950/70">
            <div className="max-h-[min(72vh,840px)] overflow-y-auto">
              <table className="w-full min-w-[1080px] border-collapse text-sm">
                <thead>
                  <tr>
                    <th className={thBase}>TikTok ID</th>
                    <th className={thBase}>クリエイター名</th>
                    <th className={thBase}>リンク</th>
                    <th className={thBase}>所属代理店</th>
                    <th className={thBase}>紹介者</th>
                    <th className={thBase}>区分</th>
                    <th className={`${thBase} text-right`}>分配率</th>
                    <th className={`${thBase} text-right`}>今月売上</th>
                    <th className={`${thBase} text-right`}>累計売上</th>
                    <th className={`${thBase} text-right`}>今月紹介報酬</th>
                    <th className={thBase}>登録日</th>
                    {isAdmin ? <th className={thBase}>月別所属</th> : null}
                    {isAdmin ? <th className={thBase}>編集</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((row) => (
                    <tr
                      key={row.id}
                      className={`border-b border-zinc-800/70 ${
                        editingId === row.id ? "bg-cyan-500/[0.05]" : ""
                      }`}
                    >
                      <td className={`${td} font-mono text-zinc-300`}>{row.tiktokIdLabel}</td>
                      <td className={`${td} font-medium text-zinc-100`}>
                        <Link href={`/creators/${row.id}`} className="text-cyan-400 hover:underline">
                          {row.creatorName}
                        </Link>
                      </td>
                      <td className={td}>
                        <span
                          className={`rounded-full border px-2 py-0.5 text-[11px] ${
                            row.linkState === "linked"
                              ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-300"
                              : "border-zinc-700 bg-zinc-800/50 text-zinc-500"
                          }`}
                        >
                          {row.linkState === "linked" ? "連携済み" : "未連携"}
                        </span>
                      </td>
                      <td className={`${td} text-zinc-300`}>{row.agencyName}</td>
                      <td className={`${td} text-zinc-300`}>{row.referrerName ?? "—"}</td>
                      <td className={td}>
                        <span
                          className={`rounded-full border px-2 py-0.5 text-[11px] ${typeBadgeClass(
                            row.accountManagementType,
                          )}`}
                        >
                          {accountManagementTypeLabel(row.accountManagementType)}
                        </span>
                      </td>
                      <td className={`${td} text-right font-mono text-zinc-300`}>
                        {row.commissionRate}%
                      </td>
                      <td className={`${td} text-right font-mono text-zinc-200`}>
                        {formatYen(Math.round(row.salesMonth))}
                      </td>
                      <td className={`${td} text-right font-mono text-zinc-400`}>
                        {formatYen(Math.round(row.salesTotal))}
                      </td>
                      <td className={`${td} text-right font-mono text-amber-200/90`}>
                        {row.referralEligible ? formatYenPrecise(row.referralRewardMonth) : "—"}
                      </td>
                      <td className={`${td} font-mono text-zinc-500`}>
                        {formatDate(row.createdAt)}
                        <span className="ml-2 text-[10px] text-zinc-600">
                          {formatCreatorRegistrationStatusLabel(row.registrationStatus)}
                        </span>
                      </td>
                      {isAdmin ? (
                        <td className={td}>
                          <MonthlyAssignmentLauncher creatorId={row.id} label="月別所属" />
                        </td>
                      ) : null}
                      {isAdmin ? (
                        <td className={td}>
                          <button
                            type="button"
                            onClick={() =>
                              setEditingId((prev) => (prev === row.id ? null : row.id))
                            }
                            className="rounded border border-white/[0.1] px-2.5 py-1 text-[11px] text-zinc-200 transition hover:bg-white/[0.06]"
                          >
                            {editingId === row.id ? "編集中" : "編集"}
                          </button>
                        </td>
                      ) : null}
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
