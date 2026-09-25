"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { PayoutConfirmButton } from "@/components/revenue/PayoutConfirmButton";
import {
  payReferralAnnualAction,
  previewReferralRewardsAction,
  syncReferralRewardsAction,
  unpayReferralAnnualAction,
  type ReferralActionResult,
} from "@/app/actions/referral-rewards";
import type {
  ReferralAnnualDetail,
  ReferralAnnualSummary,
} from "@/lib/db/referral-annual-queries";
import { formatYenPrecise } from "@/lib/revenue/calc";

const thBase =
  "whitespace-nowrap border-b border-zinc-800 bg-surface-1/80 px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-500";

const td = "whitespace-nowrap px-3 py-2.5 text-xs";

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-surface-1/60 p-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
        {label}
      </p>
      <p className="mt-2 font-mono text-xl font-bold tracking-tight text-zinc-50">
        {value}
      </p>
      {hint ? <p className="mt-1 text-[11px] text-zinc-600">{hint}</p> : null}
    </div>
  );
}

function ResultBanner({ state }: { state: ReferralActionResult | null }) {
  if (!state) return null;
  return (
    <p
      className={`rounded-lg border px-3 py-2 text-xs ${
        state.ok
          ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-200"
          : "border-red-500/25 bg-red-500/10 text-red-200"
      }`}
      role="status"
    >
      {state.ok ? state.message : state.error}
    </p>
  );
}

