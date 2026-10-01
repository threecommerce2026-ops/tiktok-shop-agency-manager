"use client";

import { useMemo, useState, useTransition } from "react";

import {
  bulkConfirmMonthlyAssignmentsAction,
  loadCreatorMonthlyAssignmentAction,
  resetCreatorMonthlyAssignmentAction,
  type MonthlyAssignmentActionResult,
} from "@/app/actions/creator-monthly-assignment";
import {
  ASSIGNMENT_STATE_LABEL,
  type AgencyAssignmentState,
} from "@/lib/agency/agency-assignment";
import type { CreatorMonthlyAssignmentData } from "@/lib/db/creator-monthly-assignment-queries";
import {
  buildPlannedChanges,
  reconfirmedChanges,
  type MonthlyAssignmentDraft,
} from "@/lib/agency/monthly-assignment-draft";
import { formatYenPrecise } from "@/lib/revenue/calc";

/*
  月別所属の確認・確定パネル。

  ■ 何を書き込むか
  creator_monthly_agency_assignments（対象月の確定所属）だけ。
  クリエイターの現在所属（creators.agency_id）は変更しない。
  紹介者 / 紹介報酬 / 代理店報酬 / payout は一切触らない。

  ■ 保存経路
  独自の UPDATE は持たない。既存の
  bulkConfirmMonthlyAssignmentsAction
    → lib/agency/confirm-monthly-assignments.ts
    → set_creator_monthly_agency_assignment RPC
  をそのまま使う。支払済のブロックも履歴
  （creator_monthly_agency_assignment_logs）もそちらが持っている。

  bulk 側を使うのは、月ごとに別の代理店を選べるようにするため。
  単一代理店版（confirmCreatorMonthlyAssignmentsAction）は
  1リクエストで1代理店しか受け取れない。

  ■ 「所属なし」で確定できない理由
  RPC set_creator_monthly_agency_assignment が
  p_agency_id is null を明示的に拒否している。
  所属を外す操作は「確定を解除」（reset RPC）が正式経路なので、
  ここで NULL を書き込む別経路は作らない。

  ■ 保存後の表示
  クライアント側で数え直さず、必ず DB から読み直す。
*/

const STATE_CLASS: Record<AgencyAssignmentState, string> = {
  monthly: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  current: "border-amber-400/25 bg-amber-400/10 text-amber-200",
  none: "border-red-400/25 bg-red-400/10 text-red-200",
};

const thBase =
  "whitespace-nowrap border-b border-zinc-800 bg-surface-1/80 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-500";

const td = "whitespace-nowrap px-3 py-2 text-xs";

