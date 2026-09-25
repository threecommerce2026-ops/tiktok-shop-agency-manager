"use client";

import { Fragment, useActionState, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  syncAgencyRewardsAction,
  unpayAgencyAnnualAction,
  type AgencyActionResult,
} from "@/app/actions/agency-rewards";
import type {
  AgencyAnnualSummary,
  AgencyAnnualSummaryRow,
  AgencyPaymentState,
} from "@/lib/db/agency-annual-queries";
import { AssignmentStateBadge } from "@/components/agency/MonthlyAssignmentPanel";
import { MonthlyAssignmentLauncher } from "@/components/agency/MonthlyAssignmentLauncher";
import { formatYen, formatYenPrecise } from "@/lib/revenue/calc";

const thBase =
  "whitespace-nowrap border-b border-zinc-800 bg-surface-1/80 px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-500";

const td = "whitespace-nowrap px-3 py-2.5 text-xs";

const PAYMENT_LABEL: Record<AgencyPaymentState, string> = {
  paid: "支払済",
  partial: "一部支払",
  unpaid: "未払い",
};

const PAYMENT_CLASS: Record<AgencyPaymentState, string> = {
  paid: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  partial: "border-amber-400/25 bg-amber-400/10 text-amber-200",
  unpaid: "border-white/[0.08] bg-white/[0.03] text-zinc-400",
};

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-surface-1/60 p-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
        {label}
      </p>
      <p className="mt-2 font-mono text-xl font-bold tracking-tight text-zinc-50">{value}</p>
      {hint ? <p className="mt-1 text-[11px] text-zinc-600">{hint}</p> : null}
    </div>
  );
}

function ResultBanner({ state }: { state: AgencyActionResult | null }) {
  if (!state) return null;
  return (
    <p
      className={`rounded-lg border px-3 py-2 text-xs ${
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

function StateBadge({ state }: { state: AgencyPaymentState }) {
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[11px] ${PAYMENT_CLASS[state]}`}>
      {PAYMENT_LABEL[state]}
    </span>
  );
}

