"use client";

import Link from "next/link";
import type { ShopIdCandidateDelta } from "@/lib/db/shop-id-candidate-queries";
import {
  createSellerFromShopPerformanceAction,
  createSellerInvoiceDraftAction,
  createSellersFromShopPerformanceBulkAction,
  executeShopPerformanceImportAction,
  linkShopPerformanceToSellerAction,
  previewShopPerformanceImportAction,
  type ShopPerformancePreviewResult,
} from "@/app/actions/shop-performance";
import type { ShopPerformanceBillingView } from "@/lib/db/shop-performance-queries";
import { formatRateDisplay } from "@/lib/db/sellers-queries";
import { parsePeriodFromShopListFilename } from "@/lib/shop-performance/normalize";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

type SellerOption = {
  id: string;
  seller_name: string;
  shop_name: string;
  tsp_rate: number | null;
};

type BatchRow = {
  id: string;
  file_name: string | null;
  period_start: string;
  period_end: string;
  row_total: number;
  upserted_count: number;
  failed_count: number;
  created_at: string;
};

type Props = {
  rows: ShopPerformanceBillingView[];
  batches: BatchRow[];
  sellers: SellerOption[];
};

const th =
  "whitespace-nowrap border-b border-zinc-800 bg-zinc-950/98 px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-400";
const td = "border-b border-zinc-800/80 px-3 py-2 text-sm text-zinc-200";
const inputClass =
  "mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-cyan-700";
const labelClass = "text-[11px] font-medium text-zinc-500";

function formatYen(value: number | null | undefined): string {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return `${Math.round(Number(value)).toLocaleString("ja-JP")}円`;
}

