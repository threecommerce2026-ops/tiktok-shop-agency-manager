"use client";

import { useState, useTransition } from "react";

import {
  listRelationRepairCandidatesAction,
  previewRelationRepairAction,
  repairRelationAction,
  type RelationRepairActionResult,
} from "@/app/actions/repair-referral-relation";
import {
  describeRelationRepairBlocks,
  type RelationRepairCandidate,
  type RelationRepairPlan,
} from "@/lib/referrals/repair-invalid-inactive-relation";

/*
  有効期間を持たない無効 relation の修復パネル（管理者のみ）。

  ■ 何を直すのか
  紹介者の付け替えで end_month < start_month になった行の
  end_month を null へ戻すだけ。
  紹介者・開始月・他の関係・紹介報酬は変更しない。

  ■ プレビューを必ず経る
  一覧 → 対象を選ぶ → プレビュー（修復前後の解決結果とガード）→ 確定。
  確定時はサーバー側で plan を作り直すので、画面の値は信用されない。

  ■ 一括修復はしない
  紹介報酬の帰属が変わる操作なので、1 件ずつ確認して確定する。
*/

const th =
  "whitespace-nowrap border-b border-zinc-800 bg-surface-1/80 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-500";
const td = "whitespace-nowrap px-3 py-2 text-xs";

