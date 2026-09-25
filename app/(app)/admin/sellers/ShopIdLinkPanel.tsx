"use client";

import { useActionState, useMemo, useState } from "react";

import {
  applyShopIdLinkBulkAction,
  setSellerShopIdManuallyAction,
  type SellerBulkResult,
} from "@/app/actions/seller-bulk";
import {
  SHOP_ID_LINK_STATE_LABEL,
  isTikTokShopIdFormat,
  SHOP_ID_MATCH_REASON_LABEL,
  buildShopIdLinkRows,
  validateShopIdAssignments,
  type ShopIdCandidateSource,
  type ShopIdLinkSeller,
  type ShopIdLinkState,
} from "@/lib/sellers/shop-id-candidates";

/*
  TikTok Shop ID の紐付け。

  候補は lib/sellers/shop-id-candidates.ts が作る。
  この画面は供給元（ショップ実績）を知らない。外部APIは使わない。

  確定候補でも自動では保存しない。管理者が選んでプレビューを確認してから適用する。
*/

const th =
  "whitespace-nowrap border-b border-zinc-800 bg-zinc-900/80 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-500";

const STATE_CLASS: Record<ShopIdLinkState, string> = {
  linked: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  confident: "border-cyan-400/25 bg-cyan-400/10 text-cyan-200",
  review: "border-amber-400/25 bg-amber-400/10 text-amber-200",
  none: "border-zinc-700 bg-zinc-800/50 text-zinc-400",
};

const STATE_ORDER: ShopIdLinkState[] = ["confident", "review", "none", "linked"];