export function AssignmentStateBadge({ state }: { state: AgencyAssignmentState }) {
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[11px] ${STATE_CLASS[state]}`}>
      {ASSIGNMENT_STATE_LABEL[state]}
    </span>
  );
}

export function MonthlyAssignmentPanel({
  data: initialData,
  agencies,
  onClose,
  onSaved,
}: {
  data: CreatorMonthlyAssignmentData;
  agencies: Array<{ id: string; name: string; isActive: boolean }>;
  onClose?: () => void;
  /** 保存が成功したあと、呼び出し側の集計を DB から読み直させる */
  onSaved?: () => void;
}) {
  const [data, setData] = useState(initialData);
  const [draft, setDraft] = useState<MonthlyAssignmentDraft>({});
  const [bulkAgencyId, setBulkAgencyId] = useState("");
  const [stage, setStage] = useState<"edit" | "confirm">("edit");
  const [banner, setBanner] = useState<MonthlyAssignmentActionResult | null>(null);
  const [isPending, startTransition] = useTransition();

  const selectableAgencies = useMemo(
    () =>
      agencies.filter(
        (agency) =>
          agency.isActive ||
          agency.id === data.currentAgencyId ||
          data.rows.some((row) => row.monthlyAgencyId === agency.id),
      ),
    [agencies, data],
  );

  const changes = useMemo(
    () => buildPlannedChanges(data.rows, draft, agencies),
    [data.rows, draft, agencies],
  );
  const reconfirmed = useMemo(() => reconfirmedChanges(changes), [changes]);

  const unconfirmedMonths = data.rows.filter(
    (row) => row.monthlyAgencyId === null && !row.hasPaidReward,
  );

  function setMonth(month: string, agencyId: string) {
    setDraft((prev) => ({ ...prev, [month]: agencyId }));
    setStage("edit");
  }

  /** PHASE 4: 入力欄を埋めるだけ。DB へは書き込まない */
  function fillUnconfirmed() {
    if (!bulkAgencyId) return;
    setDraft((prev) => {
      const next = { ...prev };
      for (const row of unconfirmedMonths) next[row.targetMonth] = bulkAgencyId;
      return next;
    });
    setStage("edit");
  }

  /** 保存後・解除後は必ず DB から読み直す（画面だけ更新しない） */
  async function reload() {
    const result = await loadCreatorMonthlyAssignmentAction(data.creatorId);
    if (result.ok) {
      setData(result.data);
      setDraft({});
      setStage("edit");
    }
    onSaved?.();
  }

  function submit() {
    startTransition(async () => {
      const formData = new FormData();
      for (const change of changes) {
        formData.append(
          "entries",
          `${data.creatorId}|${change.targetMonth}|${change.agencyId}`,
        );
      }
      const result = await bulkConfirmMonthlyAssignmentsAction(null, formData);
      setBanner(result);
      if (result.ok) await reload();
    });
  }

  function reset(targetMonth: string) {
    startTransition(async () => {
      const formData = new FormData();
      formData.set("creator_id", data.creatorId);
      formData.set("target_month", targetMonth);
      const result = await resetCreatorMonthlyAssignmentAction(null, formData);
      setBanner(result);
      if (result.ok) await reload();
    });
  }

  return (
    <div className="space-y-4 rounded-xl border border-cyan-500/20 bg-cyan-500/[0.04] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-zinc-100">
            {data.creatorName}
            <span className="ml-2 font-mono text-xs text-zinc-500">{data.tiktokId}</span>
          </p>
          <p className="mt-1 text-[11px] text-zinc-500">
            現在所属:{" "}
            <span className="text-zinc-300">{data.currentAgencyName ?? "（未設定）"}</span>
            <span className="ml-2 text-zinc-600">
              ※ このパネルでは現在所属は変更しません
            </span>
          </p>
        </div>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-zinc-500 hover:text-zinc-300"
          >
            閉じる
          </button>
        ) : null}
      </div>

      {data.error ? (
        <p className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
          {data.error}
        </p>
      ) : null}

      {banner ? (
        <p
          className={`rounded-lg border px-3 py-2 text-xs ${
            banner.ok
              ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-200"
              : "border-red-500/25 bg-red-500/10 text-red-200"
          }`}
          role="status"
        >
          {banner.ok ? banner.message : banner.error}
        </p>
      ) : null}

      {data.rows.length === 0 ? (
        <p className="rounded-lg border border-zinc-800 py-6 text-center text-xs text-zinc-500">
          対象となる実績月がありません。
        </p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-zinc-800">
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr>
                  <th className={thBase}>対象月</th>
                  <th className={thBase}>いまの所属</th>
                  <th className={thBase}>所属状態</th>
                  <th className={thBase}>この月の所属</th>
                  <th className={`${thBase} text-right`}>AP（代理店報酬）</th>
                  <th className={`${thBase} text-right`}>明細</th>
                  <th className={thBase}>操作</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => {
                  const selected = draft[row.targetMonth] ?? "";
                  const willChange =
                    selected !== "" && selected !== row.monthlyAgencyId;
                  return (
                    <tr
                      key={row.targetMonth}
                      className={`border-b border-zinc-800/60 ${
                        willChange ? "bg-cyan-400/[0.06]" : ""
                      }`}
                    >
                      <td className={`${td} font-mono text-zinc-200`}>
                        {row.targetMonth}
                      </td>
                      <td className={`${td} text-zinc-300`}>
                        {row.effectiveAgencyName ?? "（未設定）"}
                      </td>
                      <td className={td}>
                        <AssignmentStateBadge state={row.state} />
                      </td>
                      <td className={td}>
                        {row.hasPaidReward ? (
                          <span className="text-[11px] text-amber-200/80">
                            支払済のため変更不可
                          </span>
                        ) : (
                          <select
                            aria-label={`${row.targetMonth} の所属`}
                            value={selected}
                            onChange={(e) => setMonth(row.targetMonth, e.target.value)}
                            className="w-48 rounded-lg border border-white/[0.08] bg-surface-1 px-2 py-1 text-xs text-zinc-100"
                          >
                            <option value="">（変更しない）</option>
                            {selectableAgencies.map((agency) => (
                              <option key={agency.id} value={agency.id}>
                                {agency.name}
                                {agency.isActive ? "" : "（無効）"}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td className={`${td} text-right font-mono text-zinc-300`}>
                        {row.isExternalPayable
                          ? formatYenPrecise(row.agencyRevenue)
                          : `${formatYenPrecise(row.agencyRevenue)}（自社/対象外）`}
                      </td>
                      <td className={`${td} text-right font-mono text-zinc-500`}>
                        {row.lineCount}
                      </td>
                      <td className={td}>
                        {row.hasPaidReward ? (
                          <span className="text-[11px] text-zinc-600">—</span>
                        ) : row.monthlyAgencyId ? (
                          <button
                            type="button"
                            onClick={() => reset(row.targetMonth)}
                            disabled={isPending}
                            className="rounded border border-white/[0.1] px-2 py-1 text-[11px] text-zinc-300 transition hover:bg-white/[0.06] disabled:opacity-50"
                          >
                            確定を解除
                          </button>
                        ) : (
                          <span className="text-[11px] text-zinc-600">未確定</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {unconfirmedMonths.length > 0 ? (
            <div className="flex flex-wrap items-end gap-3 rounded-lg border border-white/[0.08] bg-surface-0/50 p-3">
              <div>
                <label
                  htmlFor={`bulk-agency-${data.creatorId}`}
                  className="text-[11px] font-medium text-zinc-500"
                >
                  未確定の {unconfirmedMonths.length} ヶ月をまとめて選ぶ
                </label>
                <select
                  id={`bulk-agency-${data.creatorId}`}
                  value={bulkAgencyId}
                  onChange={(e) => setBulkAgencyId(e.target.value)}
                  className="mt-1 w-56 rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100"
                >
                  <option value="">選択してください</option>
                  {selectableAgencies.map((agency) => (
                    <option key={agency.id} value={agency.id}>
                      {agency.name}
                      {agency.isActive ? "" : "（無効）"}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={fillUnconfirmed}
                disabled={!bulkAgencyId}
                className="min-h-[40px] rounded-lg border border-white/[0.14] px-3 text-xs text-zinc-200 transition hover:bg-white/[0.06] disabled:opacity-40"
              >
                未確定月の選択欄を埋める
              </button>
              <p className="text-[11px] text-zinc-600">
                この操作は入力欄を埋めるだけで、まだ保存しません。
              </p>
            </div>
          ) : null}

          <div className="space-y-3 rounded-lg border border-white/[0.08] bg-surface-0/50 p-3">
            {stage === "edit" ? (
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => setStage("confirm")}
                  disabled={changes.length === 0}
                  className="min-h-[40px] rounded-lg border border-white/[0.18] px-4 text-sm font-semibold text-zinc-100 transition hover:bg-white/[0.06] disabled:opacity-40"
                >
                  変更内容を確認
                </button>
                <p className="text-[11px] text-zinc-500">
                  {changes.length === 0
                    ? "変更する月がありません。"
                    : `${changes.length} ヶ月を変更します。`}
                </p>
              </div>
            ) : (
              <>
                <p className="text-xs font-semibold text-zinc-100">
                  この内容で月別所属を確定しますか？
                </p>

                <ul className="space-y-1">
                  {changes.map((change) => (
                    <li
                      key={change.targetMonth}
                      className="flex flex-wrap items-center gap-2 text-[11px]"
                    >
                      <span className="font-mono text-zinc-200">
                        {change.targetMonth}
                      </span>
                      <span className="text-zinc-500">
                        {change.previousAgencyName ?? "未確定"}
                      </span>
                      <span className="text-zinc-600">→</span>
                      <span className="font-semibold text-zinc-100">
                        {change.agencyName}
                      </span>
                      {change.previousAgencyId ? (
                        <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-amber-200">
                          確定済を変更
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>

                {reconfirmed.length > 0 ? (
                  <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-100">
                    すでに確定済の {reconfirmed.length} ヶ月（
                    {reconfirmed.map((change) => change.targetMonth).join(", ")}
                    ）を別の代理店へ付け替えます。過去の代理店報酬の帰属先が変わるため、
                    変更後は「売上・報酬 › 代理店報酬」で再集計し、金額を確認してください。
                  </p>
                ) : null}

                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={submit}
                    disabled={isPending || changes.length === 0}
                    className="min-h-[40px] rounded-lg bg-white px-4 text-sm font-semibold text-zinc-950 transition hover:bg-zinc-200 disabled:opacity-40"
                  >
                    {isPending ? "確定中…" : "この内容で月別所属を確定"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setStage("edit")}
                    disabled={isPending}
                    className="text-xs text-zinc-500 transition hover:text-zinc-300 disabled:opacity-40"
                  >
                    選択に戻る
                  </button>
                </div>
              </>
            )}

            <p className="text-[11px] leading-relaxed text-zinc-600">
              この操作は対象月の所属だけを確定します。クリエイターの現在所属・紹介者・
              紹介報酬は変更しません。確定後に代理店報酬へ反映するには
              「売上・報酬 › 代理店報酬」で再集計を実行してください。
            </p>
          </div>
        </>
      )}
    </div>
  );
}
