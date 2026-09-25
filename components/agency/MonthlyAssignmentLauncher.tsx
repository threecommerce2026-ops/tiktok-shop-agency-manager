"use client";

import { useState, useTransition } from "react";

import {
  loadCreatorMonthlyAssignmentAction,
  type LoadMonthlyAssignmentResult,
} from "@/app/actions/creator-monthly-assignment";
import { MonthlyAssignmentPanel } from "@/components/agency/MonthlyAssignmentPanel";

/*
  「月別所属を確認」ボタン。
  押されたときだけサーバーから対象クリエイターの月別所属を読み込み、
  同じ画面内にパネルを開く。
*/
export function MonthlyAssignmentLauncher({
  creatorId,
  label = "月別所属を確認",
  className,
}: {
  creatorId: string;
  label?: string;
  className?: string;
}) {
  const [result, setResult] = useState<LoadMonthlyAssignmentResult | null>(null);
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
      setResult(await loadCreatorMonthlyAssignmentAction(creatorId));
    });
  }

  return (
    <>
      <button type="button" onClick={toggle} disabled={isPending} className={buttonClass}>
        {isPending ? "読込中…" : result ? "閉じる" : label}
      </button>

      {result && !result.ok ? (
        <p className="mt-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          {result.error}
        </p>
      ) : null}

      {result?.ok ? (
        <div className="mt-3">
          <MonthlyAssignmentPanel
            data={result.data}
            agencies={result.agencies}
            onClose={() => setResult(null)}
          />
        </div>
      ) : null}
    </>
  );
}
