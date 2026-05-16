"use client";

import {
  executeSellerImportRowsAction,
  previewSellerImportRowsAction,
} from "@/app/actions/seller-import";
import { buildSellerImportRowsFromObjects } from "@/lib/sellers/build-import-rows";
import type { SellerImportPreviewRow, SellerImportSourceRow } from "@/lib/sellers/import-types";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";

function statusBadge(status: SellerImportPreviewRow["status"]) {
  if (status === "new") {
    return <span className="rounded bg-emerald-950 px-2 py-0.5 text-[11px] text-emerald-300">新規</span>;
  }
  if (status === "update") {
    return <span className="rounded bg-amber-950 px-2 py-0.5 text-[11px] text-amber-200">更新</span>;
  }
  return <span className="rounded bg-red-950 px-2 py-0.5 text-[11px] text-red-300">エラー</span>;
}

async function parseSpreadsheetFile(file: File): Promise<Record<string, unknown>[]> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".csv")) {
    const Papa = (await import("papaparse")).default;
    const text = await file.text();
    const result = Papa.parse<Record<string, unknown>>(text, {
      header: true,
      skipEmptyLines: "greedy",
    });
    const fatal = result.errors.find((e) => e.type === "Quotes" || e.type === "FieldMismatch");
    if (fatal) {
      throw new Error(`CSV 解析エラー: ${fatal.message}`);
    }
    const rows = (result.data as Record<string, unknown>[]).filter((row) =>
      Object.values(row).some((v) => String(v ?? "").trim().length > 0),
    );
    return rows;
  }
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    const XLSX = await import("xlsx");
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array", cellDates: true });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) throw new Error("シートがありません");
    const sheet = wb.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false });
    return data.filter((row) => Object.values(row).some((v) => String(v ?? "").trim().length > 0));
  }
  throw new Error("対応形式は .csv / .xlsx / .xls です");
}

