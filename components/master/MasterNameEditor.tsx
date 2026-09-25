"use client";

import { useActionState, useState } from "react";

import {
  renameAgencyAction,
  renameReferrerAction,
  type MasterNameActionResult,
} from "@/app/actions/master-name-edit";

/*
  マスタ名称の編集フォーム（代理店 / 紹介者 共通）。

  ・変更するのは同じ ID の表示名だけ。ID は変えない
  ・確定前に 変更前 / 変更後 / ID / 影響件数 を必ず表示する
  ・重複マスタの統合はこの機能では扱わない
*/

export type MasterImpactRow = { label: string; value: number };

export function MasterNameEditor({
  targetType,
  targetId,
  currentName,
  impacts,
  extraNote,
}: {
  targetType: "agency" | "referrer";
  targetId: string;
  currentName: string;
  impacts: MasterImpactRow[];
  extraNote?: string;
}) {
  const [open, setOpen] = useState(false);
  const [nextName, setNextName] = useState(currentName);

  const [state, formAction, pending] = useActionState<
    MasterNameActionResult | null,
    FormData
  >(targetType === "agency" ? renameAgencyAction : renameReferrerAction, null);

  const idFieldName = targetType === "agency" ? "agency_id" : "referrer_id";
  const label = targetType === "agency" ? "代理店名" : "紹介者名";
  const changed = nextName.trim() !== "" && nextName.trim() !== currentName;

  if (!open) {
    return (
      <>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded border border-white/[0.1] px-2.5 py-1 text-[11px] text-zinc-200 transition hover:bg-white/[0.06]"
        >
          名称編集
        </button>
        {state?.ok ? (
          <p className="mt-1 text-[11px] text-emerald-300">{state.message}</p>
        ) : null}
      </>
    );
  }

  return (
    <form action={formAction} className="space-y-3 rounded-xl border border-cyan-500/20 bg-cyan-500/[0.04] p-3">
      <input type="hidden" name={idFieldName} value={targetId} />

      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-semibold text-zinc-100">{label}の変更</p>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setNextName(currentName);
          }}
          className="text-[11px] text-zinc-500 hover:text-zinc-300"
        >
          閉じる
        </button>
      </div>

      <div>
        <label
          htmlFor={`next-name-${targetId}`}
          className="text-[11px] font-medium text-zinc-500"
        >
          新しい{label}
        </label>
        <input
          id={`next-name-${targetId}`}
          name="next_name"
          value={nextName}
          onChange={(e) => setNextName(e.target.value)}
          maxLength={100}
          className="mt-1 w-full rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-cyan-700"
        />
      </div>

      <dl className="space-y-1 rounded-lg border border-white/[0.06] bg-surface-0/50 p-3 text-[11px]">
        <div className="flex justify-between gap-3">
          <dt className="text-zinc-500">変更前</dt>
          <dd className="text-zinc-300">{currentName}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-zinc-500">変更後</dt>
          <dd className="font-semibold text-zinc-100">
            {changed ? nextName.trim() : "（未変更）"}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-zinc-500">
            {targetType === "agency" ? "agency_id" : "referrer_id"}
          </dt>
          <dd className="break-all font-mono text-[10px] text-zinc-500">{targetId}</dd>
        </div>

        <div className="mt-2 border-t border-white/[0.06] pt-2">
          <p className="mb-1 text-zinc-500">影響（表示名のみ変わります）</p>
          {impacts.map((impact) => (
            <div key={impact.label} className="flex justify-between gap-3">
              <span className="text-zinc-500">{impact.label}</span>
              <span className="font-mono text-zinc-300">{impact.value}</span>
            </div>
          ))}
        </div>
      </dl>

      <p className="text-[11px] leading-relaxed text-zinc-500">
        ID は変更しません。クリエイターの紐付け・月別確定所属・報酬明細・支払履歴は
        そのまま維持されます。
        {extraNote ? ` ${extraNote}` : null}
      </p>

      {state ? (
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
      ) : null}

      <button
        type="submit"
        disabled={pending || !changed}
        className="min-h-[36px] rounded-lg bg-white px-4 text-xs font-semibold text-zinc-950 transition hover:bg-zinc-200 disabled:opacity-40"
      >
        {pending ? "変更中…" : "名称変更を確定"}
      </button>
    </form>
  );
}
