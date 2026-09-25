"use client";

import { useActionState, useMemo, useState } from "react";

import {
  applyTspRateBulkAction,
  type SellerBulkResult,
} from "@/app/actions/seller-bulk";
import {
  DEFAULT_TSP_RATE_PCT,
  TSP_RATE_CATEGORY_LABEL,
  classifySellerForTspRate,
  parseTspRatePct,
  planTspRateBulkUpdate,
  resolveTspRateExclusion,
  TSP_RATE_EXCLUSION_LABEL,
  type TspRateSeller,
} from "@/lib/sellers/tsp-rate-bulk";
import { formatRateDisplay, type SellerRow } from "@/lib/db/sellers-queries";

/*
  TSP契約料率の一括設定。

  対象を選ぶ → 料率を入れる → プレビュー → 確認 → 適用 の順に進む。
  「全セラーへ無条件に10%」はできない。必ず選択と確認を挟む。
*/

const th =
  "whitespace-nowrap border-b border-zinc-800 bg-zinc-900/80 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-500";

function toRateSeller(r: SellerRow): TspRateSeller {
  return {
    id: r.id,
    seller_name: r.seller_name,
    shop_name: r.shop_name,
    tsp_rate: r.tsp_rate,
    status: r.status,
    is_tsp_billing_eligible: r.is_tsp_billing_eligible,
    form_note: r.form_note,
  };
}

