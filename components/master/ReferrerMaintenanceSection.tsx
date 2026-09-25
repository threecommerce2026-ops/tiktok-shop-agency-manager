"use client";

import { useActionState, useMemo, useState } from "react";

import {
  deleteReferrerAction,
  mergeReferrerAction,
  setReferrerActiveAction,
  type ReferrerMaintenanceResult,
} from "@/app/actions/referrer-maintenance";
import { MasterNameEditor } from "@/components/master/MasterNameEditor";
import { ReferrerDuplicateGroups } from "@/components/master/ReferrerDuplicateGroups";
import type {
  ReferrerMaintenanceData,
  ReferrerMaintenanceRow,
} from "@/lib/db/referrer-maintenance-queries";
import { formatYenPrecise } from "@/lib/revenue/calc";

/*
  紹介者マスタ整理（名称編集 / 統合 / 無効化 / 削除）。

  代理店の AgencyMaintenanceSection と同じ安全設計に揃えている。
  ・重複候補は「候補」として出すだけ。自動統合は一切しない
  ・統合は二段階確認（① DRY RUN → 影響確認 → ② 最終確認 → 実行）
  ・支払い済みデータがある紹介者は統合ボタンを押せない
  ・参照が全て0の紹介者だけ削除ボタンを表示
*/

const thBase =
  "whitespace-nowrap border-b border-zinc-800 bg-surface-1/80 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-500";

const td = "whitespace-nowrap px-3 py-2 text-xs";

type StateFilter = "all" | "active" | "inactive";

