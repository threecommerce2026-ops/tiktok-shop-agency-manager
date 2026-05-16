"use client";

import {
  saveReferrerAction,
  type AdminActionResult,
} from "@/app/actions/admin-referrers";
import {
  markReferralPayoutPaidAction,
  markReferralPayoutUnpaidAction,
  reconcileReferrerLifetimePaidAction,
  syncReferralRewardsAction,
} from "@/app/actions/admin-referral-payouts";
import type { ReferrerAdminCreatorRow, ReferrerAdminRow } from "@/lib/db/referrer-admin-queries";
import type {
  ReferralPayoutAdminRow,
  ReferralRewardItemRow,
} from "@/lib/db/referral-payout-admin-queries";
import { formatYen } from "@/lib/revenue/calc";
import Link from "next/link";
import { useActionState, useState, useTransition } from "react";

type Props = {
  referrers: ReferrerAdminRow[];
  referralLinks: Record<string, string>;
  targetMonth: string;
  selectedReferrerId: string | null;
  selectedReferrer: ReferrerAdminRow | null;
  selectedPayout: ReferralPayoutAdminRow | null;
  creators: ReferrerAdminCreatorRow[];
  rewardItems: ReferralRewardItemRow[];
};

const inputClass =
  "mt-1.5 w-full rounded-xl border border-white/[0.08] bg-surface-0 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-[var(--accent-cyan)]/40";
const labelClass = "text-[11px] font-medium uppercase tracking-wider text-zinc-500";

function ReferrerForm({ referrer }: { referrer?: ReferrerAdminRow }) {
  const [state, formAction, isPending] = useActionState(saveReferrerAction, null as AdminActionResult | null);

  return (
    <form action={formAction} className="space-y-4 rounded-2xl border border-white/[0.06] bg-surface-1/40 p-4 sm:p-5">
      {referrer ? <input type="hidden" name="referrer_id" value={referrer.id} /> : null}
      <h2 className="text-sm font-semibold text-zinc-100">{referrer ? `${referrer.referrerName} を編集` : "紹介者を追加"}</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor={`referrer-name-${referrer?.id ?? "new"}`}>紹介者名</label>
          <input id={`referrer-name-${referrer?.id ?? "new"}`} name="referrer_name" defaultValue={referrer?.referrerName ?? ""} required className={inputClass} />
        </div>
        <div>
          <label className={labelClass} htmlFor={`referrer-email-${referrer?.id ?? "new"}`}>メール</label>
          <input id={`referrer-email-${referrer?.id ?? "new"}`} name="email" type="email" defaultValue={referrer?.email ?? ""} className={inputClass} />
        </div>
        <div>
          <label className={labelClass} htmlFor={`referrer-phone-${referrer?.id ?? "new"}`}>電話番号</label>
          <input id={`referrer-phone-${referrer?.id ?? "new"}`} name="phone" defaultValue={referrer?.phone ?? ""} className={inputClass} />
        </div>
        <div className="sm:col-span-2">
          <label className={labelClass} htmlFor={`referrer-memo-${referrer?.id ?? "new"}`}>メモ</label>
          <textarea id={`referrer-memo-${referrer?.id ?? "new"}`} name="memo" defaultValue={referrer?.memo ?? ""} rows={3} className={inputClass} />
        </div>
        <label className="flex min-h-[44px] items-center gap-2 rounded-xl border border-white/[0.08] bg-surface-0 px-3 py-2 text-sm text-zinc-300 sm:col-span-2">
          <input type="checkbox" name="is_active" defaultChecked={referrer?.isActive ?? true} />
          有効な紹介者として扱う
        </label>
      </div>
      {state?.ok ? <p className="text-sm text-emerald-300">{state.message}</p> : null}
      {state && !state.ok ? <p className="text-sm text-red-300">{state.error}</p> : null}
      <button type="submit" disabled={isPending} className="inline-flex min-h-[40px] items-center justify-center rounded-lg bg-gradient-to-r from-[var(--accent-cyan)]/90 to-[var(--accent-magenta)]/80 px-4 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-50">
        {isPending ? "保存中…" : referrer ? "紹介者を更新" : "紹介者を追加"}
      </button>
    </form>
  );
}