export function TspRateBulkPanel({ rows }: { rows: SellerRow[] }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rateInput, setRateInput] = useState(String(DEFAULT_TSP_RATE_PCT));
  const [onlyUnset, setOnlyUnset] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [query, setQuery] = useState("");

  const [state, action, pending] = useActionState<SellerBulkResult | null, FormData>(
    applyTspRateBulkAction,
    null,
  );

  const sellers = useMemo(() => rows.map(toRateSeller), [rows]);

  const counts = useMemo(() => {
    const out = { unset_eligible: 0, already_set: 0, excluded: 0 };
    for (const s of sellers) out[classifySellerForTspRate(s)] += 1;
    return out;
  }, [sellers]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sellers;
    return sellers.filter(
      (s) =>
        s.seller_name.toLowerCase().includes(q) ||
        s.shop_name.toLowerCase().includes(q),
    );
  }, [sellers, query]);

  const ratePct = parseTspRatePct(rateInput);

  const plan = useMemo(() => {
    if (ratePct == null) return null;
    return planTspRateBulkUpdate({
      sellers,
      selectedIds: [...selected],
      ratePct,
      onlyUnset,
    });
  }, [sellers, selected, ratePct, onlyUnset]);

  function toggle(id: string) {
    setConfirmed(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** 未設定かつ設定可能なセラーだけを選ぶ。全件選択ではない */
  function selectUnsetEligible() {
    setConfirmed(false);
    setSelected(
      new Set(
        visible
          .filter((s) => classifySellerForTspRate(s) === "unset_eligible")
          .map((s) => s.id),
      ),
    );
    setRateInput(String(DEFAULT_TSP_RATE_PCT));
    setOnlyUnset(true);
  }

  function clearSelection() {
    setConfirmed(false);
    setSelected(new Set());
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-900"
      >
        TSP料率 一括設定
      </button>
    );
  }

  return (
    <section className="space-y-4 rounded-xl border border-cyan-500/20 bg-cyan-500/[0.04] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">TSP料率 一括設定</h2>
          <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
            基本料率は {DEFAULT_TSP_RATE_PCT}% です。契約条件が異なるセラーは個別に料率を入力してください。
            新規セラーへ自動で料率が入ることはありません。
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

      <div className="grid grid-cols-3 gap-2">
        {(["unset_eligible", "already_set", "excluded"] as const).map((k) => (
          <div
            key={k}
            className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-center"
          >
            <p className="text-[10px] uppercase text-zinc-500">
              {TSP_RATE_CATEGORY_LABEL[k]}
            </p>
            <p
              className={`font-mono text-lg ${
                k === "unset_eligible"
                  ? "text-amber-300"
                  : k === "excluded"
                    ? "text-red-300"
                    : "text-emerald-300"
              }`}
            >
              {counts[k]}
            </p>
          </div>
        ))}
      </div>

      {state && !state.ok ? (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200" role="alert">
          {state.error}
        </p>
      ) : null}
      {state?.ok ? (
        <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
          <p className="font-semibold">{state.message}</p>
          {state.details.length > 0 ? (
            <ul className="mt-1 space-y-0.5 text-[11px] text-emerald-200/80">
              {state.details.slice(0, 20).map((d, i) => (
                <li key={i}>・{d}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="bulk-rate" className="text-[11px] font-medium text-zinc-500">
            設定する料率（%）
          </label>
          <input
            id="bulk-rate"
            value={rateInput}
            onChange={(e) => {
              setRateInput(e.target.value);
              setConfirmed(false);
            }}
            inputMode="decimal"
            className="mt-1 w-28 rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100"
          />
        </div>
        <label className="flex items-center gap-2 pb-2 text-xs text-zinc-400">
          <input
            type="checkbox"
            checked={onlyUnset}
            onChange={(e) => {
              setOnlyUnset(e.target.checked);
              setConfirmed(false);
            }}
          />
          未設定のセラーだけに適用する
        </label>
        <button
          type="button"
          onClick={selectUnsetEligible}
          className="min-h-[38px] rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 text-xs text-cyan-200 hover:bg-cyan-500/20"
        >
          未設定のセラーを選択して {DEFAULT_TSP_RATE_PCT}% にする
        </button>
        <button
          type="button"
          onClick={clearSelection}
          className="min-h-[38px] rounded-lg border border-zinc-700 px-3 text-xs text-zinc-400 hover:bg-zinc-900"
        >
          選択をクリア
        </button>
      </div>

      {ratePct == null ? (
        <p className="text-xs text-amber-300">契約料率は 0〜100 の数値で入力してください</p>
      ) : null}

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="セラー名・ショップ名で絞り込み"
        className="w-full rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100"
      />

      <div className="max-h-[22rem] overflow-auto rounded-lg border border-zinc-800">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead className="sticky top-0">
            <tr>
              <th className={th}>選択</th>
              <th className={th}>セラー名</th>
              <th className={th}>ショップ名</th>
              <th className={`${th} text-right`}>現在の料率</th>
              <th className={th}>区分</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((s) => {
              const category = classifySellerForTspRate(s);
              const exclusion = resolveTspRateExclusion(s);
              return (
                <tr key={s.id} className="border-b border-zinc-800/60">
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label={`${s.seller_name} を選択`}
                      checked={selected.has(s.id)}
                      onChange={() => toggle(s.id)}
                    />
                  </td>
                  <td className="max-w-[14rem] truncate px-3 py-2 text-zinc-200" title={s.seller_name}>
                    {s.seller_name}
                  </td>
                  <td className="max-w-[12rem] truncate px-3 py-2 text-xs text-zinc-400" title={s.shop_name}>
                    {s.shop_name || "—"}
                  </td>
                  <td
                    className={`whitespace-nowrap px-3 py-2 text-right font-mono text-xs ${
                      s.tsp_rate == null ? "text-amber-300/80" : "text-zinc-300"
                    }`}
                  >
                    {s.tsp_rate == null ? "未設定" : formatRateDisplay(s.tsp_rate)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-[11px]">
                    {exclusion ? (
                      <span className="rounded-full border border-red-400/25 bg-red-400/10 px-2 py-0.5 text-red-200">
                        TSP請求対象外（{TSP_RATE_EXCLUSION_LABEL[exclusion]}）
                      </span>
                    ) : (
                      <span className="text-zinc-500">
                        {TSP_RATE_CATEGORY_LABEL[category]}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {plan && selected.size > 0 ? (
        <div className="space-y-2 rounded-lg border border-white/[0.08] bg-surface-0/50 p-3">
          <p className="text-xs font-semibold text-zinc-200">
            プレビュー: {plan.targets.length}件を {plan.ratePct}% に変更 / {plan.skipped.length}件はスキップ
          </p>

          {plan.targets.length > 0 ? (
            <ul className="max-h-40 space-y-0.5 overflow-auto text-[11px] text-zinc-400">
              {plan.targets.map((t) => (
                <li key={t.sellerId}>
                  ・{t.sellerName}（{t.shopName || "—"}）:{" "}
                  {t.beforeRate == null ? "未設定" : `${t.beforeRate}%`} → {t.afterRate}%
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[11px] text-amber-300">変更対象がありません</p>
          )}

          {plan.skipped.length > 0 ? (
            <ul className="max-h-32 space-y-0.5 overflow-auto text-[11px] text-red-200/80">
              {plan.skipped.map((s) => (
                <li key={s.sellerId}>
                  ・{s.sellerName}: {s.reason}
                </li>
              ))}
            </ul>
          ) : null}

          <label className="flex items-center gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={plan.targets.length === 0}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            上記 {plan.targets.length} 件の内容を確認しました
          </label>

          <form action={action}>
            <input type="hidden" name="seller_ids" value={[...selected].join(",")} />
            <input type="hidden" name="rate_pct" value={rateInput} />
            <input type="hidden" name="only_unset" value={onlyUnset ? "1" : "0"} />
            <button
              type="submit"
              disabled={pending || !confirmed || plan.targets.length === 0}
              className="min-h-[40px] rounded-lg bg-white px-4 text-sm font-semibold text-zinc-950 transition hover:bg-zinc-200 disabled:opacity-40"
            >
              {pending ? "適用中…" : `選択した ${plan.targets.length} 件に ${plan.ratePct}% を適用`}
            </button>
          </form>

          <p className="text-[11px] leading-relaxed text-zinc-600">
            適用時にDBを読み直して再判定します。発行済みの請求書の料率・請求額は変更されません。
          </p>
        </div>
      ) : (
        <p className="text-xs text-zinc-500">対象セラーをチェックすると、プレビューが表示されます。</p>
      )}
    </section>
  );
}
