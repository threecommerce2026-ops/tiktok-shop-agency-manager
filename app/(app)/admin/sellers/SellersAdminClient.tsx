"use client";

import {
  createSellerAction,
  deleteSellerAction,
  updateSellerAction,
} from "@/app/actions/admin-sellers";
import type { AdminActionResult } from "@/app/actions/admin-agencies";
import { SellersImportPanel } from "@/app/(app)/admin/sellers/SellersImportPanel";
import { formatRateDisplay, formatSellerStatusLabel, type SellerRow } from "@/lib/db/sellers-queries";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useCallback, useEffect, useMemo, useState } from "react";

type Props = {
  rows: SellerRow[];
};

const ALL = "all";

const th =
  "whitespace-nowrap border-b border-zinc-800 bg-zinc-950/98 px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-400";

const inputClass =
  "mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-cyan-700";
const labelClass = "text-[11px] font-medium text-zinc-500";

function formatMeetingDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit" });
}

function downloadCsv(header: string[], lines: Array<Array<string | number | boolean>>) {
  const escape = (cell: string | number | boolean) => {
    const s = String(cell);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const body = [header.map(escape).join(","), ...lines.map((row) => row.map(escape).join(","))].join("\n");
  const blob = new Blob(["\uFEFF", body], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `sellers_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function matchesSearch(row: SellerRow, q: string) {
  if (!q.trim()) return true;
  const n = q.trim().toLowerCase();
  const hay = [
    row.seller_name,
    row.shop_name,
    row.category,
    row.sample_condition,
    row.last_meeting_note,
    row.discount_condition,
    row.memo,
    row.contact_person,
    row.contact_email,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return hay.includes(n);
}

function SellerFormFields({ seller }: { seller?: SellerRow | null }) {
  return (
    <div className="grid max-h-[min(70vh,640px)] gap-3 overflow-y-auto pr-1 sm:grid-cols-2">
      {seller ? <input type="hidden" name="id" value={seller.id} /> : null}
      <div className="sm:col-span-2">
        <label className={labelClass} htmlFor="sf-seller_name">
          セラー名 <span className="text-red-400">*</span>
        </label>
        <input
          id="sf-seller_name"
          name="seller_name"
          required
          defaultValue={seller?.seller_name ?? ""}
          className={inputClass}
        />
      </div>
      <div className="sm:col-span-2">
        <label className={labelClass} htmlFor="sf-shop_name">
          ショップ名
        </label>
        <input id="sf-shop_name" name="shop_name" defaultValue={seller?.shop_name ?? ""} className={inputClass} />
      </div>
      <div>
        <label className={labelClass} htmlFor="sf-contact_person">
          担当者名
        </label>
        <input
          id="sf-contact_person"
          name="contact_person"
          defaultValue={seller?.contact_person ?? ""}
          className={inputClass}
        />
      </div>
      <div>
        <label className={labelClass} htmlFor="sf-contact_email">
          メール
        </label>
        <input
          id="sf-contact_email"
          name="contact_email"
          type="email"
          defaultValue={seller?.contact_email ?? ""}
          className={inputClass}
        />
      </div>
      <div className="sm:col-span-2">
        <label className={labelClass} htmlFor="sf-contact_phone">
          電話番号
        </label>
        <input
          id="sf-contact_phone"
          name="contact_phone"
          defaultValue={seller?.contact_phone ?? ""}
          className={inputClass}
        />
      </div>
      <div>
        <label className={labelClass} htmlFor="sf-category">
          カテゴリ
        </label>
        <input id="sf-category" name="category" defaultValue={seller?.category ?? ""} className={inputClass} />
      </div>
      <div className="sm:col-span-2">
        <label className={labelClass} htmlFor="sf-sample_condition">
          サンプル条件
        </label>
        <textarea
          id="sf-sample_condition"
          name="sample_condition"
          rows={2}
          defaultValue={seller?.sample_condition ?? ""}
          className={inputClass}
        />
      </div>
      <label className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-300">
        <input type="checkbox" name="has_smp" defaultChecked={seller?.has_smp ?? false} />
        SMP有無
      </label>
      <label className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-300">
        <input
          type="checkbox"
          name="seller_live_available"
          defaultChecked={seller?.seller_live_available ?? false}
        />
        セラーライブ可否
      </label>
      <div>
        <label className={labelClass} htmlFor="sf-tap_rate">
          TAP料率 (%)
        </label>
        <input
          id="sf-tap_rate"
          name="tap_rate"
          inputMode="decimal"
          placeholder="例: 5 または 5.5"
          defaultValue={seller?.tap_rate != null ? String(seller.tap_rate) : ""}
          className={inputClass}
        />
      </div>
      <div>
        <label className={labelClass} htmlFor="sf-tsp_rate">
          TSP料率 (%)
        </label>
        <input
          id="sf-tsp_rate"
          name="tsp_rate"
          inputMode="decimal"
          placeholder="例: 3"
          defaultValue={seller?.tsp_rate != null ? String(seller.tsp_rate) : ""}
          className={inputClass}
        />
      </div>
      <div>
        <label className={labelClass} htmlFor="sf-last_meeting_date">
          前回打ち合わせ日
        </label>
        <input
          id="sf-last_meeting_date"
          name="last_meeting_date"
          type="date"
          defaultValue={seller?.last_meeting_date?.slice(0, 10) ?? ""}
          className={inputClass}
        />
      </div>
      <div className="sm:col-span-2">
        <label className={labelClass} htmlFor="sf-last_meeting_note">
          前回打ち合わせ情報
        </label>
        <textarea
          id="sf-last_meeting_note"
          name="last_meeting_note"
          rows={2}
          defaultValue={seller?.last_meeting_note ?? ""}
          className={inputClass}
        />
      </div>
      <div className="sm:col-span-2">
        <label className={labelClass} htmlFor="sf-discount_condition">
          割引条件
        </label>
        <textarea
          id="sf-discount_condition"
          name="discount_condition"
          rows={2}
          defaultValue={seller?.discount_condition ?? ""}
          className={inputClass}
        />
      </div>
      <div className="sm:col-span-2">
        <label className={labelClass} htmlFor="sf-status">
          ステータス
        </label>
        <select
          id="sf-status"
          name="status"
          defaultValue={seller?.status ?? "pending"}
          className={inputClass}
        >
          <option value="active">稼働中</option>
          <option value="pending">保留</option>
          <option value="stopped">停止</option>
        </select>
      </div>
      <div className="sm:col-span-2">
        <label className={labelClass} htmlFor="sf-memo">
          メモ
        </label>
        <textarea id="sf-memo" name="memo" rows={3} defaultValue={seller?.memo ?? ""} className={inputClass} />
      </div>
    </div>
  );
}

function SellerModal({
  mode,
  seller,
  onClose,
  formKey,
}: {
  mode: "create" | "edit";
  seller: SellerRow | null;
  onClose: () => void;
  formKey: number;
}) {
  const router = useRouter();
  const action = mode === "create" ? createSellerAction : updateSellerAction;
  const [state, formAction, pending] = useActionState(action, null as AdminActionResult | null);

  useEffect(() => {
    if (state?.ok) {
      router.refresh();
      onClose();
    }
  }, [state, onClose, router]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="seller-modal-title"
    >
      <div className="max-h-[90vh] w-full max-w-2xl overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-xl">
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <h2 id="seller-modal-title" className="text-lg font-semibold text-zinc-100">
            {mode === "create" ? "セラーを追加" : "セラーを編集"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          >
            閉じる
          </button>
        </div>
        <form key={formKey} action={formAction} className="space-y-4 p-4">
          <SellerFormFields seller={mode === "edit" ? seller : null} />
          {state && !state.ok ? <p className="text-sm text-red-300">{state.error}</p> : null}
          <div className="flex flex-wrap gap-2 border-t border-zinc-800 pt-4">
            <button
              type="submit"
              disabled={pending}
              className="inline-flex min-h-[40px] items-center justify-center rounded-lg bg-gradient-to-r from-cyan-600/90 to-fuchsia-600/80 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {pending ? "保存中…" : mode === "create" ? "追加する" : "更新する"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-900"
            >
              キャンセル
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function SellersAdminClient({ rows }: Props) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>(ALL);
  const [smpFilter, setSmpFilter] = useState<string>(ALL);
  const [liveFilter, setLiveFilter] = useState<string>(ALL);
  const [statusFilter, setStatusFilter] = useState<string>(ALL);
  const [modal, setModal] = useState<null | { mode: "create" | "edit"; seller: SellerRow | null }>(null);
  const [formKey, setFormKey] = useState(0);

  const closeModal = useCallback(() => setModal(null), []);

  const [deleteState, deleteAction, deletePending] = useActionState(deleteSellerAction, null as AdminActionResult | null);

  useEffect(() => {
    if (deleteState?.ok) {
      router.refresh();
    }
  }, [deleteState, router]);

  const categoryOptions = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) {
      if (r.category?.trim()) s.add(r.category.trim());
    }
    return [...s].sort((a, b) => a.localeCompare(b, "ja"));
  }, [rows]);

  const filtered = useMemo(() => {
    return rows.filter((row) => {
      if (!matchesSearch(row, search)) return false;
      if (categoryFilter !== ALL && (row.category?.trim() ?? "") !== categoryFilter) return false;
      if (smpFilter === "yes" && !row.has_smp) return false;
      if (smpFilter === "no" && row.has_smp) return false;
      if (liveFilter === "yes" && !row.seller_live_available) return false;
      if (liveFilter === "no" && row.seller_live_available) return false;
      if (statusFilter !== ALL && row.status !== statusFilter) return false;
      return true;
    });
  }, [categoryFilter, liveFilter, rows, search, smpFilter, statusFilter]);

  const exportCsv = () => {
    const header = [
      "セラー名",
      "ショップ名",
      "担当者",
      "メール",
      "電話",
      "カテゴリ",
      "サンプル条件",
      "SMP有無",
      "TAP料率",
      "TSP料率",
      "前回打ち合わせ日",
      "前回打ち合わせ情報",
      "割引条件",
      "セラーライブ可否",
      "ステータス",
      "メモ",
    ];
    const lines = filtered.map((r) => [
      r.seller_name,
      r.shop_name,
      r.contact_person ?? "",
      r.contact_email ?? "",
      r.contact_phone ?? "",
      r.category ?? "",
      r.sample_condition ?? "",
      r.has_smp ? "あり" : "なし",
      r.tap_rate ?? "",
      r.tsp_rate ?? "",
      r.last_meeting_date ?? "",
      r.last_meeting_note ?? "",
      r.discount_condition ?? "",
      r.seller_live_available ? "可" : "不可",
      formatSellerStatusLabel(r.status),
      r.memo ?? "",
    ]);
    downloadCsv(header, lines);
  };

  const openCreate = () => {
    setFormKey((k) => k + 1);
    setModal({ mode: "create", seller: null });
  };

  const openEdit = (seller: SellerRow) => {
    setFormKey((k) => k + 1);
    setModal({ mode: "edit", seller });
  };

  return (
    <div className="space-y-4">
      <SellersImportPanel />

      <div className="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-950/80 p-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-zinc-500">
          表示 <span className="font-mono text-zinc-300">{filtered.length}</span> / {rows.length} 件
        </p>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/admin/seller-import-histories"
            className="inline-flex min-h-[40px] items-center justify-center rounded-lg border border-zinc-600 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-800"
          >
            取込履歴
          </Link>
          <button
            type="button"
            onClick={openCreate}
            className="inline-flex min-h-[40px] items-center justify-center rounded-lg bg-gradient-to-r from-cyan-600/90 to-fuchsia-600/80 px-4 py-2 text-sm font-semibold text-white"
          >
            セラー追加
          </button>
          <button
            type="button"
            onClick={exportCsv}
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-800"
          >
            CSV出力
          </button>
        </div>
      </div>

      <section className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-5">
          <div className="lg:col-span-2">
            <label className={labelClass} htmlFor="sl-search">
              検索
            </label>
            <input
              id="sl-search"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="名前・ショップ・メモなど"
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="sl-cat">
              カテゴリ
            </label>
            <select
              id="sl-cat"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className={inputClass}
            >
              <option value={ALL}>すべて</option>
              {categoryOptions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="sl-smp">
              SMP有無
            </label>
            <select id="sl-smp" value={smpFilter} onChange={(e) => setSmpFilter(e.target.value)} className={inputClass}>
              <option value={ALL}>すべて</option>
              <option value="yes">あり</option>
              <option value="no">なし</option>
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="sl-live">
              セラーライブ
            </label>
            <select id="sl-live" value={liveFilter} onChange={(e) => setLiveFilter(e.target.value)} className={inputClass}>
              <option value={ALL}>すべて</option>
              <option value="yes">可</option>
              <option value="no">不可</option>
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="sl-status">
              ステータス
            </label>
            <select
              id="sl-status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className={inputClass}
            >
              <option value={ALL}>すべて</option>
              <option value="active">稼働中</option>
              <option value="pending">保留</option>
              <option value="stopped">停止</option>
            </select>
          </div>
        </div>
      </section>

      {deleteState && !deleteState.ok ? (
        <p className="rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-200">{deleteState.error}</p>
      ) : null}
      {deleteState?.ok ? <p className="text-sm text-emerald-400">{deleteState.message}</p> : null}

      <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950/80">
        <table className="min-w-[1400px] w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className={th}>セラー名</th>
              <th className={th}>ショップ名</th>
              <th className={th}>カテゴリ</th>
              <th className={th}>サンプル条件</th>
              <th className={th}>SMP有無</th>
              <th className={th}>TAP料率</th>
              <th className={th}>TSP料率</th>
              <th className={th}>前回打ち合わせ日</th>
              <th className={th}>前回打ち合わせ情報</th>
              <th className={th}>割引条件</th>
              <th className={th}>セラーライブ可否</th>
              <th className={th}>ステータス</th>
              <th className={th}>メモ</th>
              <th className={`${th} sticky right-0 z-10 min-w-[8rem] border-l border-zinc-800 bg-zinc-950`}>編集</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={14} className="px-4 py-10 text-center text-zinc-500">
                  {rows.length === 0 ? "セラーがまだ登録されていません。「セラー追加」から登録してください。" : "条件に一致するセラーがありません。"}
                </td>
              </tr>
            ) : (
              filtered.map((r) => (
                <tr key={r.id} className="border-b border-zinc-800/80 bg-zinc-950/40">
                  <td className="max-w-[10rem] truncate px-3 py-2 font-medium text-zinc-100" title={r.seller_name}>
                    {r.seller_name}
                  </td>
                  <td className="max-w-[10rem] truncate px-3 py-2 text-zinc-300" title={r.shop_name}>
                    {r.shop_name || "—"}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-zinc-400">{r.category ?? "—"}</td>
                  <td className="max-w-[12rem] truncate px-3 py-2 text-xs text-zinc-400" title={r.sample_condition ?? ""}>
                    {r.sample_condition ?? "—"}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-zinc-300">{r.has_smp ? "あり" : "なし"}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs text-zinc-300">
                    {formatRateDisplay(r.tap_rate)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs text-zinc-300">
                    {formatRateDisplay(r.tsp_rate)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-zinc-500">
                    {formatMeetingDate(r.last_meeting_date)}
                  </td>
                  <td className="max-w-[14rem] truncate px-3 py-2 text-xs text-zinc-400" title={r.last_meeting_note ?? ""}>
                    {r.last_meeting_note ?? "—"}
                  </td>
                  <td className="max-w-[12rem] truncate px-3 py-2 text-xs text-zinc-400" title={r.discount_condition ?? ""}>
                    {r.discount_condition ?? "—"}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-zinc-300">
                    {r.seller_live_available ? "可" : "不可"}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-zinc-300">{formatSellerStatusLabel(r.status)}</td>
                  <td className="max-w-[12rem] truncate px-3 py-2 text-xs text-zinc-500" title={r.memo ?? ""}>
                    {r.memo ?? "—"}
                  </td>
                  <td className="sticky right-0 z-10 border-l border-zinc-800/80 bg-zinc-950 px-3 py-2">
                    <div className="flex flex-col gap-1">
                      <button
                        type="button"
                        onClick={() => openEdit(r)}
                        className="rounded border border-zinc-600 px-2 py-1 text-xs text-cyan-400 hover:bg-zinc-900"
                      >
                        編集
                      </button>
                      <form
                        action={deleteAction}
                        onSubmit={(e) => {
                          if (!window.confirm(`「${r.seller_name}」を削除しますか？（停止のみの場合は編集でステータスを「停止」にしてください）`)) {
                            e.preventDefault();
                          }
                        }}
                      >
                        <input type="hidden" name="id" value={r.id} />
                        <button
                          type="submit"
                          disabled={deletePending}
                          className="w-full rounded border border-red-900/60 px-2 py-1 text-xs text-red-300 hover:bg-red-950/50 disabled:opacity-50"
                        >
                          削除
                        </button>
                      </form>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {modal ? (
        <SellerModal
          mode={modal.mode}
          seller={modal.mode === "edit" ? modal.seller : null}
          onClose={closeModal}
          formKey={formKey}
        />
      ) : null}
    </div>
  );
}