export function ReferrersAdminClient({
  referrers,
  referralLinks,
  targetMonth,
  selectedReferrerId,
  selectedReferrer,
  selectedPayout,
  creators,
  rewardItems,
}: Props) {
  const [syncState, syncAction, isSyncPending] = useActionState(
    syncReferralRewardsAction,
    null as AdminActionResult | null,
  );
  const [reconcileState, reconcileAction, isReconcilePending] = useActionState(
    reconcileReferrerLifetimePaidAction,
    null as AdminActionResult | null,
  );
  const [isPending, startTransition] = useTransition();
  const [paidMessage, setPaidMessage] = useState<AdminActionResult | null>(null);

  return (
    <div className="space-y-6">
      <ReferrerForm />
      <div className="overflow-x-auto rounded-2xl border border-white/[0.06] bg-surface-1/40">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b border-white/[0.06] text-xs uppercase tracking-wider text-zinc-500">
            <tr>
              <th className="px-4 py-3">紹介者名</th>
              <th className="px-4 py-3">メール</th>
              <th className="px-4 py-3">電話</th>
              <th className="px-4 py-3">紹介リンク</th>
              <th className="px-4 py-3">紹介CR数</th>
              <th className="px-4 py-3">今月報酬</th>
              <th className="px-4 py-3">累計報酬</th>
              <th className="px-4 py-3">支払い対象</th>
              <th className="px-4 py-3">状態</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {referrers.map((referrer) => (
              <tr key={referrer.id} className="border-b border-white/[0.04] text-zinc-200">
                <td className="px-4 py-3 font-medium">{referrer.referrerName}</td>
                <td className="px-4 py-3">{referrer.email ?? "—"}</td>
                <td className="px-4 py-3">{referrer.phone ?? "—"}</td>
                <td className="px-4 py-3">
                  {referrer.referralCode ? (
                    <span className="break-all font-mono text-xs text-zinc-400">
                      {referralLinks[referrer.id] ?? referrer.referralCode}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-4 py-3">{referrer.creatorCount}</td>
                <td className="px-4 py-3">{formatYen(referrer.rewardMonth)}</td>
                <td className="px-4 py-3">{formatYen(referrer.rewardTotal)}</td>
                <td className="px-4 py-3">{referrer.isPayableMonth ? "対象" : "対象外"}</td>
                <td className="px-4 py-3">{referrer.isActive ? "有効" : "無効"}</td>
                <td className="px-4 py-3">
                  <Link href={`/admin/referrers?referrerId=${referrer.id}`} className="text-[var(--accent-cyan)] hover:underline">
                    詳細
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selectedReferrerId && selectedReferrer ? (
        <section className="space-y-5 rounded-2xl border border-white/[0.06] bg-surface-1/40 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-zinc-100">{selectedReferrer.referrerName} の支払い管理</h2>
              <p className="mt-1 text-xs text-zinc-500">対象月: {targetMonth}</p>
            </div>
            <Link href="/admin/referrers" className="text-sm text-zinc-400 hover:text-zinc-200">
              一覧に戻る
            </Link>
          </div>

          <form action={syncAction} className="space-y-3 rounded-xl border border-white/[0.06] bg-surface-0/50 p-4">
            <h3 className="text-sm font-medium text-zinc-200">月次報酬を集計</h3>
            <input type="hidden" name="target_month" value={targetMonth} />
            {syncState?.ok ? <p className="text-sm text-emerald-300">{syncState.message}</p> : null}
            {syncState && !syncState.ok ? <p className="text-sm text-red-300">{syncState.error}</p> : null}
            <button
              type="submit"
              disabled={isSyncPending}
              className="inline-flex min-h-[40px] items-center justify-center rounded-lg bg-gradient-to-r from-[var(--accent-cyan)]/90 to-[var(--accent-magenta)]/80 px-4 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-50"
            >
              {isSyncPending ? "集計中…" : "月次報酬を集計"}
            </button>
          </form>

          <form action={reconcileAction} className="space-y-3 rounded-xl border border-white/[0.06] bg-surface-0/50 p-4">
            <h3 className="text-sm font-medium text-zinc-200">支払い済み累計を再集計</h3>
            <p className="text-xs text-zinc-500">
              既存の支払い済み明細から、紹介者×クリエイター別の累計支払い額を再計算します。
            </p>
            {reconcileState?.ok ? <p className="text-sm text-emerald-300">{reconcileState.message}</p> : null}
            {reconcileState && !reconcileState.ok ? (
              <p className="text-sm text-red-300">{reconcileState.error}</p>
            ) : null}
            <button
              type="submit"
              disabled={isReconcilePending}
              className="inline-flex min-h-[40px] items-center justify-center rounded-lg border border-white/[0.12] px-4 py-2 text-sm font-semibold text-zinc-100 disabled:opacity-50"
            >
              {isReconcilePending ? "再集計中…" : "累計支払い額を再集計"}
            </button>
          </form>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <SummaryCard label="今月報酬" value={formatYen(selectedReferrer.rewardMonth)} />
            <SummaryCard label="累計報酬" value={formatYen(selectedReferrer.rewardTotal)} />
            <SummaryCard label="支払い対象" value={selectedReferrer.isPayableMonth ? "対象" : "対象外"} />
            <SummaryCard label="支払い状況" value={selectedPayout?.status ?? "未集計"} />
          </div>

          {selectedPayout && selectedPayout.status !== "paid" ? (
            <button
              type="button"
              disabled={isPending}
              onClick={() => {
                startTransition(async () => {
                  const result = await markReferralPayoutPaidAction(selectedPayout.id);
                  setPaidMessage(result);
                });
              }}
              className="inline-flex min-h-[40px] items-center justify-center rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm font-semibold text-emerald-200 disabled:opacity-50"
            >
              支払い済みにする
            </button>
          ) : null}
          {selectedPayout && selectedPayout.status === "paid" ? (
            <button
              type="button"
              disabled={isPending}
              onClick={() => {
                startTransition(async () => {
                  const result = await markReferralPayoutUnpaidAction(selectedPayout.id);
                  setPaidMessage(result);
                });
              }}
              className="inline-flex min-h-[40px] items-center justify-center rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm font-semibold text-amber-100 disabled:opacity-50"
            >
              支払い済みを取り消す
            </button>
          ) : null}
          {paidMessage?.ok ? <p className="text-sm text-emerald-300">{paidMessage.message}</p> : null}
          {paidMessage && !paidMessage.ok ? <p className="text-sm text-red-300">{paidMessage.error}</p> : null}

          <div>
            <h3 className="text-sm font-medium text-zinc-200">紹介クリエイター</h3>
            <div className="mt-3 overflow-x-auto rounded-xl border border-white/[0.06]">
              <table className="min-w-full text-left text-sm">
                <thead className="border-b border-white/[0.06] text-xs uppercase tracking-wider text-zinc-500">
                  <tr>
                    <th className="px-3 py-2">TikTok名</th>
                    <th className="px-3 py-2">TikTok ID</th>
                    <th className="px-3 py-2">公式LINE</th>
                    <th className="px-3 py-2">開始月</th>
                    <th className="px-3 py-2">今月報酬</th>
                    <th className="px-3 py-2">累計支払い</th>
                    <th className="px-3 py-2">残り上限</th>
                    <th className="px-3 py-2">上限</th>
                    <th className="px-3 py-2">状態</th>
                  </tr>
                </thead>
                <tbody>
                  {creators.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="px-3 py-6 text-center text-zinc-500">
                        紹介クリエイターがいません
                      </td>
                    </tr>
                  ) : (
                    creators.map((creator) => (
                      <tr key={creator.creatorId} className="border-b border-white/[0.04] text-zinc-200">
                        <td className="px-3 py-2">{creator.creatorName}</td>
                        <td className="px-3 py-2 font-mono text-xs text-zinc-400">{creator.tiktokId}</td>
                        <td className="px-3 py-2">{creator.officialLineRegistered}</td>
                        <td className="px-3 py-2 font-mono text-xs">{creator.startMonth}</td>
                        <td className="px-3 py-2">{formatYen(creator.rewardMonth)}</td>
                        <td className="px-3 py-2">{formatYen(creator.lifetimePaidAmount)}</td>
                        <td className="px-3 py-2">{formatYen(creator.remainingCap)}</td>
                        <td className="px-3 py-2">
                          {creator.capReached ? (
                            <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-100">
                              上限到達
                            </span>
                          ) : (
                            formatYen(creator.lifetimePayoutCap)
                          )}
                        </td>
                        <td className="px-3 py-2">{creator.isActive ? "有効" : "無効"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <h3 className="text-sm font-medium text-zinc-200">月次報酬明細</h3>
            <div className="mt-3 overflow-x-auto rounded-xl border border-white/[0.06]">
              <table className="min-w-full text-left text-sm">
                <thead className="border-b border-white/[0.06] text-xs uppercase tracking-wider text-zinc-500">
                  <tr>
                    <th className="px-3 py-2">注文ID</th>
                    <th className="px-3 py-2">クリエイター</th>
                    <th className="px-3 py-2">対象額</th>
                    <th className="px-3 py-2">報酬</th>
                    <th className="px-3 py-2">支払い</th>
                  </tr>
                </thead>
                <tbody>
                  {rewardItems.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-3 py-6 text-center text-zinc-500">
                        明細がありません。月次集計を実行してください。
                      </td>
                    </tr>
                  ) : (
                    rewardItems.map((item) => (
                      <tr key={item.id} className="border-b border-white/[0.04] text-zinc-200">
                        <td className="px-3 py-2 font-mono text-xs">{item.orderId}</td>
                        <td className="px-3 py-2">{item.creatorName}</td>
                        <td className="px-3 py-2">{formatYen(item.baseAmount)}</td>
                        <td className="px-3 py-2">{formatYen(item.rewardAmount)}</td>
                        <td className="px-3 py-2">{item.isPaid ? "支払い済み" : "未払い"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}

      <div className="space-y-6">
        {referrers.map((referrer) => (
          <ReferrerForm key={referrer.id} referrer={referrer} />
        ))}
      </div>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-surface-0/60 px-4 py-3">
      <p className="text-[11px] uppercase tracking-wider text-zinc-500">{label}</p>
      <p className="mt-1 text-base font-semibold text-zinc-100">{value}</p>
    </div>
  );
}