function ResultBanner({ state }: { state: ReferrerMaintenanceResult | null }) {
  if (!state) return null;
  return (
    <p
      className={`rounded-lg border px-3 py-2 text-[11px] leading-relaxed ${
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

function SideSummary({
  title,
  side,
}: {
  title: string;
  side: {
    name: string;
    id: string;
    referralCode: string | null;
    isActive: boolean;
    hasLogin: boolean;
    creatorCount: number;
    linkCount: number;
    activeLinkCount: number;
    rewardItemCount: number;
    rewardAmount: number;
    paidRewardItemCount: number;
    paidRewardAmount: number;
    unpaidRewardAmount: number;
    payoutCount: number;
    paidPayoutCount: number;
    paidPayoutAmount: number;
    unpaidPayoutAmount: number;
    nameChangeLogCount: number;
  };
}) {
  const rows: Array<[string, string]> = [
    ["紐付けクリエイター", `${side.creatorCount} 名`],
    ["creator_referrals", `${side.linkCount} 件（有効 ${side.activeLinkCount}）`],
    ["紹介者報酬明細", `${side.rewardItemCount} 件`],
    ["紹介報酬 合計", formatYenPrecise(side.rewardAmount)],
    ["うち支払済", `${side.paidRewardItemCount} 件 / ${formatYenPrecise(side.paidRewardAmount)}`],
    ["うち未払", formatYenPrecise(side.unpaidRewardAmount)],
    ["支払レコード", `${side.payoutCount} 件（支払済 ${side.paidPayoutCount}）`],
    ["支払済 金額", formatYenPrecise(side.paidPayoutAmount)],
    ["未払 金額", formatYenPrecise(side.unpaidPayoutAmount)],
    ["紹介コード", side.referralCode ?? "（なし）"],
    ["ポータルログイン", side.hasLogin ? "あり" : "なし"],
    ["名称変更履歴", `${side.nameChangeLogCount} 件`],
    ["状態", side.isActive ? "有効" : "無効"],
  ];

  return (
    <div className="rounded-lg border border-white/[0.08] bg-surface-0/50 p-3">
      <p className="text-[11px] font-semibold text-zinc-300">{title}</p>
      <p className="mt-0.5 text-xs font-semibold text-zinc-100">{side.name}</p>
      <p className="break-all font-mono text-[10px] text-zinc-600">{side.id}</p>
      <dl className="mt-2 space-y-0.5 text-[11px]">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-3">
            <dt className="text-zinc-500">{label}</dt>
            <dd className="font-mono text-zinc-300">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** 統合パネル（二段階確認） */
function MergePanel({
  source,
  rows,
  onClose,
}: {
  source: ReferrerMaintenanceRow;
  rows: ReferrerMaintenanceRow[];
  onClose: () => void;
}) {
  const [targetId, setTargetId] = useState("");
  const [finalConfirmed, setFinalConfirmed] = useState(false);
  const [state, formAction, pending] = useActionState<
    ReferrerMaintenanceResult | null,
    FormData
  >(mergeReferrerAction, null);

  const dryRun = state?.dryRun ?? null;
  const dryRunMatches =
    dryRun?.source.id === source.id && dryRun?.target.id === targetId;
  const canExecute = Boolean(
    state?.ok && dryRunMatches && dryRun && dryRun.canMerge && finalConfirmed,
  );

  return (
    <div className="space-y-3 rounded-xl border border-cyan-500/20 bg-cyan-500/[0.04] p-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-semibold text-zinc-100">
          {source.name} を別の紹介者へ統合
        </p>
        <button
          type="button"
          onClick={onClose}
          className="text-[11px] text-zinc-500 hover:text-zinc-300"
        >
          閉じる
        </button>
      </div>

      <p className="rounded-lg border border-white/[0.06] bg-surface-1/40 px-3 py-2 text-[10px] leading-relaxed text-zinc-500">
        統合は「統合元の referrer_id を参照しているデータを統合先へ付け替える」操作です。
        名前が似ているだけでは同一人物とは限りません。DRY RUN の内容を確認し、
        同一人物だと判断できた場合のみ実行してください。
      </p>

      <div>
        <label
          htmlFor={`merge-target-${source.id}`}
          className="text-[11px] font-medium text-zinc-500"
        >
          統合先（残す紹介者）
        </label>
        <select
          id={`merge-target-${source.id}`}
          value={targetId}
          onChange={(e) => {
            setTargetId(e.target.value);
            setFinalConfirmed(false);
          }}
          className="mt-1 w-full rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100"
        >
          <option value="">選択してください</option>
          {rows
            .filter((row) => row.id !== source.id)
            .map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
                {row.referralCode ? `（${row.referralCode}）` : ""}
                {row.isActive ? "" : "【無効】"}
              </option>
            ))}
        </select>
      </div>

      {source.mergeBlockedByPaidData ? (
        <div className="space-y-1 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[11px] leading-relaxed text-red-200">
          <p className="font-semibold">
            この紹介者には支払い済みデータがあります（支払済明細{" "}
            {source.paidRewardItemCount} 件 / 支払確定 {source.paidPayoutCount} 件）。
          </p>
          <p>
            支払履歴を壊さないため、通常の統合ボタンでは実行できません。DRY RUN で影響だけ確認できます。
          </p>
        </div>
      ) : null}

      {/* ① DRY RUN */}
      <form action={formAction} className="space-y-2">
        <input type="hidden" name="source_referrer_id" value={source.id} />
        <input type="hidden" name="target_referrer_id" value={targetId} />
        <button
          type="submit"
          disabled={pending || !targetId}
          className="min-h-[36px] rounded-lg border border-white/[0.1] px-4 text-xs font-medium text-zinc-100 transition hover:bg-white/[0.06] disabled:opacity-40"
        >
          {pending ? "確認中…" : "① 影響を確認（DRY RUN・DBは変更しません）"}
        </button>
      </form>

      <ResultBanner state={state} />

      {/* ② 影響内容の確認 */}
      {dryRun && dryRunMatches ? (
        <div className="space-y-3 rounded-lg border border-white/[0.08] bg-surface-0/50 p-3 text-[11px]">
          <p className="text-zinc-300">
            <span className="font-semibold">{dryRun.source.name}</span>
            <span className="mx-1 text-zinc-500">→</span>
            <span className="font-semibold">{dryRun.target.name}</span>
          </p>

          <div className="grid gap-3 md:grid-cols-2">
            <SideSummary title="統合元（消える側）" side={dryRun.source} />
            <SideSummary title="統合先（残す側）" side={dryRun.target} />
          </div>

          <div className="space-y-0.5">
            <p className="text-zinc-500">付け替えられるデータ</p>
            {dryRun.reassign.map((row) => (
              <div key={row.key} className="flex justify-between gap-3">
                <span className="text-zinc-500">
                  {row.label}
                  <span className="ml-1 font-mono text-[10px] text-zinc-600">
                    {row.key}
                  </span>
                </span>
                <span className="font-mono text-zinc-300">{row.count}</span>
              </div>
            ))}
            <div className="flex justify-between gap-3 border-t border-white/[0.06] pt-1">
              <span className="text-zinc-400">合計</span>
              <span className="font-mono font-semibold text-zinc-100">
                {dryRun.reassignTotal}
              </span>
            </div>
            <p className="pt-1 text-[10px] text-zinc-600">
              名称変更履歴（master_name_change_logs）は当時の記録として残すため付け替えません。
            </p>
          </div>

          {dryRun.collisions.length > 0 ? (
            <div className="rounded border border-red-500/25 bg-red-500/10 p-2 text-red-200">
              <p className="font-semibold">統合すると報酬明細が衝突します</p>
              {dryRun.collisions.map((collision) => (
                <div key={collision.table} className="mt-1">
                  <p className="font-mono text-[10px]">
                    {collision.table}: {collision.count} 件
                  </p>
                  <p className="text-[10px] leading-relaxed text-red-200/80">
                    {collision.description}
                  </p>
                  {collision.samples.length > 0 ? (
                    <p className="break-all font-mono text-[10px] text-red-200/70">
                      {collision.samples.join(", ")}
                    </p>
                  ) : null}
                </div>
              ))}
              <p className="mt-1 text-[10px] text-red-200/80">
                合算・削除・再計算は自動で行いません。
              </p>
            </div>
          ) : null}

          <div className="space-y-1 rounded border border-cyan-500/25 bg-cyan-500/[0.07] p-2 text-[10px] leading-relaxed text-cyan-100">
            <p className="font-semibold">旧紹介コードの転送（alias）</p>
            {dryRun.aliasPlan.aliasTableReady ? (
              <>
                <p>
                  転送元（統合元の旧コード）:{" "}
                  <span className="font-mono">
                    {dryRun.aliasPlan.sourceCode ?? "（なし）"}
                  </span>
                </p>
                <p>
                  転送先（統合先 referrer_id）:{" "}
                  <span className="font-mono">{dryRun.target.id}</span>
                  {dryRun.aliasPlan.keptCode ? (
                    <>
                      {" / 統合先の正規コード "}
                      <span className="font-mono">{dryRun.aliasPlan.keptCode}</span>
                    </>
                  ) : null}
                </p>
                {dryRun.aliasPlan.inheritedCodes.length > 0 ? (
                  <p>
                    引き継ぐ既存の旧コード:{" "}
                    <span className="font-mono">
                      {dryRun.aliasPlan.inheritedCodes.join(", ")}
                    </span>
                  </p>
                ) : null}
                <p className="text-cyan-200/70">
                  コードはどちらも削除しません。alias は転送先を示すだけで、クリエイター紐付けと紹介報酬は必ず統合先
                  referrer_id 側に作られます。
                </p>
              </>
            ) : (
              <p className="text-amber-200">
                referrer_code_aliases が未適用のため転送を作成できません。migration
                を適用するまで統合は実行できません。
              </p>
            )}
          </div>

          {dryRun.warnings.length > 0 ? (
            <ul className="space-y-1 rounded border border-amber-500/25 bg-amber-500/10 p-2 text-[10px] leading-relaxed text-amber-100">
              {dryRun.warnings.map((warning) => (
                <li key={warning}>・{warning}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* ③ 最終確認 → ④ 実行 */}
      {state?.ok && dryRunMatches && dryRun?.canMerge ? (
        <form
          action={formAction}
          className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.08] p-3"
        >
          <input type="hidden" name="source_referrer_id" value={source.id} />
          <input type="hidden" name="target_referrer_id" value={targetId} />
          <input type="hidden" name="confirm" value="1" />
          <p className="text-[11px] font-semibold text-amber-100">
            「{dryRun.source.name}」を「{dryRun.target.name}」へ統合します。
            この操作は {dryRun.reassignTotal} 件のデータを書き換えます。
          </p>
          <p className="text-[10px] leading-relaxed text-amber-200/80">
            クリエイター紐付け・紹介リンク・紹介報酬明細・支払レコードが統合先へ移ります。
            旧紹介コードは転送設定として保存され、統合元は「無効」になります（行は残るので過去の履歴から名前を引けます）。
            以上すべてを1トランザクションで実行し、途中で失敗した場合は元の状態へ戻します。
            成功後に元へ戻すには手作業が必要です。
          </p>
          <label className="flex items-start gap-2 text-[10px] leading-relaxed text-amber-100">
            <input
              type="checkbox"
              checked={finalConfirmed}
              onChange={(e) => setFinalConfirmed(e.target.checked)}
              className="mt-0.5"
            />
            上記2名が同一人物であることを確認しました（③ 最終確認）
          </label>
          <button
            type="submit"
            disabled={pending || !canExecute}
            className="min-h-[36px] rounded-lg bg-amber-400 px-4 text-xs font-semibold text-zinc-950 transition hover:bg-amber-300 disabled:opacity-40"
          >
            {pending ? "統合中…" : "④ 統合を実行する"}
          </button>
        </form>
      ) : null}
    </div>
  );
}

/** 無効化 / 有効化 */
function ActiveToggle({ row }: { row: ReferrerMaintenanceRow }) {
  const [state, formAction, pending] = useActionState<
    ReferrerMaintenanceResult | null,
    FormData
  >(setReferrerActiveAction, null);

  return (
    <form action={formAction} className="inline">
      <input type="hidden" name="referrer_id" value={row.id} />
      <input type="hidden" name="next_active" value={row.isActive ? "0" : "1"} />
      <button
        type="submit"
        disabled={pending}
        className="rounded border border-white/[0.1] px-2.5 py-1 text-[11px] text-zinc-200 transition hover:bg-white/[0.06] disabled:opacity-50"
        title={
          row.isActive
            ? "新規の紹介者選択と紹介リンク /ref/コード が無効になります。過去の報酬・支払履歴は残ります。"
            : "紹介者選択と紹介リンクが再び有効になります。"
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
function DeleteButton({ row }: { row: ReferrerMaintenanceRow }) {
  const [confirmed, setConfirmed] = useState(false);
  const [state, formAction, pending] = useActionState<
    ReferrerMaintenanceResult | null,
    FormData
  >(deleteReferrerAction, null);

  return (
    <form action={formAction} className="space-y-1">
      <input type="hidden" name="referrer_id" value={row.id} />
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

export function ReferrerMaintenanceSection({
  data,
}: {
  data: ReferrerMaintenanceData;
}) {
  const [openMergeId, setOpenMergeId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [onlyDuplicates, setOnlyDuplicates] = useState(false);
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");

  const duplicateIds = useMemo(() => {
    const ids = new Set<string>();
    for (const group of data.duplicateGroups) {
      group.referrerIds.forEach((id) => ids.add(id));
    }
    return ids;
  }, [data.duplicateGroups]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return data.rows.filter((row) => {
      if (onlyDuplicates && !duplicateIds.has(row.id)) return false;
      if (stateFilter === "active" && !row.isActive) return false;
      if (stateFilter === "inactive" && row.isActive) return false;
      if (!q) return true;
      return (
        row.name.toLowerCase().includes(q) ||
        (row.referralCode?.toLowerCase().includes(q) ?? false) ||
        (row.email?.toLowerCase().includes(q) ?? false) ||
        row.id.includes(q)
      );
    });
  }, [data.rows, duplicateIds, onlyDuplicates, search, stateFilter]);

  const deletableCount = data.rows.filter((row) => row.canDelete).length;
  const mergedSourceCount = data.rows.filter((row) => row.isMergedSource).length;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-200">紹介者マスタ 整理</h2>
          <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
            名称編集・統合・無効化・削除をここで行います。統合は
            「残す紹介者を選択 → 統合内容を確認（DRY RUN）→ 影響内容の表示 → 最終確認 → 実行」
            の順で進み、削除は参照が全て0のときだけ可能です。
            統合しても統合元は無効化されて残るため、紹介者総数は減りません。
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-amber-200/80">
            重複「候補」は表示するだけで、自動統合は一切行いません。同姓同名の可能性があるため、
            同一人物かどうかは必ず管理者が判断してください。
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-amber-200/80">
            creator_referrals / 紹介者報酬明細 / 支払レコードは ON DELETE CASCADE
            のため、参照が残ったまま削除すると報酬データが道連れで消えます。
            また統合元として使われた紹介者は、統合の証跡と旧紹介コードの転送元を保持するため
            物理削除できません（無効のまま残ります）。
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor="referrer-maint-search" className="text-[11px] text-zinc-500">
              検索
            </label>
            <input
              id="referrer-maint-search"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="紹介者名 / コード / メール / referrer_id"
              className="mt-1 w-64 rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-cyan-700"
            />
          </div>
          <label className="flex min-h-[38px] cursor-pointer items-center gap-2 rounded-lg border border-white/[0.08] bg-surface-1 px-3 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={onlyDuplicates}
              onChange={(e) => setOnlyDuplicates(e.target.checked)}
            />
            重複候補のみ
          </label>
          <div>
            <label htmlFor="referrer-maint-state" className="text-[11px] text-zinc-500">
              状態
            </label>
            <select
              id="referrer-maint-state"
              value={stateFilter}
              onChange={(e) => setStateFilter(e.target.value as StateFilter)}
              className="mt-1 min-h-[38px] rounded-lg border border-white/[0.08] bg-surface-1 px-3 text-sm text-zinc-100"
            >
              <option value="all">すべて</option>
              <option value="active">有効のみ</option>
              <option value="inactive">無効のみ（統合済みなど）</option>
            </select>
          </div>
        </div>
      </div>

      {data.notice ? (
        <p className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-100">
          {data.notice}
        </p>
      ) : null}

      {/*
        統合しても統合元は is_active=false で残るため総数は減らない。
        「総数 / 有効 / 無効」を並べて、整理が進んだことが分かるようにする。
      */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        {[
          { label: "紹介者総数", value: data.totals.total },
          { label: "● 有効", value: data.totals.activeCount },
          { label: "○ 無効", value: data.totals.inactiveCount },
          { label: "⚠ 重複候補（組）", value: data.totals.duplicateGroupCount },
          { label: "🔗 統合済み", value: mergedSourceCount },
          { label: "🗑 削除可能", value: deletableCount },
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

      <p className="text-[11px] text-zinc-500">
        重複候補の内訳: A 高確度 {data.totals.highCount} 組 / B 要確認{" "}
        {data.totals.mediumCount} 組 / C 低確度 {data.totals.lowCount} 組
      </p>

      {/* 重複候補（危険度別カード） */}
      <ReferrerDuplicateGroups
        groups={data.duplicateGroups}
        rows={data.rows}
        search={search}
      />

      <div className="overflow-x-auto rounded-xl border border-zinc-800">
        <table className="w-full min-w-[1340px] text-sm">
          <thead>
            <tr>
              <th className={`${thBase} min-w-[200px]`}>紹介者名</th>
              <th className={thBase}>紹介コード</th>
              <th className={thBase}>状態</th>
              <th className={`${thBase} text-right`}>紐付けCR</th>
              <th className={`${thBase} text-right`}>紹介リンク</th>
              <th className={`${thBase} text-right`}>報酬明細</th>
              <th className={`${thBase} text-right`}>報酬額</th>
              <th className={`${thBase} text-right`}>支払済</th>
              <th className={`${thBase} text-right`}>支払レコード</th>
              <th className={`${thBase} text-right`}>参照合計</th>
              <th className={`${thBase} min-w-[320px]`}>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-zinc-800/60 align-top">
                <td className={`${td} font-medium text-zinc-100`}>
                  {row.name}
                  <p className="break-all font-mono text-[10px] font-normal text-zinc-600">
                    {row.id}
                  </p>
                  {row.email ? (
                    <p className="text-[10px] font-normal text-zinc-600">{row.email}</p>
                  ) : null}
                </td>
                <td className={`${td} font-mono text-zinc-400`}>
                  {row.referralCode ?? "—"}
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
                    {row.mergeBlockedByPaidData ? (
                      <span className="rounded-full border border-red-400/25 bg-red-400/10 px-2 py-0.5 text-[11px] text-red-200">
                        🔒 支払済
                      </span>
                    ) : null}
                    {row.canDelete ? (
                      <span className="rounded-full border border-red-400/25 bg-red-400/10 px-2 py-0.5 text-[11px] text-red-200">
                        🗑 削除可能
                      </span>
                    ) : null}
                    {row.isMergedSource ? (
                      <span
                        className="rounded-full border border-violet-400/25 bg-violet-400/10 px-2 py-0.5 text-[11px] text-violet-200"
                        title="過去に統合元として使われた紹介者です。統合の証跡と旧紹介コードの転送元を保持するため、物理削除はできません。"
                      >
                        🔗 統合済み（削除不可）
                      </span>
                    ) : null}
                    {row.hasLogin ? (
                      <span className="rounded-full border border-cyan-400/25 bg-cyan-400/10 px-2 py-0.5 text-[11px] text-cyan-200">
                        ログイン有
                      </span>
                    ) : null}
                  </div>
                </td>
                <td className={`${td} text-right font-mono text-zinc-300`}>
                  {row.creatorCount}
                </td>
                <td className={`${td} text-right font-mono text-zinc-400`}>
                  {row.activeLinkCount}
                </td>
                <td className={`${td} text-right font-mono text-zinc-400`}>
                  {row.rewardItemCount}
                </td>
                <td className={`${td} text-right font-mono text-zinc-300`}>
                  {formatYenPrecise(row.rewardAmount)}
                </td>
                <td
                  className={`${td} text-right font-mono ${
                    row.paidRewardItemCount > 0 ? "text-amber-200" : "text-zinc-500"
                  }`}
                >
                  {row.paidRewardItemCount}
                </td>
                <td className={`${td} text-right font-mono text-zinc-400`}>
                  {row.payoutCount}
                </td>
                <td className={`${td} text-right font-mono text-zinc-200`}>
                  {row.totalReferences}
                </td>
                <td className="space-y-2 px-3 py-2">
                  <div className="flex flex-wrap items-start gap-2">
                    <MasterNameEditor
                      targetType="referrer"
                      targetId={row.id}
                      currentName={row.name}
                      impacts={row.references
                        .filter((item) => item.count > 0)
                        .map((item) => ({ label: item.label, value: item.count }))}
                      extraNote="紹介者コードと紹介リンクは変更されません。"
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

                  {row.isMergedSource ? (
                    <p className="text-[10px] text-violet-300/80">
                      統合元として使われたため物理削除はできません。統合の証跡と旧紹介コードの転送元を残す必要があるので、無効のまま保持してください。
                    </p>
                  ) : !row.canDelete ? (
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
            ))}
          </tbody>
        </table>
      </div>

      <div className="rounded-xl border border-white/[0.06] bg-surface-1/40 p-3 text-[11px] leading-relaxed text-zinc-500">
        <h3 className="text-xs font-semibold text-zinc-300">
          支払済みデータがある紹介者を整理したい場合
        </h3>
        <p className="mt-1">
          支払済みの明細・支払レコードは「いつ・誰に・いくら払ったか」の証跡のため、統合で
          referrer_id を書き換えると過去の支払額が別人の実績として集計されます。
          そのため通常の統合ボタンでは実行できません。次の順序を推奨します。
        </p>
        <ol className="mt-1 list-inside list-decimal space-y-0.5">
          <li>重複側（今後使わない方）を「無効化」して、新規登録と紹介リンクを止める</li>
          <li>
            未払分だけを対象に、クリエイターの紐付けを「クリエイターマスタ一括編集」で残す側へ変更する
          </li>
          <li>「売上・報酬 › 紹介者報酬」で再集計し、以降の報酬が残す側に付くことを確認する</li>
          <li>
            支払済みの明細は統合元に残したままにする（過去の支払証跡として保持）。年間累計の
            1,000円しきい値は referrer_id 単位で判定されるため、合算が必要な場合は別途相談
          </li>
        </ol>
      </div>

      {data.nameChangeLogs.length > 0 ? (
        <div className="rounded-xl border border-white/[0.06] bg-surface-1/40 p-3">
          <h3 className="text-xs font-semibold text-zinc-300">紹介者名の変更履歴</h3>
          <ul className="mt-2 space-y-1 text-[11px] text-zinc-400">
            {data.nameChangeLogs.map((log) => (
              <li key={log.id}>
                <span className="font-mono text-zinc-500">
                  {new Date(log.createdAt).toLocaleString("ja-JP")}
                </span>{" "}
                {log.fromName ?? "（不明）"} →{" "}
                <span className="text-zinc-200">{log.toName}</span>
                {log.changedByEmail ? (
                  <span className="ml-2 text-zinc-600">{log.changedByEmail}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {data.logs.length > 0 ? (
        <div className="rounded-xl border border-white/[0.06] bg-surface-1/40 p-3">
          <h3 className="text-xs font-semibold text-zinc-300">整理履歴（統合 / 削除 / 無効化）</h3>
          <ul className="mt-2 space-y-1 text-[11px] text-zinc-400">
            {data.logs.map((log) => (
              <li key={log.id}>
                <span className="font-mono text-zinc-500">
                  {new Date(log.createdAt).toLocaleString("ja-JP")}
                </span>{" "}
                <span className="text-zinc-300">
                  {log.action === "merge"
                    ? `統合: ${log.referrerName} → ${log.targetReferrerName ?? "?"}（${log.affectedTotal}件 / 旧コード ${log.sourceReferralCode ?? "—"} → 残したコード ${log.keptReferralCode ?? "—"}）`
                    : log.action === "delete"
                      ? `削除: ${log.referrerName}（コード ${log.sourceReferralCode ?? "—"}）`
                      : log.action === "deactivate"
                        ? `無効化: ${log.referrerName}`
                        : `有効化: ${log.referrerName}`}
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
