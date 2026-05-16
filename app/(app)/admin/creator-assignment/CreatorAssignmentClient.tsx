"use client";

import {
  updateCreatorAssignmentAction,
  type UpdateCreatorAssignmentResult,
} from "@/app/actions/update-creator-assignment";
import type { AgencyOption, CreatorAssignmentRow } from "@/lib/db/creator-assignment-queries";
import { formatOfficialLineRegisteredLabel } from "@/lib/creators/referral-registration";
import { formatYen } from "@/lib/revenue/calc";
import Link from "next/link";
import { useActionState, useMemo, useState } from "react";

type Props = {
  agencies: AgencyOption[];
  creators: CreatorAssignmentRow[];
  unassignedCreators: CreatorAssignmentRow[];
  pendingCreators: CreatorAssignmentRow[];
};

const UNASSIGNED_VALUE = "";

function matchesSearch(query: string, row: CreatorAssignmentRow) {
  if (!query.trim()) return true;
  const n = query.trim().toLowerCase();
  return (
    row.tiktok_id.toLowerCase().includes(n) ||
    row.creator_name.toLowerCase().includes(n) ||
    (row.referrer_name?.toLowerCase().includes(n) ?? false)
  );
}

function applyDefaultCommissionOnAssign(
  agencies: AgencyOption[],
  previousAgencyId: string,
  nextAgencyId: string,
  setCommissionRate: (value: string) => void,
) {
  if (previousAgencyId !== UNASSIGNED_VALUE || nextAgencyId === UNASSIGNED_VALUE) {
    return;
  }
  const agency = agencies.find((item) => item.id === nextAgencyId);
  if (agency) {
    setCommissionRate(String(agency.default_commission_rate));
  }
}

function AssignmentRow({
  row,
  agencies,
  showSales,
  state,
}: {
  row: CreatorAssignmentRow;
  agencies: AgencyOption[];
  showSales: boolean;
  state: UpdateCreatorAssignmentResult | null;
}) {
  const [localState, formAction, isPending] = useActionState(
    updateCreatorAssignmentAction,
    state,
  );
  const displayState = localState ?? state;
  const formId = `creator-assignment-${row.id}`;

  const [agencyId, setAgencyId] = useState(row.agency_id ?? UNASSIGNED_VALUE);
  const [commissionRate, setCommissionRate] = useState(String(row.commission_rate));

  return (
    <tr className="border-b border-white/[0.04] align-top hover:bg-white/[0.02]">
      <td className="px-3 py-2 font-medium text-zinc-100">
        <form id={formId} action={formAction} className="inline">
          <input type="hidden" name="creator_id" value={row.id} />
        </form>
        {row.creator_name}
      </td>
      <td className="px-3 py-2 font-mono text-xs text-zinc-400">{row.tiktok_id}</td>
      <td className="px-3 py-2 text-xs text-zinc-300">{row.referrer_name ?? "—"}</td>
      <td className="px-3 py-2 text-xs text-zinc-300">
        {formatOfficialLineRegisteredLabel(row.official_line_registered)}
      </td>
      {showSales ? (
        <td className="px-3 py-2 text-right font-mono text-xs text-zinc-300">
          {formatYen(row.sales_month)}
        </td>
      ) : null}
      <td className="px-3 py-2">
        <label className="sr-only" htmlFor={`agency-${row.id}`}>
          代理店
        </label>
        <select
          id={`agency-${row.id}`}
          form={formId}
          name="agency_id"
          value={agencyId}
          onChange={(event) => {
            const next = event.target.value;
            applyDefaultCommissionOnAssign(agencies, agencyId, next, setCommissionRate);
            setAgencyId(next);
          }}
          className="w-full min-w-[8rem] rounded-lg border border-white/[0.08] bg-surface-0 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-[var(--accent-cyan)]/40"
        >
          <option value={UNASSIGNED_VALUE}>未振り分け</option>
          {agencies.map((agency) => (
            <option key={agency.id} value={agency.id}>
              {agency.name}
            </option>
          ))}
        </select>
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-1">
          <input
            form={formId}
            name="commission_rate"
            type="number"
            inputMode="decimal"
            min={0}
            max={100}
            step={0.01}
            value={commissionRate}
            onChange={(event) => setCommissionRate(event.target.value)}
            className="w-20 rounded-lg border border-white/[0.08] bg-surface-0 px-2 py-1.5 text-right font-mono text-sm text-zinc-100 outline-none focus:border-[var(--accent-cyan)]/40"
          />
          <span className="text-xs text-zinc-500">%</span>
        </div>
      </td>
      <td className="px-3 py-2">
        <select
          form={formId}
          name="registration_status"
          defaultValue={row.registration_status ?? "assigned"}
          className="w-full min-w-[6rem] rounded-lg border border-white/[0.08] bg-surface-0 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-[var(--accent-cyan)]/40"
        >
          <option value="pending">仮登録</option>
          <option value="assigned">稼働中</option>
          <option value="inactive">停止</option>
        </select>
      </td>
      <td className="px-3 py-2">
        <input
          form={formId}
          name="tiktok_id_new"
          type="text"
          placeholder="修正時のみ"
          autoComplete="off"
          className="w-full min-w-[7rem] rounded-lg border border-white/[0.08] bg-surface-0 px-2 py-1.5 font-mono text-xs text-zinc-100 outline-none focus:border-[var(--accent-cyan)]/40"
        />
      </td>
      <td className="px-3 py-2 text-right">
        <button
          form={formId}
          type="submit"
          className="inline-flex min-h-[36px] items-center justify-center rounded-lg bg-gradient-to-r from-[var(--accent-cyan)]/90 to-[var(--accent-magenta)]/80 px-3 py-1.5 text-xs font-semibold text-zinc-950 hover:opacity-90"
        >
          保存
        </button>
      </td>
      <td className="px-3 py-2 align-top text-xs">
        {displayState?.ok ? <p className="text-emerald-300">{displayState.message}</p> : null}
        {displayState && !displayState.ok ? <p className="text-red-300">{displayState.error}</p> : null}
        {isPending ? <p className="text-zinc-500">保存中…</p> : null}
      </td>
    </tr>
  );
}