function serializeRowsForAction(rows: SellerImportSourceRow[]): string {
  return JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

export function SellersImportPanel() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [fileName, setFileName] = useState("");
  const [sourceType, setSourceType] = useState<"excel" | "csv">("excel");
  const [parsedRows, setParsedRows] = useState<SellerImportSourceRow[] | null>(null);
  const [preview, setPreview] = useState<SellerImportPreviewRow[] | null>(null);
  const [counts, setCounts] = useState<{ total: number; new: number; update: number; error: number } | null>(
    null,
  );
  const [message, setMessage] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const resetPreview = useCallback(() => {
    setParsedRows(null);
    setPreview(null);
    setCounts(null);
    setMessage(null);
    setWarning(null);
    setError(null);
  }, []);

  const handleFile = useCallback(
    async (file: File | null) => {
      resetPreview();
      if (!file) return;
      setFileName(file.name);
      setSourceType(file.name.toLowerCase().endsWith(".csv") ? "csv" : "excel");
      try {
        const objects = await parseSpreadsheetFile(file);
        const rows = buildSellerImportRowsFromObjects(objects);
        setParsedRows(rows);
        startTransition(async () => {
          const res = await previewSellerImportRowsAction(serializeRowsForAction(rows));
          if (!res.ok) {
            setError(res.error);
            return;
          }
          setPreview(res.rows);
          setCounts(res.counts);
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : "ファイルの読み取りに失敗しました");
      }
    },
    [resetPreview],
  );

  const runImport = useCallback(() => {
    if (!parsedRows?.length) return;
    setMessage(null);
    setWarning(null);
    setError(null);
    startTransition(async () => {
      const res = await executeSellerImportRowsAction(serializeRowsForAction(parsedRows), fileName, sourceType);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setMessage(res.message);
      setWarning(res.warning ?? null);
      resetPreview();
      setFileName("");
      router.refresh();
    });
  }, [fileName, parsedRows, resetPreview, router, sourceType]);

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-zinc-100">Excel / CSV 取込</h2>
          <p className="mt-1 text-xs text-zinc-500">
            列: 創建時間・会社名・SHOP名・担当者・電話・メール。重複はメール → 電話 → 会社名+SHOP名の順で判定し、既存行を更新します。
          </p>
          <p className="mt-2">
            <Link
              href="/admin/seller-import-histories"
              className="text-sm font-medium text-cyan-400 hover:underline"
            >
              取込履歴一覧 →
            </Link>
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setOpen((v) => !v);
            if (open) resetPreview();
          }}
          className="inline-flex min-h-[40px] shrink-0 items-center justify-center rounded-lg border border-cyan-800/60 bg-cyan-950/40 px-4 py-2 text-sm font-medium text-cyan-200 hover:bg-cyan-950/70"
        >
          {open ? "取込を閉じる" : "Excel/CSV取込"}
        </button>
      </div>

      {open ? (
        <div className="mt-4 space-y-4 border-t border-zinc-800 pt-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1">
              <label className="text-[11px] font-medium text-zinc-500" htmlFor="seller-import-file">
                ファイル
              </label>
              <input
                id="seller-import-file"
                type="file"
                accept=".csv,.xlsx,.xls"
                className="mt-1 block w-full text-sm text-zinc-300 file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-800 file:px-3 file:py-2 file:text-sm file:text-zinc-200"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  void handleFile(f);
                  e.target.value = "";
                }}
              />
            </div>
          </div>

          {error ? (
            <div className="rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-sm text-red-200">{error}</div>
          ) : null}
          {message ? (
            <div className="rounded-lg border border-emerald-900/40 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-200">
              {message}
            </div>
          ) : null}
          {warning ? (
            <div className="rounded-lg border border-amber-800/50 bg-amber-950/25 px-3 py-2 text-sm text-amber-100">
              {warning}
            </div>
          ) : null}

          {pending && !preview ? (
            <p className="text-sm text-zinc-500">プレビューを計算しています…</p>
          ) : null}

          {counts && preview ? (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-center">
                  <p className="text-[10px] uppercase text-zinc-500">対象</p>
                  <p className="font-mono text-lg text-zinc-100">{counts.total}</p>
                </div>
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-center">
                  <p className="text-[10px] uppercase text-zinc-500">新規</p>
                  <p className="font-mono text-lg text-emerald-300">{counts.new}</p>
                </div>
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-center">
                  <p className="text-[10px] uppercase text-zinc-500">更新</p>
                  <p className="font-mono text-lg text-amber-200">{counts.update}</p>
                </div>
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-center">
                  <p className="text-[10px] uppercase text-zinc-500">エラー</p>
                  <p className="font-mono text-lg text-red-300">{counts.error}</p>
                </div>
              </div>

              <div className="overflow-x-auto rounded-lg border border-zinc-800">
                <table className="min-w-[720px] w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-zinc-800 bg-zinc-900/80 text-[11px] uppercase text-zinc-500">
                      <th className="px-3 py-2">#</th>
                      <th className="px-3 py-2">会社名</th>
                      <th className="px-3 py-2">SHOP名</th>
                      <th className="px-3 py-2">担当者</th>
                      <th className="px-3 py-2">電話</th>
                      <th className="px-3 py-2">メール</th>
                      <th className="px-3 py-2">取込</th>
                      <th className="px-3 py-2">備考</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((r) => (
                      <tr key={r.index} className="border-b border-zinc-800/80">
                        <td className="px-3 py-2 font-mono text-xs text-zinc-500">{r.index + 1}</td>
                        <td className="max-w-[10rem] truncate px-3 py-2 text-zinc-200" title={r.seller_name}>
                          {r.seller_name}
                        </td>
                        <td className="max-w-[10rem] truncate px-3 py-2 text-zinc-300" title={r.shop_name}>
                          {r.shop_name}
                        </td>
                        <td className="max-w-[8rem] truncate px-3 py-2 text-xs text-zinc-400">{r.contact_person ?? "—"}</td>
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-zinc-400">
                          {r.contact_phone ?? "—"}
                        </td>
                        <td className="max-w-[12rem] truncate px-3 py-2 font-mono text-xs text-zinc-400">
                          {r.contact_email ?? "—"}
                        </td>
                        <td className="px-3 py-2">{statusBadge(r.status)}</td>
                        <td className="max-w-[14rem] truncate px-3 py-2 text-xs text-red-300/90" title={r.errorMessage}>
                          {r.errorMessage ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={pending || !parsedRows?.length || counts.new + counts.update === 0}
                  onClick={runImport}
                  className="inline-flex min-h-[44px] min-w-[10rem] items-center justify-center rounded-lg bg-gradient-to-r from-cyan-600/90 to-fuchsia-600/80 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-40"
                >
                  {pending ? "実行中…" : "取り込み実行"}
                </button>
                <button
                  type="button"
                  onClick={resetPreview}
                  className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-400 hover:bg-zinc-900"
                >
                  クリア
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
