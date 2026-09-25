"use client";

import { useActionState, useMemo, useState } from "react";

import {
  deleteAgencyAction,
  mergeAgencyAction,
  setAgencyActiveAction,
  type AgencyMaintenanceResult,
} from "@/app/actions/agency-maintenance";
import { MasterNameEditor } from "@/components/master/MasterNameEditor";
import type {
  AgencyMaintenanceData,
  AgencyMaintenanceRow,
} from "@/lib/db/agency-maintenance-queries";

/*
  代理店マスタ整理（名称編集 / 統合 / 無効化 / 削除）。

  ・統合は二段階確認（1回目は DRY RUN、2回目で実行）
  ・支払い済みデータがある代理店は統合禁止
  ・参照が全て0の代理店だけ削除ボタンを表示
*/

const thBase =
  "whitespace-nowrap border-b border-zinc-800 bg-surface-1/80 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-500";

const td = "whitespace-nowrap px-3 py-2 text-xs";

function normalizeName(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s.,!！・･ー\-_（）()株式会社（株）]/g, "");
}

function ResultBanner({ state }: { state: AgencyMaintenanceResult | null }) {
  if (!state) return null;
  return (
    <p
      className={`rounded-lg border px-3 py-2 text-[11px] ${
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

/** 統合パネル（二段階確認） */
function MergePanel({
  source,
  rows,
  onClose,
}: {
  source: AgencyMaintenanceRow;
  rows: AgencyMaintenanceRow[];
  onClose: () => void;
}) {
  const [targetId, setTargetId] = useState("");
  const [state, formAction, pending] = useActionState<
    AgencyMaintenanceResult | null,
    FormData
  >(mergeAgencyAction, null);

  const target = rows.find((row) => row.id === targetId) ?? null;
  const dryRun = state?.dryRun ?? null;
  const dryRunMatches =
    dryRun?.sourceId === source.id && dryRun?.targetId === targetId;
  const canExecute = Boolean(state?.ok && dryRunMatches && dryRun && dryRun.canMerge);

  return (
    <div className="space-y-3 rounded-xl border border-cyan-500/20 bg-cyan-500/[0.04] p-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-semibold text-zinc-100">
          {source.name} を別の代理店へ統合
        </p>
        <button
          type="button"
          onClick={onClose}
          className="text-[11px] text-zinc-500 hover:text-zinc-300"
        >
          閉じる
        </button>
      </div>

      <div>
        <label
          htmlFor={`merge-target-${source.id}`}
          className="text-[11px] font-medium text-zinc-500"
        >
          統合先（残す代理店）
        </label>
        <select
          id={`merge-target-${source.id}`}
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
          className="mt-1 w-full rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100"
        >
          <option value="">選択してください</option>
          {rows
            .filter((row) => row.id !== source.id)
            .map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
                {row.isActive ? "" : "（無効）"}
              </option>
            ))}
        </select>
      </div>

      {source.mergeBlockedByPaidData ? (
        <p className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[11px] text-red-200">
          この代理店には支払い済みデータがあります（支払済明細 {source.paidRewardItemCount} 件 /
          支払確定 {source.paidPayoutCount} 件）。支払履歴を壊さないため統合はできません。
        </p>
      ) : null}

      {/* 1回目: DRY RUN */}
      <form action={formAction} className="space-y-2">
        <input type="hidden" name="source_agency_id" value={source.id} />
        <input type="hidden" name="target_agency_id" value={targetId} />
        <button
          type="submit"
          disabled={pending || !targetId || source.mergeBlockedByPaidData}
          className="min-h-[36px] rounded-lg border border-white/[0.1] px-4 text-xs font-medium text-zinc-100 transition hover:bg-white/[0.06] disabled:opacity-40"
        >
          {pending ? "確認中…" : "① 影響を確認（DRY RUN）"}
        </button>
      </form>

      <ResultBanner state={state} />

      {dryRun && dryRunMatches ? (
        <div className="space-y-2 rounded-lg border border-white/[0.08] bg-surface-0/50 p-3 text-[11px]">
          <p className="text-zinc-300">
            <span className="font-semibold">{dryRun.sourceName}</span>
            <span className="mx-1 text-zinc-500">→</span>
            <span className="font-semibold">{dryRun.targetName}</span>
          </p>
          <p className="break-all font-mono text-[10px] text-zinc-600">
            {dryRun.sourceId} → {dryRun.targetId}
          </p>

          <div className="mt-2 space-y-0.5">
            <p className="text-zinc-500">付け替えられるデータ</p>
            {dryRun.reassign.map((row) => (
              <div key={row.key} className="flex justify-between gap-3">
                <span className="text-zinc-500">{row.label}</span>
                <span className="font-mono text-zinc-300">{row.count}</span>
              </div>
            ))}
            <div className="flex justify-between gap-3 border-t border-white/[0.06] pt-1">
              <span className="text-zinc-400">合計</span>
              <span className="font-mono font-semibold text-zinc-100">
                {dryRun.reassignTotal}
              </span>
            </div>
          </div>

          {dryRun.collisions.length > 0 ? (
            <div className="rounded border border-red-500/25 bg-red-500/10 p-2 text-red-200">
              <p className="font-semibold">一意制約が衝突します</p>
              {dryRun.collisions.map((collision) => (
                <div key={collision.table} className="mt-1">
                  <p>
                    {collision.table}: {collision.count} 件
                  </p>
                  <p className="text-[10px] text-red-200/80">{collision.description}</p>
                  {collision.samples.length > 0 ? (
                    <p className="font-mono text-[10px] text-red-200/70">
                      {collision.samples.join(", ")}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 2回目: 最終確認して実行 */}
      {canExecute ? (
        <form action={formAction} className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.08] p-3">
          <input type="hidden" name="source_agency_id" value={source.id} />
          <input type="hidden" name="target_agency_id" value={targetId} />
          <input type="hidden" name="confirm" value="1" />
          <p className="text-[11px] font-semibold text-amber-100">
            「{dryRun?.sourceName}」を「{dryRun?.targetName}」へ統合します。
            この操作は {dryRun?.reassignTotal} 件のデータを書き換えます。
          </p>
          <p className="text-[10px] leading-relaxed text-amber-200/80">
            統合元の agency_id を参照しているデータが統合先へ付け替わります。元に戻すには手作業が必要です。
          </p>
          <button
            type="submit"
            disabled={pending}
            className="min-h-[36px] rounded-lg bg-amber-400 px-4 text-xs font-semibold text-zinc-950 transition hover:bg-amber-300 disabled:opacity-40"
          >
            {pending ? "統合中…" : "② 統合を実行する"}
          </button>
        </form>
      ) : null}

      {target && !target.isActive ? (
        <p className="text-[11px] text-amber-200/80">
          統合先「{target.name}」は現在「無効」です。統合後に有効化が必要か確認してください。
        </p>
      ) : null}
    </div>
  );
}

/** 無効化 / 有効化 */
function ActiveToggle({ row }: { row: AgencyMaintenanceRow }) {
  const [state, formAction, pending] = useActionState<
    AgencyMaintenanceResult | null,
    FormData
  >(setAgencyActiveAction, null);

  return (
    <form action={formAction} className="inline">
      <input type="hidden" name="agency_id" value={row.id} />
      <input type="hidden" name="next_active" value={row.isActive ? "0" : "1"} />
      <button
        type="submit"
        disabled={pending}
        className="rounded border border-white/[0.1] px-2.5 py-1 text-[11px] text-zinc-200 transition hover:bg-white/[0.06] disabled:opacity-50"
        title={
          row.isActive
            ? "新規の代理店選択に表示されなくなります。過去データは残ります。"
            : "代理店選択に再び表示されます。"
        }
      >
        {pending ? "処理中…" : row.isActive ? "無効化" : "有効化"}
      </button>
      {state && !state.ok ? (
        <span className="ml-2 text-[11px] text-red-300">{state.error}</span>
      ) : null}
    </form>
  );
}

/** 物理削除（参照ゼロのときだけ表示） */
function DeleteButton({ row }: { row: AgencyMaintenanceRow }) {
  const [confirmed, setConfirmed] = useState(false);
  const [state, formAction, pending] = useActionState<
    AgencyMaintenanceResult | null,
    FormData
  >(deleteAgencyAction, null);

  return (
    <form action={formAction} className="space-y-1">
      <input type="hidden" name="agency_id" value={row.id} />
      <input type="hidden" name="confirm" value={confirmed ? "1" : ""} />
      <label className="flex items-center gap-1 text-[10px] text-zinc-500">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        削除を確認
      </label>
      <button
        type="submit"
        disabled={pending || !confirmed}
        className="rounded border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-[11px] text-red-200 transition hover:bg-red-500/20 disabled:opacity-40"
      >
        {pending ? "削除中…" : "削除"}
      </button>
      {state && !state.ok ? (
        <p className="text-[10px] text-red-300">{state.error}</p>
      ) : null}
    </form>
  );
}

export function AgencyMaintenanceSection({ data }: { data: AgencyMaintenanceData }) {
  const [openMergeId, setOpenMergeId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [onlyIssues, setOnlyIssues] = useState(false);

  /** 正規化名が一致するものを重複候補とする */
  const duplicateIds = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const row of data.rows) {
      const key = normalizeName(row.name);
      if (!key) continue;
      groups.set(key, [...(groups.get(key) ?? []), row.id]);
    }
    const ids = new Set<string>();
    for (const [, list] of groups) {
      if (list.length > 1) list.forEach((id) => ids.add(id));
    }
    return ids;
  }, [data.rows]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return data.rows.filter((row) => {
      if (onlyIssues && !duplicateIds.has(row.id) && !row.canDelete && row.isActive) {
        return false;
      }
      if (!q) return true;
      return row.name.toLowerCase().includes(q) || row.id.includes(q);
    });
  }, [data.rows, duplicateIds, onlyIssues, search]);

  const deletableCount = data.rows.filter((row) => row.canDelete).length;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-200">代理店マスタ 整理</h2>
          <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
            名称編集・統合・無効化・削除をここで行います。統合は二段階確認、削除は参照が全て0のときだけ可能です。
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-amber-200/80">
            代理店報酬明細と支払レコードは ON DELETE CASCADE のため、参照が残ったまま削除すると
            報酬データが道連れで消えます。参照がある代理店は統合または無効化を使ってください。
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor="agency-maint-search" className="text-[11px] text-zinc-500">
              検索
            </label>
            <input
              id="agency-maint-search"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="代理店名 / agency_id"
              className="mt-1 w-56 rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-cyan-700"
            />
          </div>
          <label className="flex min-h-[38px] cursor-pointer items-center gap-2 rounded-lg border border-white/[0.08] bg-surface-1 px-3 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={onlyIssues}
              onChange={(e) => setOnlyIssues(e.target.checked)}
            />
            要整理のみ
          </label>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "代理店総数", value: data.rows.length },
          { label: "⚠ 重複候補", value: duplicateIds.size },
          { label: "🗑 削除可能", value: deletableCount },
          { label: "○ 無効", value: data.rows.filter((row) => !row.isActive).length },
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

      <div className="overflow-x-auto rounded-xl border border-zinc-800">
        <table className="w-full min-w-[1200px] text-sm">
          <thead>
            <tr>
              <th className={`${thBase} min-w-[200px]`}>代理店名</th>
              <th className={thBase}>状態</th>
              <th className={`${thBase} text-right`}>所属CR</th>
              <th className={`${thBase} text-right`}>月別確定</th>
              <th className={`${thBase} text-right`}>報酬明細</th>
              <th className={`${thBase} text-right`}>支払済</th>
              <th className={`${thBase} text-right`}>支払レコード</th>
              <th className={`${thBase} text-right`}>ログイン</th>
              <th className={`${thBase} text-right`}>参照合計</th>
              <th className={`${thBase} min-w-[320px]`}>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const ref = (key: string) =>
                row.references.find((item) => item.key === key)?.count ?? 0;

              return (
                <tr key={row.id} className="border-b border-zinc-800/60 align-top">
                  <td className={`${td} font-medium text-zinc-100`}>
                    {row.name}
                    <p className="break-all font-mono text-[10px] font-normal text-zinc-600">
                      {row.id}
                    </p>
                  </td>
                  <td className={td}>
                    <div className="flex flex-col gap-1">
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[11px] ${
                          row.isActive
                            ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-300"
                            : "border-white/[0.08] bg-white/[0.03] text-zinc-500"
                        }`}
                      >
                        {row.isActive ? "● 有効" : "○ 無効"}
                      </span>
                      {duplicateIds.has(row.id) ? (
                        <span className="rounded-full border border-amber-400/25 bg-amber-400/10 px-2 py-0.5 text-[11px] text-amber-200">
                          ⚠ 重複候補
                        </span>
                      ) : null}
                      {row.canDelete ? (
                        <span className="rounded-full border border-red-400/25 bg-red-400/10 px-2 py-0.5 text-[11px] text-red-200">
                          🗑 削除可能
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className={`${td} text-right font-mono text-zinc-300`}>
                    {ref("creators.agency_id")}
                  </td>
                  <td className={`${td} text-right font-mono text-zinc-400`}>
                    {ref("creator_monthly_agency_assignments.agency_id")}
                  </td>
                  <td className={`${td} text-right font-mono text-zinc-400`}>
                    {ref("agency_reward_items.agency_id")}
                  </td>
                  <td
                    className={`${td} text-right font-mono ${
                      row.paidRewardItemCount > 0 ? "text-amber-200" : "text-zinc-500"
                    }`}
                  >
                    {row.paidRewardItemCount}
                  </td>
                  <td className={`${td} text-right font-mono text-zinc-400`}>
                    {ref("agency_payouts.agency_id")}
                  </td>
                  <td className={`${td} text-right font-mono text-zinc-400`}>
                    {ref("profiles.agency_id")}
                  </td>
                  <td className={`${td} text-right font-mono text-zinc-200`}>
                    {row.totalReferences}
                  </td>
                  <td className="space-y-2 px-3 py-2">
                    <div className="flex flex-wrap items-start gap-2">
                      <MasterNameEditor
                        targetType="agency"
                        targetId={row.id}
                        currentName={row.name}
                        impacts={row.references
                          .filter((item) => item.count > 0)
                          .map((item) => ({ label: item.label, value: item.count }))}
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setOpenMergeId((prev) => (prev === row.id ? null : row.id))
                        }
                        className="rounded border border-white/[0.1] px-2.5 py-1 text-[11px] text-zinc-200 transition hover:bg-white/[0.06]"
                      >
                        {openMergeId === row.id ? "統合を閉じる" : "統合"}
                      </button>
                      <ActiveToggle row={row} />
                      {row.canDelete ? <DeleteButton row={row} /> : null}
                    </div>

                    {!row.canDelete ? (
                      <p className="text-[10px] text-zinc-600">
                        参照があるため削除できません。統合または無効化してください。
                      </p>
                    ) : null}

                    {openMergeId === row.id ? (
                      <MergePanel
                        source={row}
                        rows={data.rows}
                        onClose={() => setOpenMergeId(null)}
                      />
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {data.logs.length > 0 ? (
        <div className="rounded-xl border border-white/[0.06] bg-surface-1/40 p-3">
          <h3 className="text-xs font-semibold text-zinc-300">整理履歴</h3>
          <ul className="mt-2 space-y-1 text-[11px] text-zinc-400">
            {data.logs.map((log) => (
              <li key={log.id}>
                <span className="font-mono text-zinc-500">
                  {new Date(log.createdAt).toLocaleString("ja-JP")}
                </span>{" "}
                <span className="text-zinc-300">
                  {log.action === "merge"
                    ? `統合: ${log.agencyName} → ${log.targetAgencyName ?? "?"}（${log.affectedTotal}件）`
                    : log.action === "delete"
                      ? `削除: ${log.agencyName}`
                      : log.action === "deactivate"
                        ? `無効化: ${log.agencyName}`
                        : `有効化: ${log.agencyName}`}
                </span>
                {log.changedByEmail ? (
                  <span className="ml-2 text-zinc-600">{log.changedByEmail}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
