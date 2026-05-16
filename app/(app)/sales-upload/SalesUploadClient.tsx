"use client";

import { importSalesCsvAction } from "@/app/actions/import-sales-csv";
import type { ImportCsvResult } from "@/lib/csv/import-sales-result";
import type { UploadHistoryRow } from "@/lib/db/sales-queries";
import {
  buildSalesImportSampleCsv,
  buildSalesImportTemplateCsv,
  triggerCsvDownload,
} from "@/lib/csv/sales-template-download";
import { PARTNER_SALES_IMPORT_ERROR } from "@/lib/sales/partner-export-columns";
import { parsePartnerSalesFile } from "@/lib/sales/read-partner-upload";
import { formatYen } from "@/lib/revenue/calc";
import Link from "next/link";
import {
  useActionState,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
} from "react";
import { useRouter } from "next/navigation";

type Props = {
  agencyName: string;
  month: string;
  history: UploadHistoryRow[];
  loadError: string | null;
};

function matchesSearch(q: string, ...parts: string[]) {
  if (!q.trim()) return true;
  const n = q.trim().toLowerCase();
  return parts.some((p) => p.toLowerCase().includes(n));
}

const steps = [
  {
    n: "1",
    t: "パートナーセンターから出力",
    d: "CSV または XLSX をダウンロード（列名はそのまま）",
  },
  { n: "2", t: "対象月を選択", d: "取り込み画面で売上の対象月を指定" },
  {
    n: "3",
    t: "アップロード",
    d: "ファイルを選び取り込むと Supabase へ保存",
  },
] as const;

