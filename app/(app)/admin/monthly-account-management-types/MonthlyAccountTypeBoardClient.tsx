"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import {
  bulkConfirmMonthlyAccountTypesAction,
  type MonthlyAccountTypeActionResult,
} from "@/app/actions/creator-monthly-account-type";
import {
  ACCOUNT_MANAGEMENT_TYPES,
  accountManagementTypeLabel,
  type AccountManagementType,
} from "@/lib/creators/account-management-type";
import {
  boardRowKey,
  buildBoardChanges,
  pickRewardImpactRows,
  selectUnconfirmedRows,
  summarizeBoardChanges,
  type BoardSelection,
} from "@/lib/creators/monthly-account-type-board-draft";
import type { MonthlyAccountTypeBoardData } from "@/lib/db/monthly-account-type-board-queries";
import { formatYenPrecise } from "@/lib/revenue/calc";

/*
  月別クリエイター区分 一括確認・確定ボード。

  ■ 何を書き込むか
  creator_monthly_account_management_types だけ。
  creators.account_management_type（現在区分）・紹介者・月別所属・
  紹介報酬・payout は一切触らない。

  ■ 保存経路
  独自の INSERT / UPDATE は持たない。
    bulkConfirmMonthlyAccountTypesAction
      → lib/creators/confirm-monthly-account-types.ts
      → set_creator_monthly_account_management_type RPC
  支払済みのブロックも履歴も auth.uid() の記録もそちらが持っている。

  ■ 埋める値は現在区分
  creator_master_change_logs の変更日時から過去区分を推測しない。
  9月末の区分変更はマスタ訂正であって実運用の変更日ではないため、
  変更日を境に過去を別区分として扱うのは誤り（2026-10-03 確定）。

  ■ 紹介報酬は再計算しない
  確定しても referral_reward_items は動かない。影響額は
  「再計算プレビュー」として読み取りのみで出し、実行はしない。
*/

const th =
  "whitespace-nowrap border-b border-zinc-800 bg-surface-1/80 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-500";
const td = "whitespace-nowrap px-3 py-2 text-xs";

const TYPE_CLASS: Record<AccountManagementType, string> = {
  standard: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  self_operated: "border-sky-400/25 bg-sky-400/10 text-sky-200",
  account_lending: "border-violet-400/25 bg-violet-400/10 text-violet-200",
};

const STATE_FILTERS = [
  { key: "all", label: "すべて" },
  { key: "provisional", label: "未確定のみ" },
  { key: "confirmed", label: "確定済みのみ" },
] as const;

const int = (value: number) => Number(value).toLocaleString("ja-JP");

function TypeBadge({ type }: { type: AccountManagementType }) {
  return (
    <span
      className={`whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] ${TYPE_CLASS[type]}`}
    >
      {accountManagementTypeLabel(type)}
    </span>
  );
}