export function ShopIdLinkPanel({
  sellers,
  sources,
  sourceError,
  aliases,
  defaultOpen = false,
}: {
  sellers: ShopIdLinkSeller[];
  sources: ShopIdCandidateSource[];
  sourceError: string | null;
  aliases: Array<{ seller_id: string; alias_normalized: string }>;
  /** ショップ実績の取込完了画面から遷移してきた場合は開いた状態にする */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [selected, setSelected] = useState<Map<string, string>>(new Map());
  const [confirmed, setConfirmed] = useState(false);
  const [stateFilter, setStateFilter] = useState<ShopIdLinkState | "all">("confident");
  const [query, setQuery] = useState("");

  const [result, action, pending] = useActionState<SellerBulkResult | null, FormData>(
    applyShopIdLinkBulkAction,
    null,
  );

  /* 実績に現れないショップ向けの手動設定 */
  const [manualSellerId, setManualSellerId] = useState("");
  const [manualShopId, setManualShopId] = useState("");
  const [manualResult, manualAction, manualPending] = useActionState<
    SellerBulkResult | null,
    FormData
  >(setSellerShopIdManuallyAction, null);

  const rows = useMemo(
    () => buildShopIdLinkRows({ sellers, sources, aliases }),
    [sellers, sources, aliases],
  );

  const counts = useMemo(() => {
    const out: Record<ShopIdLinkState, number> = {
      linked: 0,
      confident: 0,
      review: 0,
      none: 0,
    };
    for (const r of rows) out[r.state] += 1;
    return out;
  }, [rows]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows
      .filter((r) => (stateFilter === "all" ? true : r.state === stateFilter))
      .filter(
        (r) =>
          !q ||
          r.sellerName.toLowerCase().includes(q) ||
          r.shopName.toLowerCase().includes(q),
      );
  }, [rows, stateFilter, query]);

  const assignments = useMemo(
    () => [...selected].map(([sellerId, shopId]) => ({ sellerId, shopId })),
    [selected],
  );

  const check = useMemo(
    () => validateShopIdAssignments(sellers, assignments),
    [sellers, assignments],
  );

  const nameById = useMemo(
    () => new Map(sellers.map((s) => [s.id, s.seller_name])),
    [sellers],
  );

  function pick(sellerId: string, shopId: string) {
    setConfirmed(false);
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.get(sellerId) === shopId) next.delete(sellerId);
      else next.set(sellerId, shopId);
      return next;
    });
  }

  /** 表示中の確定候補だけをまとめて選ぶ */
  function selectVisibleConfident() {
    setConfirmed(false);
    const next = new Map(selected);
    for (const r of visible) {
      if (r.state === "confident" && r.suggestedShopId) {
        next.set(r.sellerId, r.suggestedShopId);
      }
    }
    setSelected(next);
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-900"
      >
        TikTok Shop紐付け
      </button>
    );
  }

  return (
    <section className="space-y-4 rounded-xl border border-fuchsia-500/20 bg-fuchsia-500/[0.04] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">TikTok Shop紐付け</h2>
          <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
            候補はショップ実績（shop_performance_imports）の Shop ID から作成しています。
            注文CSVの Shop Code は別の識別子のため使用しません。
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-zinc-500 hover:text-zinc-300"
        >
          閉じる
        </button>
      </div>

      {sourceError ? (
        <p className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
          候補の取得に失敗しました: {sourceError}
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {STATE_ORDER.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setStateFilter(stateFilter === k ? "all" : k)}
            className={`rounded-lg border px-3 py-2 text-center transition ${
              stateFilter === k ? STATE_CLASS[k] : "border-zinc-800 bg-zinc-900/50"
            }`}
          >
            <p className="text-[10px] uppercase text-zinc-500">
              {SHOP_ID_LINK_STATE_LABEL[k]}
            </p>
            <p className="font-mono text-lg">{counts[k]}</p>
          </button>
        ))}
      </div>

      {result && !result.ok ? (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200" role="alert">
          {result.error}
        </p>
      ) : null}
      {result?.ok ? (
        <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
          <p className="font-semibold">{result.message}</p>
          {result.details.length > 0 ? (
            <ul className="mt-1 space-y-0.5 text-[11px] text-emerald-200/80">
              {result.details.slice(0, 20).map((d, i) => (
                <li key={i}>・{d}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="セラー名・ショップ名で絞り込み"
          className="min-w-[14rem] flex-1 rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100"
        />
        <button
          type="button"
          onClick={selectVisibleConfident}
          className="min-h-[38px] rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 text-xs text-cyan-200 hover:bg-cyan-500/20"
        >
          表示中の確定候補を選択
        </button>
        <button
          type="button"
          onClick={() => {
            setSelected(new Map());
            setConfirmed(false);
          }}
          className="min-h-[38px] rounded-lg border border-zinc-700 px-3 text-xs text-zinc-400 hover:bg-zinc-900"
        >
          選択をクリア
        </button>
      </div>

      <div className="max-h-[26rem] overflow-auto rounded-lg border border-zinc-800">
        <table className="w-full min-w-[900px] border-collapse text-sm">
          <thead className="sticky top-0">
            <tr>
              <th className={th}>状態</th>
              <th className={th}>セラー名</th>
              <th className={th}>DBのショップ名</th>
              <th className={th}>現在の Shop ID</th>
              <th className={th}>候補（実績側のショップ名 / Shop ID / 一致根拠）</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-xs text-zinc-500">
                  条件に一致するセラーがありません。
                </td>
              </tr>
            ) : (
              visible.map((r) => (
                <tr key={r.sellerId} className="border-b border-zinc-800/60 align-top">
                  <td className="whitespace-nowrap px-3 py-2">
                    <span className={`rounded-full border px-2 py-0.5 text-[11px] ${STATE_CLASS[r.state]}`}>
                      {SHOP_ID_LINK_STATE_LABEL[r.state]}
                    </span>
                  </td>
                  <td className="max-w-[12rem] truncate px-3 py-2 text-zinc-200" title={r.sellerName}>
                    {r.sellerName}
                  </td>
                  <td className="max-w-[11rem] truncate px-3 py-2 text-xs text-zinc-400" title={r.shopName}>
                    {r.shopName || "—"}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-zinc-400">
                    {r.currentShopId ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    {r.state === "linked" ? (
                      <span className="text-[11px] text-zinc-600">紐付け済みのため変更しません</span>
                    ) : r.candidates.length === 0 ? (
                      <span className="text-[11px] text-zinc-600">
                        実績に対応するショップがまだありません
                      </span>
                    ) : (
                      <div className="space-y-1">
                        {r.reviewReason ? (
                          <p className="text-[11px] text-amber-300/90">{r.reviewReason}</p>
                        ) : null}
                        {r.candidates.map((c) => (
                          <label
                            key={c.shopId}
                            className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-300"
                          >
                            <input
                              type="checkbox"
                              checked={selected.get(r.sellerId) === c.shopId}
                              onChange={() => pick(r.sellerId, c.shopId)}
                            />
                            <span className="text-zinc-200">{c.shopName}</span>
                            <span className="font-mono text-zinc-500">{c.shopId}</span>
                            <span className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400">
                              {SHOP_ID_MATCH_REASON_LABEL[c.matchReason]}
                            </span>
                            <span className="text-[10px] text-zinc-600">
                              {c.sourceLabel}
                              {c.note ? ` / ${c.note}` : ""}
                            </span>
                            {c.conflictWithSellerName ? (
                              <span className="text-[10px] text-red-300">
                                「{c.conflictWithSellerName}」が使用中
                              </span>
                            ) : null}
                          </label>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {assignments.length > 0 ? (
        <div className="space-y-2 rounded-lg border border-white/[0.08] bg-surface-0/50 p-3">
          <p className="text-xs font-semibold text-zinc-200">
            プレビュー: {check.accepted.length}件を紐付け / {check.rejected.length}件を除外
          </p>

          <ul className="max-h-40 space-y-0.5 overflow-auto text-[11px] text-zinc-400">
            {check.accepted.map((a) => (
              <li key={a.sellerId}>
                ・{nameById.get(a.sellerId) ?? a.sellerId} → shop_id = {a.shopId}
              </li>
            ))}
          </ul>

          {check.rejected.length > 0 ? (
            <ul className="max-h-32 space-y-0.5 overflow-auto text-[11px] text-red-200/90">
              {check.rejected.map((r, i) => (
                <li key={`${r.sellerId}-${i}`}>
                  ・{nameById.get(r.sellerId) ?? r.sellerId}: {r.reason}
                </li>
              ))}
            </ul>
          ) : null}

          <label className="flex items-center gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={check.accepted.length === 0}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            上記 {check.accepted.length} 件の内容を確認しました
          </label>

          <form action={action}>
            <input
              type="hidden"
              name="assignments"
              value={assignments.map((a) => `${a.sellerId}:${a.shopId}`).join(",")}
            />
            <button
              type="submit"
              disabled={pending || !confirmed || check.accepted.length === 0}
              className="min-h-[40px] rounded-lg bg-white px-4 text-sm font-semibold text-zinc-950 transition hover:bg-zinc-200 disabled:opacity-40"
            >
              {pending ? "紐付け中…" : `選択した ${check.accepted.length} 件を紐付け`}
            </button>
          </form>

          <p className="text-[11px] leading-relaxed text-zinc-600">
            適用時にDBを読み直し、Shop IDの重複・既存値の上書きを再検証します。
            既に Shop ID が入っているセラーは上書きしません。
          </p>
        </div>
      ) : (
        <p className="text-xs text-zinc-500">候補をチェックすると、プレビューが表示されます。</p>
      )}

      {/* 実績にまだ現れないショップ用の手動設定 */}
      <div className="space-y-2 rounded-lg border border-white/[0.08] bg-surface-0/50 p-3">
        <p className="text-xs font-semibold text-zinc-200">Shop ID を手動設定</p>
        <p className="text-[11px] leading-relaxed text-zinc-500">
          売上実績がまだ無いショップは候補を作れません。Partner Center で確認した Shop ID を直接入力してください。
          保存前に、数値形式・他セラーでの使用状況・現在値が未設定かをサーバー側で再検証します。
        </p>

        {manualResult && !manualResult.ok ? (
          <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200" role="alert">
            {manualResult.error}
          </p>
        ) : null}
        {manualResult?.ok ? (
          <p className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
            {manualResult.message}
          </p>
        ) : null}

        <form action={manualAction} className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="manual-seller" className="text-[11px] font-medium text-zinc-500">
              セラー（Shop ID 未設定のみ）
            </label>
            <select
              id="manual-seller"
              name="seller_id"
              value={manualSellerId}
              onChange={(e) => setManualSellerId(e.target.value)}
              className="mt-1 w-72 rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100"
            >
              <option value="">選択してください</option>
              {sellers
                .filter((s) => !String(s.shop_id ?? "").trim())
                .sort((a, b) => a.seller_name.localeCompare(b.seller_name, "ja"))
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.seller_name}（{s.shop_name || "SHOP名なし"}）
                  </option>
                ))}
            </select>
          </div>
          <div>
            <label htmlFor="manual-shop-id" className="text-[11px] font-medium text-zinc-500">
              TikTok Shop ID（数値）
            </label>
            <input
              id="manual-shop-id"
              name="shop_id"
              value={manualShopId}
              onChange={(e) => setManualShopId(e.target.value)}
              inputMode="numeric"
              placeholder="7494573593353880665"
              className="mt-1 w-64 rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 font-mono text-sm text-zinc-100"
            />
          </div>
          <button
            type="submit"
            disabled={
              manualPending ||
              !manualSellerId ||
              !isTikTokShopIdFormat(manualShopId)
            }
            className="min-h-[40px] rounded-lg border border-zinc-600 px-4 text-sm text-zinc-200 transition hover:bg-zinc-900 disabled:opacity-40"
          >
            {manualPending ? "設定中…" : "この Shop ID を設定"}
          </button>
        </form>

        {manualShopId && !isTikTokShopIdFormat(manualShopId) ? (
          <p className="text-[11px] text-amber-300">
            Shop ID は数値のみです。注文CSVの Shop Code（英数字）は使用できません。
          </p>
        ) : null}
        <p className="text-[11px] text-zinc-600">
          既に Shop ID が設定されているセラーはここに出ません。付け替えが必要な場合はセラー編集から行ってください。
        </p>
      </div>
    </section>
  );
}
