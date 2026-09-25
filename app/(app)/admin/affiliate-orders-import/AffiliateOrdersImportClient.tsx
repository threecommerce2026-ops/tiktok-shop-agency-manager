"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import {
  compareAffiliateOrderChunkAction,
  finishAffiliateOrderImportAction,
  importAffiliateOrderChunkAction,
  startAffiliateOrderImportAction,
} from "@/app/actions/import-affiliate-orders";
import {
  buildPayloadChunks,
  dedupeAffiliateOrderRows,
  MAX_COMPARE_CHUNK_BYTES,
  MAX_COMPARE_CHUNK_ROWS,
  toCompareItem,
  type AffiliateOrderPayloadRow,
  type CompareItem,
} from "@/lib/orders/affiliate-order-import-payload";
import {
  emptyCompareTotals,
  mergeCompareTotals,
  resolveImportBlockers,
  summarizeAffiliateOrderRows,
  type AffiliateOrderCompareTotals,
  type AffiliateOrderImportSummary,
  type ImportBlocker,
} from "@/lib/orders/affiliate-order-preview";
import { parseAffiliateOrderFile } from "@/lib/orders/parse-affiliate-order-export";

/*
  Partner Center 注文Excelの取込画面。

  ■ Excelファイルをサーバーへ送らない
  Vercel のリクエストボディ上限 4.5MB / Next.js Server Action の 1MB を
  避けるため、解析はこのブラウザ内で完結させ、
  サーバーへは小分けしたJSONだけを送る。
  20MB のExcelでも1リクエストは 400KB 以下に収まる。

  ■ 流れ
  ファイル選択 → ブラウザで解析 → 検証 → ファイル内重複を排除
    → 既存DBと照合（SELECTのみ）→ プレビュー
    → 「取込実行」→ チャンク送信 → 結果表示
*/

type Phase =
  | "idle"
  | "parsing"
  | "comparing"
  | "preview"
  | "importing"
  | "done"
  | "failed";

type InvalidRow = { rowNumber: number; error: string };

type PreviewState = {
  fileName: string;
  fileSize: number;
  summary: AffiliateOrderImportSummary;
  rows: AffiliateOrderPayloadRow[];
  invalidRows: InvalidRow[];
  duplicateKeys: string[];
  blockers: ImportBlocker[];
  compare: AffiliateOrderCompareTotals | null;
  compareError: string | null;
  chunkCount: number;
  maxChunkBytes: number;
};

type ImportProgress = {
  totalChunks: number;
  doneChunks: number;
  totalRows: number;
  doneRows: number;
  failedRows: number;
  failures: InvalidRow[];
  failedChunks: number[];
};

const card =
  "rounded-2xl border border-white/[0.08] bg-surface-1/50 p-5 sm:p-6";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatInt(value: number): string {
  return value.toLocaleString("ja-JP");
}

function formatYen(value: number): string {
  return `¥${Math.round(value).toLocaleString("ja-JP")}`;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return iso.slice(0, 19).replace("T", " ");
}

function Stat({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "warn" | "strong";
}) {
  return (
    <div
      className={`rounded-xl border px-4 py-3 ${
        tone === "warn"
          ? "border-amber-400/25 bg-amber-400/[0.07]"
          : tone === "strong"
            ? "border-[var(--accent-cyan)]/30 bg-[var(--accent-cyan)]/[0.06]"
            : "border-white/[0.07] bg-surface-0/40"
      }`}
    >
      <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
        {label}
      </p>
      <p className="mt-1.5 font-mono text-lg font-bold text-zinc-50">{value}</p>
      {hint ? <p className="mt-1 text-[11px] text-zinc-500">{hint}</p> : null}
    </div>
  );
}

