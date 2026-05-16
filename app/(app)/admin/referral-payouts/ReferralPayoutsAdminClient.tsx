"use client";

import {
  markReferralPayoutPaidAction,
  syncReferralRewardsAction,
  type AdminActionResult,
} from "@/app/actions/admin-referral-payouts";
import type {
  ReferralPayoutAdminRow,
  ReferralRewardItemRow,
} from "@/lib/db/referral-payout-admin-queries";
import { formatYen } from "@/lib/revenue/calc";
import Link from "next/link";
import { useActionState, useState, useTransition } from "react";

type Props = {
  targetMonth: string;
  payouts: ReferralPayoutAdminRow[];
  items: ReferralRewardItemRow[];
  selectedReferrerId: string | null;
};

const inputClass =
  "mt-1.5 w-full rounded-xl border border-white/[0.08] bg-surface-0 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-[var(--accent-cyan)]/40";
const labelClass = "text-[11px] font-medium uppercase tracking-wider text-zinc-500";

export function ReferralPayoutsAdminClient({
  targetMonth,
  payouts,
  items,
  selectedReferrerId,
}: Props) {
  const [syncState, syncAction, isSyncPending] = useActionState(
    syncReferralRewardsAction,
    null as AdminActionResult | null,
  );
  const [isPending, startTransition] = useTransition();
  const [paidMessage, setPaidMessage] = useState<AdminActionResult | null>(null);

  return (
    <div className="space-y-6">
      <form action={syncAction} className="space-y-4 rounded-2xl border border-white/[0.06] bg-surface-1/40 p-4 sm:p-5">
        <h2 className="text-sm font-semibold text-zinc-100">月次報酬を集計</h2>
        <div>
          <label className={labelClass} htmlFor="target-month">対象月</label>
          <input id="target-month" name="target_month" defaultValue={targetMonth} required className={inputClass} />
        </div>
        {syncState?.ok ? <p className="text-sm text-emerald-300">{syncState.message}</p> : null}
        {syncState && !syncState.ok ? <p className="text-sm text-red-300">{syncState.error}</p> : null}
        <button type="submit" disabled={isSyncPending} className="inline-flex min-h-[40px] items-center justify-center rounded-lg bg-gradient-to-r from-[var(--accent-cyan)]/90 to-[var(--accent-magenta)]/80 px-4 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-50">
          {isSyncPending ? "集計中…" : "月次報酬を集計"}
        </button>
      </form>

      <div className="overflow-x-auto rounded-2xl border border-white/[0.06] bg-surface-1/40">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b border-white/[0.06] text-xs uppercase tracking-wider text-zinc-500">
            <tr>
              <th className="px-4 py-3">対象月</th>
              <th className="px-4 py-3">紹介者</th>
              <th className="px-4 py-3">報酬総額</th>
              <th className="px-4 py-3">1,000円以上</th>
              <th className="px-4 py-3">支払い対象</th>
              <th className="px-4 py-3">状況</th>
              <th className="px-4 py-3">支払日</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {payouts.map((payout) => (
              <tr key={payout.id} className="border-b border-white/[0.04] text-zinc-200">
                <td className="px-4 py-3 font-mono text-xs">{payout.targetMonth}</td>
                <td className="px-4 py-3">{payout.referrerName}</td>
                <td className="px-4 py-3">{formatYen(payout.totalRewardAmount)}</td>
                <td className="px-4 py-3">{payout.totalRewardAmount >= payout.thresholdAmount ? "はい" : "いいえ"}</td>
                <td className="px-4 py-3">{payout.isPayable ? "対象" : "保留"}</td>
                <td className="px-4 py-3">{payout.status}</td>
                <td className="px-4 py-3">{payout.paidAt ? new Date(payout.paidAt).toLocaleString("ja-JP") : "—"}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-2">
                    <Link href={`/admin/referral-payouts?referrerId=${payout.referrerId}`} className="text-[var(--accent-cyan)] hover:underline">
                      明細
                    </Link>
                    {payout.status !== "paid" ? (
                      <button
                        type="button"
                        disabled={isPending}
                        onClick={() => {
                          startTransition(async () => {
                            const result = await markReferralPayoutPaidAction(payout.id);
                            setPaidMessage(result);
                          });
                        }}
                        className="text-emerald-300 hover:underline disabled:opacity-50"
                      >
                        支払い済み
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {paidMessage?.ok ? <p className="text-sm text-emerald-300">{paidMessage.message}</p> : null}
      {paidMessage && !paidMessage.ok ? <p className="text-sm text-red-300">{paidMessage.error}</p> : null}

      {selectedReferrerId ? (
        <section className="space-y-3 rounded-2xl border border-white/[0.06] bg-surface-1/40 p-4 sm:p-5">
          <h2 className="text-sm font-semibold text-zinc-100">詳細明細</h2>
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b border-white/[0.06] text-xs uppercase tracking-wider text-zinc-500">
                <tr>
                  <th className="px-3 py-2">注文ID</th>
                  <th className="px-3 py-2">商品ID</th>
                  <th className="px-3 py-2">クリエイター</th>
                  <th className="px-3 py-2">紹介者</th>
                  <th className="px-3 py-2">対象収益</th>
                  <th className="px-3 py-2">報酬</th>
                  <th className="px-3 py-2">支払い済み</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-b border-white/[0.04] text-zinc-200">
                    <td className="px-3 py-2 font-mono text-xs">{item.orderId}</td>
                    <td className="px-3 py-2 font-mono text-xs">{item.productId || "—"}</td>
                    <td className="px-3 py-2">{item.creatorName}</td>
                    <td className="px-3 py-2">{item.referrerName}</td>
                    <td className="px-3 py-2">{formatYen(item.baseAmount)}</td>
                    <td className="px-3 py-2">{formatYen(item.rewardAmount)}</td>
                    <td className="px-3 py-2">{item.isPaid ? "はい" : "いいえ"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
