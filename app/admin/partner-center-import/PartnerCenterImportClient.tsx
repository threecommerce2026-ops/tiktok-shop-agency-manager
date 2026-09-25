"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";

import type { ShopIdCandidateDelta } from "@/lib/db/shop-id-candidate-queries";
import {
  PARTNER_SHOP_ISSUE_LABEL,
  defaultPeriodEnd,
  defaultPeriodStart,
  isValidTargetMonth,
  parsePartnerCenterResponse,
  partnerResponseError,
  validatePartnerCenterShops,
  type PartnerCenterEnvelope,
  type PartnerCenterValidation,
} from "@/lib/shop-performance/partner-center-payload";

/*
  Partner Center JSON の取込画面。

  ここでは sellers.shop_id を変更しない。
  shop_performance_imports へ保存し、Shop ID の確定は
  /admin/sellers の「TikTok Shop紐付け」で行う。

  検証はサーバーと同じ validatePartnerCenterShops() を使う。
*/

const th =
  "whitespace-nowrap border-b border-zinc-800 bg-zinc-900/80 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-500";

type SyncResponse = {
  ok: boolean;
  error?: string;
  targetMonth?: string;
  periodStart?: string;
  periodEnd?: string;
  receivedCount?: number;
  upsertedCount?: number;
  matchedByShopId?: number;
  matchedByAlias?: number;
  matchedByName?: number;
  unlinked?: number;
  shopIdCandidates?: ShopIdCandidateDelta | null;
};

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function PartnerCenterImportClient() {
  const [jsonText, setJsonText] = useState("");
  const [targetMonth, setTargetMonth] = useState(currentMonth());
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [result, setResult] = useState<SyncResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  /* 貼り付けJSONを解析して、保存前にプレビューする */
  const parsed = useMemo((): {
    envelope: PartnerCenterEnvelope | null;
    validation: PartnerCenterValidation | null;
    parseError: string | null;
  } => {
    const text = jsonText.trim();
    if (!text) return { envelope: null, validation: null, parseError: null };

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return {
        envelope: null,
        validation: null,
        parseError: "JSON の形式が正しくありません",
      };
    }

    const envelope = parsePartnerCenterResponse(json);
    if (!envelope) {
      return {
        envelope: null,
        validation: null,
        parseError:
          "ショップデータを読み取れません。Partner Center のレスポンス全体（data.stats を含む）を貼り付けてください",
      };
    }

    const responseError = partnerResponseError(envelope);
    if (responseError) {
      return { envelope, validation: null, parseError: responseError };
    }

    return {
      envelope,
      validation: validatePartnerCenterShops(envelope.shops),
      parseError: null,
    };
  }, [jsonText]);

  /* 対象月・期間は JSON 側を正とし、無い形式のときだけ手入力を使う */
  const envelope = parsed.envelope;
  const effectiveMonth = envelope?.targetMonth ?? targetMonth;
  const effectiveStart =
    envelope?.periodStart ??
    (periodStart.trim() ||
      (isValidTargetMonth(effectiveMonth) ? defaultPeriodStart(effectiveMonth) : ""));
  const effectiveEnd =
    envelope?.periodEnd ??
    (periodEnd.trim() ||
      (isValidTargetMonth(effectiveMonth) ? defaultPeriodEnd(effectiveMonth) : ""));

  const validation = parsed.validation;
  const completeness = envelope?.completeness ?? null;
  const hasIssues = (validation?.issues.length ?? 0) > 0;
  const isIncomplete = completeness != null && !completeness.isComplete;

  const canImport =
    !pending &&
    !parsed.parseError &&
    !hasIssues &&
    !isIncomplete &&
    (validation?.rows.length ?? 0) > 0 &&
    isValidTargetMonth(effectiveMonth);

  /** 対象月を「2026年8月」形式で表示する */
  const monthLabel = isValidTargetMonth(effectiveMonth)
    ? `${effectiveMonth.slice(0, 4)}年${Number(effectiveMonth.slice(5, 7))}月`
    : "—";

  function runImport() {
    if (!validation || !canImport) return;

    startTransition(async () => {
      setError(null);
      setResult(null);
      try {
        const response = await fetch("/api/partner-center-sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          /*
            サーバーでも同じ検証を通すため、貼り付けたJSONをそのまま送る。
            実レスポンス形式なら target_month / 期間 / 件数もサーバー側で読み直される。
          */
          body: jsonText,
        });
        const data = (await response.json()) as SyncResponse;
        if (!data.ok) {
          setError(data.error ?? "取込に失敗しました");
          return;
        }
        setResult(data);
      } catch (e) {
        setError(e instanceof Error ? e.message : "取込に失敗しました");
      }
    });
  }

  return (
    <div className="space-y-6">
      {/* 用途の説明。ShopList CSV と混同させない */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <p className="text-xs font-semibold text-zinc-200">ShopList CSV 取込</p>
          <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
            用途: GMV・販売実績などの取込
            <br />
            <span className="text-amber-300/90">注意: Shop ID は含まれません</span>
          </p>
          <Link
            href="/admin/shop-performance"
            className="mt-2 inline-block text-[11px] text-[var(--accent-cyan)] hover:underline"
          >
            ショップ実績へ →
          </Link>
        </div>
        <div className="rounded-xl border border-fuchsia-500/25 bg-fuchsia-500/[0.06] p-4">
          <p className="text-xs font-semibold text-zinc-100">Partner Center JSON 取込（この画面）</p>
          <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">
            用途: <span className="text-fuchsia-200">Shop ID 付き</span>ショップ情報の取込
            <br />
            Shop ID を登録できる唯一の取込経路です
          </p>
        </div>
      </div>

      {/* 対象月・期間。実レスポンスなら JSON から自動判定する */}
      {envelope?.targetMonth ? (
        <div className="rounded-xl border border-white/[0.08] bg-surface-0/50 p-4">
          <div className="flex flex-wrap gap-6">
            <div>
              <p className="text-[11px] font-medium text-zinc-500">対象月</p>
              <p className="mt-1 text-lg font-semibold text-zinc-100">{monthLabel}</p>
            </div>
            <div>
              <p className="text-[11px] font-medium text-zinc-500">期間</p>
              <p className="mt-1 font-mono text-sm text-zinc-300">
                {effectiveStart?.replace(/-/g, "/")} ～ {effectiveEnd?.replace(/-/g, "/")}
              </p>
            </div>
          </div>
          <p className="mt-2 text-[11px] text-zinc-500">
            貼り付けたレスポンスの time_descriptor から自動判定しました。
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-[11px] text-zinc-500">
            期間情報を持たない形式のため、対象月を指定してください。
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="pc-month" className="text-[11px] font-medium text-zinc-500">
                対象月（YYYY-MM）
              </label>
              <input
                id="pc-month"
                value={targetMonth}
                onChange={(e) => setTargetMonth(e.target.value)}
                placeholder="2026-09"
                className="mt-1 w-36 rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 font-mono text-sm text-zinc-100"
              />
            </div>
            <div>
              <label htmlFor="pc-start" className="text-[11px] font-medium text-zinc-500">
                開始日（省略可）
              </label>
              <input
                id="pc-start"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
                placeholder={effectiveStart || "YYYY-MM-DD"}
                className="mt-1 w-40 rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 font-mono text-sm text-zinc-100"
              />
            </div>
            <div>
              <label htmlFor="pc-end" className="text-[11px] font-medium text-zinc-500">
                終了日（省略可）
              </label>
              <input
                id="pc-end"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
                placeholder={effectiveEnd || "YYYY-MM-DD"}
                className="mt-1 w-40 rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 font-mono text-sm text-zinc-100"
              />
            </div>
          </div>
          {!isValidTargetMonth(effectiveMonth) ? (
            <p className="text-xs text-amber-300">対象月は YYYY-MM 形式で入力してください</p>
          ) : null}
        </div>
      )}

      <div>
        <label htmlFor="pc-json" className="text-[11px] font-medium text-zinc-500">
          Partner Center から取得したショップJSON
        </label>
        <textarea
          id="pc-json"
          value={jsonText}
          onChange={(e) => setJsonText(e.target.value)}
          placeholder="ここにショップJSONを貼り付け"
          className="mt-1 h-72 w-full rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 font-mono text-xs text-zinc-100"
        />
      </div>

      {parsed.parseError ? (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200" role="alert">
          {parsed.parseError}
        </p>
      ) : null}

      {/* 保存前プレビュー */}
      {validation ? (
        <section className="space-y-3 rounded-xl border border-white/[0.08] bg-surface-0/50 p-4">
          <p className="text-sm font-semibold text-zinc-100">Partner Center取込プレビュー</p>

          <div className="flex flex-wrap gap-6 text-xs">
            <div>
              <p className="text-[10px] uppercase text-zinc-500">対象月</p>
              <p className="mt-0.5 text-sm text-zinc-100">{monthLabel}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase text-zinc-500">期間</p>
              <p className="mt-0.5 font-mono text-sm text-zinc-300">
                {effectiveStart?.replace(/-/g, "/")} ～ {effectiveEnd?.replace(/-/g, "/")}
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase text-zinc-500">取得ショップ</p>
              <p className="mt-0.5 font-mono text-sm text-zinc-100">
                {completeness?.actualCount ?? validation.counts.total}件
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase text-zinc-500">Partner Center報告件数</p>
              <p className="mt-0.5 font-mono text-sm text-zinc-100">
                {completeness?.expectedTotal ?? "—"}
                {completeness?.expectedTotal != null ? "件" : ""}
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase text-zinc-500">完全取得</p>
              <p
                className={`mt-0.5 font-mono text-sm ${
                  isIncomplete ? "text-red-300" : "text-emerald-300"
                }`}
              >
                {completeness?.expectedTotal == null
                  ? "—"
                  : `${isIncomplete ? "✕" : "✓"} ${completeness.actualCount} / ${completeness.expectedTotal}`}
              </p>
            </div>
          </div>

          {isIncomplete ? (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200" role="alert">
              Partner Center の全ショップが含まれていない可能性があります。
              {completeness?.reason}
              <br />
              Shop ID 候補の供給元として不完全なため、取込できません。
              ショップ分析の一覧をすべて表示した状態でレスポンスを取得し直してください。
            </p>
          ) : null}

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-center">
              <p className="text-[10px] uppercase text-zinc-500">正常</p>
              <p className="font-mono text-lg text-emerald-300">{validation.counts.valid}</p>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-center">
              <p className="text-[10px] uppercase text-zinc-500">不正 Shop ID</p>
              <p className="font-mono text-lg text-red-300">{validation.counts.invalidShopId}</p>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-center">
              <p className="text-[10px] uppercase text-zinc-500">重複 Shop ID</p>
              <p className="font-mono text-lg text-red-300">{validation.counts.duplicateShopId}</p>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-center">
              <p className="text-[10px] uppercase text-zinc-500">ショップ名なし</p>
              <p className="font-mono text-lg text-red-300">{validation.counts.missingShopName}</p>
            </div>
          </div>

          {validation.counts.conflictingShopName > 0 ? (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-center text-xs text-amber-100">
              同名ショップに別の Shop ID:{" "}
              <span className="font-mono">{validation.counts.conflictingShopName}件</span>
            </div>
          ) : null}

          {hasIssues ? (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              <p className="font-semibold">
                不正なデータが {validation.issues.length} 件あります。取込は実行できません。
              </p>
              <ul className="mt-1 max-h-40 space-y-0.5 overflow-auto text-[11px]">
                {validation.issues.slice(0, 30).map((i) => (
                  <li key={`${i.index}-${i.kind}`}>
                    ・{PARTNER_SHOP_ISSUE_LABEL[i.kind]}: {i.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="max-h-72 overflow-auto rounded-lg border border-zinc-800">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead className="sticky top-0">
                <tr>
                  <th className={th}>#</th>
                  <th className={th}>ショップ名</th>
                  <th className={th}>Shop ID</th>
                  <th className={`${th} text-right`}>GMV</th>
                  <th className={`${th} text-right`}>順位</th>
                  <th className={th}>対象月</th>
                  <th className={th}>状態</th>
                </tr>
              </thead>
              <tbody>
                {[...validation.rows]
                  .sort((a, b) => (a.shopRanking ?? 9999) - (b.shopRanking ?? 9999))
                  .map((r) => (
                  <tr key={r.shopId} className="border-b border-zinc-800/60">
                    <td className="px-3 py-2 font-mono text-xs text-zinc-500">{r.index}</td>
                    <td className="max-w-[16rem] truncate px-3 py-2 text-zinc-200" title={r.shopName}>
                      {r.shopName}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-zinc-400">
                      {r.shopId}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs text-zinc-300">
                      ¥{r.revenue.toLocaleString()}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs text-zinc-500">
                      {r.shopRanking ?? "—"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-zinc-500">
                      {effectiveMonth}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-[11px]">
                      <span className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2 py-0.5 text-emerald-300">
                        正常
                      </span>
                    </td>
                  </tr>
                  ))}
              </tbody>
            </table>
          </div>

          <button
            type="button"
            onClick={runImport}
            disabled={!canImport}
            className="min-h-[44px] rounded-lg bg-gradient-to-r from-cyan-600/90 to-fuchsia-600/80 px-5 text-sm font-semibold text-white disabled:opacity-40"
          >
            {pending
              ? "取込中…"
              : `${validation.counts.valid}ショップを取り込む`}
          </button>

          <p className="text-[11px] leading-relaxed text-zinc-600">
            この取込では sellers.shop_id を変更しません。Shop ID の確定は
            「セラー管理 › TikTok Shop紐付け」で行います。
          </p>
        </section>
      ) : null}

      {error ? (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200" role="alert">
          {error}
        </p>
      ) : null}

      {/* 取込結果 */}
      {result?.ok ? (
        <section className="space-y-3 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] p-4">
          <p className="text-sm font-semibold text-emerald-200">
            Partner Center データを取り込みました
          </p>
          <ul className="space-y-0.5 text-xs text-zinc-300">
            <li>
              取込: <span className="font-mono text-emerald-200">{result.upsertedCount}ショップ</span>
              （対象月 {result.targetMonth} / {result.periodStart} 〜 {result.periodEnd}）
            </li>
            <li className="text-[11px] text-zinc-500">
              セラー照合: Shop ID {result.matchedByShopId} / 別名 {result.matchedByAlias} / 名前{" "}
              {result.matchedByName} / 未紐付 {result.unlinked}
            </li>
          </ul>

          {result.shopIdCandidates ? (
            <div className="space-y-2 rounded-lg border border-fuchsia-500/25 bg-fuchsia-500/[0.06] px-3 py-3 text-xs">
              <ul className="space-y-0.5">
                <li>
                  新しく Shop ID を特定できたセラー:{" "}
                  <span className="font-mono text-cyan-200">
                    {result.shopIdCandidates.newlyConfident.length}件
                  </span>
                </li>
                <li>
                  新しく要確認になったセラー:{" "}
                  <span className="font-mono text-amber-200">
                    {result.shopIdCandidates.newlyReview.length}件
                  </span>
                </li>
              </ul>

              {result.shopIdCandidates.newlyConfident.length > 0 ? (
                <ul className="max-h-32 space-y-0.5 overflow-auto text-[11px] text-zinc-400">
                  {result.shopIdCandidates.newlyConfident.map((c) => (
                    <li key={c.shopId}>
                      ・{c.sellerName}（{c.shopName || "—"}） → {c.shopId}
                    </li>
                  ))}
                </ul>
              ) : null}

              <p className="text-[11px] text-zinc-400">
                現在: 確定候補{" "}
                <span className="font-mono text-cyan-200">{result.shopIdCandidates.confident}件</span>
                {" / "}要確認{" "}
                <span className="font-mono text-amber-200">{result.shopIdCandidates.review}件</span>
                {" / "}候補なし{" "}
                <span className="font-mono text-zinc-300">{result.shopIdCandidates.none}件</span>
                {" / "}紐付け済み{" "}
                <span className="font-mono text-emerald-200">{result.shopIdCandidates.linked}件</span>
              </p>

              <Link
                href="/admin/sellers?panel=shop-id"
                className="inline-flex min-h-[36px] items-center rounded-lg border border-fuchsia-500/30 bg-fuchsia-500/10 px-3 text-xs font-medium text-fuchsia-200 hover:bg-fuchsia-500/20"
              >
                Shop ID候補を確認 →
              </Link>
            </div>
          ) : null}

          <p className="text-[11px] text-zinc-600">
            取込では sellers.shop_id を自動更新していません。
          </p>
        </section>
      ) : null}
    </div>
  );
}