function downloadBillingCsv(rows: ShopPerformanceBillingView[]) {
  const header = [
    "ショップ名",
    "Shop ID",
    "期間開始",
    "期間終了",
    "GMV",
    "販売数",
    "契約料率",
    "請求額（税込）",
    "source",
    "セラー紐付け状態",
    "セラー名",
  ];
  const escape = (cell: string | number) => {
    const s = String(cell);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = rows.map((r) => [
    r.shop_name,
    r.sellers_shop_id ?? r.shop_id ?? "",
    r.period_start,
    r.period_end,
    r.gmv_amount,
    r.items_sold ?? "",
    r.tsp_rate ?? "",
    r.seller_fee ?? "",
    r.source,
    r.billing_status_label,
    r.seller_name ?? "",
  ]);
  const body = [header.map(escape).join(","), ...lines.map((row) => row.map(escape).join(","))].join(
    "\n",
  );
  const blob = new Blob(["\uFEFF", body], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `shop_performance_billing_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function ShopPerformanceClient({ rows, batches, sellers }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [file, setFile] = useState<File | null>(null);
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [preview, setPreview] = useState<Extract<
    ShopPerformancePreviewResult,
    { ok: true }
  > | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  /* 取込完了後に出す Shop ID 候補の状況（取込前との差分つき） */
  const [shopIdCandidates, setShopIdCandidates] =
    useState<ShopIdCandidateDelta | null>(null);
  const [rowsWithShopId, setRowsWithShopId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [linkSellerByImport, setLinkSellerByImport] = useState<Record<string, string>>({});
  const [selectedImportIds, setSelectedImportIds] = useState<string[]>([]);

  const unlinkedRows = useMemo(
    () => rows.filter((r) => !r.seller_id),
    [rows],
  );

  function toggleSelectedImport(importId: string) {
    setSelectedImportIds((prev) =>
      prev.includes(importId)
        ? prev.filter((id) => id !== importId)
        : [...prev, importId],
    );
  }

  function toggleAllUnlinked() {
    setSelectedImportIds((prev) =>
      prev.length === unlinkedRows.length
        ? []
        : unlinkedRows.map((row) => row.id),
    );
  }

  function createSelectedTemporarySellers() {
    if (selectedImportIds.length === 0) {
      setError("仮登録するショップを選択してください");
      return;
    }

    startTransition(async () => {
      setError(null);
      setMessage(null);

      const result = await createSellersFromShopPerformanceBulkAction({
        importIds: selectedImportIds,
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      setSelectedImportIds([]);
      setMessage(result.message);
      router.refresh();
    });
  }

  function onFileChange(next: File | null) {
    setFile(next);
    setPreview(null);
    setMessage(null);
    setError(null);
    if (!next) return;
    const suggested = parsePeriodFromShopListFilename(next.name);
    if (suggested) {
      setPeriodStart(suggested.periodStart);
      setPeriodEnd(suggested.periodEnd);
    }
  }

  function runPreview() {
    if (!file) {
      setError("ファイルを選択してください");
      return;
    }
    const fd = new FormData();
    fd.set("file", file);
    fd.set("period_start", periodStart);
    fd.set("period_end", periodEnd);
    startTransition(async () => {
      setError(null);
      setMessage(null);
      const result = await previewShopPerformanceImportAction(fd);
      if (!result.ok) {
        setError(result.error);
        setPreview(null);
        return;
      }
      setPreview(result);
      setPeriodStart(result.periodStart);
      setPeriodEnd(result.periodEnd);
      setMessage(`プレビュー: ${result.rows.length} 行`);
    });
  }

  function runImport() {
    if (!file) {
      setError("ファイルを選択してください");
      return;
    }
    const fd = new FormData();
    fd.set("file", file);
    fd.set("period_start", periodStart);
    fd.set("period_end", periodEnd);
    startTransition(async () => {
      setError(null);
      const result = await executeShopPerformanceImportAction(fd);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMessage(result.message);
      setShopIdCandidates(result.shopIdCandidates);
      setRowsWithShopId(result.rowsWithShopId);
      setPreview(null);
      router.refresh();
    });
  }

  function linkRow(importId: string, shopName: string) {
    const sellerId = linkSellerByImport[importId];
    if (!sellerId) {
      setError("紐付けるセラーを選択してください");
      return;
    }
    startTransition(async () => {
      setError(null);
      const result = await linkShopPerformanceToSellerAction({
        importId,
        sellerId,
        aliasShopName: shopName,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMessage(result.message);
      router.refresh();
    });
  }

  function createInvoiceDraft(importId: string) {
    startTransition(async () => {
      setError(null);
      setMessage(null);

      const result = await createSellerInvoiceDraftAction({
        importId,
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      setMessage(result.message);
      router.refresh();
    });
  }

  function createTemporarySeller(importId: string) {
    startTransition(async () => {
      setError(null);
      setMessage(null);

      const result = await createSellerFromShopPerformanceAction({
        importId,
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      setMessage(result.message);
      router.refresh();
    });
  }

  return (
    <div className="space-y-8">
      <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 sm:p-5">
        <h2 className="text-base font-semibold text-zinc-100">Shop ranking 取込</h2>
        <p className="mt-1 text-xs text-zinc-500">
          Partner Center の ShopList_YYYY-MM-DD_YYYY-MM-DD.xlsx を想定。空ヘッダー列は raw
          のみ保持し請求には使いません。
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="sm:col-span-3">
            <label className={labelClass} htmlFor="sp-file">
              XLSX ファイル
            </label>
            <input
              id="sp-file"
              type="file"
              accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className={inputClass}
              onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="sp-start">
              期間開始
            </label>
            <input
              id="sp-start"
              type="date"
              value={periodStart}
              onChange={(e) => setPeriodStart(e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="sp-end">
              期間終了
            </label>
            <input
              id="sp-end"
              type="date"
              value={periodEnd}
              onChange={(e) => setPeriodEnd(e.target.value)}
              className={inputClass}
            />
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={runPreview}
            className="rounded-lg border border-zinc-600 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-100 hover:bg-zinc-800 disabled:opacity-50"
          >
            プレビュー
          </button>
          <button
            type="button"
            disabled={pending || !preview}
            onClick={runImport}
            className="rounded-lg bg-cyan-700 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-600 disabled:opacity-50"
          >
            取込実行
          </button>
        </div>
        {error ? (
          <p className="mt-3 text-sm text-red-300" role="alert">
            {error}
          </p>
        ) : null}
        {message ? <p className="mt-3 text-sm text-emerald-300">{message}</p> : null}

        {shopIdCandidates ? (
          <div className="mt-3 space-y-2 rounded-lg border border-fuchsia-500/25 bg-fuchsia-500/[0.06] px-3 py-3 text-xs text-zinc-200">
            <p className="font-semibold text-zinc-100">Shop ID 候補の状況</p>

            {rowsWithShopId === 0 ? (
              <p className="text-[11px] leading-relaxed text-amber-200">
                このファイルには Shop ID 列がありません（ShopList の書き出しにはショップ名と実績値しか含まれません）。
                そのため今回の取込で新しい Shop ID 候補は増えません。
                Shop ID は Partner Center の同期データ、または手動設定から登録してください。
              </p>
            ) : (
              <p className="text-[11px] leading-relaxed text-zinc-400">
                取り込んだ {rowsWithShopId} 行が Shop ID を持っていました。
              </p>
            )}

            <ul className="space-y-0.5 text-[11px]">
              <li>
                新しく Shop ID を特定できたセラー:{" "}
                <span className="font-mono text-cyan-200">
                  {shopIdCandidates.newlyConfident.length}件
                </span>
              </li>
              <li>
                新しく要確認になったセラー:{" "}
                <span className="font-mono text-amber-200">
                  {shopIdCandidates.newlyReview.length}件
                </span>
              </li>
            </ul>

            {shopIdCandidates.newlyConfident.length > 0 ? (
              <ul className="max-h-32 space-y-0.5 overflow-auto text-[11px] text-zinc-400">
                {shopIdCandidates.newlyConfident.map((c) => (
                  <li key={c.shopId}>
                    ・{c.sellerName}（{c.shopName || "—"}） → {c.shopId}
                  </li>
                ))}
              </ul>
            ) : null}

            <p className="text-[11px] text-zinc-400">
              現在の確定候補 <span className="font-mono text-cyan-200">{shopIdCandidates.confident}件</span>
              {" / "}要確認 <span className="font-mono text-amber-200">{shopIdCandidates.review}件</span>
              {" / "}候補なし <span className="font-mono text-zinc-300">{shopIdCandidates.none}件</span>
              {" / "}紐付け済み <span className="font-mono text-emerald-200">{shopIdCandidates.linked}件</span>
            </p>

            <Link
              href="/admin/sellers?panel=shop-id"
              className="inline-flex min-h-[36px] items-center rounded-lg border border-fuchsia-500/30 bg-fuchsia-500/10 px-3 text-xs font-medium text-fuchsia-200 hover:bg-fuchsia-500/20"
            >
              Shop ID候補を確認 →
            </Link>

            <p className="text-[11px] text-zinc-600">
              取込では sellers.shop_id を自動更新しません。管理画面で確認してから適用してください。
            </p>
          </div>
        ) : null}

        {preview ? (
          <div className="mt-4 overflow-x-auto rounded-lg border border-zinc-800">
            <table className="min-w-full text-left">
              <thead>
                <tr>
                  <th className={th}>Shop name</th>
                  <th className={th}>GMV</th>
                  <th className={th}>紐付け</th>
                  <th className={th}>更新?</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.shopNameNormalized}>
                    <td className={td}>{r.shopName}</td>
                    <td className={td}>{formatYen(r.gmvAmount)}</td>
                    <td className={td}>
                      {r.linkStatus === "auto_alias"
                        ? "別名で自動"
                        : r.linkStatus === "candidates"
                          ? `候補 ${r.candidates.length}（取込後に確定）`
                          : "未紐付け"}
                    </td>
                    <td className={td}>{r.willUpdateExisting ? "更新" : "新規"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-zinc-100">請求プレビュー</h2>
          <button
            type="button"
            onClick={() => downloadBillingCsv(rows)}
            className="rounded-lg border border-zinc-600 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-900"
          >
            表示中をCSV出力
          </button>
        </div>
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="min-w-full text-left">
            <thead>
              <tr>
                <th className={th}>ショップ名</th>
                <th className={th}>Shop ID</th>
                <th className={th}>期間</th>
                <th className={th}>GMV</th>
                <th className={th}>返金GMV</th>
                <th className={th}>請求対象GMV</th>
                <th className={th}>契約料率</th>
                <th className={th}>請求額（税込）</th>
                <th className={th}>source</th>
                <th className={th}>紐付け</th>
                <th className={th}>請求書</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td className={`${td} text-zinc-500`} colSpan={11}>
                    取込データがありません
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id}>
                    <td className={td}>{r.shop_name}</td>
                    <td className={`${td} font-mono text-xs`}>
                      {r.sellers_shop_id ?? r.shop_id ?? "—"}
                    </td>
                    <td className={td}>
                      {r.period_start} ~ {r.period_end}
                    </td>
                    <td className={td}>{formatYen(r.gmv_amount)}</td>
                    <td className={td}>{formatYen(r.refund_amount ?? 0)}</td>
                    <td className={td}>{formatYen(r.billing_gmv_amount)}</td>
                    <td className={td}>{formatRateDisplay(r.tsp_rate)}</td>
                    <td className={td}>
                      {r.seller_fee != null ? (
                        formatYen(r.seller_fee)
                      ) : (
                        <span className="text-amber-300">{r.billing_status_label}</span>
                      )}
                    </td>
                    <td className={td}>{r.source}</td>
                    <td className={td}>
                      {r.seller_id ? (
                        <span className="text-emerald-300">
                          {r.seller_name ?? "紐付け済"}
                        </span>
                      ) : (
                        <span className="text-amber-300">未紐付け</span>
                      )}
                    </td>

                    <td className={td}>
                      <button
                        type="button"
                        disabled={
                          pending ||
                          r.billing_status !== "ok" ||
                          r.seller_fee == null
                        }
                        onClick={() => createInvoiceDraft(r.id)}
                        className="whitespace-nowrap rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-1.5 text-xs font-semibold text-cyan-200 hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        ドラフト作成
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {unlinkedRows.length > 0 ? (
        <section className="space-y-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
          <h2 className="text-base font-semibold text-amber-100">セラー紐付け（admin確定）</h2>
          <p className="text-xs text-amber-200/80">
            ショップ名だけでは自動確定しません。候補から選択するか、セラー管理で作成後に紐付けてください。
          </p>
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/20 bg-zinc-950/60 p-3">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-200">
              <input
                type="checkbox"
                checked={
                  unlinkedRows.length > 0 &&
                  selectedImportIds.length === unlinkedRows.length
                }
                onChange={toggleAllUnlinked}
                disabled={pending}
                className="h-4 w-4"
              />
              未紐付けを全選択
            </label>

            <span className="text-xs text-zinc-500">
              {selectedImportIds.length}件選択中
            </span>

            <button
              type="button"
              disabled={pending || selectedImportIds.length === 0}
              onClick={createSelectedTemporarySellers}
              className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              選択したショップを仮セラー登録
            </button>
          </div>

          <div className="space-y-3">
            {unlinkedRows.map((r) => (
              <div
                key={r.id}
                className="flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-950/80 p-3 sm:flex-row sm:items-end"
              >
                <label className="flex items-center self-start pb-2 sm:self-center sm:pb-0">
                  <input
                    type="checkbox"
                    checked={selectedImportIds.includes(r.id)}
                    onChange={() => toggleSelectedImport(r.id)}
                    disabled={pending}
                    className="h-4 w-4"
                    aria-label={`${r.shop_name}を選択`}
                  />
                </label>

                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-zinc-100">{r.shop_name}</p>
                  <p className="text-xs text-zinc-500">
                    {r.period_start} ~ {r.period_end} / GMV {formatYen(r.gmv_amount)}
                  </p>
                </div>
                <select
                  className={inputClass + " sm:max-w-xs"}
                  value={linkSellerByImport[r.id] ?? ""}
                  onChange={(e) =>
                    setLinkSellerByImport((prev) => ({
                      ...prev,
                      [r.id]: e.target.value,
                    }))
                  }
                >
                  <option value="">セラーを選択</option>
                  {sellers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.seller_name}
                      {s.shop_name ? ` / ${s.shop_name}` : ""}
                    </option>
                  ))}
                </select>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => linkRow(r.id, r.shop_name)}
                    className="rounded-lg bg-zinc-100 px-3 py-2 text-sm font-semibold text-zinc-900 disabled:opacity-50"
                  >
                    紐付け確定
                  </button>

                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => createTemporarySeller(r.id)}
                    className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm font-semibold text-amber-200 hover:bg-amber-500/20 disabled:opacity-50"
                  >
                    仮セラー登録
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-base font-semibold text-zinc-100">取込履歴</h2>
        <ul className="space-y-2 text-sm text-zinc-400">
          {batches.length === 0 ? (
            <li>履歴はまだありません</li>
          ) : (
            batches.map((b) => (
              <li key={b.id} className="rounded-lg border border-zinc-800 px-3 py-2">
                <span className="text-zinc-200">{b.file_name ?? "(無題)"}</span>
                {" · "}
                {b.period_start}~{b.period_end}
                {" · "}
                {b.upserted_count}/{b.row_total} 件
                {b.failed_count > 0 ? ` · 失敗 ${b.failed_count}` : ""}
              </li>
            ))
          )}
        </ul>
      </section>
    </div>
  );
}