export function SalesUploadClient({
  agencyName,
  month,
  history,
  loadError,
}: Props) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [targetMonth, setTargetMonth] = useState(month);
  const [fileName, setFileName] = useState<string | null>(null);
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [parseErr, setParseErr] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<ImportCsvResult | null>(null);

  const [state, formAction, isPending] = useActionState(
    importSalesCsvAction,
    null as ImportCsvResult | null,
  );

  useEffect(() => {
    if (!state) return;
    setLastResult(state);
    if (state.ok) {
      router.refresh();
    }
  }, [state, router]);

  useEffect(() => {
    if (fileName !== null) {
      setLastResult(null);
    }
  }, [fileName]);

  const filteredHistory = useMemo(
    () =>
      history.filter((h) =>
        matchesSearch(search, h.creator_name, h.tiktok_id, h.target_month),
      ),
    [history, search],
  );

  async function onFilePick(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    setParseErr(null);
    setPreviewCount(null);
    setFileName(f?.name ?? null);
    if (!f) return;
    try {
      const parsed = await parsePartnerSalesFile(f);
      if (!parsed.rows.length) {
        setParseErr(
          parsed.failures.length
            ? `取り込み可能なデータ行がありません（検出したエラー ${parsed.failures.length} 件）。`
            : PARTNER_SALES_IMPORT_ERROR,
        );
        return;
      }
      setPreviewCount(parsed.rows.length);
    } catch {
      setParseErr(
        "ファイルの読み込みに失敗しました。CSV / XLSX の形式を確認してください。",
      );
    }
  }

  const showSuccess = lastResult?.ok === true;
  const resultFailures =
    lastResult && "failures" in lastResult ? (lastResult.failures ?? []) : [];

  return (
    <div className="space-y-10">
      {/* ヘッダー */}
      <div className="rounded-3xl border border-white/[0.08] bg-gradient-to-br from-surface-1/90 to-surface-0/80 p-6 ring-glow sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
          {agencyName}
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
          売上 CSV / XLSX 取込
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-zinc-400">
          TikTok Shop パートナーセンターから出力した{" "}
          <strong className="text-zinc-200">CSV / XLSX</strong> をそのまま取り込めます。
          Creator username でクリエイターを自動紐付けし、未登録なら{" "}
          <strong className="text-zinc-200">自動作成</strong>します。対象月はファイルではなく画面で指定します。
        </p>
      </div>

      {/* 手順 */}
      <section aria-labelledby="flow-heading">
        <h2 id="flow-heading" className="text-lg font-semibold text-zinc-100">
          手順（3ステップ）
        </h2>
        <ol className="mt-4 grid gap-3 sm:grid-cols-3">
          {steps.map((s) => (
            <li
              key={s.n}
              className="flex gap-3 rounded-2xl border border-white/[0.06] bg-surface-1/50 p-4"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/[0.06] font-mono text-sm font-bold text-[var(--accent-cyan)]">
                {s.n}
              </span>
              <div>
                <p className="font-semibold text-zinc-200">{s.t}</p>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500">{s.d}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* 保存される項目 */}
      <section
        aria-labelledby="cols-heading"
        className="rounded-2xl border border-white/[0.06] bg-surface-2/30 px-5 py-4"
      >
        <h2 id="cols-heading" className="text-sm font-semibold text-zinc-300">
          Supabase に保存される項目（1行ごと）
        </h2>
        <ul className="mt-3 grid gap-2 text-sm text-zinc-400 sm:grid-cols-2">
          {[
            "対象月（画面で選択 → sales_imports.target_month）",
            "Creator nickname → creators.creator_name",
            "Creator username → creators.tiktok_id",
            "Affiliate GMV → sales_imports.sales_amount",
            "Est. commission → sales_imports.profit_amount",
            "Items sold → sales_imports.order_count",
            "Commission base → sales_imports.commission_base",
          ].map((t) => (
            <li key={t} className="flex items-start gap-2">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-[var(--accent-cyan)]" />
              {t}
            </li>
          ))}
        </ul>
      </section>

      {/* テンプレート DL */}
      <section aria-labelledby="dl-heading">
        <h2 id="dl-heading" className="text-lg font-semibold text-zinc-100">
          テスト用ファイル
        </h2>
        <p className="mt-2 text-sm text-zinc-500">
          パートナーセンターと同じ列名の見本 CSV です。金額は「円」やカンマ付きの例を含みます。
        </p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          <button
            type="button"
            onClick={() =>
              triggerCsvDownload("sales-import-template.csv", buildSalesImportTemplateCsv())
            }
            className="inline-flex min-h-[52px] touch-manipulation items-center justify-center rounded-full border border-white/[0.12] bg-surface-1/80 px-6 text-sm font-semibold text-zinc-100 transition hover:border-[var(--accent-cyan)]/40 hover:bg-white/[0.04]"
          >
            テンプレートをダウンロード（BOM付・ヘッダーのみ）
          </button>
          <button
            type="button"
            onClick={() =>
              triggerCsvDownload(
                "sales-import-sample.csv",
                buildSalesImportSampleCsv(),
              )
            }
            className="inline-flex min-h-[52px] touch-manipulation items-center justify-center rounded-full bg-gradient-to-r from-[var(--accent-cyan)]/25 to-[var(--accent-magenta)]/25 px-6 text-sm font-semibold text-zinc-100 ring-1 ring-white/10 transition hover:ring-[var(--accent-cyan)]/30"
          >
            テスト用サンプルをダウンロード（2行）
          </button>
          <a
            href="/csv/sales-import-template.csv"
            download
            className="inline-flex min-h-[52px] touch-manipulation items-center justify-center rounded-full border border-dashed border-white/[0.15] px-6 text-sm font-medium text-zinc-400 transition hover:text-zinc-200"
          >
            シンプル版（BOMなし・公開ファイル）
          </a>
          <a
            href="/csv/sales-import-sample.csv"
            download
            className="inline-flex min-h-[52px] touch-manipulation items-center justify-center rounded-full border border-dashed border-white/[0.15] px-6 text-sm font-medium text-zinc-400 transition hover:text-zinc-200"
          >
            サンプル固定版（公開ファイル）
          </a>
        </div>
      </section>

      {/* アップロード */}
      <section aria-labelledby="up-heading">
        <h2 id="up-heading" className="text-lg font-semibold text-zinc-100">
          ファイルをアップロード
        </h2>

        {(loadError || parseErr) && (
          <div
            className="mt-4 rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-100"
            role="alert"
          >
            <p className="font-semibold text-red-200">エラー</p>
            <p className="mt-1">{loadError ?? parseErr}</p>
          </div>
        )}

        {state?.ok === false && (
          <div
            className="mt-4 rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-100"
            role="alert"
          >
            <p className="font-semibold text-red-200">取り込みに失敗しました</p>
            <p className="mt-1">{state.error}</p>
            {state.failures && state.failures.length > 0 ? (
              <ul className="mt-3 space-y-1 text-xs text-red-200/90">
                {state.failures.map((failure) => (
                  <li key={`${failure.rowNumber}-${failure.error}`}>
                    {failure.rowNumber}行目: {failure.error}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}

        {showSuccess && (
          <div
            className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-4 text-emerald-50"
            role="status"
          >
            <p className="text-lg font-bold text-emerald-100">
              {lastResult?.ok === true ? lastResult.message : ""}
            </p>
            <p className="mt-2 text-sm text-emerald-200/90">
              成功:{" "}
              <span className="font-mono font-semibold">
                {lastResult?.ok === true ? lastResult.successCount : 0}
              </span>{" "}
              件 ／ 失敗:{" "}
              <span className="font-mono font-semibold">
                {lastResult?.ok === true ? lastResult.failedCount : 0}
              </span>{" "}
              件 ／ 関係したクリエイター:{" "}
              <span className="font-mono font-semibold">
                {lastResult?.ok === true ? lastResult.creatorsTouched : 0}
              </span>{" "}
              名
            </p>
            {resultFailures.length > 0 ? (
              <div className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                <p className="font-semibold text-amber-50">失敗した行</p>
                <ul className="mt-2 space-y-1">
                  {resultFailures.map((failure) => (
                    <li key={`${failure.rowNumber}-${failure.error}`}>
                      {failure.rowNumber}行目: {failure.error}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <p className="mt-2 text-xs text-emerald-300/80">
              ダッシュボードの数値を確認する場合は、下のリンクから移動するか、このページが自動更新された内容をご覧ください。
            </p>
          </div>
        )}

        <form
          action={formAction}
          className="mt-6 space-y-4 rounded-2xl border border-white/[0.08] bg-surface-1/50 p-5 sm:p-6"
        >
          <label className="block">
            <span className="text-sm font-medium text-zinc-300">対象月（必須）</span>
            <input
              name="target_month"
              type="month"
              required
              value={targetMonth}
              onChange={(e) => setTargetMonth(e.target.value)}
              className="mt-3 block w-full min-h-[48px] rounded-xl border border-white/[0.08] bg-surface-0/50 px-4 text-base text-zinc-100 outline-none focus:border-[var(--accent-cyan)]/40"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-zinc-300">
              CSV / XLSX ファイル（必須）
            </span>
            <input
              name="file"
              type="file"
              accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
              required
              onChange={onFilePick}
              className="mt-3 block w-full min-h-[52px] cursor-pointer touch-manipulation rounded-xl border border-dashed border-white/[0.14] bg-surface-0/50 px-4 py-3 text-sm text-zinc-400 file:mr-4 file:rounded-lg file:border-0 file:bg-white/10 file:px-4 file:py-2 file:text-sm file:font-medium file:text-zinc-200"
            />
          </label>
          {fileName ? (
            <p className="text-xs text-zinc-500">
              選択中: <span className="font-mono text-zinc-400">{fileName}</span>
              {previewCount != null ? (
                <span className="ml-2 text-zinc-400">
                  → 取り込み可能なデータ行:{" "}
                  <span className="font-mono font-semibold text-zinc-300">
                    {previewCount}
                  </span>
                </span>
              ) : null}
            </p>
          ) : null}
          <div className="rounded-xl bg-black/25 px-3 py-2 text-xs leading-relaxed text-zinc-500">
            <span className="font-semibold text-zinc-400">必須の列名:</span>{" "}
            <code className="break-all font-mono text-[11px] text-zinc-400">
              Creator nickname / Creator username / Affiliate GMV など
            </code>
            <span className="mt-1 block text-zinc-600">
              TikTok ID 列は TikTok ID・Tiktok ID・tiktok_id・creator_id
              にも対応します。ID は trim と小文字化後に紐付けます。LIVE / Video
              の CTR 等は読み込みません。
            </span>
          </div>
          <button
            type="submit"
            disabled={isPending}
            className="flex min-h-[54px] w-full touch-manipulation items-center justify-center rounded-full bg-gradient-to-r from-[var(--accent-cyan)]/90 to-[var(--accent-magenta)]/90 px-8 text-base font-semibold text-surface-0 shadow-lg transition hover:brightness-110 disabled:opacity-50 sm:w-auto"
          >
            {isPending ? "取り込み中…" : "このファイルを取り込む"}
          </button>
        </form>
      </section>

      {/* 検索 */}
      <div>
        <label htmlFor="creator-search" className="text-sm font-semibold text-zinc-300">
          クリエイター検索
        </label>
        <input
          id="creator-search"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="名前・TikTok ID・対象月で絞り込み"
          className="mt-2 w-full min-h-[48px] rounded-xl border border-white/[0.08] bg-surface-2/60 px-4 text-base text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-[var(--accent-cyan)]/40"
        />
      </div>


      <section aria-labelledby="hist-heading">
        <h2 id="hist-heading" className="text-lg font-semibold text-zinc-200">
          アップロード履歴（直近の保存内容）
        </h2>
        <div className="mt-4 overflow-x-auto rounded-2xl border border-white/[0.06]">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-white/[0.06] bg-surface-1/80 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                <th className="px-3 py-2">保存日時</th>
                <th className="px-3 py-2">対象月</th>
                <th className="px-3 py-2">クリエイター</th>
                <th className="px-3 py-2 text-right">売上</th>
                <th className="px-3 py-2 text-right">収益</th>
                <th className="px-3 py-2 text-right">注文</th>
              </tr>
            </thead>
            <tbody>
              {filteredHistory.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-zinc-500">
                    履歴がありません。CSV を取り込むとここに表示されます。
                  </td>
                </tr>
              ) : (
                filteredHistory.map((h) => (
                  <tr key={h.id} className="border-b border-white/[0.04]">
                    <td className="px-3 py-2 font-mono text-xs text-zinc-400">
                      {new Date(h.created_at).toLocaleString("ja-JP")}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{h.target_month}</td>
                    <td className="px-3 py-2">
                      <span className="font-medium text-zinc-200">{h.creator_name}</span>
                      <span className="ml-2 font-mono text-xs text-zinc-500">{h.tiktok_id}</span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono">{formatYen(h.sales_amount)}</td>
                    <td className="px-3 py-2 text-right font-mono text-[var(--accent-cyan)]">
                      {formatYen(h.profit_amount)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">{h.order_count}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <div className="flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
        <Link
          href="/dashboard"
          className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-white/[0.12] px-6 text-sm font-semibold text-zinc-200 transition hover:bg-white/[0.06]"
        >
          ダッシュボードで数値を確認
        </Link>
        <Link
          href="/creators"
          className="text-sm font-medium text-[var(--accent-cyan)] hover:underline"
        >
          クリエイター売上一覧へ
        </Link>
      </div>
    </div>
  );
}
