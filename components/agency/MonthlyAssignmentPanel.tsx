"use client";

import { useActionState, useState } from "react";

import {
  confirmCreatorMonthlyAssignmentsAction,
  resetCreatorMonthlyAssignmentAction,
  type MonthlyAssignmentActionResult,
} from "@/app/actions/creator-monthly-assignment";
import {
  ASSIGNMENT_STATE_LABEL,
  type AgencyAssignmentState,
} from "@/lib/agency/agency-assignment";
import type { CreatorMonthlyAssignmentData } from "@/lib/db/creator-monthly-assignment-queries";
import { formatYenPrecise } from "@/lib/revenue/calc";

/*
  月別所属の確認・確定パネル。

  ここで変更するのは「対象月の確定所属」だけ。
  クリエイターの現在所属（creators.agency_id）は変更しない。
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
  data,
  agencies,
  onClose,
}: {
  data: CreatorMonthlyAssignmentData;
  agencies: Array<{ id: string; name: string; isActive: boolean }>;
  onClose?: () => void;
}) {
  const [selectedMonths, setSelectedMonths] = useState<string[]>(() =>
    data.rows.filter((row) => row.state !== "monthly" && !row.hasPaidReward).map((row) => row.targetMonth),
  );
  const [agencyId, setAgencyId] = useState(data.currentAgencyId ?? "");

  const [confirmState, confirmAction, confirmPending] = useActionState<
    MonthlyAssignmentActionResult | null,
    FormData
  >(confirmCreatorMonthlyAssignmentsAction, null);

  const [resetState, resetAction, resetPending] = useActionState<
    MonthlyAssignmentActionResult | null,
    FormData
  >(resetCreatorMonthlyAssignmentAction, null);

  const selectedAgencyName =
    agencies.find((agency) => agency.id === agencyId)?.name ?? "（未選択）";

  const banner = confirmState ?? resetState;

  function toggleMonth(month: string) {
    setSelectedMonths((prev) =>
      prev.includes(month) ? prev.filter((m) => m !== month) : [...prev, month],
    );
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
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr>
                  <th className={thBase}>選択</th>
                  <th className={thBase}>対象月</th>
                  <th className={thBase}>適用される代理店</th>
                  <th className={thBase}>所属状態</th>
                  <th className={`${thBase} text-right`}>AP（代理店報酬）</th>
                  <th className={`${thBase} text-right`}>明細</th>
                  <th className={thBase}>操作</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.targetMonth} className="border-b border-zinc-800/60">
                    <td className={td}>
                      <input
                        type="checkbox"
                        aria-label={`${row.targetMonth} を選択`}
                        checked={selectedMonths.includes(row.targetMonth)}
                        disabled={row.hasPaidReward}
                        onChange={() => toggleMonth(row.targetMonth)}
                      />
                    </td>
                    <td className={`${td} font-mono text-zinc-200`}>{row.targetMonth}</td>
                    <td className={`${td} text-zinc-300`}>
                      {row.effectiveAgencyName ?? "（未設定）"}
                    </td>
                    <td className={td}>
                      <AssignmentStateBadge state={row.state} />
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
                        <span className="text-[11px] text-amber-200/80">
                          支払済のため変更不可
                        </span>
                      ) : row.state === "monthly" ? (
                        <form action={resetAction} className="inline">
                          <input type="hidden" name="creator_id" value={data.creatorId} />
                          <input type="hidden" name="target_month" value={row.targetMonth} />
                          <button
                            type="submit"
                            disabled={resetPending}
                            className="rounded border border-white/[0.1] px-2 py-1 text-[11px] text-zinc-300 transition hover:bg-white/[0.06] disabled:opacity-50"
                          >
                            確定を解除
                          </button>
                        </form>
                      ) : (
                        <span className="text-[11px] text-zinc-600">未確定</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <form action={confirmAction} className="space-y-3 rounded-lg border border-white/[0.08] bg-surface-0/50 p-3">
            <input type="hidden" name="creator_id" value={data.creatorId} />
            {selectedMonths.map((month) => (
              <input key={month} type="hidden" name="target_months" value={month} />
            ))}

            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label
                  htmlFor={`assign-agency-${data.creatorId}`}
                  className="text-[11px] font-medium text-zinc-500"
                >
                  確定する代理店
                </label>
                <select
                  id={`assign-agency-${data.creatorId}`}
                  name="agency_id"
                  value={agencyId}
                  onChange={(e) => setAgencyId(e.target.value)}
                  className="mt-1 w-56 rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100"
                >
                  <option value="">選択してください</option>
                  {agencies
                    .filter(
                      (agency) => agency.isActive || agency.id === data.currentAgencyId,
                    )
                    .map((agency) => (
                      <option key={agency.id} value={agency.id}>
                        {agency.name}
                        {agency.isActive ? "" : "（無効）"}
                      </option>
                    ))}
                </select>
              </div>

              <button
                type="submit"
                disabled={confirmPending || selectedMonths.length === 0 || !agencyId}
                className="min-h-[40px] rounded-lg bg-white px-4 text-sm font-semibold text-zinc-950 transition hover:bg-zinc-200 disabled:opacity-40"
              >
                {confirmPending ? "確定中…" : "選択した月をこの代理店で確定"}
              </button>
            </div>

            <p className="text-[11px] leading-relaxed text-zinc-400">
              確定内容:{" "}
              <span className="font-mono text-zinc-200">
                {selectedMonths.length > 0 ? [...selectedMonths].sort().join(", ") : "（月が未選択）"}
              </span>{" "}
              →{" "}
              <span className="font-semibold text-zinc-100">{selectedAgencyName}</span>
            </p>
            <p className="text-[11px] leading-relaxed text-zinc-600">
              この操作は対象月の所属だけを確定します。クリエイターの現在所属は変更しません。
              確定後に代理店報酬へ反映するには「売上・報酬 › 代理店報酬」で再集計を実行してください。
            </p>
          </form>
        </>
      )}
    </div>
  );
}
