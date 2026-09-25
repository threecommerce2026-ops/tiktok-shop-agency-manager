"use client";

import { useActionState, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import {
  bulkConfirmMonthlyAssignmentsAction,
  type MonthlyAssignmentActionResult,
} from "@/app/actions/creator-monthly-assignment";
import { AssignmentStateBadge } from "@/components/agency/MonthlyAssignmentPanel";
import type { AgencyAssignmentState } from "@/lib/agency/agency-assignment";
import type { MonthlyAssignmentBoardData } from "@/lib/db/monthly-assignment-board-queries";
import { formatYenPrecise } from "@/lib/revenue/calc";

/*
  月別所属の一括確認・確定ボード。

  ・1行 = クリエイター × 対象月
  ・チェックした行だけを「月別確定」する（現在所属は自動確定しない）
  ・未確定（代理店なし）の行は、管理者が代理店を選んでから確定する
  ・支払い済みの行はチェック不可
*/

const ALL = "all";

const thBase =
  "sticky top-0 z-10 whitespace-nowrap border-b border-zinc-800 bg-zinc-950/95 px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-400";

const td = "whitespace-nowrap px-3 py-2 text-xs";


/** 選択肢に出す代理店。無効代理店は隠すが、現在値だけは選べるように残す */
function selectableAgencies<T extends { id: string; isActive: boolean }>(
  agencies: T[],
  currentId: string | null,
): T[] {
  return agencies.filter((agency) => agency.isActive || agency.id === currentId);
}

function rowKey(creatorId: string, targetMonth: string): string {
  return `${creatorId}:${targetMonth}`;
}

export function MonthlyAssignmentBoardClient({
  data,
}: {
  data: MonthlyAssignmentBoardData;
}) {
  const router = useRouter();

  const [monthFilter, setMonthFilter] = useState(ALL);
  const [agencyFilter, setAgencyFilter] = useState(ALL);
  const [stateFilter, setStateFilter] = useState<AgencyAssignmentState | typeof ALL>(
    "current",
  );
  const [search, setSearch] = useState("");

  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** 未確定行に対して管理者が選んだ代理店 */
  const [agencyOverrides, setAgencyOverrides] = useState<Record<string, string>>({});

  const [state, formAction, pending] = useActionState<
    MonthlyAssignmentActionResult | null,
    FormData
  >(bulkConfirmMonthlyAssignmentsAction, null);

  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return data.rows.filter((row) => {
      if (monthFilter !== ALL && row.targetMonth !== monthFilter) return false;
      if (stateFilter !== ALL && row.state !== stateFilter) return false;
      if (agencyFilter !== ALL) {
        if (agencyFilter === "none") {
          if (row.effectiveAgencyId !== null) return false;
        } else if (row.effectiveAgencyId !== agencyFilter) {
          return false;
        }
      }
      if (!q) return true;
      return (
        row.tiktokId.toLowerCase().includes(q) ||
        row.creatorName.toLowerCase().includes(q)
      );
    });
  }, [agencyFilter, data.rows, monthFilter, search, stateFilter]);

  /** 行で実際に確定する代理店（未確定行は管理者の選択値） */
  function resolveAgencyId(row: (typeof data.rows)[number]): string {
    return agencyOverrides[rowKey(row.creatorId, row.targetMonth)] ??
      row.effectiveAgencyId ??
      "";
  }

  const selectedRows = data.rows.filter((row) =>
    selected.has(rowKey(row.creatorId, row.targetMonth)),
  );

  const readyRows = selectedRows.filter(
    (row) => !row.hasPaidReward && resolveAgencyId(row),
  );
  const missingAgencyRows = selectedRows.filter(
    (row) => !row.hasPaidReward && !resolveAgencyId(row),
  );

  const summaryByAgency = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of readyRows) {
      const agencyId = resolveAgencyId(row);
      const name =
        data.agencies.find((agency) => agency.id === agencyId)?.name ?? "—";
      map.set(name, (map.get(name) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyRows, agencyOverrides, data.agencies]);

  function toggleRow(row: (typeof data.rows)[number]) {
    if (row.hasPaidReward) return;
    const key = rowKey(row.creatorId, row.targetMonth);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectAllVisibleUnconfirmed() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const row of visibleRows) {
        if (row.hasPaidReward) continue;
        if (row.state === "monthly") continue;
        next.add(rowKey(row.creatorId, row.targetMonth));
      }
      return next;
    });
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[
          { label: "対象行", value: data.totals.rowCount },
          { label: "✓ 月別確定", value: data.totals.confirmedCount },
          { label: "△ 現在所属（暫定）", value: data.totals.provisionalCount },
          { label: "！ 未確定", value: data.totals.unassignedCount },
          { label: "支払済（変更不可）", value: data.totals.lockedCount },
        ].map((kpi) => (
          <div
            key={kpi.label}
            className="rounded-2xl border border-white/[0.07] bg-surface-1/60 p-4"
          >
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
              {kpi.label}
            </p>
            <p className="mt-2 font-mono text-xl font-bold text-zinc-50">{kpi.value}</p>
          </div>
        ))}
      </div>

      {state ? (
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
      ) : null}

      <section className="rounded-xl border border-white/[0.06] bg-surface-1/40 p-4">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-5">
          <div>
            <label htmlFor="board-year" className="text-[11px] font-medium text-zinc-500">
              対象年
            </label>
            <input
              id="board-year"
              type="number"
              min={2020}
              max={2100}
              defaultValue={data.year}
              onChange={(e) => {
                if (/^\d{4}$/.test(e.target.value)) {
                  router.push(`/admin/monthly-agency-assignments?year=${e.target.value}`);
                }
              }}
              className="mt-1 w-full rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 font-mono text-sm text-zinc-100"
            />
          </div>

          <div>
            <label htmlFor="board-month" className="text-[11px] font-medium text-zinc-500">
              対象月
            </label>
            <select
              id="board-month"
              value={monthFilter}
              onChange={(e) => setMonthFilter(e.target.value)}
              className="mt-1 w-full rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100"
            >
              <option value={ALL}>すべて</option>
              {data.months.map((month) => (
                <option key={month} value={month}>
                  {month}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="board-agency" className="text-[11px] font-medium text-zinc-500">
              代理店
            </label>
            <select
              id="board-agency"
              value={agencyFilter}
              onChange={(e) => setAgencyFilter(e.target.value)}
              className="mt-1 w-full rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100"
            >
              <option value={ALL}>すべて</option>
              <option value="none">（代理店なし）</option>
              {data.agencies.map((agency) => (
                <option key={agency.id} value={agency.id}>
                  {agency.name}
                  {agency.isActive ? "" : "（無効）"}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="board-state" className="text-[11px] font-medium text-zinc-500">
              所属状態
            </label>
            <select
              id="board-state"
              value={stateFilter}
              onChange={(e) =>
                setStateFilter(e.target.value as AgencyAssignmentState | typeof ALL)
              }
              className="mt-1 w-full rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100"
            >
              <option value={ALL}>すべて</option>
              <option value="current">△ 現在所属（暫定）のみ</option>
              <option value="monthly">✓ 月別確定のみ</option>
              <option value="none">！ 未確定のみ</option>
            </select>
          </div>

          <div>
            <label htmlFor="board-search" className="text-[11px] font-medium text-zinc-500">
              検索
            </label>
            <input
              id="board-search"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="TikTok ID / クリエイター名"
              className="mt-1 w-full rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-cyan-700"
            />
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={selectAllVisibleUnconfirmed}
            className="rounded-lg border border-white/[0.1] px-3 py-2 text-xs font-medium text-zinc-200 transition hover:bg-white/[0.06]"
          >
            表示中の未確定をすべて選択（{visibleRows.filter((r) => !r.hasPaidReward && r.state !== "monthly").length} 件）
          </button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="rounded-lg border border-white/[0.1] px-3 py-2 text-xs text-zinc-400 transition hover:bg-white/[0.06]"
          >
            選択を解除
          </button>
          <span className="text-[11px] text-zinc-500">
            表示 {visibleRows.length} 件 / 全 {data.rows.length} 件
          </span>
        </div>
      </section>

      <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950/70">
        <div className="max-h-[min(65vh,760px)] overflow-y-auto">
          <table className="w-full min-w-[1100px] border-collapse text-sm">
            <thead>
              <tr>
                <th className={thBase}>選択</th>
                <th className={thBase}>対象月</th>
                <th className={thBase}>TikTok ID</th>
                <th className={thBase}>クリエイター名</th>
                <th className={thBase}>現在所属代理店</th>
                <th className={thBase}>適用予定代理店</th>
                <th className={thBase}>所属状態</th>
                <th className={`${thBase} text-right`}>AP 代理店報酬</th>
                <th className={`${thBase} text-right`}>対象明細数</th>
                <th className={thBase}>操作</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => {
                const key = rowKey(row.creatorId, row.targetMonth);
                const chosenAgencyId = resolveAgencyId(row);
                return (
                  <tr
                    key={key}
                    className={`border-b border-zinc-800/70 ${
                      selected.has(key) ? "bg-cyan-500/[0.06]" : ""
                    }`}
                  >
                    <td className={td}>
                      <input
                        type="checkbox"
                        aria-label={`${row.tiktokId} ${row.targetMonth} を選択`}
                        checked={selected.has(key)}
                        disabled={row.hasPaidReward}
                        onChange={() => toggleRow(row)}
                      />
                    </td>
                    <td className={`${td} font-mono text-zinc-200`}>{row.targetMonth}</td>
                    <td className={`${td} font-mono text-zinc-300`}>
                      {row.tiktokId || "—"}
                    </td>
                    <td className={`${td} text-zinc-200`}>{row.creatorName}</td>
                    <td className={`${td} text-zinc-400`}>
                      {row.currentAgencyName ?? "（未設定）"}
                    </td>
                    <td className={td}>
                      {row.state === "none" ? (
                        <select
                          aria-label={`${row.tiktokId} ${row.targetMonth} の代理店`}
                          value={agencyOverrides[key] ?? ""}
                          onChange={(e) =>
                            setAgencyOverrides((prev) => ({
                              ...prev,
                              [key]: e.target.value,
                            }))
                          }
                          className="w-44 rounded border border-white/[0.08] bg-surface-1 px-2 py-1 text-xs text-zinc-100"
                        >
                          <option value="">代理店を選択</option>
                          {selectableAgencies(data.agencies, row.effectiveAgencyId).map(
                            (agency) => (
                              <option key={agency.id} value={agency.id}>
                                {agency.name}
                                {agency.isActive ? "" : "（無効）"}
                              </option>
                            ),
                          )}
                        </select>
                      ) : (
                        <span className="text-zinc-200">
                          {row.effectiveAgencyName ?? "—"}
                          {row.isInHouse ? (
                            <span className="ml-1 text-[10px] text-zinc-500">
                              （自社・支払対象外）
                            </span>
                          ) : null}
                        </span>
                      )}
                    </td>
                    <td className={td}>
                      <AssignmentStateBadge state={row.state} />
                    </td>
                    <td className={`${td} text-right font-mono text-zinc-200`}>
                      {formatYenPrecise(row.agencyRevenue)}
                    </td>
                    <td className={`${td} text-right font-mono text-zinc-500`}>
                      {row.lineCount}
                    </td>
                    <td className={td}>
                      {row.hasPaidReward ? (
                        <span className="text-[11px] text-amber-200/80">
                          支払済みのため所属変更不可
                        </span>
                      ) : chosenAgencyId ? (
                        <span className="text-[11px] text-zinc-600">選択して一括確定</span>
                      ) : (
                        <span className="text-[11px] text-red-300/80">代理店未選択</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {visibleRows.length === 0 ? (
        <p className="rounded-xl border border-zinc-800 py-10 text-center text-sm text-zinc-500">
          条件に一致する行がありません。
        </p>
      ) : null}

      <form
        action={formAction}
        className="space-y-3 rounded-xl border border-cyan-500/20 bg-cyan-500/[0.04] p-4"
      >
        {readyRows.map((row) => (
          <input
            key={rowKey(row.creatorId, row.targetMonth)}
            type="hidden"
            name="entries"
            value={`${row.creatorId}|${row.targetMonth}|${resolveAgencyId(row)}`}
          />
        ))}

        <h2 className="text-sm font-semibold text-zinc-100">確定内容の確認</h2>

        <dl className="grid gap-2 text-xs sm:grid-cols-4">
          <div>
            <dt className="text-zinc-500">確定件数</dt>
            <dd className="mt-1 font-mono text-lg font-bold text-zinc-50">
              {readyRows.length}
            </dd>
          </div>
          <div>
            <dt className="text-zinc-500">対象クリエイター数</dt>
            <dd className="mt-1 font-mono text-lg font-bold text-zinc-50">
              {new Set(readyRows.map((row) => row.creatorId)).size}
            </dd>
          </div>
          <div>
            <dt className="text-zinc-500">対象月</dt>
            <dd className="mt-1 font-mono text-xs text-zinc-200">
              {[...new Set(readyRows.map((row) => row.targetMonth))].sort().join(", ") ||
                "—"}
            </dd>
          </div>
          <div>
            <dt className="text-zinc-500">代理店別件数</dt>
            <dd className="mt-1 space-y-0.5 text-xs text-zinc-200">
              {summaryByAgency.length === 0
                ? "—"
                : summaryByAgency.map(([name, count]) => (
                    <p key={name}>
                      {name}: <span className="font-mono">{count}</span> 件
                    </p>
                  ))}
            </dd>
          </div>
        </dl>

        {missingAgencyRows.length > 0 ? (
          <p className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-100">
            代理店が未選択の行が {missingAgencyRows.length} 件あります。代理店を選ぶまで確定対象に入りません。
          </p>
        ) : null}

        <button
          type="submit"
          disabled={pending || readyRows.length === 0}
          className="min-h-[40px] rounded-lg bg-white px-5 text-sm font-semibold text-zinc-950 transition hover:bg-zinc-200 disabled:opacity-40"
        >
          {pending
            ? "確定中…"
            : `選択した ${readyRows.length} 件を月別確定`}
        </button>

        <p className="text-[11px] leading-relaxed text-zinc-500">
          この操作は対象月の所属だけを確定します。クリエイターの現在所属は変更しません。
          確定後に金額へ反映するには「売上・報酬 › 代理店報酬」で再集計を実行してください
          （確定だけでは代理店報酬明細は変わりません）。
        </p>
      </form>
    </div>
  );
}
