"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  mergeReferrerAction,
  type ReferrerMaintenanceResult,
} from "@/app/actions/referrer-maintenance";
import {
  REFERRER_DUPLICATE_CONFIDENCE_LABEL,
  REFERRER_DUPLICATE_CONFIDENCE_NOTE,
  REFERRER_DUPLICATE_REASON_LABEL,
  type ReferrerDuplicateConfidence,
  type ReferrerDuplicateGroup,
  type ReferrerMaintenanceRow,
  type ReferrerMergeDryRunResult,
} from "@/lib/db/referrer-maintenance-queries";
import { formatYenPrecise } from "@/lib/revenue/calc";

/*
  重複候補の整理カード。

  ■ ここは表示と操作導線だけ
  統合の実処理は既存の mergeReferrerAction（→ merge_referrer RPC）をそのまま呼ぶ。
  安全チェック・DRY RUN・トランザクションはサーバー側の実装を一切変えていない。

  ■ 操作の流れ（誤クリックで統合できないようにする）
    ① 残す紹介者を選ぶ（自動では決めない）
    ② 統合元を選ぶ（3ID以上のケースに対応）
    ③「統合内容を確認」→ DRY RUN
    ④ 影響内容の表示
    ⑤ 最終確認のチェック
    ⑥ 統合実行

  ■ 3件以上の重複
  RPC は 1回につき 1組しか統合しない。
  複数の統合元を選んだ場合は「1件ずつ順番に」実行し、
  1件でも失敗したらそこで中断して後続を実行しない。
*/

const CONFIDENCE_STYLE: Record<ReferrerDuplicateConfidence, string> = {
  high: "border-emerald-400/25 bg-emerald-400/[0.06]",
  medium: "border-amber-400/25 bg-amber-400/[0.06]",
  low: "border-zinc-600/40 bg-white/[0.02]",
};

const CONFIDENCE_BADGE: Record<ReferrerDuplicateConfidence, string> = {
  high: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
  medium: "border-amber-400/30 bg-amber-400/10 text-amber-200",
  low: "border-zinc-500/30 bg-white/[0.04] text-zinc-400",
};