/** 代理店の月別 → クリエイター別内訳（同じ画面内で展開する） */
function AgencyDetail({ row }: { row: AgencyAnnualSummaryRow }) {
  const [openMonth, setOpenMonth] = useState<string | null>(
    row.monthlyRows[0]?.targetMonth ?? null,
  );

  const creatorRows = openMonth
    ? row.creatorRows.filter((creator) => creator.targetMonth === openMonth)
    : row.creatorRows;

  return (
    <div className="space-y-4 border-t border-zinc-800 bg-zinc-950/60 px-4 py-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="年間発生額" value={formatYenPrecise(row.annualRewardAmount)} />
        <Kpi label="支払済額" value={formatYenPrecise(row.paidAmount)} />
        <Kpi label="未払残高" value={formatYenPrecise(row.unpaidAmount)} />
        <Kpi
          label="AD Commission Base（参考）"
          value={formatYen(Math.round(row.annualCommissionBase))}
          hint={`明細 ${row.itemCount} 件 / CR ${row.creatorCount} 名`}
        />
      </div>

      <div>
        <h3 className="mb-2 text-xs font-semibold text-zinc-300">
          月別内訳（行をクリックするとその月のクリエイター別内訳に絞り込みます）
        </h3>
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr>
                <th className={thBase}>対象月</th>
                <th className={`${thBase} text-right`}>AD Commission Base</th>
                <th className={`${thBase} text-right`}>AJ 分配前クリエイター収益</th>
                <th className={`${thBase} text-right`}>AP 代理店報酬</th>
                <th className={`${thBase} text-right`}>支払済</th>
                <th className={`${thBase} text-right`}>未払</th>
                <th className={`${thBase} text-right`}>明細</th>
                <th className={thBase}>支払状態</th>
              </tr>
            </thead>
            <tbody>
              {row.monthlyRows.map((month) => {
                const active = openMonth === month.targetMonth;
                return (
                  <tr
                    key={month.targetMonth}
                    onClick={() =>
                      setOpenMonth(active ? null : month.targetMonth)
                    }
                    className={`cursor-pointer border-b border-zinc-800/60 transition hover:bg-white/[0.03] ${
                      active ? "bg-cyan-500/[0.06]" : ""
                    }`}
                  >
                    <td className={`${td} font-mono text-zinc-200`}>
                      {active ? "▾ " : "▸ "}
                      {month.targetMonth}
                    </td>
                    <td className={`${td} text-right font-mono text-zinc-400`}>
                      {formatYen(Math.round(month.commissionBase))}
                    </td>
                    <td className={`${td} text-right font-mono text-zinc-400`}>
                      {formatYen(Math.round(month.creatorRevenueBeforeSplit))}
                    </td>
                    <td className={`${td} text-right font-mono text-zinc-100`}>
                      {formatYenPrecise(month.rewardAmount)}
                    </td>
                    <td className={`${td} text-right font-mono text-zinc-500`}>
                      {formatYenPrecise(month.paidAmount)}
                    </td>
                    <td className={`${td} text-right font-mono text-amber-200/90`}>
                      {formatYenPrecise(month.unpaidAmount)}
                    </td>
                    <td className={`${td} text-right font-mono text-zinc-500`}>
                      {month.itemCount}
                    </td>
                    <td className={td}>
                      <StateBadge state={month.paymentState} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <p className="mb-2 text-[11px] text-zinc-500">
          代理店報酬は AP「エージェンシーの収益総額」と同額です（AK は掛けません）。
        </p>
        <h3 className="mb-2 text-xs font-semibold text-zinc-300">
          クリエイター別内訳
          {openMonth ? `（${openMonth}）` : "（全期間）"}
        </h3>
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr>
                <th className={thBase}>TikTok ID</th>
                <th className={thBase}>クリエイター</th>
                <th className={thBase}>対象月</th>
                <th className={`${thBase} text-right`}>AD Commission Base</th>
                <th className={`${thBase} text-right`}>AJ 分配前クリエイター収益</th>
                <th className={`${thBase} text-right`} title="TikTok側で既にAPへ反映済み。掛け算には使いません">
                  AK 分配率(参考)
                </th>
                <th className={`${thBase} text-right`}>AP エージェンシー収益総額</th>
                <th className={`${thBase} text-right`}>代理店報酬</th>
                <th className={`${thBase} text-right`}>明細</th>
                <th className={thBase}>所属状態</th>
                <th className={thBase}>支払状態</th>
              </tr>
            </thead>
            <tbody>
              {creatorRows.map((creator) => (
                <tr
                  key={`${creator.targetMonth}-${creator.creatorId}`}
                  className="border-b border-zinc-800/60"
                >
                  <td className={`${td} font-mono text-zinc-300`}>
                    {creator.tiktokId || "—"}
                  </td>
                  <td className={`${td} text-zinc-200`}>{creator.creatorName}</td>
                  <td className={`${td} font-mono text-zinc-400`}>{creator.targetMonth}</td>
                  <td className={`${td} text-right font-mono text-zinc-400`}>
                    {formatYen(Math.round(creator.commissionBase))}
                  </td>
                  <td className={`${td} text-right font-mono text-zinc-400`}>
                    {formatYen(Math.round(creator.creatorRevenueBeforeSplit))}
                  </td>
                  <td
                    className={`${td} text-right font-mono text-zinc-500`}
                    title="TikTok側で既にAPへ反映済みの分配率。APに掛け直しません。"
                  >
                    {creator.agencySplitRate}%
                  </td>
                  <td className={`${td} text-right font-mono text-cyan-300/90`}>
                    {formatYenPrecise(creator.rewardAmount)}
                  </td>
                  <td className={`${td} text-right font-mono text-zinc-100`}>
                    {formatYenPrecise(creator.rewardAmount)}
                  </td>
                  <td className={`${td} text-right font-mono text-zinc-500`}>
                    {creator.itemCount}
                  </td>
                  <td className={td}>
                    <AssignmentStateBadge state={creator.assignmentState} />
                  </td>
                  <td className={td}>
                    <StateBadge state={creator.paymentState} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export function AgencyRewardTabClient({
  summary,
  isAdmin,
  selectedAgencyId,
}: {
  summary: AgencyAnnualSummary;
  isAdmin: boolean;
  selectedAgencyId: string | null;
}) {
  const router = useRouter();
  const [openAgencyId, setOpenAgencyId] = useState<string | null>(selectedAgencyId);
  const [search, setSearch] = useState("");
  const [showHistory, setShowHistory] = useState(false);

  const [syncState, syncAction, syncPending] = useActionState(
    syncAgencyRewardsAction,
    null,
  );
  const [unpayState, unpayAction, unpayPending] = useActionState(
    unpayAgencyAnnualAction,
    null,
  );

  const q = search.trim().toLowerCase();
  const rows = q
    ? summary.rows.filter((row) => row.agencyName.toLowerCase().includes(q))
    : summary.rows;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 rounded-xl border border-white/[0.06] bg-surface-1/40 p-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <label htmlFor="agency-year" className="text-[11px] font-medium text-zinc-500">
            対象年
          </label>
          <input
            id="agency-year"
            type="number"
            min={2020}
            max={2100}
            defaultValue={summary.year}
            onChange={(e) => {
              if (/^\d{4}$/.test(e.target.value)) {
                router.push(`/revenue?tab=agency&year=${e.target.value}`);
              }
            }}
            className="mt-1 w-32 rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 font-mono text-sm text-zinc-100 outline-none"
          />
          <div className="mt-2 max-w-2xl space-y-1 rounded-lg border border-white/[0.06] bg-surface-0/50 px-3 py-2 text-[11px] leading-relaxed text-zinc-400">
            <p>
              <span className="font-semibold text-zinc-200">代理店報酬 = AP「エージェンシーの収益総額」を100%そのまま支払い</span>
            </p>
            <p>
              対象は CAP の AU「支払い状況」が
              <span className="font-mono text-zinc-300">支払い済み</span>
              の明細のみ。TAP収益は含みません。
            </p>
            <p className="text-amber-200/80">
              分配率（AK）は TikTok 側で既に AP に反映済みの値です。
              表示は確認用で、<span className="font-semibold">AP × 分配率の再計算は行いません</span>。
            </p>
          </div>
        </div>

        {isAdmin ? (
          <div className="flex flex-wrap items-end gap-2">
            <Link
              href={`/admin/monthly-agency-assignments?year=${summary.year}`}
              className="inline-flex min-h-[40px] items-center rounded-lg border border-white/[0.1] px-4 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.06]"
            >
              月別所属を一括確認
            </Link>
          </div>
        ) : null}

        {isAdmin ? (
          <form action={syncAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="scope" value="year" />
            <input type="hidden" name="year" value={summary.year} />
            <button
              type="submit"
              disabled={syncPending}
              className="min-h-[40px] rounded-lg border border-white/[0.1] px-4 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.06] disabled:opacity-50"
            >
              {syncPending ? "再集計中…" : `${summary.year}年を再集計`}
            </button>
          </form>
        ) : null}
      </div>

      <ResultBanner state={syncState} />
      <ResultBanner state={unpayState} />

      {summary.error ? (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          {summary.error}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          label="年間発生額"
          value={formatYenPrecise(summary.totals.annualRewardAmount)}
          hint={`代理店 ${summary.totals.agencyCount} 社 / 明細 ${summary.totals.itemCount} 件`}
        />
        <Kpi label="支払済額" value={formatYenPrecise(summary.totals.paidAmount)} />
        <Kpi label="未払残高" value={formatYenPrecise(summary.totals.unpaidAmount)} />
        <Kpi
          label="今回支払対象額"
          value={formatYenPrecise(summary.totals.payableAmount)}
          hint={`${summary.totals.payableAgencyCount} 社が支払可能`}
        />
        <Kpi
          label="月別確定済みの未払い"
          value={formatYenPrecise(summary.totals.confirmedUnpaidAmount)}
          hint="対象月の所属が確定済み"
        />
        <Kpi
          label="所属未確定の未払い"
          value={formatYenPrecise(summary.totals.provisionalUnpaidAmount)}
          hint="現在所属で暫定計算。確定するまで支払不可"
        />
      </div>

      {summary.reviewRows.length > 0 ? (
        <section className="rounded-xl border border-amber-500/25 bg-amber-500/[0.07] p-4">
          <h2 className="text-sm font-semibold text-amber-100">
            要確認：代理店が未設定のまま分配率が付いているクリエイター（{summary.reviewRows.length} 名）
          </h2>
          <p className="mt-1 text-[11px] leading-relaxed text-amber-200/80">
            正しい代理店が不明なため支払対象から除外しています。自動では割り当てません。
            分配率が100%だから自社、10%だから二次代理店といった推測もしません。
            クリエイターマスタで所属を設定してから再集計してください。
          </p>
          <div className="mt-3 overflow-x-auto rounded-lg border border-amber-500/20">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr>
                  <th className={thBase}>TikTok ID</th>
                  <th className={thBase}>クリエイター</th>
                  <th className={thBase}>対象月</th>
                  <th className={`${thBase} text-right`}>Commission Base</th>
                  <th className={`${thBase} text-right`}>分配率</th>
                  <th className={`${thBase} text-right`}>未帰属の代理店収益</th>
                  <th className={`${thBase} text-right`}>明細</th>
                  <th className={thBase}>操作</th>
                </tr>
              </thead>
              <tbody>
                {summary.reviewRows.map((review) => (
                  <tr key={review.creatorId} className="border-b border-amber-500/10">
                    <td className={`${td} font-mono text-amber-100`}>
                      {review.tiktokId || "—"}
                    </td>
                    <td className={`${td} text-amber-100/90`}>{review.creatorName}</td>
                    <td className={`${td} font-mono text-amber-200/70`}>
                      {review.targetMonths.join(", ")}
                    </td>
                    <td className={`${td} text-right font-mono text-amber-200/70`}>
                      {formatYen(Math.round(review.commissionBase))}
                    </td>
                    <td className={`${td} text-right font-mono text-amber-200/70`}>
                      {review.agencySplitRate}%
                    </td>
                    <td className={`${td} text-right font-mono text-amber-100`}>
                      {formatYenPrecise(review.unassignedAgencyRevenue)}
                    </td>
                    <td className={`${td} text-right font-mono text-amber-200/70`}>
                      {review.itemCount}
                    </td>
                    <td className={td}>
                      <MonthlyAssignmentLauncher
                        creatorId={review.creatorId}
                        label="所属を確定する"
                        className="rounded border border-amber-400/30 bg-amber-400/10 px-2.5 py-1 text-[11px] text-amber-100 transition hover:bg-amber-400/20 disabled:opacity-50"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <div className="flex flex-col gap-3 rounded-xl border border-white/[0.06] bg-surface-1/40 p-4 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label htmlFor="agency-search" className="text-[11px] font-medium text-zinc-500">
            代理店検索
          </label>
          <input
            id="agency-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="代理店名"
            className="mt-1 w-full rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-cyan-700"
          />
        </div>
        {summary.history.length > 0 ? (
          <button
            type="button"
            onClick={() => setShowHistory((prev) => !prev)}
            className="min-h-[40px] rounded-lg border border-white/[0.1] px-4 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.06]"
          >
            支払履歴 {showHistory ? "を隠す" : `(${summary.history.length})`}
          </button>
        ) : null}
      </div>

      {showHistory && summary.history.length > 0 ? (
        <section className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr>
                <th className={thBase}>支払日</th>
                <th className={thBase}>代理店</th>
                <th className={thBase}>対象月</th>
                <th className={`${thBase} text-right`}>支払額</th>
              </tr>
            </thead>
            <tbody>
              {summary.history.map((entry) => (
                <tr key={entry.id} className="border-b border-zinc-800/60">
                  <td className={`${td} font-mono text-zinc-400`}>
                    {entry.paidAt ? new Date(entry.paidAt).toLocaleString("ja-JP") : "—"}
                  </td>
                  <td className={`${td} text-zinc-200`}>{entry.agencyName}</td>
                  <td className={`${td} font-mono text-zinc-400`}>{entry.targetMonth}</td>
                  <td className={`${td} text-right font-mono text-zinc-100`}>
                    {formatYenPrecise(entry.totalRewardAmount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {rows.length === 0 ? (
        <p className="rounded-xl border border-zinc-800 py-10 text-center text-sm text-zinc-500">
          {summary.year}年の代理店報酬明細がありません。
          {isAdmin ? `「${summary.year}年を再集計」を実行してください。` : null}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full min-w-[980px] border-collapse text-sm">
            <thead>
              <tr>
                <th className={thBase}>代理店</th>
                <th className={`${thBase} text-right`}>年間発生額</th>
                <th className={`${thBase} text-right`}>支払済額</th>
                <th className={`${thBase} text-right`}>未払残高</th>
                <th className={`${thBase} text-right`}>支払対象</th>
                <th className={thBase}>最終支払日</th>
                {isAdmin ? <th className={thBase}>操作</th> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const open = openAgencyId === row.agencyId;
                return (
                  // リストの直接の子は Fragment。key は Fragment 側に付ける必要がある
                  <Fragment key={row.agencyId}>
                    <tr
                      className={`border-b border-zinc-800/60 ${open ? "bg-cyan-500/[0.05]" : ""}`}
                    >
                      <td className={`${td} font-medium text-zinc-100`}>
                        <button
                          type="button"
                          onClick={() =>
                            setOpenAgencyId(open ? null : row.agencyId)
                          }
                          className="text-cyan-400 hover:underline"
                        >
                          {open ? "▾ " : "▸ "}
                          {row.agencyName}
                        </button>
                        <span className="ml-2 text-[11px] text-zinc-600">
                          CR {row.creatorCount} / 明細 {row.itemCount}
                        </span>
                        {row.hasUnconfirmedAssignment ? (
                          <span className="ml-2 rounded-full border border-amber-400/25 bg-amber-400/10 px-2 py-0.5 text-[10px] text-amber-200">
                            △ 所属未確定 {row.provisionalCreatorCount} 名
                          </span>
                        ) : row.usesCurrentAgencyFallback ? (
                          <span className="ml-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-2 py-0.5 text-[10px] text-zinc-500">
                            現在所属で計算（支払済分）
                          </span>
                        ) : (
                          <span className="ml-2 rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2 py-0.5 text-[10px] text-emerald-300">
                            ✓ 全月確定
                          </span>
                        )}
                      </td>
                      <td className={`${td} text-right font-mono text-zinc-200`}>
                        {formatYenPrecise(row.annualRewardAmount)}
                      </td>
                      <td className={`${td} text-right font-mono text-zinc-400`}>
                        {formatYenPrecise(row.paidAmount)}
                      </td>
                      <td className={`${td} text-right font-mono text-amber-200/90`}>
                        {formatYenPrecise(row.unpaidAmount)}
                      </td>
                      <td className={`${td} text-right`}>
                        {row.isPayable ? (
                          <span className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2 py-1 font-mono text-[11px] text-emerald-300">
                            {formatYenPrecise(row.payableAmount)}
                          </span>
                        ) : (
                          <span className="rounded-full border border-white/[0.06] bg-white/[0.03] px-2 py-1 text-[11px] text-zinc-500">
                            なし
                          </span>
                        )}
                      </td>
                      <td className={`${td} font-mono text-zinc-500`}>
                        {row.lastPaidAt
                          ? new Date(row.lastPaidAt).toLocaleDateString("ja-JP")
                          : "—"}
                      </td>
                      {isAdmin ? (
                        <td className={td}>
                          <div className="flex gap-2">
                            {/*
                              支払確定はこの画面から行わない。
                              実際の銀行振込の前後を分けるため、支払明細の作成 →
                              承認 → 振込CSV → 振込完了登録 は支払管理へ一本化する。
                            */}
                            {row.isPayable && !row.hasUnconfirmedAssignment ? (
                              <Link
                                href="/payments?payee=agency"
                                className="rounded border border-[var(--accent-cyan)]/30 bg-[var(--accent-cyan)]/10 px-2.5 py-1.5 text-[11px] font-medium text-[var(--accent-cyan)] transition hover:bg-[var(--accent-cyan)]/20"
                              >
                                支払管理へ
                              </Link>
                            ) : null}

                            {row.isPayable && row.hasUnconfirmedAssignment ? (
                              <span
                                className="rounded border border-amber-400/30 bg-amber-400/10 px-2.5 py-1.5 text-[11px] text-amber-100"
                                title={`月別所属が未確定のクリエイターが ${row.provisionalCreatorCount} 名います（${formatYenPrecise(row.provisionalUnpaidAmount)}）。確定後に支払ってください。`}
                              >
                                所属未確定 {row.provisionalCreatorCount} 名
                              </span>
                            ) : null}

                            {row.payoutStatus === "paid" && row.payoutId ? (
                              <form action={unpayAction}>
                                <input type="hidden" name="payout_id" value={row.payoutId} />
                                <button
                                  type="submit"
                                  disabled={unpayPending}
                                  className="rounded border border-white/[0.1] px-2.5 py-1.5 text-[11px] text-zinc-300 transition hover:bg-white/[0.06] disabled:opacity-50"
                                >
                                  取消
                                </button>
                              </form>
                            ) : null}
                          </div>
                        </td>
                      ) : null}
                    </tr>

                    {open ? (
                      <tr>
                        <td colSpan={isAdmin ? 7 : 6} className="p-0">
                          <AgencyDetail row={row} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