export function AffiliateOrdersImportClient() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const [phase, setPhase] = useState<Phase>("idle");
  const [statusText, setStatusText] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);

  const reset = useCallback(() => {
    setPhase("idle");
    setStatusText("");
    setError(null);
    setPreview(null);
    setProgress(null);
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  // ---------------------------------------------------------------------------
  // ファイル選択 → ブラウザ内で解析 → 照合 → プレビュー
  // ---------------------------------------------------------------------------
  const handleFile = useCallback(
    async (file: File) => {
      setError(null);
      setProgress(null);
      setPreview(null);
      setPhase("parsing");
      setStatusText("Excelを解析しています…");

      try {
        const parsed = await parseAffiliateOrderFile(file);

        // 必須列が無い等、ヘッダー起因の致命的エラー
        const headerError =
          parsed.rows.length === 0 && parsed.failures.length > 0
            ? parsed.failures[0].error
            : null;

        const deduped = dedupeAffiliateOrderRows(parsed.rows);

        const summary = summarizeAffiliateOrderRows(deduped.rows, {
          parsedRows: parsed.rows.length,
          invalidRows: parsed.failures.length,
          duplicateRows: deduped.duplicateCount,
        });

        const blockers = resolveImportBlockers({ summary, headerError });

        const { chunks, maxChunkBytes } = buildPayloadChunks(deduped.rows);

        const base: PreviewState = {
          fileName: file.name,
          fileSize: file.size,
          summary,
          rows: deduped.rows,
          invalidRows: parsed.failures,
          duplicateKeys: deduped.duplicateKeys,
          blockers,
          compare: null,
          compareError: null,
          chunkCount: chunks.length,
          maxChunkBytes,
        };

        if (blockers.length > 0 || deduped.rows.length === 0) {
          setPreview(base);
          setPhase("preview");
          setStatusText("");
          return;
        }

        // ---- 既存DBとの照合（SELECTのみ。DB WRITE なし）----
        setPhase("comparing");
        setStatusText("既存データと照合しています…");

        const compareItems: CompareItem[] = deduped.rows.map(toCompareItem);
        const compareChunks = buildPayloadChunks(compareItems, {
          maxBytes: MAX_COMPARE_CHUNK_BYTES,
          maxRows: MAX_COMPARE_CHUNK_ROWS,
        }).chunks;

        let totals = emptyCompareTotals();
        let compareError: string | null = null;

        for (let i = 0; i < compareChunks.length; i += 1) {
          setStatusText(
            `既存データと照合しています… ${i + 1} / ${compareChunks.length}`,
          );
          const result = await compareAffiliateOrderChunkAction({
            items: compareChunks[i],
          });

          if (!result.ok) {
            compareError = result.error;
            break;
          }
          totals = mergeCompareTotals(totals, result.totals);
        }

        setPreview({
          ...base,
          compare: compareError ? null : totals,
          compareError,
        });
        setPhase("preview");
        setStatusText("");
      } catch (caught) {
        setError(
          caught instanceof Error
            ? `Excelを解析できませんでした: ${caught.message}`
            : "Excelを解析できませんでした",
        );
        setPhase("failed");
        setStatusText("");
      }
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // 取込実行（チャンク送信）
  // ---------------------------------------------------------------------------
  const runImport = useCallback(async () => {
    if (!preview || preview.blockers.length > 0) return;

    setError(null);
    setPhase("importing");

    const { chunks } = buildPayloadChunks(preview.rows);

    const state: ImportProgress = {
      totalChunks: chunks.length,
      doneChunks: 0,
      totalRows: preview.rows.length,
      doneRows: 0,
      failedRows: 0,
      failures: [],
      failedChunks: [],
    };
    setProgress({ ...state });

    const started = await startAffiliateOrderImportAction({
      fileName: preview.fileName,
      rowTotal: preview.rows.length,
    });

    if (!started.ok) {
      setError(started.error);
      setPhase("failed");
      return;
    }

    for (let i = 0; i < chunks.length; i += 1) {
      setStatusText(`取込中… ${i + 1} / ${chunks.length} チャンク`);

      const result = await importAffiliateOrderChunkAction({
        batchId: started.batchId,
        rows: chunks[i],
      });

      if (!result.ok) {
        state.failedChunks.push(i + 1);
        state.failedRows += chunks[i].length;
        if (result.failures?.length) {
          state.failures.push(...result.failures);
        } else {
          state.failures.push({ rowNumber: 0, error: result.error });
        }
      } else {
        state.doneRows += result.upsertedCount;
        state.failedRows += result.failedCount;
        if (result.failures.length > 0) {
          state.failures.push(...result.failures);
        }
      }

      state.doneChunks = i + 1;
      setProgress({ ...state, failures: state.failures.slice(0, 100) });
    }

    await finishAffiliateOrderImportAction({
      batchId: started.batchId,
      upsertedCount: state.doneRows,
      failedCount: state.failedRows,
    });

    setStatusText("");
    setPhase(state.failedChunks.length > 0 ? "failed" : "done");
    router.refresh();
  }, [preview, router]);

  const busy =
    phase === "parsing" || phase === "comparing" || phase === "importing";

  const progressPct = useMemo(() => {
    if (!progress || progress.totalChunks === 0) return 0;
    return Math.round((progress.doneChunks / progress.totalChunks) * 100);
  }, [progress]);

  return (
    <div className="space-y-6">
      <div className="rounded-3xl border border-white/[0.08] bg-surface-1/60 p-6 sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
          親管理画面
        </p>

        <h1 className="mt-2 text-2xl font-bold text-zinc-50 sm:text-3xl">
          アフィリエイト注文Excel取込
        </h1>

        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-zinc-400">
          Partner Center の「ファイナンス → 収益 → 注文をエクスポート」から取得した
          XLSX / XLS を取り込みます。
        </p>

        <p className="mt-2 max-w-3xl text-sm text-zinc-400">
          ファイルは
          <span className="font-semibold text-zinc-200">
            ブラウザ内で解析
          </span>
          し、サーバーへは小分けしたデータだけを送ります。
          大きなファイルでもアップロード上限に当たりません。
        </p>

        <p className="mt-2 text-sm text-zinc-400">
          同じファイルを何度取り込んでも、明細キーで更新するため二重登録しません。
        </p>
      </div>

      {error ? (
        <div className="rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-100">
          <p className="font-semibold">エラー</p>
          <p className="mt-1">{error}</p>
        </div>
      ) : null}

      {/* ---------------- ファイル選択 ---------------- */}
      {phase === "idle" || phase === "failed" || phase === "done" ? (
        <div className={card}>
          <label className="block">
            <span className="text-sm font-medium text-zinc-300">
              Partner Center 注文Excel
            </span>

            <input
              ref={inputRef}
              type="file"
              accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleFile(file);
              }}
              className="mt-3 block min-h-[52px] w-full cursor-pointer rounded-xl border border-dashed border-white/[0.14] bg-surface-0/50 px-4 py-3 text-sm text-zinc-400 file:mr-4 file:rounded-lg file:border-0 file:bg-white/10 file:px-4 file:py-2 file:text-sm file:font-medium file:text-zinc-200"
            />
          </label>

          <div className="mt-4 rounded-xl bg-black/25 p-4 text-xs leading-relaxed text-zinc-500">
            <p className="font-semibold text-zinc-300">取込時の自動処理</p>
            <p className="mt-2">
              TikTok IDでクリエイター照合 → 未登録なら仮登録 → 現在の代理店紐付けを維持
              → セラー照合 → 注文明細をupsert
            </p>
            <p className="mt-2">
              報酬の再集計は行いません。全期間の取込が終わってから
              「代理店報酬の再集計」「紹介者報酬の再集計」を実行してください。
            </p>
          </div>
        </div>
      ) : null}

      {/* ---------------- 解析中 / 照合中 ---------------- */}
      {phase === "parsing" || phase === "comparing" ? (
        <div className={card}>
          <p className="text-sm font-medium text-zinc-200">{statusText}</p>
          <p className="mt-2 text-xs text-zinc-500">
            大きなファイルは解析に時間がかかります。このタブを閉じないでください。
          </p>
          <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-[var(--accent-cyan)]" />
          </div>
        </div>
      ) : null}

      {/* ---------------- プレビュー ---------------- */}
      {preview && (phase === "preview" || phase === "importing") ? (
        <div className={card}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold text-zinc-100">取込プレビュー</h2>
            <p className="font-mono text-xs text-zinc-500">
              {preview.fileName}（{formatBytes(preview.fileSize)}）
            </p>
          </div>

          <p className="mt-1 text-[11px] text-zinc-500">
            この時点ではデータベースへ一切書き込んでいません。
          </p>

          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="総行数" value={formatInt(preview.summary.parsedRows)} />
            <Stat
              label="取込対象"
              value={formatInt(preview.summary.validRows)}
              tone="strong"
            />
            <Stat
              label="無効行"
              value={formatInt(preview.summary.invalidRows)}
              tone={preview.summary.invalidRows > 0 ? "warn" : "default"}
            />
            <Stat
              label="ファイル内重複"
              value={formatInt(preview.summary.duplicateRows)}
              hint={
                preview.summary.duplicateRows > 0
                  ? "最後の行を採用して除外しました"
                  : undefined
              }
              tone={preview.summary.duplicateRows > 0 ? "warn" : "default"}
            />
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="ユニーク注文" value={formatInt(preview.summary.uniqueOrders)} />
            <Stat label="クリエイター" value={formatInt(preview.summary.uniqueCreators)} />
            <Stat label="ショップ" value={formatInt(preview.summary.uniqueShops)} />
            <Stat
              label="対象月"
              value={
                preview.summary.targetMonths.length === 0
                  ? "—"
                  : preview.summary.targetMonths.join(" / ")
              }
              hint={
                preview.summary.missingTargetMonth > 0
                  ? `対象月不明 ${formatInt(preview.summary.missingTargetMonth)} 件`
                  : undefined
              }
            />
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="対象期間"
              value={formatDateTime(preview.summary.periodStart)}
              hint={`〜 ${formatDateTime(preview.summary.periodEnd)}`}
            />
            <Stat label="成果報酬GMV" value={formatYen(preview.summary.commissionGmv)} />
            <Stat
              label="Commission Base"
              value={formatYen(preview.summary.commissionBase)}
            />
            <Stat
              label="Agency Revenue"
              value={formatYen(preview.summary.agencyRevenue)}
            />
          </div>

          {/* 既存DBとの差分 */}
          <div className="mt-5">
            <h3 className="text-sm font-semibold text-zinc-200">
              既存データとの差分
            </h3>
            {preview.compareError ? (
              <p className="mt-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-100">
                照合に失敗しました: {preview.compareError}
                （取込自体は実行できます）
              </p>
            ) : preview.compare ? (
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <Stat
                  label="新規予定"
                  value={formatInt(preview.compare.newRows)}
                  tone="strong"
                />
                <Stat label="更新あり" value={formatInt(preview.compare.changedRows)} />
                <Stat
                  label="変更なし"
                  value={formatInt(preview.compare.unchangedRows)}
                  hint="再取込しても内容が変わらない明細"
                />
              </div>
            ) : (
              <p className="mt-2 text-[11px] text-zinc-500">照合していません。</p>
            )}
          </div>

          {/* 送信計画 */}
          <div className="mt-5 rounded-xl bg-black/25 p-4 text-[11px] leading-relaxed text-zinc-500">
            <p className="font-semibold text-zinc-300">送信の分割</p>
            <p className="mt-1">
              {formatInt(preview.chunkCount)} 回に分けて送信します（最大
              {formatBytes(preview.maxChunkBytes)} / リクエスト）。
              Excelファイル自体はサーバーへ送信しません。
            </p>
          </div>

          {/* 重大エラー */}
          {preview.blockers.length > 0 ? (
            <div className="mt-4 rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-100">
              <p className="font-semibold">取り込めません</p>
              <ul className="mt-1 space-y-1 text-[11px]">
                {preview.blockers.map((blocker) => (
                  <li key={blocker.code}>{blocker.message}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* 無効行 */}
          {preview.invalidRows.length > 0 ? (
            <div className="mt-4">
              <h3 className="text-sm font-semibold text-amber-200">
                取り込めない行（{formatInt(preview.invalidRows.length)}）
              </h3>
              <p className="mt-1 text-[11px] text-zinc-500">
                これらの行は除外して取り込みます。
              </p>
              <div className="mt-2 max-h-56 overflow-auto rounded-lg bg-black/25 p-3 font-mono text-[11px] text-zinc-400">
                {preview.invalidRows.slice(0, 200).map((row, index) => (
                  <p key={`${row.rowNumber}-${index}`}>
                    {row.rowNumber > 0 ? `${row.rowNumber}行目: ` : ""}
                    {row.error}
                  </p>
                ))}
                {preview.invalidRows.length > 200 ? (
                  <p className="mt-1 text-zinc-600">
                    ほか {formatInt(preview.invalidRows.length - 200)} 件
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}

          {/* 実行ボタン */}
          {phase === "preview" ? (
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void runImport()}
                disabled={preview.blockers.length > 0}
                className="inline-flex min-h-[52px] items-center justify-center rounded-full bg-gradient-to-r from-[var(--accent-cyan)]/90 to-[var(--accent-magenta)]/90 px-7 text-sm font-bold text-surface-0 disabled:opacity-40"
              >
                {formatInt(preview.summary.validRows)} 件を取り込む
              </button>

              <button
                type="button"
                onClick={reset}
                className="min-h-[52px] rounded-full border border-white/[0.12] px-6 text-sm font-medium text-zinc-300 hover:bg-white/[0.06]"
              >
                やり直す
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ---------------- 取込中 ---------------- */}
      {phase === "importing" && progress ? (
        <div className={card}>
          <p className="text-sm font-semibold text-zinc-100">{statusText}</p>

          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-white/[0.06]">
            <div
              className="h-full rounded-full bg-[var(--accent-cyan)] transition-all"
              style={{ width: `${progressPct}%` }}
            />
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Stat
              label="チャンク"
              value={`${formatInt(progress.doneChunks)} / ${formatInt(progress.totalChunks)}`}
            />
            <Stat
              label="行"
              value={`${formatInt(progress.doneRows)} / ${formatInt(progress.totalRows)}`}
            />
            <Stat label="進捗" value={`${progressPct}%`} tone="strong" />
          </div>

          <p className="mt-3 text-[11px] text-amber-200">
            取込が終わるまでこのタブを閉じないでください。
          </p>
        </div>
      ) : null}

      {/* ---------------- 完了 ---------------- */}
      {phase === "done" && progress ? (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-5 py-5 text-emerald-50">
          <p className="text-lg font-bold">
            {formatInt(progress.doneRows)} 件の注文明細を取り込みました
          </p>

          <div className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <p className="text-emerald-300/70">チャンク</p>
              <p className="font-mono text-lg">
                {formatInt(progress.doneChunks)} / {formatInt(progress.totalChunks)}
              </p>
            </div>
            <div>
              <p className="text-emerald-300/70">保存成功</p>
              <p className="font-mono text-lg">{formatInt(progress.doneRows)}</p>
            </div>
            <div>
              <p className="text-emerald-300/70">失敗</p>
              <p className="font-mono text-lg">{formatInt(progress.failedRows)}</p>
            </div>
          </div>

          <p className="mt-4 rounded-lg bg-black/20 px-3 py-2 text-sm">
            注文データの取込が完了しました。
            全期間の取込完了後に報酬再集計を実行してください。
          </p>
        </div>
      ) : null}

      {/* ---------------- 途中失敗 ---------------- */}
      {phase === "failed" && progress ? (
        <div className="rounded-xl border border-red-500/25 bg-red-500/10 px-5 py-5 text-red-50">
          <p className="text-lg font-bold">取込が途中で失敗しました</p>

          <div className="mt-3 grid gap-3 text-sm sm:grid-cols-4">
            <div>
              <p className="text-red-300/70">成功チャンク</p>
              <p className="font-mono text-lg">
                {formatInt(progress.doneChunks - progress.failedChunks.length)}
              </p>
            </div>
            <div>
              <p className="text-red-300/70">失敗チャンク</p>
              <p className="font-mono text-lg">
                {formatInt(progress.failedChunks.length)}
              </p>
            </div>
            <div>
              <p className="text-red-300/70">成功行数</p>
              <p className="font-mono text-lg">{formatInt(progress.doneRows)}</p>
            </div>
            <div>
              <p className="text-red-300/70">失敗行数</p>
              <p className="font-mono text-lg">{formatInt(progress.failedRows)}</p>
            </div>
          </div>

          <p className="mt-4 rounded-lg bg-black/20 px-3 py-2 text-sm">
            同じExcelを最初から取り込み直して問題ありません。
            明細キーで更新するため、
            <span className="font-semibold">再実行しても二重計上されません。</span>
          </p>

          {progress.failures.length > 0 ? (
            <div className="mt-3 max-h-56 overflow-auto rounded-lg bg-black/25 p-3 font-mono text-[11px] text-red-100/80">
              {progress.failures.slice(0, 100).map((failure, index) => (
                <p key={`${failure.rowNumber}-${index}`}>
                  {failure.rowNumber > 0 ? `${failure.rowNumber}行目: ` : ""}
                  {failure.error}
                </p>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {(phase === "done" || phase === "failed") && progress ? (
        <button
          type="button"
          onClick={reset}
          className="min-h-[48px] rounded-full border border-white/[0.12] px-6 text-sm font-medium text-zinc-300 hover:bg-white/[0.06]"
        >
          別のファイルを取り込む
        </button>
      ) : null}

      {/* 参考情報 */}
      <p className="text-[11px] leading-relaxed text-zinc-600">
        1リクエストの上限は 400KB です（Next.js Server Action の既定 1MB /
        Vercel の 4.5MB に対して余裕を確保）。
        送信するJSONの実バイト数を測って分割するため、
        Excelが何MBでも1リクエストがこの上限を超えることはありません。
      </p>
    </div>
  );
}