/** referrer_id は長いので先頭8桁だけ出し、全文はコピーできるようにする */
function IdChip({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      title={`クリックで referrer_id をコピー: ${id}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(id);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          // クリップボードが使えない環境では title の全文表示で代替する
          setCopied(false);
        }
      }}
      className="rounded border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-zinc-400 transition hover:bg-white/[0.08]"
    >
      {copied ? "コピーしました" : `${id.slice(0, 8)}… ⧉`}
    </button>
  );
}

function MetricRow({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-zinc-500">{label}</dt>
      <dd className={`font-mono ${strong ? "text-zinc-100" : "text-zinc-300"}`}>
        {value}
      </dd>
    </div>
  );
}

/** 1人分の比較カード */
function ReferrerCompareCard({
  row,
  isKeeper,
  isMergeSource,
  hasMostRecords,
  disabled,
  onSelectKeeper,
  onToggleSource,
}: {
  row: ReferrerMaintenanceRow;
  isKeeper: boolean;
  isMergeSource: boolean;
  hasMostRecords: boolean;
  disabled: boolean;
  onSelectKeeper: () => void;
  onToggleSource: () => void;
}) {
  return (
    <div
      className={`flex flex-col gap-2 rounded-lg border p-3 ${
        isKeeper
          ? "border-cyan-400/40 bg-cyan-400/[0.07]"
          : isMergeSource
            ? "border-amber-400/30 bg-amber-400/[0.05]"
            : "border-white/[0.08] bg-surface-0/50"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-zinc-100" title={row.name}>
            {row.name}
          </p>
          <p className="mt-0.5 font-mono text-[10px] text-zinc-500">
            {row.referralCode ?? "コードなし"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {hasMostRecords ? (
            <span
              className="rounded-full border border-cyan-400/25 bg-cyan-400/10 px-1.5 py-0.5 text-[10px] text-cyan-200"
              title="報酬明細または紐付けクリエイターが最も多い紹介者です。統合先の自動決定はしません。参考情報です。"
            >
              実績が多い
            </span>
          ) : null}
          <span
            className={`rounded-full border px-1.5 py-0.5 text-[10px] ${
              row.isActive
                ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-300"
                : "border-white/[0.08] bg-white/[0.03] text-zinc-500"
            }`}
          >
            {row.isActive ? "有効" : "無効"}
          </span>
          {row.mergeBlockedByPaidData ? (
            <span className="rounded-full border border-red-400/25 bg-red-400/10 px-1.5 py-0.5 text-[10px] text-red-200">
              支払済
            </span>
          ) : null}
        </div>
      </div>

      <IdChip id={row.id} />

      <dl className="space-y-0.5 text-[11px]">
        <MetricRow label="紐付けCR" value={`${row.creatorCount} 名`} strong />
        <MetricRow
          label="creator_referrals"
          value={`${row.references.find((r) => r.table === "creator_referrals")?.count ?? 0} 件（有効 ${row.activeLinkCount}）`}
        />
        <MetricRow label="報酬明細" value={`${row.rewardItemCount} 件`} strong />
        <MetricRow label="紹介報酬総額" value={formatYenPrecise(row.rewardAmount)} />
        <MetricRow label="支払レコード" value={`${row.payoutCount} 件`} />
        <MetricRow
          label="支払済み"
          value={
            row.paidRewardItemCount > 0 || row.paidPayoutCount > 0
              ? `あり（明細 ${row.paidRewardItemCount} / 確定 ${row.paidPayoutCount}）`
              : "なし"
          }
        />
      </dl>

      <div className="mt-auto space-y-1 border-t border-white/[0.06] pt-2">
        <label className="flex cursor-pointer items-center gap-2 text-[11px] text-zinc-200">
          <input
            type="radio"
            checked={isKeeper}
            disabled={disabled}
            onChange={onSelectKeeper}
          />
          この紹介者を残す
        </label>
        {!isKeeper ? (
          <label className="flex cursor-pointer items-center gap-2 text-[11px] text-amber-200/90">
            <input
              type="checkbox"
              checked={isMergeSource}
              disabled={disabled || row.mergeBlockedByPaidData}
              onChange={onToggleSource}
            />
            この紹介者を統合元にする
            {row.mergeBlockedByPaidData ? (
              <span className="text-[10px] text-red-300">（支払済のため不可）</span>
            ) : null}
          </label>
        ) : null}
      </div>
    </div>
  );
}

/** DRY RUN の影響内容 */
function DryRunImpact({ dryRun }: { dryRun: ReferrerMergeDryRunResult }) {
  const count = (key: string) =>
    dryRun.reassign.find((row) => row.key === key)?.count ?? 0;

  const rows: Array<[string, string]> = [
    ["統合元", `${dryRun.source.name}（${dryRun.source.referralCode ?? "コードなし"}）`],
    ["統合先", `${dryRun.target.name}（${dryRun.target.referralCode ?? "コードなし"}）`],
    ["移動するクリエイター", `${count("creators.referred_by_referrer_id")} 名`],
    ["移動する creator_referrals", `${count("creator_referrals.referrer_id")} 件`],
    ["移動する報酬明細", `${count("referral_reward_items.referrer_id")} 件`],
    ["移動する payout", `${count("referral_payouts.referrer_id")} 件`],
    [
      "旧紹介コード → 統合先",
      dryRun.aliasPlan.sourceCode
        ? `${dryRun.aliasPlan.sourceCode} → ${dryRun.target.id.slice(0, 8)}…（正規コード ${dryRun.aliasPlan.keptCode ?? "なし"}）`
        : "統合元に紹介コードなし",
    ],
    ["衝突件数", `${dryRun.collisions.reduce((sum, c) => sum + c.count, 0)} 件`],
    [
      "支払済み",
      dryRun.source.paidRewardItemCount > 0 || dryRun.source.paidPayoutCount > 0
        ? `あり（明細 ${dryRun.source.paidRewardItemCount} / 確定 ${dryRun.source.paidPayoutCount}）`
        : "なし",
    ],
  ];

  return (
    <div className="space-y-2 rounded-lg border border-white/[0.08] bg-surface-0/60 p-3 text-[11px]">
      <p className="font-semibold text-zinc-200">
        DRY RUN の結果（この時点ではDBを変更していません）
      </p>
      <dl className="space-y-0.5">
        {rows.map(([label, value]) => (
          <MetricRow key={label} label={label} value={value} />
        ))}
        <div className="flex justify-between gap-2 border-t border-white/[0.06] pt-1">
          <dt className="text-zinc-400">付け替え合計</dt>
          <dd className="font-mono font-semibold text-zinc-100">
            {dryRun.reassignTotal} 件
          </dd>
        </div>
      </dl>

      {dryRun.collisions.length > 0 ? (
        <div className="rounded border border-red-500/25 bg-red-500/10 p-2 text-red-200">
          <p className="font-semibold">統合すると報酬明細が衝突します</p>
          {dryRun.collisions.map((collision) => (
            <p key={collision.table} className="mt-1 text-[10px] leading-relaxed">
              [{collision.table}] {collision.count} 件 — {collision.description}
            </p>
          ))}
        </div>
      ) : null}

      {dryRun.warnings.length > 0 ? (
        <ul className="space-y-0.5 rounded border border-amber-500/25 bg-amber-500/10 p-2 text-[10px] leading-relaxed text-amber-100">
          {dryRun.warnings.map((warning) => (
            <li key={warning}>・{warning}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

type StepResult = {
  sourceId: string;
  sourceName: string;
  result: ReferrerMaintenanceResult;
};

/** 重複グループ1組分のカード */
function DuplicateGroupCard({
  group,
  members,
}: {
  group: ReferrerDuplicateGroup;
  members: ReferrerMaintenanceRow[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [keeperId, setKeeperId] = useState<string | null>(null);
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [steps, setSteps] = useState<StepResult[] | null>(null);
  const [finalConfirmed, setFinalConfirmed] = useState(false);
  const [executed, setExecuted] = useState(false);

  /* 参考バッジ用。統合先の自動決定はしない */
  const mostRecordsIds = useMemo(() => {
    const maxItems = Math.max(...members.map((row) => row.rewardItemCount));
    const maxCreators = Math.max(...members.map((row) => row.creatorCount));
    return new Set(
      members
        .filter(
          (row) =>
            (maxItems > 0 && row.rewardItemCount === maxItems) ||
            (maxCreators > 0 && row.creatorCount === maxCreators),
        )
        .map((row) => row.id),
    );
  }, [members]);

  const resetFlow = () => {
    setSteps(null);
    setFinalConfirmed(false);
    setExecuted(false);
  };

  const selectKeeper = (id: string) => {
    setKeeperId(id);
    setSourceIds((prev) => prev.filter((sourceId) => sourceId !== id));
    resetFlow();
  };

  const toggleSource = (id: string) => {
    setSourceIds((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id],
    );
    resetFlow();
  };

  /*
    DRY RUN も実行も同じ mergeReferrerAction を使う。
    confirm を付けなければサーバー側は DRY RUN だけ返す（DBは変更されない）。
    複数の統合元は1件ずつ順番に処理し、失敗したらそこで中断する。
  */
  const run = (confirm: boolean) => {
    if (!keeperId || sourceIds.length === 0) return;

    startTransition(async () => {
      const collected: StepResult[] = [];

      for (const sourceId of sourceIds) {
        const formData = new FormData();
        formData.set("source_referrer_id", sourceId);
        formData.set("target_referrer_id", keeperId);
        if (confirm) formData.set("confirm", "1");

        const result = await mergeReferrerAction(null, formData);
        collected.push({
          sourceId,
          sourceName: members.find((row) => row.id === sourceId)?.name ?? sourceId,
          result,
        });

        // 1件目が失敗したら後続は実行しない
        if (!result.ok) break;
      }

      setSteps(collected);
      if (confirm) {
        setExecuted(true);
        setFinalConfirmed(false);
        // 統合後は総数・有効/無効・重複候補を取り直す
        router.refresh();
      }
    });
  };

  const dryRunSteps = steps ?? [];
  const allDryRunOk =
    !executed && dryRunSteps.length > 0 && dryRunSteps.every((step) => step.result.ok);
  const canExecute = allDryRunOk && finalConfirmed && !pending;
  const keeper = members.find((row) => row.id === keeperId) ?? null;

  return (
    <div className={`space-y-3 rounded-xl border p-3 ${CONFIDENCE_STYLE[group.confidence]}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${CONFIDENCE_BADGE[group.confidence]}`}
        >
          {REFERRER_DUPLICATE_CONFIDENCE_LABEL[group.confidence]}
        </span>
        <span className="text-[10px] text-zinc-400">
          {group.reasons
            .map((reason) => REFERRER_DUPLICATE_REASON_LABEL[reason])
            .join(" / ")}
        </span>
        <span className="text-[10px] text-zinc-600">{members.length} ID</span>
      </div>

      <div
        className={`grid gap-2 ${
          members.length >= 3 ? "md:grid-cols-3" : "md:grid-cols-2"
        }`}
      >
        {members.map((row) => (
          <ReferrerCompareCard
            key={row.id}
            row={row}
            isKeeper={row.id === keeperId}
            isMergeSource={sourceIds.includes(row.id)}
            hasMostRecords={mostRecordsIds.has(row.id)}
            disabled={pending}
            onSelectKeeper={() => selectKeeper(row.id)}
            onToggleSource={() => toggleSource(row.id)}
          />
        ))}
      </div>

      {/* ①② 選択状況 */}
      <div className="rounded-lg border border-white/[0.06] bg-surface-1/40 px-3 py-2 text-[11px]">
        {keeper ? (
          <p className="text-zinc-300">
            残す: <span className="font-semibold text-cyan-200">{keeper.name}</span>
            <span className="mx-2 text-zinc-600">／</span>
            統合元:{" "}
            <span className="font-semibold text-amber-200">
              {sourceIds.length > 0
                ? sourceIds
                    .map((id) => members.find((row) => row.id === id)?.name ?? id)
                    .join(", ")
                : "未選択"}
            </span>
            {sourceIds.length > 1 ? (
              <span className="ml-2 text-[10px] text-zinc-500">
                （1件ずつ順番に実行し、失敗した時点で中断します）
              </span>
            ) : null}
          </p>
        ) : (
          <p className="text-zinc-500">
            ① まず「この紹介者を残す」を選んでください。統合先を自動では決めません。
          </p>
        )}
      </div>

      {/* ③ DRY RUN */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={pending || !keeperId || sourceIds.length === 0}
          onClick={() => run(false)}
          className="min-h-[34px] rounded-lg border border-white/[0.12] px-3 text-[11px] font-medium text-zinc-100 transition hover:bg-white/[0.06] disabled:opacity-40"
        >
          {pending && !executed ? "確認中…" : "③ 統合内容を確認（DRY RUN）"}
        </button>
        {steps ? (
          <button
            type="button"
            onClick={resetFlow}
            className="text-[11px] text-zinc-500 hover:text-zinc-300"
          >
            結果をクリア
          </button>
        ) : null}
      </div>

      {/* ④ 影響内容 */}
      {dryRunSteps.map((step) => (
        <div key={step.sourceId} className="space-y-2">
          <p
            className={`rounded-lg border px-3 py-2 text-[11px] leading-relaxed ${
              step.result.ok
                ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-200"
                : "border-red-500/25 bg-red-500/10 text-red-200"
            }`}
            role="status"
          >
            <span className="font-semibold">{step.sourceName}:</span>{" "}
            {step.result.ok ? step.result.message : step.result.error}
          </p>
          {step.result.dryRun ? <DryRunImpact dryRun={step.result.dryRun} /> : null}
        </div>
      ))}

      {dryRunSteps.length > 0 &&
      dryRunSteps.length < sourceIds.length &&
      !dryRunSteps.every((step) => step.result.ok) ? (
        <p className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-100">
          失敗したため、残り {sourceIds.length - dryRunSteps.length} 件は実行していません。
        </p>
      ) : null}

      {/* ⑤⑥ 最終確認 → 実行 */}
      {allDryRunOk ? (
        <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.08] p-3">
          <p className="text-[11px] font-semibold text-amber-100">
            ⑤ 最終確認: {sourceIds.length} 件を「{keeper?.name}」へ統合します。
          </p>
          <p className="text-[10px] leading-relaxed text-amber-200/80">
            統合元は is_active=false になり、旧紹介コードは統合先へ転送されます。
            行は残るので過去の報酬・支払履歴・統合履歴・名称変更履歴から名前を引けます。
          </p>
          <label className="flex items-start gap-2 text-[10px] leading-relaxed text-amber-100">
            <input
              type="checkbox"
              checked={finalConfirmed}
              onChange={(e) => setFinalConfirmed(e.target.checked)}
              className="mt-0.5"
            />
            上記が同一人物であることを確認しました
          </label>
          <button
            type="button"
            disabled={!canExecute}
            onClick={() => run(true)}
            className="min-h-[34px] rounded-lg bg-amber-400 px-4 text-[11px] font-semibold text-zinc-950 transition hover:bg-amber-300 disabled:opacity-40"
          >
            {pending ? "統合中…" : "⑥ 統合を実行する"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** 確度ごとの折りたたみセクション */
function ConfidenceSection({
  confidence,
  groups,
  rowById,
  defaultOpen,
}: {
  confidence: ReferrerDuplicateConfidence;
  groups: ReferrerDuplicateGroup[];
  rowById: Map<string, ReferrerMaintenanceRow>;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="rounded-xl border border-white/[0.07] bg-surface-1/40">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <span className="flex flex-wrap items-center gap-2">
          <span
            className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${CONFIDENCE_BADGE[confidence]}`}
          >
            {REFERRER_DUPLICATE_CONFIDENCE_LABEL[confidence]}
          </span>
          <span className="font-mono text-sm text-zinc-200">{groups.length} 組</span>
          <span className="text-[10px] text-zinc-500">
            {REFERRER_DUPLICATE_CONFIDENCE_NOTE[confidence]}
          </span>
        </span>
        <span className="shrink-0 text-xs text-zinc-500">{open ? "▲ 閉じる" : "▼ 開く"}</span>
      </button>

      {open ? (
        <div className="space-y-3 border-t border-white/[0.06] p-3">
          {groups.length === 0 ? (
            <p className="py-4 text-center text-[11px] text-zinc-600">
              該当する候補はありません。
            </p>
          ) : (
            groups.map((group) => {
              const members = group.referrerIds
                .map((id) => rowById.get(id))
                .filter((row): row is ReferrerMaintenanceRow => Boolean(row));
              if (members.length < 2) return null;
              return (
                <DuplicateGroupCard key={group.key} group={group} members={members} />
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}

export function ReferrerDuplicateGroups({
  groups,
  rows,
  search,
}: {
  groups: ReferrerDuplicateGroup[];
  rows: ReferrerMaintenanceRow[];
  /** 上部の検索ボックスと同じ文字列。候補カードも同時に絞り込む */
  search: string;
}) {
  const rowById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter((group) =>
      group.referrerIds.some((id) => {
        const row = rowById.get(id);
        if (!row) return false;
        return (
          row.name.toLowerCase().includes(q) ||
          (row.referralCode?.toLowerCase().includes(q) ?? false) ||
          (row.email?.toLowerCase().includes(q) ?? false) ||
          row.id.includes(q)
        );
      }),
    );
  }, [groups, rowById, search]);

  const byConfidence = (confidence: ReferrerDuplicateConfidence) =>
    filtered.filter((group) => group.confidence === confidence);

  if (groups.length === 0) {
    return (
      <p className="rounded-lg border border-white/[0.06] bg-surface-1/40 px-3 py-2 text-[11px] text-zinc-500">
        有効な紹介者に重複候補はありません。
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.05] px-4 py-3">
        <h3 className="text-xs font-semibold text-amber-100">
          ⚠ 重複候補 {filtered.length} 組
          {search.trim() ? `（検索絞り込み中 / 全 ${groups.length} 組）` : ""}
        </h3>
        <p className="mt-1 text-[10px] leading-relaxed text-amber-200/70">
          自動統合は一切しません。統合先も自動では決めません。「実績が多い」は参考バッジで、
          どちらを残すかは必ず管理者が選択してください。無効になった紹介者（統合済みの統合元）は候補に出ません。
        </p>
      </div>

      <ConfidenceSection
        confidence="high"
        groups={byConfidence("high")}
        rowById={rowById}
        defaultOpen
      />
      <ConfidenceSection
        confidence="medium"
        groups={byConfidence("medium")}
        rowById={rowById}
        defaultOpen={false}
      />
      <ConfidenceSection
        confidence="low"
        groups={byConfidence("low")}
        rowById={rowById}
        defaultOpen={false}
      />
    </div>
  );
}