export function RelationRepairPanel() {
  const [rows, setRows] = useState<RelationRepairCandidate[] | null>(null);
  const [plan, setPlan] = useState<RelationRepairPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<RelationRepairActionResult | null>(null);
  const [isPending, startTransition] = useTransition();

  function load() {
    startTransition(async () => {
      setError(null);
      setPlan(null);
      const result = await listRelationRepairCandidatesAction();
      if (result.ok) setRows(result.rows);
      else setError(result.error);
    });
  }

  function preview(relationId: string) {
    startTransition(async () => {
      setError(null);
      setBanner(null);
      const result = await previewRelationRepairAction(relationId);
      if (result.ok) setPlan(result.plan);
      else setError(result.error);
    });
  }

  function apply(relationId: string) {
    startTransition(async () => {
      const formData = new FormData();
      formData.set("relation_id", relationId);
      const result = await repairRelationAction(null, formData);
      setBanner(result);
      if (result.ok) {
        setPlan(null);
        const reloaded = await listRelationRepairCandidatesAction();
        if (reloaded.ok) setRows(reloaded.rows);
      }
    });
  }

  const canApply =
    plan != null && plan.candidate != null && plan.blocks.length === 0;

  return (
    <section className="space-y-4 rounded-xl border border-white/[0.07] bg-surface-1/50 p-5">
      <div>
        <h2 className="text-sm font-semibold text-zinc-200">
          無効な紹介関係の修復
        </h2>
        <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
          紹介者を付け替えたときに
          <span className="text-zinc-300">終了月が開始月より前</span>
          になってしまった関係を直します。終了月を「なし」へ戻すだけで、
          紹介者・開始月・他の関係は変更しません。関係の行も削除しません。
          <br />
          この形の関係が残っていると、本来正しい関係まで
          「有効期間なし」と判定され、紹介報酬が発生しないことがあります。
        </p>
      </div>

      {banner ? (
        <p
          className={`rounded-lg border px-3 py-2 text-xs leading-relaxed ${
            banner.ok
              ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-200"
              : "border-red-500/25 bg-red-500/10 text-red-200"
          }`}
          role="status"
        >
          {banner.ok ? banner.message : banner.error}
        </p>
      ) : null}

      {error ? (
        <p className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          {error}
        </p>
      ) : null}

      <button
        type="button"
        onClick={load}
        disabled={isPending}
        className="rounded-lg border border-white/[0.14] px-3 py-2 text-xs text-zinc-200 transition hover:bg-white/[0.06] disabled:opacity-50"
      >
        {isPending && rows === null ? "読込中…" : "対象を一覧する"}
      </button>

      {rows !== null ? (
        rows.length === 0 ? (
          <p className="rounded-lg border border-zinc-800 py-6 text-center text-xs text-zinc-500">
            修復が必要な関係はありません。
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-zinc-800">
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr>
                  <th className={th}>TikTok ID</th>
                  <th className={th}>クリエイター</th>
                  <th className={th}>紹介者</th>
                  <th className={th}>開始月</th>
                  <th className={th}>終了月</th>
                  <th className={th}>状態</th>
                  <th className={th}>操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.relationId} className="border-b border-zinc-800/60">
                    <td className={`${td} font-mono text-zinc-200`}>{row.tiktokId}</td>
                    <td className={`${td} text-zinc-400`}>{row.creatorName || "—"}</td>
                    <td className={`${td} text-zinc-300`}>{row.referrerName ?? "(なし)"}</td>
                    <td className={`${td} font-mono text-zinc-300`}>{row.startMonth}</td>
                    <td className={`${td} font-mono text-red-300`}>{row.endMonth}</td>
                    <td className={`${td} text-[11px] text-zinc-500`}>無効（inactive）</td>
                    <td className={td}>
                      <button
                        type="button"
                        onClick={() => preview(row.relationId)}
                        disabled={isPending}
                        className="rounded border border-white/[0.14] px-2 py-1 text-[11px] text-zinc-200 transition hover:bg-white/[0.06] disabled:opacity-50"
                      >
                        修復内容を確認
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}

      {plan?.candidate ? (
        <div className="space-y-3 rounded-lg border border-cyan-500/20 bg-cyan-500/[0.04] p-4">
          <p className="text-xs font-semibold text-zinc-100">
            {plan.candidate.tiktokId} の修復内容
          </p>

          <div className="space-y-1 text-[11px] text-zinc-300">
            <p>
              紹介者 <span className="text-zinc-100">{plan.candidate.referrerName ?? "(なし)"}</span>
              {" / 開始月 "}
              <span className="font-mono">{plan.candidate.startMonth}</span>
            </p>
            <p>
              終了月{" "}
              <span className="font-mono text-red-300">{plan.candidate.endMonth}</span>
              {" → "}
              <span className="font-mono text-emerald-300">なし</span>
              <span className="ml-2 text-zinc-600">
                （紹介者・開始月は変更しません）
              </span>
            </p>
          </div>

          <div className="overflow-x-auto rounded-lg border border-white/[0.08]">
            <table className="w-full min-w-[420px] text-[11px]">
              <thead>
                <tr className="text-left text-zinc-500">
                  <th className="px-2 py-1 font-medium">対象月</th>
                  <th className="px-2 py-1 font-medium">修復前の紹介者</th>
                  <th className="px-2 py-1 font-medium">修復後の紹介者</th>
                </tr>
              </thead>
              <tbody>
                {plan.resolutionAfter.map((after, index) => {
                  const before = plan.resolutionBefore[index];
                  const changed = before?.referrerName !== after.referrerName;
                  return (
                    <tr key={after.targetMonth} className="border-t border-white/[0.05]">
                      <td className="px-2 py-1 font-mono text-zinc-300">
                        {after.targetMonth}
                      </td>
                      <td className="px-2 py-1 text-zinc-500">
                        {before?.referrerName ?? "(なし)"}
                      </td>
                      <td
                        className={`px-2 py-1 ${
                          changed ? "font-semibold text-emerald-300" : "text-zinc-400"
                        }`}
                      >
                        {after.referrerName ?? "(なし)"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {plan.blocks.length > 0 ? (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] leading-relaxed text-red-100">
              修復できません: {describeRelationRepairBlocks(plan)}
              {plan.finalizedMonths.length > 0
                ? `（確定済み: ${plan.finalizedMonths.join(", ")}）`
                : ""}
              {plan.paidItemCount > 0 ? `（支払済み明細 ${plan.paidItemCount} 件）` : ""}
              {plan.claimedItemCount > 0
                ? `（支払予定中 ${plan.claimedItemCount} 件）`
                : ""}
            </p>
          ) : (
            <p className="rounded-lg border border-white/[0.1] bg-surface-1/60 px-3 py-2 text-[11px] font-semibold text-zinc-200">
              この操作では紹介報酬・支払データは変更されません。確定後に
              「売上・報酬 › 紹介報酬」で差分を確認してから再集計してください。
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => apply(plan.candidate!.relationId)}
              disabled={isPending || !canApply}
              className="min-h-[40px] rounded-lg bg-white px-4 text-sm font-semibold text-zinc-950 transition hover:bg-zinc-200 disabled:opacity-40"
            >
              {isPending ? "修復中…" : "この内容で修復する"}
            </button>
            <button
              type="button"
              onClick={() => setPlan(null)}
              disabled={isPending}
              className="text-xs text-zinc-500 transition hover:text-zinc-300 disabled:opacity-40"
            >
              閉じる
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
