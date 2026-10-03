"use client";

import { useState, useTransition } from "react";

import {
  loadCreatorMonthlyAccountTypeAction,
  type LoadMonthlyAccountTypeResult,
} from "@/app/actions/creator-monthly-account-type";
import { MonthlyAccountTypePanel } from "@/components/creators/MonthlyAccountTypePanel";

/*
  「月別区分を確認」ボタン。
  押されたときだけサーバーから対象クリエイターの月別区分を読み込み、
  同じ画面内にパネルを開く（別ページへ遷移しない）。
*/
export function MonthlyAccountTypeLauncher({
  creatorId,
  label = "月別区分を確認",
  className,
  onSaved,
}: {
  creatorId: string;
  label?: string;
  className?: string;
  /** 保存後に呼び出し側の集計を DB から読み直させる */
  onSaved?: () => void;
}) {
  const [result, setResult] = useState<LoadMonthlyAccountTypeResult | null>(null);
  const [isPending, startTransition] = useTransition();

  const buttonClass =
    className ??
    "rounded border border-white/[0.1] px-2.5 py-1 text-[11px] text-zinc-200 transition hover:bg-white/[0.06] disabled:opacity-50";

  function toggle() {
    if (result) {
      setResult(null);
      return;
    }
    startTransition(async () => {
      setResult(await loadCreatorMonthlyAccountTypeAction(creatorId));
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={toggle}
        disabled={isPending}
        className={buttonClass}
      >
        {isPending ? "読込中…" : result ? "閉じる" : label}
      </button>

      {result && !result.ok ? (
        <p className="mt-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          {result.error}
        </p>
      ) : null}

      {result?.ok ? (
        <div className="mt-3">
          <MonthlyAccountTypePanel
            data={result.data}
            onClose={() => setResult(null)}
            onSaved={onSaved}
          />
        </div>
      ) : null}
    </>
  );
}