export function ReferralRewardTabClient({
  summary,
  detail,
  selectedReferrerId,
  defaultMonth,
}: {
  summary: ReferralAnnualSummary;
  detail: ReferralAnnualDetail | null;
  selectedReferrerId: string | null;
  defaultMonth: string;
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [payableOnly, setPayableOnly] = useState(false);

  const [syncState, syncAction, syncPending] = useActionState(
    syncReferralRewardsAction,
    null,
  );
  const [payState, payAction, payPending] = useActionState(
    payReferralAnnualAction,
    null,
  );
  const [unpayState, unpayAction, unpayPending] = useActionState(
    unpayReferralAnnualAction,
    null,
  );
  const [previewState, previewAction, previewPending] = useActionState(
    previewReferralRewardsAction,
    null,
  );

  const q = search.trim().toLowerCase();
  const rows = summary.rows.filter((row) => {
    if (payableOnly && !row.isPayable) return false;
    if (!q) return true;
    return row.referrerName.toLowerCase().includes(q);
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 rounded-xl border border-white/[0.06] bg-surface-1/40 p-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <label htmlFor="referral-year" className="text-[11px] font-medium text-zinc-500">
            対象年
          </label>
          <input
            id="referral-year"
            type="number"
            min={2020}
            max={2100}
            defaultValue={summary.year}
            onChange={(e) => {
              if (/^\d{4}$/.test(e.target.value)) {
                router.push(`/revenue?tab=referral&year=${e.target.value}`);
              }
            }}
            className="mt-1 w-32 rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 font-mono text-sm text-zinc-100 outline-none"
          />
          <p className="mt-2 max-w-md text-[11px] leading-relaxed text-zinc-600">
            支払判定は月単位ではなく「その年の未払い累積」です。
            {formatYenPrecise(summary.thresholdAmount)} 未満は消えずに翌月へ繰り越されます。
          </p>
        </div>

        <form action={syncAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="scope" value="year" />
          <input type="hidden" name="year" value={summary.year} />
          <button
            type="submit"
            disabled={syncPending}
            className="min-h-[40px] rounded-lg border border-white/[0.1] px-4 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.06] disabled:opacity-50"
          >
            {syncPending ? "再集計中…" : `${summary.year}年を再集計`}
          </button>
        </form>
      </div>

      <ResultBanner state={syncState} />
      <ResultBanner state={payState} />
      <ResultBanner state={unpayState} />

      {summary.error ? (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          {summary.error}
        </div>
      ) : null}

      {/*
        「総発生額」「自社分」「外部支払対象額」を混同しないよう分けて出す。
        （株）3 は自社なので実績には含めるが外部への支払対象にはしない。
      */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Kpi
          label="総発生額（自社含む）"
          value={formatYenPrecise(summary.totals.annualRewardAmount)}
          hint={`紹介者 ${summary.totals.referrerCount} 名`}
        />
        <Kpi
          label="うち自社分（支払対象外）"
          value={formatYenPrecise(summary.totals.inHouseRewardAmount)}
          hint={
            summary.totals.inHouseReferrerCount > 0
              ? `自社 ${summary.totals.inHouseReferrerCount} 名 / 外部へは振り込みません`
              : "自社紹介なし"
          }
        />
        <Kpi
          label="外部紹介者分"
          value={formatYenPrecise(summary.totals.externalRewardAmount)}
          hint={`外部 ${summary.totals.referrerCount - summary.totals.inHouseReferrerCount} 名`}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Kpi label="支払済額" value={formatYenPrecise(summary.totals.paidAmount)} />
        <Kpi
          label="未払残高"
          value={formatYenPrecise(summary.totals.unpaidAmount)}
          hint={`うち繰越 ${formatYenPrecise(summary.totals.carryOverAmount)}（外部のみ）`}
        />
        <Kpi
          label="外部への今回支払対象額"
          value={formatYenPrecise(summary.totals.payableAmount)}
          hint={`${summary.totals.payableReferrerCount} 名が支払可能（自社分は含みません）`}
        />
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-white/[0.06] bg-surface-1/40 p-4 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label htmlFor="referral-search" className="text-[11px] font-medium text-zinc-500">
            紹介者検索
          </label>
          <input
            id="referral-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="紹介者名"
            className="mt-1 w-full rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-cyan-700"
          />
        </div>
        <label className="flex min-h-[40px] cursor-pointer items-center gap-2 rounded-lg border border-white/[0.08] bg-surface-1 px-3 text-sm text-zinc-400">
          <input
            type="checkbox"
            checked={payableOnly}
            onChange={(e) => setPayableOnly(e.target.checked)}
          />
          支払対象のみ
        </label>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-xl border border-zinc-800 py-10 text-center text-sm text-zinc-500">
          {summary.year}年の紹介者報酬明細がありません。「{summary.year}年を再集計」を実行してください。
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full min-w-[980px] border-collapse text-sm">
            <thead>
              <tr>
                <th className={thBase}>紹介者</th>
                <th className={`${thBase} text-right`}>年間発生額</th>
                <th className={`${thBase} text-right`}>支払済額</th>
                <th className={`${thBase} text-right`}>未払残高</th>
                <th className={`${thBase} text-right`}>支払対象</th>
                <th className={thBase}>最終支払日</th>
                <th className={thBase}>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.referrerId} className="border-b border-zinc-800/60">
                  <td className={`${td} font-medium text-zinc-100`}>
                    <Link
                      href={`/revenue?tab=referral&year=${summary.year}&referrerId=${row.referrerId}`}
                      className="text-cyan-400 hover:underline"
                    >
                      {row.referrerName}
                    </Link>
                    <span className="ml-2 text-[11px] text-zinc-600">
                      CR {row.creatorCount} / 明細 {row.itemCount}
                    </span>
                  </td>
                  <td className={`${td} text-right font-mono text-zinc-200`}>
                    {formatYenPrecise(row.annualRewardAmount)}
                    {row.isInHouse ? (
                      <span className="ml-2 rounded-full border border-cyan-400/25 bg-cyan-400/10 px-1.5 py-0.5 text-[10px] text-cyan-200">
                        自社・支払対象外
                      </span>
                    ) : null}
                  </td>
                  <td className={`${td} text-right font-mono text-zinc-400`}>
                    {formatYenPrecise(row.paidAmount)}
                  </td>
                  <td className={`${td} text-right font-mono text-amber-200/90`}>
                    {formatYenPrecise(row.unpaidAmount)}
                  </td>
                  <td className={`${td} text-right`}>
                    {row.isPayable ? (
                      <span className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2 py-1 font-mono text-[11px] text-emerald-300">
                        {formatYenPrecise(row.payableAmount)}
                      </span>
                    ) : (
                      <span className="rounded-full border border-white/[0.06] bg-white/[0.03] px-2 py-1 text-[11px] text-zinc-500">
                        繰越
                      </span>
                    )}
                  </td>
                  <td className={`${td} font-mono text-zinc-500`}>
                    {row.lastPaidAt
                      ? new Date(row.lastPaidAt).toLocaleDateString("ja-JP")
                      : "—"}
                  </td>
                  <td className={td}>
                    <div className="flex gap-2">
                      {row.isPayable ? (
                        <form action={payAction}>
                          <PayoutConfirmButton
                            targetName={row.referrerName}
                            amountLabel={formatYenPrecise(row.payableAmount)}
                            itemCount={row.itemCount}
                            creatorCount={row.creatorCount}
                            creatorNoun="クリエイター"
                            pending={payPending}
                            hiddenFields={
                              <>
                                <input type="hidden" name="referrer_id" value={row.referrerId} />
                                <input
                                  type="hidden"
                                  name="target_month"
                                  value={row.latestUnpaidMonth ?? defaultMonth}
                                />
                              </>
                            }
                          />
                        </form>
                      ) : null}

                      {row.payoutStatus === "paid" && row.payoutId ? (
                        <form action={unpayAction}>
                          <input type="hidden" name="payout_id" value={row.payoutId} />
                          <button
                            type="submit"
                            disabled={unpayPending}
                            className="rounded border border-white/[0.1] px-2.5 py-1.5 text-[11px] text-zinc-300 transition hover:bg-white/[0.06] disabled:opacity-50"
                          >
                            取消
                          </button>
                        </form>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detail && selectedReferrerId ? (
        <section className="space-y-3 rounded-xl border border-white/[0.06] bg-surface-1/40 p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-200">
              {summary.rows.find((r) => r.referrerId === selectedReferrerId)?.referrerName ??
                "紹介者"}{" "}
              の内訳（{summary.year}年）
            </h2>
            <Link
              href={`/revenue?tab=referral&year=${summary.year}`}
              className="text-xs text-zinc-500 hover:text-zinc-300"
            >
              閉じる
            </Link>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="overflow-x-auto rounded-lg border border-zinc-800">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className={thBase}>対象月</th>
                    <th className={`${thBase} text-right`}>発生</th>
                    <th className={`${thBase} text-right`}>支払済</th>
                    <th className={`${thBase} text-right`}>未払</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.monthlyRows.map((row) => (
                    <tr key={row.targetMonth} className="border-b border-zinc-800/60">
                      <td className={`${td} font-mono text-zinc-300`}>{row.targetMonth}</td>
                      <td className={`${td} text-right font-mono text-zinc-200`}>
                        {formatYenPrecise(row.earnedAmount)}
                      </td>
                      <td className={`${td} text-right font-mono text-zinc-500`}>
                        {formatYenPrecise(row.paidAmount)}
                      </td>
                      <td className={`${td} text-right font-mono text-amber-200/90`}>
                        {formatYenPrecise(row.unpaidAmount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="overflow-x-auto rounded-lg border border-zinc-800">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className={thBase}>クリエイター</th>
                    <th className={`${thBase} text-right`}>Base</th>
                    <th className={`${thBase} text-right`}>報酬</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.creatorRows.map((row) => (
                    <tr key={row.creatorId} className="border-b border-zinc-800/60">
                      <td className={`${td} text-zinc-200`}>
                        {row.creatorName}
                        <span className="ml-1 font-mono text-[11px] text-zinc-600">
                          {row.tiktokId}
                        </span>
                      </td>
                      <td className={`${td} text-right font-mono text-zinc-400`}>
                        {formatYenPrecise(row.baseAmount)}
                      </td>
                      <td className={`${td} text-right font-mono text-zinc-200`}>
                        {formatYenPrecise(row.earnedAmount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}

      <section className="space-y-3 rounded-xl border border-white/[0.06] bg-surface-1/40 p-4">
        <h2 className="text-sm font-semibold text-zinc-200">再計算プレビュー（検証用・DB書き込みなし）</h2>
        <p className="text-[11px] leading-relaxed text-zinc-600">
          affiliate_order_lines と現在のクリエイター設定だけから紹介者報酬を再計算します。
          金額はコードに固定していません。
        </p>

        <form action={previewAction} className="flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor="preview-from" className="text-[11px] text-zinc-500">
              開始月
            </label>
            <input
              id="preview-from"
              name="from_month"
              type="month"
              defaultValue={`${summary.year}-01`}
              className="mt-1 block rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100"
            />
          </div>
          <div>
            <label htmlFor="preview-to" className="text-[11px] text-zinc-500">
              終了月
            </label>
            <input
              id="preview-to"
              name="to_month"
              type="month"
              defaultValue={defaultMonth}
              className="mt-1 block rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100"
            />
          </div>
          <button
            type="submit"
            disabled={previewPending}
            className="min-h-[40px] rounded-lg border border-white/[0.1] px-4 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.06] disabled:opacity-50"
          >
            {previewPending ? "計算中…" : "再計算する"}
          </button>
        </form>

        {previewState && !previewState.ok ? (
          <p className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-200">
            {previewState.error}
          </p>
        ) : null}

        {previewState?.ok ? (
          <div className="space-y-2">
            <p className="text-xs text-zinc-400">
              {previewState.months[0]}〜{previewState.months[previewState.months.length - 1]} /
              Commission Base{" "}
              <span className="font-mono text-zinc-200">
                {formatYenPrecise(previewState.totalBaseAmount)}
              </span>{" "}
              / 紹介者報酬{" "}
              <span className="font-mono font-semibold text-gradient-brand">
                {formatYenPrecise(previewState.totalRewardAmount)}
              </span>
            </p>
            <div className="overflow-x-auto rounded-lg border border-zinc-800">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr>
                    <th className={thBase}>紹介者</th>
                    <th className={thBase}>クリエイター</th>
                    <th className={`${thBase} text-right`}>Base</th>
                    <th className={`${thBase} text-right`}>報酬</th>
                  </tr>
                </thead>
                <tbody>
                  {previewState.rows.map((row) => (
                    <tr
                      key={`${row.referrerName}-${row.tiktokId}`}
                      className="border-b border-zinc-800/60"
                    >
                      <td className={`${td} text-zinc-200`}>{row.referrerName}</td>
                      <td className={`${td} text-zinc-400`}>
                        {row.creatorName}
                        <span className="ml-1 font-mono text-[11px] text-zinc-600">
                          {row.tiktokId}
                        </span>
                      </td>
                      <td className={`${td} text-right font-mono text-zinc-400`}>
                        {formatYenPrecise(row.baseAmount)}
                      </td>
                      <td className={`${td} text-right font-mono text-zinc-200`}>
                        {formatYenPrecise(row.rewardAmount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