export function MonthlyAccountTypeBoardClient({
  data: initialData,
}: {
  data: MonthlyAccountTypeBoardData;
}) {
  const router = useRouter();
  const data = initialData;
  const [selection, setSelection] = useState<BoardSelection>(new Set());
  const [stage, setStage] = useState<"edit" | "confirm">("edit");
  const [banner, setBanner] = useState<MonthlyAccountTypeActionResult | null>(null);
  const [isPending, startTransition] = useTransition();

  const [month, setMonth] = useState("all");
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] =
    useState<(typeof STATE_FILTERS)[number]["key"]>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");

  const rows = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return data.rows.filter((row) => {
      if (month !== "all" && row.targetMonth !== month) return false;
      if (keyword && !row.tiktokId.toLowerCase().includes(keyword)) return false;
      if (stateFilter === "provisional" && row.source !== "current") return false;
      if (stateFilter === "confirmed" && row.source !== "monthly") return false;
      if (typeFilter !== "all" && row.effectiveType !== typeFilter) return false;
      return true;
    });
  }, [data.rows, month, search, stateFilter, typeFilter]);

  /* 確定対象は画面の絞り込みではなく、選択した行そのもの */
  const changes = useMemo(
    () => buildBoardChanges(data.rows, selection),
    [data.rows, selection],
  );
  const summary = useMemo(() => summarizeBoardChanges(changes), [changes]);
  const impact = useMemo(
    () => pickRewardImpactRows(data.rows, changes),
    [data.rows, changes],
  );

  const blocked = useMemo(
    () => data.rows.filter((row) => row.hasPaidReward),
    [data.rows],
  );
  const finalized = useMemo(
    () => [...new Set(data.rows.filter((r) => r.settlementFinalized).map((r) => r.targetMonth))].sort(),
    [data.rows],
  );

  function toggle(key: string) {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setStage("edit");
  }

  /** 未確定月を現在区分で埋める。DB へは書き込まない */
  function fillUnconfirmed() {
    setSelection(selectUnconfirmedRows(data.rows));
    setStage("edit");
  }

  function clearSelection() {
    setSelection(new Set());
    setStage("edit");
  }

  function submit() {
    startTransition(async () => {
      const formData = new FormData();
      for (const change of changes) {
        formData.append(
          "entries",
          `${change.creatorId}|${change.targetMonth}|${change.accountManagementType}`,
        );
      }
      const result = await bulkConfirmMonthlyAccountTypesAction(null, formData);
      setBanner(result);

      if (result.ok) {
        /*
          画面で数え直さない。確定件数も未確定件数も DB から読み直す。
          サーバーコンポーネントを再実行させて data を入れ替える。
        */
        setSelection(new Set());
        setStage("edit");
        router.refresh();
      }
    });
  }

  return (
    <div className="space-y-5">
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

      {/* 集計 */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="クリエイター" value={int(data.totals.creatorCount)} hint="TAP実績あり" />
        <Kpi label="クリエイター × 対象月" value={int(data.totals.rowCount)} />
        <Kpi
          label="確定済み"
          value={int(data.totals.confirmedCount)}
          hint={`未確定 ${int(data.totals.provisionalCount)}`}
        />
        <Kpi
          label="変更不可（支払済み）"
          value={int(data.totals.lockedCount)}
          hint={finalized.length > 0 ? `月次確定済: ${finalized.join(", ")}` : "月次確定なし"}
        />
      </div>

      <div className="flex flex-wrap gap-2 text-[11px] text-zinc-400">
        <span>区分の内訳（適用中）:</span>
        <span>通常 <span className="font-mono text-zinc-200">{int(data.totals.standardCount)}</span></span>
        <span>自社運用 <span className="font-mono text-zinc-200">{int(data.totals.selfOperatedCount)}</span></span>
        <span>アカウント貸し出し <span className="font-mono text-zinc-200">{int(data.totals.accountLendingCount)}</span></span>
      </div>

      {/* 絞り込み */}
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-white/[0.08] bg-surface-1/40 p-3">
        <div>
          <label htmlFor="board-month" className="text-[11px] font-medium text-zinc-500">
            対象月
          </label>
          <select
            id="board-month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="mt-1 w-36 rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100"
          >
            <option value="all">すべて</option>
            {data.months.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="board-search" className="text-[11px] font-medium text-zinc-500">
            TikTok ID 検索
          </label>
          <input
            id="board-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="TikTok ID の一部"
            className="mt-1 w-52 rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100"
          />
        </div>

        <div className="flex flex-wrap gap-1">
          {STATE_FILTERS.map((filter) => (
            <button
              key={filter.key}
              type="button"
              onClick={() => setStateFilter(filter.key)}
              className={`rounded-lg border px-3 py-2 text-[11px] ${
                stateFilter === filter.key
                  ? "border-[var(--accent-cyan)]/40 bg-[var(--accent-cyan)]/10 text-[var(--accent-cyan)]"
                  : "border-white/[0.1] text-zinc-300 hover:bg-white/[0.05]"
              }`}
            >
              {filter.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            onClick={() => setTypeFilter("all")}
            className={`rounded-lg border px-3 py-2 text-[11px] ${
              typeFilter === "all"
                ? "border-[var(--accent-cyan)]/40 bg-[var(--accent-cyan)]/10 text-[var(--accent-cyan)]"
                : "border-white/[0.1] text-zinc-300 hover:bg-white/[0.05]"
            }`}
          >
            区分すべて
          </button>
          {ACCOUNT_MANAGEMENT_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => setTypeFilter(type)}
              className={`rounded-lg border px-3 py-2 text-[11px] ${
                typeFilter === type
                  ? "border-[var(--accent-cyan)]/40 bg-[var(--accent-cyan)]/10 text-[var(--accent-cyan)]"
                  : "border-white/[0.1] text-zinc-300 hover:bg-white/[0.05]"
              }`}
            >
              {accountManagementTypeLabel(type)}
            </button>
          ))}
        </div>

        <p className="text-[11px] text-zinc-500">
          表示 <span className="font-mono text-zinc-300">{int(rows.length)}</span> 行
        </p>
      </div>

      {/* 埋める */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-white/[0.08] bg-surface-0/50 p-3">
        <button
          type="button"
          onClick={fillUnconfirmed}
          className="min-h-[40px] rounded-lg border border-white/[0.18] px-4 text-sm font-semibold text-zinc-100 transition hover:bg-white/[0.06]"
        >
          未確定月を現在区分で埋める
        </button>
        <button
          type="button"
          onClick={clearSelection}
          disabled={selection.size === 0}
          className="text-xs text-zinc-500 transition hover:text-zinc-300 disabled:opacity-40"
        >
          選択を解除
        </button>
        <p className="text-[11px] leading-relaxed text-zinc-500">
          選択中 <span className="font-mono text-zinc-200">{int(selection.size)}</span> 行
          {" / "}
          実際に変わる <span className="font-mono text-zinc-200">{int(changes.length)}</span> 行。
          <span className="ml-1 text-zinc-600">
            この操作は選択するだけで、まだ保存しません。
          </span>
        </p>
      </div>

      {/* ブロック対象 */}
      {blocked.length > 0 ? (
        <div className="rounded-xl border border-amber-400/25 bg-amber-400/5 p-4">
          <p className="text-xs font-semibold text-amber-200">
            支払済みのため確定できない行があります（{int(blocked.length)} 件）
          </p>
          <ul className="mt-1 space-y-0.5 text-[11px] text-amber-100/90">
            {blocked.slice(0, 20).map((row) => (
              <li key={boardRowKey(row)}>
                <span className="font-mono">{row.tiktokId}</span> / {row.targetMonth}
                {" — "}
                紹介報酬 {formatYenPrecise(row.rewardAmount)}（支払済みまたは支払予定中）
              </li>
            ))}
            {blocked.length > 20 ? (
              <li className="text-amber-200/70">ほか {int(blocked.length - 20)} 件</li>
            ) : null}
          </ul>
        </div>
      ) : null}

      {/* 一覧 */}
      <div className="overflow-x-auto rounded-xl border border-zinc-800">
        <table className="w-full min-w-[980px] text-sm">
          <thead>
            <tr>
              <th className={th}>選択</th>
              <th className={th}>TikTok ID</th>
              <th className={th}>クリエイター名</th>
              <th className={th}>対象月</th>
              <th className={th}>現在区分</th>
              <th className={th}>月別確定区分</th>
              <th className={th}>確定状態</th>
              <th className={`${th} text-right`}>算定元(W+X)</th>
              <th className={`${th} text-right`}>紹介報酬</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const key = boardRowKey(row);
              const checked = selection.has(key);
              return (
                <tr
                  key={key}
                  className={`border-b border-zinc-800/60 ${checked ? "bg-cyan-400/[0.06]" : ""}`}
                >
                  <td className={td}>
                    <input
                      type="checkbox"
                      aria-label={`${row.tiktokId} ${row.targetMonth} を選択`}
                      checked={checked}
                      disabled={row.hasPaidReward}
                      onChange={() => toggle(key)}
                    />
                  </td>
                  <td className={`${td} font-mono text-zinc-200`}>{row.tiktokId}</td>
                  <td className={`${td} text-zinc-400`}>{row.creatorName || "—"}</td>
                  <td className={`${td} font-mono text-zinc-300`}>{row.targetMonth}</td>
                  <td className={td}>
                    <TypeBadge type={row.currentType} />
                  </td>
                  <td className={td}>
                    {row.monthlyType ? (
                      <TypeBadge type={row.monthlyType} />
                    ) : (
                      <span className="text-[11px] text-zinc-600">—</span>
                    )}
                  </td>
                  <td className={td}>
                    {row.hasPaidReward ? (
                      <span className="text-[11px] text-amber-200/80">変更不可（支払済み）</span>
                    ) : row.source === "monthly" ? (
                      <span className="text-[11px] text-emerald-300">✓ 月別確定</span>
                    ) : (
                      <span className="text-[11px] text-amber-200">△ 現在区分（暫定）</span>
                    )}
                  </td>
                  <td className={`${td} text-right font-mono text-zinc-300`}>
                    {formatYenPrecise(row.referralBase)}
                  </td>
                  <td className={`${td} text-right font-mono text-zinc-300`}>
                    {row.rewardItemCount === 0 ? "—" : formatYenPrecise(row.rewardAmount)}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-3 py-10 text-center text-xs text-zinc-500">
                  条件に合う行がありません。
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {/* 確定 */}
      <div className="space-y-3 rounded-xl border border-white/[0.08] bg-surface-0/50 p-4">
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
                ? "確定する行がありません。"
                : `${int(summary.creatorCount)} 名 / ${int(summary.rowCount)} 行を確定します。`}
            </p>
          </div>
        ) : (
          <>
            <p className="text-sm font-semibold text-zinc-100">
              この内容で月別区分を確定しますか？
            </p>

            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
              <Kpi label="対象クリエイター" value={int(summary.creatorCount)} />
              <Kpi label="クリエイター × 対象月" value={int(summary.rowCount)} />
              <Kpi label="通常" value={int(summary.standardCount)} />
              <Kpi label="自社運用" value={int(summary.selfOperatedCount)} />
              <Kpi label="アカウント貸し出し" value={int(summary.accountLendingCount)} />
            </div>

            {summary.reconfirmCount > 0 ? (
              <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-100">
                すでに確定済みの {int(summary.reconfirmCount)} 行を別の区分へ付け替えます。
              </p>
            ) : null}

            {/* 報酬影響確認 */}
            {impact.length > 0 ? (
              <div className="rounded-lg border border-white/[0.08] bg-surface-1/40 p-3">
                <p className="text-xs font-semibold text-zinc-200">報酬影響確認</p>
                <p className="mt-1 text-[11px] text-zinc-500">
                  紹介報酬が発生している、または算定元が大きいクリエイターです。
                  確定前に内容をご確認ください。
                </p>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full min-w-[620px] text-[11px]">
                    <thead>
                      <tr className="text-left text-zinc-500">
                        <th className="px-2 py-1 font-medium">TikTok ID</th>
                        <th className="px-2 py-1 font-medium">対象月</th>
                        <th className="px-2 py-1 font-medium">確定予定区分</th>
                        <th className="px-2 py-1 text-right font-medium">現在の紹介報酬</th>
                      </tr>
                    </thead>
                    <tbody>
                      {impact.map((row) => (
                        <tr key={boardRowKey(row)} className="border-t border-white/[0.05]">
                          <td className="px-2 py-1 font-mono text-zinc-300">{row.tiktokId}</td>
                          <td className="px-2 py-1 font-mono text-zinc-400">{row.targetMonth}</td>
                          <td className="px-2 py-1">
                            {accountManagementTypeLabel(row.currentType)}
                          </td>
                          <td className="px-2 py-1 text-right font-mono text-zinc-300">
                            {row.rewardItemCount === 0
                              ? "¥0"
                              : formatYenPrecise(row.rewardAmount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 text-[11px] font-semibold text-amber-200">
                  月別区分を確定しても紹介報酬は自動再計算されません。
                </p>
              </div>
            ) : null}

            <p className="rounded-lg border border-white/[0.1] bg-surface-1/60 px-3 py-2 text-[11px] font-semibold text-zinc-200">
              この操作では紹介報酬・支払データは変更されません。
            </p>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={submit}
                disabled={isPending || changes.length === 0}
                className="min-h-[40px] rounded-lg bg-white px-4 text-sm font-semibold text-zinc-950 transition hover:bg-zinc-200 disabled:opacity-40"
              >
                {isPending ? "確定中…" : "この内容で月別区分を確定"}
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
      </div>

      {/* 再計算プレビュー */}
      <div className="rounded-xl border border-white/[0.08] bg-surface-1/40 p-4">
        <p className="text-xs font-semibold text-zinc-200">紹介報酬の再計算プレビュー</p>
        <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
          いまの区分判定で再集計したらどうなるかの試算です。
          <span className="font-semibold text-amber-200">
            この画面からは再集計を実行しません。
          </span>
        </p>

        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Kpi
            label="現在"
            value={formatYenPrecise(data.rewardPreview.beforeAmount)}
            hint={`${int(data.rewardPreview.beforeItemCount)} 件`}
          />
          <Kpi
            label="再計算予定"
            value={formatYenPrecise(data.rewardPreview.afterAmount)}
            hint={`${int(data.rewardPreview.afterItemCount)} 件`}
          />
          <Kpi
            label="差額"
            value={formatYenPrecise(
              data.rewardPreview.afterAmount - data.rewardPreview.beforeAmount,
            )}
            hint={`${int(
              data.rewardPreview.afterItemCount - data.rewardPreview.beforeItemCount,
            )} 件`}
            tone="strong"
          />
        </div>

        {data.rewardPreview.changes.length > 0 ? (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[560px] text-[11px]">
              <thead>
                <tr className="text-left text-zinc-500">
                  <th className="px-2 py-1 font-medium">TikTok ID</th>
                  <th className="px-2 py-1 text-right font-medium">現在</th>
                  <th className="px-2 py-1 text-right font-medium">再計算予定</th>
                  <th className="px-2 py-1 text-right font-medium">差額</th>
                </tr>
              </thead>
              <tbody>
                {data.rewardPreview.changes.map((change) => (
                  <tr key={change.tiktokId} className="border-t border-white/[0.05]">
                    <td className="px-2 py-1 font-mono text-zinc-300">{change.tiktokId}</td>
                    <td className="px-2 py-1 text-right font-mono text-zinc-400">
                      {formatYenPrecise(change.beforeAmount)}
                    </td>
                    <td className="px-2 py-1 text-right font-mono text-zinc-400">
                      {formatYenPrecise(change.afterAmount)}
                    </td>
                    <td
                      className={`px-2 py-1 text-right font-mono ${
                        change.diff < 0 ? "text-red-300" : "text-emerald-300"
                      }`}
                    >
                      {formatYenPrecise(change.diff)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Kpi({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "strong";
}) {
  return (
    <div
      className={`rounded-xl border px-3 py-3 ${
        tone === "strong"
          ? "border-[var(--accent-cyan)]/30 bg-[var(--accent-cyan)]/[0.06]"
          : "border-white/[0.08] bg-surface-1"
      }`}
    >
      <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
        {label}
      </p>
      <p className="mt-1 font-mono text-lg font-bold text-zinc-50">{value}</p>
      {hint ? <p className="mt-0.5 text-[11px] text-zinc-500">{hint}</p> : null}
    </div>
  );
}
