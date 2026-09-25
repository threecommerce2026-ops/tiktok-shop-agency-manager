"use client";

import { useState } from "react";

/*
  支払確定の二段階確認ボタン。

  支払確定は取り消しが面倒な外向きの操作なので、
  1クリックで paid にならないようにする。

    ① 「支払確定」を押す
    ② 「誰に / いくら / 何件」を表示して最終確認
    ③ 「確定する」で Server Action を実行

  フォームの中身（hidden input）は呼び出し側がそのまま渡す。
  ここは表示と確認ステップだけを担当し、支払処理自体は変更しない。
*/
export function PayoutConfirmButton({
  targetName,
  amountLabel,
  itemCount,
  creatorCount,
  creatorNoun,
  pending,
  hiddenFields,
}: {
  /** 支払先の表示名（代理店名 / 紹介者名） */
  targetName: string;
  /** 支払額（整形済み文字列） */
  amountLabel: string;
  itemCount: number;
  creatorCount: number;
  /** 「クリエイター」などの単位名 */
  creatorNoun: string;
  pending: boolean;
  hiddenFields: React.ReactNode;
}) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="rounded border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-[11px] font-medium text-emerald-200 transition hover:bg-emerald-500/20"
      >
        支払確定
      </button>
    );
  }

  return (
    <div className="min-w-[240px] space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.08] p-2">
      <p className="text-[11px] leading-relaxed text-amber-100">
        <span className="font-semibold">{targetName}</span> へ{" "}
        <span className="font-mono font-semibold">{amountLabel}</span> を支払い確定します。
      </p>
      <p className="text-[10px] text-amber-200/80">
        対象明細 {itemCount} 件 / {creatorNoun} {creatorCount} 名。
        確定すると明細が支払済みになり、再集計しても金額は変わりません。
      </p>
      <div className="flex gap-2">
        {hiddenFields}
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-amber-400 px-3 py-1.5 text-[11px] font-semibold text-zinc-950 transition hover:bg-amber-300 disabled:opacity-50"
        >
          {pending ? "確定中…" : "確定する"}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          disabled={pending}
          className="rounded border border-white/[0.12] px-3 py-1.5 text-[11px] text-zinc-300 transition hover:bg-white/[0.06] disabled:opacity-50"
        >
          やめる
        </button>
      </div>
    </div>
  );
}
