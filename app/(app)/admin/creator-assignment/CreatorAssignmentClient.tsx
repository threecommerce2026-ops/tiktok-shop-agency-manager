"use client";

import {
  updateCreatorAssignmentAction,
  type UpdateCreatorAssignmentResult,
} from "@/app/actions/update-creator-assignment";
import {
  resetCreatorMonthlyCommissionRate,
  saveCreatorMonthlyCommissionRate,
} from "@/app/actions/creator-monthly-commission-rate";
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
  targetMonth: string;
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

function AssignmentRow({
  row,
  agencies,
  showSales,
  state,
  scope,
  targetMonth,
}: {
  row: CreatorAssignmentRow;
  agencies: AgencyOption[];
  showSales: boolean;
  state: UpdateCreatorAssignmentResult | null;
  scope: string;
  targetMonth: string;
}) {
  const [localState, formAction, isPending] = useActionState(
    updateCreatorAssignmentAction,
    state,
  );
  const displayState = localState ?? state;
  const formId = `creator-assignment-${scope}-${row.id}`;

  const [agencyId, setAgencyId] = useState(row.agency_id ?? UNASSIGNED_VALUE);

  return (
    <tr className="border-b border-white/[0.04] align-top hover:bg-white/[0.02]">
      <td className="px-3 py-2 font-medium text-zinc-100">
        <form id={formId} action={formAction} className="inline">
          <input type="hidden" name="creator_id" value={row.id} />
          <input
            type="hidden"
            name="commission_rate"
            value={String(row.commission_rate)}
          />
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
        <label className="sr-only" htmlFor={`agency-${scope}-${row.id}`}>
          代理店
        </label>
        <select
          id={`agency-${scope}-${row.id}`}
          form={formId}
          name="agency_id"
          value={agencyId}
          onChange={(event) => {
            setAgencyId(event.target.value);
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
        {row.tiktok_agency_split_rate === null ||
        row.tiktok_creator_split_rate === null ? (
          <div className="whitespace-nowrap">
            <span className="rounded-full border border-zinc-500/20 bg-zinc-500/10 px-2 py-0.5 text-[10px] font-semibold text-zinc-400">
              実分配率データなし
            </span>
          </div>
        ) : (
          <div className="space-y-1 whitespace-nowrap text-xs">
            {row.tiktok_creator_split_rate === 100 ? (
              <div>
                <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-200">
                  クリエイター100%
                </span>
              </div>
            ) : row.tiktok_agency_split_rate === 100 ? (
              <div>
                <span className="rounded-full border border-cyan-400/30 bg-cyan-400/10 px-2 py-0.5 text-[10px] font-semibold text-cyan-200">
                  エージェンシー100%
                </span>
              </div>
            ) : null}

            <div className="text-zinc-300">
              エージェンシー{" "}
              <span className="font-mono text-zinc-100">
                {row.tiktok_agency_split_rate}%
              </span>
            </div>

            <div className="text-zinc-500">
              クリエイター{" "}
              <span className="font-mono text-zinc-300">
                {row.tiktok_creator_split_rate}%
              </span>
            </div>
          </div>
        )}
      </td>
      <td className="px-3 py-2">
        <div className="min-w-[190px] space-y-2">
          <form action={saveCreatorMonthlyCommissionRate} className="space-y-2">
            <input type="hidden" name="creatorId" value={row.id} />
            <input type="hidden" name="targetMonth" value={targetMonth} />

            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] text-zinc-500">
                {targetMonth}
              </span>

              {row.has_manual_split_override ? (
                <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[10px] font-semibold text-amber-200">
                  手動補正中
                </span>
              ) : (
                <span className="text-[10px] text-zinc-600">
                  自動
                </span>
              )}
            </div>

            <div className="flex items-center gap-1.5">
              <input
                name="commissionRate"
                type="number"
                min="0"
                max="100"
                step="0.01"
                required
                defaultValue={
                  row.manual_creator_split_rate ??
                  row.tiktok_creator_split_rate ??
                  ""
                }
                placeholder="入力"
                className="w-20 rounded-lg border border-white/[0.08] bg-surface-0 px-2 py-1.5 font-mono text-xs text-zinc-100 outline-none focus:border-[var(--accent-cyan)]/40"
              />

              <span className="text-xs text-zinc-500">%</span>

              <button
                type="submit"
                className="rounded-lg border border-cyan-400/20 bg-cyan-400/10 px-2.5 py-1.5 text-xs font-semibold text-cyan-100 hover:bg-cyan-400/15"
              >
                保存
              </button>
            </div>
          </form>

          <div className="text-[10px] leading-relaxed text-zinc-500">
            適用：
            {(
              row.manual_creator_split_rate ??
              row.tiktok_creator_split_rate
            ) === null ? (
              <span> —</span>
            ) : (
              <>
                <span className="font-mono text-zinc-300">
                  {" "}クリエイター{" "}
                  {row.manual_creator_split_rate ??
                    row.tiktok_creator_split_rate}
                  %
                </span>

                <span className="block font-mono">
                  エージェンシー{" "}
                  {100 -
                    (row.manual_creator_split_rate ??
                      row.tiktok_creator_split_rate ??
                      0)}
                  %
                </span>
              </>
            )}
          </div>

          {row.has_manual_split_override ? (
            <form action={resetCreatorMonthlyCommissionRate}>
              <input type="hidden" name="creatorId" value={row.id} />
              <input type="hidden" name="targetMonth" value={targetMonth} />

              <button
                type="submit"
                className="text-[11px] font-medium text-zinc-400 underline decoration-zinc-700 underline-offset-2 hover:text-zinc-200"
              >
                自動に戻す
              </button>
            </form>
          ) : null}
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

function PendingSection({
  rows,
  agencies,
  targetMonth,
}: {
  rows: CreatorAssignmentRow[];
  agencies: AgencyOption[];
  targetMonth: string;
}) {
  if (rows.length === 0) {
    return (
      <section className="rounded-2xl border border-white/[0.06] bg-surface-1/40 p-4">
        <h2 className="text-lg font-semibold text-zinc-100">登録確認が必要なクリエイター</h2>
        <p className="mt-2 text-sm text-zinc-500">該当するクリエイターはいません。</p>
      </section>
    );
  }

  return (
    <section className="space-y-3 rounded-2xl border border-cyan-500/20 bg-cyan-500/[0.04] p-4 sm:p-5">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-cyan-200/80">
          登録確認が必要なクリエイター
        </p>
        <p className="mt-1 text-sm text-zinc-400">仮登録中で、登録内容の確認が必要なクリエイターです。代理店設定済みでも仮登録中の場合はここに表示されます。</p>
      </div>
      <div className="overflow-x-auto rounded-xl border border-white/[0.06]">
        <table className="w-full min-w-[1340px] text-left text-sm">
          <thead>
            <tr className="border-b border-white/[0.06] bg-surface-1/80 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              <th className="px-3 py-2">名前</th>
              <th className="px-3 py-2">TikTok ID</th>
              <th className="px-3 py-2">紹介者</th>
              <th className="px-3 py-2">LINE</th>
              <th className="px-3 py-2">代理店</th>
              <th className="px-3 py-2">TikTok実分配率</th>
              <th className="px-3 py-2">手動補正（クリエイター）</th>
              <th className="px-3 py-2">ステータス</th>
              <th className="px-3 py-2">TikTok修正</th>
              <th className="px-3 py-2 text-right">操作</th>
              <th className="px-3 py-2">結果</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <AssignmentRow
                key={row.id}
                row={row}
                agencies={agencies}
                showSales={false}
                state={null}
                scope="pending"
                  targetMonth={targetMonth}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function UnassignedSection({
  rows,
  agencies,
  targetMonth,
}: {
  rows: CreatorAssignmentRow[];
  agencies: AgencyOption[];
  targetMonth: string;
}) {
  return (
    <section className="space-y-3 rounded-2xl border border-amber-500/20 bg-amber-500/[0.04] p-4 sm:p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-200/80">
            代理店未設定のクリエイター
          </p>
          <p className="mt-1 text-sm text-zinc-400">
            代理店がまだ設定されていない要対応クリエイターです。今月売上がある行を優先して表示します。
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
          <table className="w-full min-w-[1420px] text-left text-sm">
            <thead>
              <tr className="border-b border-white/[0.06] bg-surface-1/80 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                <th className="px-3 py-2">名前</th>
                <th className="px-3 py-2">TikTok ID</th>
                <th className="px-3 py-2">紹介者</th>
                <th className="px-3 py-2">LINE</th>
                <th className="px-3 py-2 text-right">今月売上</th>
                <th className="px-3 py-2">代理店</th>
                <th className="px-3 py-2">TikTok実分配率</th>
              <th className="px-3 py-2">手動補正（クリエイター）</th>
                <th className="px-3 py-2">ステータス</th>
                <th className="px-3 py-2">TikTok修正</th>
                <th className="px-3 py-2 text-right">操作</th>
                <th className="px-3 py-2">結果</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <AssignmentRow
                  key={row.id}
                  row={row}
                  agencies={agencies}
                  showSales
                  state={null}
                  scope="unassigned"
                  targetMonth={targetMonth}
                />
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
  targetMonth,
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
      <UnassignedSection
        rows={unassignedCreators}
        agencies={agencies}
        targetMonth={targetMonth}
      />
      <PendingSection
        rows={pendingCreators}
        agencies={agencies}
        targetMonth={targetMonth}
      />

      <div className="space-y-6">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">全クリエイター（マスター一覧）</h2>
          <p className="mt-1 text-sm text-zinc-500">
            すべてのクリエイターを表示するマスター一覧です。上の要対応一覧と同じクリエイターが表示される場合があります。紹介者の紐付け変更は{" "}
            <Link href="/admin/creator-referrals" className="text-[var(--accent-cyan)] hover:underline">
              CR紹介者管理
            </Link>
            へ。
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
            <Link
              href="/admin/creator-assignment-logs"
              className="font-medium text-[var(--accent-cyan)] hover:underline"
            >
              振り分け変更履歴
            </Link>

            <span className="text-zinc-700">｜</span>

            <Link
              href="/admin/creator-commission-rate-logs"
              className="font-medium text-[var(--accent-cyan)] hover:underline"
            >
              分配率変更履歴
            </Link>
          </div>
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
            <table className="w-full min-w-[1420px] text-left text-sm">
              <thead>
                <tr className="border-b border-white/[0.06] bg-surface-1/80 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                  <th className="px-3 py-2">名前</th>
                  <th className="px-3 py-2">TikTok ID</th>
                  <th className="px-3 py-2">紹介者</th>
                  <th className="px-3 py-2">LINE</th>
                  <th className="px-3 py-2">代理店</th>
                  <th className="px-3 py-2">TikTok実分配率</th>
              <th className="px-3 py-2">手動補正（クリエイター）</th>
                  <th className="px-3 py-2">ステータス</th>
                  <th className="px-3 py-2">TikTok修正</th>
                  <th className="px-3 py-2 text-right">操作</th>
                  <th className="px-3 py-2">結果</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <AssignmentRow
                    key={row.id}
                    row={row}
                    agencies={agencies}
                    showSales={false}
                    state={null}
                    scope="all"
                  targetMonth={targetMonth}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