function PendingSection({ rows, agencies }: { rows: CreatorAssignmentRow[]; agencies: AgencyOption[] }) {
  if (rows.length === 0) {
    return (
      <section className="rounded-2xl border border-white/[0.06] bg-surface-1/40 p-4">
        <h2 className="text-lg font-semibold text-zinc-100">新規登録（仮登録）クリエイター</h2>
        <p className="mt-2 text-sm text-zinc-500">該当するクリエイターはいません。</p>
      </section>
    );
  }

  return (
    <section className="space-y-3 rounded-2xl border border-cyan-500/20 bg-cyan-500/[0.04] p-4 sm:p-5">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-cyan-200/80">
          新規登録（仮登録）クリエイター
        </p>
        <p className="mt-1 text-sm text-zinc-400">紹介リンク等で仮登録されたクリエイターを新しい順に表示します。</p>
      </div>
      <div className="overflow-x-auto rounded-xl border border-white/[0.06]">
        <table className="w-full min-w-[1100px] text-left text-sm">
          <thead>
            <tr className="border-b border-white/[0.06] bg-surface-1/80 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              <th className="px-3 py-2">名前</th>
              <th className="px-3 py-2">TikTok ID</th>
              <th className="px-3 py-2">紹介者</th>
              <th className="px-3 py-2">LINE</th>
              <th className="px-3 py-2">代理店</th>
              <th className="px-3 py-2">分配率</th>
              <th className="px-3 py-2">ステータス</th>
              <th className="px-3 py-2">TikTok修正</th>
              <th className="px-3 py-2 text-right">操作</th>
              <th className="px-3 py-2">結果</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <AssignmentRow key={row.id} row={row} agencies={agencies} showSales={false} state={null} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function UnassignedSection({ rows, agencies }: { rows: CreatorAssignmentRow[]; agencies: AgencyOption[] }) {
  return (
    <section className="space-y-3 rounded-2xl border border-amber-500/20 bg-amber-500/[0.04] p-4 sm:p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-200/80">
            未振り分けクリエイター
          </p>
          <p className="mt-1 text-sm text-zinc-400">
            今月売上がある行を上に表示し、次に新しい登録順です。
          </p>
        </div>
        <p className="text-sm text-zinc-300">
          件数: <span className="font-mono text-amber-100">{rows.length}</span>
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-xl border border-white/[0.06] bg-surface-1/40 px-4 py-6 text-center text-sm text-zinc-500">
          未振り分けのクリエイターはいません。
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-white/[0.06]">
          <table className="w-full min-w-[1180px] text-left text-sm">
            <thead>
              <tr className="border-b border-white/[0.06] bg-surface-1/80 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                <th className="px-3 py-2">名前</th>
                <th className="px-3 py-2">TikTok ID</th>
                <th className="px-3 py-2">紹介者</th>
                <th className="px-3 py-2">LINE</th>
                <th className="px-3 py-2 text-right">今月売上</th>
                <th className="px-3 py-2">代理店</th>
                <th className="px-3 py-2">分配率</th>
                <th className="px-3 py-2">ステータス</th>
                <th className="px-3 py-2">TikTok修正</th>
                <th className="px-3 py-2 text-right">操作</th>
                <th className="px-3 py-2">結果</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <AssignmentRow key={row.id} row={row} agencies={agencies} showSales state={null} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function CreatorAssignmentClient({
  agencies,
  creators,
  unassignedCreators,
  pendingCreators,
}: Props) {
  const [search, setSearch] = useState("");
  const [agencyFilter, setAgencyFilter] = useState("all");
  const [unassignedOnly, setUnassignedOnly] = useState(false);

  const filtered = useMemo(() => {
    return creators.filter((row) => {
      if (!matchesSearch(search, row)) return false;
      if (unassignedOnly && row.agency_id != null) return false;
      if (agencyFilter !== "all") {
        if (agencyFilter === UNASSIGNED_VALUE) {
          if (row.agency_id != null) return false;
        } else if (row.agency_id !== agencyFilter) {
          return false;
        }
      }
      return true;
    });
  }, [agencyFilter, creators, search, unassignedOnly]);

  return (
    <div className="space-y-8">
      <UnassignedSection rows={unassignedCreators} agencies={agencies} />
      <PendingSection rows={pendingCreators} agencies={agencies} />

      <div className="space-y-6">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">全クリエイター</h2>
          <p className="mt-1 text-sm text-zinc-500">
            一覧から直接編集できます。紹介者の紐付け変更は{" "}
            <Link href="/admin/creator-referrals" className="text-[var(--accent-cyan)] hover:underline">
              CR紹介者管理
            </Link>
            へ。
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="sm:col-span-2">
            <label
              className="text-[11px] font-medium uppercase tracking-wider text-zinc-500"
              htmlFor="creator-assignment-search"
            >
              検索
            </label>
            <input
              id="creator-assignment-search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="名前 / TikTok ID / 紹介者"
              className="mt-1.5 w-full rounded-xl border border-white/[0.08] bg-surface-1/60 px-4 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-[var(--accent-cyan)]/40"
            />
          </div>
          <div>
            <label
              className="text-[11px] font-medium uppercase tracking-wider text-zinc-500"
              htmlFor="creator-assignment-agency"
            >
              代理店フィルター
            </label>
            <select
              id="creator-assignment-agency"
              value={agencyFilter}
              onChange={(event) => setAgencyFilter(event.target.value)}
              className="mt-1.5 w-full rounded-xl border border-white/[0.08] bg-surface-1/60 px-4 py-2.5 text-sm text-zinc-100 outline-none focus:border-[var(--accent-cyan)]/40"
            >
              <option value="all">すべて</option>
              <option value={UNASSIGNED_VALUE}>未振り分けのみ</option>
              {agencies.map((agency) => (
                <option key={agency.id} value={agency.id}>
                  {agency.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end">
            <label className="flex min-h-[44px] w-full cursor-pointer items-center gap-3 rounded-xl border border-white/[0.08] bg-surface-1/60 px-4 py-2.5 text-sm text-zinc-300">
              <input
                type="checkbox"
                checked={unassignedOnly}
                onChange={(event) => setUnassignedOnly(event.target.checked)}
                className="h-4 w-4 rounded border-white/20 bg-surface-0 text-[var(--accent-cyan)]"
              />
              未振り分けだけ表示
            </label>
          </div>
        </div>

        <p className="text-xs text-zinc-600">
          表示件数: <span className="font-mono text-zinc-400">{filtered.length}</span> / {creators.length}
        </p>

        {filtered.length === 0 ? (
          <p className="rounded-xl border border-white/[0.06] bg-surface-1/40 px-4 py-8 text-center text-sm text-zinc-500">
            条件に一致するクリエイターはいません。
          </p>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-white/[0.06]">
            <table className="w-full min-w-[1180px] text-left text-sm">
              <thead>
                <tr className="border-b border-white/[0.06] bg-surface-1/80 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                  <th className="px-3 py-2">名前</th>
                  <th className="px-3 py-2">TikTok ID</th>
                  <th className="px-3 py-2">紹介者</th>
                  <th className="px-3 py-2">LINE</th>
                  <th className="px-3 py-2">代理店</th>
                  <th className="px-3 py-2">分配率</th>
                  <th className="px-3 py-2">ステータス</th>
                  <th className="px-3 py-2">TikTok修正</th>
                  <th className="px-3 py-2 text-right">操作</th>
                  <th className="px-3 py-2">結果</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <AssignmentRow key={row.id} row={row} agencies={agencies} showSales={false} state={null} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
