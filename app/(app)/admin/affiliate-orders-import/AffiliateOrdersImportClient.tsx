"use client";

import {
  importAffiliateOrdersAction,
  type ImportAffiliateOrdersResult,
} from "@/app/actions/import-affiliate-orders";
import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export function AffiliateOrdersImportClient() {
  const router = useRouter();
  const [fileName, setFileName] = useState<string | null>(null);

  const [state, formAction, isPending] = useActionState(
    importAffiliateOrdersAction,
    null as ImportAffiliateOrdersResult | null,
  );

  useEffect(() => {
    if (state?.ok) {
      router.refresh();
    }
  }, [state, router]);

  return (
    <div className="space-y-8">
      <div className="rounded-3xl border border-white/[0.08] bg-surface-1/60 p-6 sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
          親管理画面
        </p>

        <h1 className="mt-2 text-2xl font-bold text-zinc-50 sm:text-3xl">
          Partner Center 注文取込
        </h1>

        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-zinc-400">
          Partner Center の「ファイナンス → 収益 → 注文をエクスポート」から取得した
          XLSX を取り込みます。
        </p>

        <p className="mt-2 text-sm text-zinc-400">
          同じファイルを再度取り込んでも、明細キーを使って更新するため二重登録しません。
        </p>
      </div>

      {state?.ok === false ? (
        <div className="rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-100">
          <p className="font-semibold">取り込みに失敗しました</p>
          <p className="mt-1">{state.error}</p>

          {state.failures?.length ? (
            <div className="mt-3 max-h-64 overflow-auto rounded-lg bg-black/20 p-3 text-xs">
              {state.failures.slice(0, 100).map((failure, index) => (
                <p key={`${failure.rowNumber}-${index}`}>
                  {failure.rowNumber > 0 ? `${failure.rowNumber}行目: ` : ""}
                  {failure.error}
                </p>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {state?.ok === true ? (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-4 text-emerald-50">
          <p className="text-lg font-bold">{state.message}</p>

          <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <p className="text-emerald-300/70">解析明細</p>
              <p className="font-mono text-lg">
                {state.rowCount.toLocaleString("ja-JP")}
              </p>
            </div>

            <div>
              <p className="text-emerald-300/70">保存成功</p>
              <p className="font-mono text-lg">
                {state.successCount.toLocaleString("ja-JP")}
              </p>
            </div>

            <div>
              <p className="text-emerald-300/70">クリエイター</p>
              <p className="font-mono text-lg">
                {state.creatorsTouched.toLocaleString("ja-JP")}
              </p>
            </div>

            <div>
              <p className="text-emerald-300/70">セラー紐付け明細</p>
              <p className="font-mono text-lg">
                {state.sellersLinked.toLocaleString("ja-JP")}
              </p>
            </div>
          </div>

          {state.failedCount > 0 ? (
            <p className="mt-3 text-sm text-amber-200">
              失敗: {state.failedCount.toLocaleString("ja-JP")}件
            </p>
          ) : null}
        </div>
      ) : null}

      <form
        action={formAction}
        className="space-y-5 rounded-2xl border border-white/[0.08] bg-surface-1/50 p-5 sm:p-6"
      >
        <label className="block">
          <span className="text-sm font-medium text-zinc-300">
            Partner Center 注文Excel
          </span>

          <input
            name="file"
            type="file"
            accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            required
            disabled={isPending}
            onChange={(event) =>
              setFileName(event.target.files?.[0]?.name ?? null)
            }
            className="mt-3 block min-h-[52px] w-full cursor-pointer rounded-xl border border-dashed border-white/[0.14] bg-surface-0/50 px-4 py-3 text-sm text-zinc-400 file:mr-4 file:rounded-lg file:border-0 file:bg-white/10 file:px-4 file:py-2 file:text-sm file:font-medium file:text-zinc-200"
          />
        </label>

        {fileName ? (
          <p className="text-xs text-zinc-500">
            選択中:{" "}
            <span className="font-mono text-zinc-300">{fileName}</span>
          </p>
        ) : null}

        <div className="rounded-xl bg-black/25 p-4 text-xs leading-relaxed text-zinc-500">
          <p className="font-semibold text-zinc-300">取り込み時に自動処理</p>
          <p className="mt-2">
            TikTok IDでクリエイター照合 → 未登録なら仮登録 → 現在の代理店紐付けを維持
            → セラー照合 → 注文明細をupsert
          </p>
        </div>

        <button
          type="submit"
          disabled={isPending}
          className="inline-flex min-h-[52px] items-center justify-center rounded-full bg-gradient-to-r from-[var(--accent-cyan)]/90 to-[var(--accent-magenta)]/90 px-7 text-sm font-bold text-surface-0 disabled:opacity-50"
        >
          {isPending ? "取り込み中…" : "注文Excelを取り込む"}
        </button>
      </form>
    </div>
  );
}
