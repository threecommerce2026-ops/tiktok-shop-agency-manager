"use client";

import { CopyReferralLinkButton } from "@/components/referrer/CopyReferralLinkButton";
import type { ReferrerDashboardData } from "@/lib/db/referrer-dashboard-queries";
import { formatYen } from "@/lib/revenue/calc";

type Props = {
  referrerName: string;
  referralLink: string;
  dashboard: ReferrerDashboardData;
  payoutThresholdYen: number;
};

export function ReferrerDashboardClient({
  referrerName,
  referralLink,
  dashboard,
  payoutThresholdYen,
}: Props) {
  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-white/[0.06] bg-surface-1/40 p-5">
        <p className="text-sm text-zinc-400">ようこそ、{referrerName} さん</p>
        <p className="mt-1 text-xs text-zinc-500">対象月: {dashboard.month}</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <StatCard label="今月報酬" value={formatYen(dashboard.referralRewardMonth)} />
          <StatCard label="累計報酬" value={formatYen(dashboard.referralRewardTotal)} />
          <StatCard label="未払い報酬" value={formatYen(dashboard.unpaidRewardTotal)} />
          <StatCard label="支払い済み" value={formatYen(dashboard.paidRewardTotal)} />
          <StatCard label="紹介クリエイター数" value={String(dashboard.creatorCount)} />
          <StatCard label="今月の報酬対象収益" value={formatYen(dashboard.eligibleRevenueMonth)} />
        </div>
        <p className="mt-4 text-sm text-zinc-300">
          支払い対象: {dashboard.isPayableMonth ? `${formatYen(payoutThresholdYen)}以上で対象` : `${formatYen(payoutThresholdYen)}未満は保留`}
          {dashboard.payoutStatus ? ` / 状況: ${dashboard.payoutStatus}` : ""}
        </p>
      </section>

      <section className="rounded-2xl border border-white/[0.06] bg-surface-1/40 p-5">
        <h2 className="text-sm font-semibold text-zinc-100">あなたの紹介リンク</h2>
        <p className="mt-2 break-all font-mono text-xs text-zinc-400">{referralLink}</p>
        <div className="mt-3">
          <CopyReferralLinkButton referralLink={referralLink} />
        </div>
      </section>

      <section className="rounded-2xl border border-white/[0.06] bg-surface-1/40 p-4 sm:p-5">
        <h2 className="text-sm font-semibold text-zinc-100">紹介クリエイター一覧</h2>
        {dashboard.creators.length === 0 ? (
          <p className="mt-4 text-center text-sm text-zinc-500">まだ紹介クリエイターがいません</p>
        ) : (
          <>
            <div className="mt-4 space-y-3 sm:hidden">
              {dashboard.creators.map((creator) => (
                <article
                  key={creator.creatorId}
                  className="rounded-xl border border-white/[0.06] bg-surface-0/60 p-4"
                >
                  <p className="font-medium text-zinc-100">{creator.creatorName}</p>
                  <p className="mt-1 font-mono text-xs text-zinc-500">{creator.tiktokId}</p>
                  <p className="mt-1 text-xs text-zinc-500">公式LINE: {creator.officialLineRegistered}</p>
                  <dl className="mt-3 grid grid-cols-2 gap-2 text-xs text-zinc-400">
                    <div>
                      <dt>今月売上</dt>
                      <dd className="mt-0.5 text-sm text-zinc-200">{formatYen(creator.salesMonth)}</dd>
                    </div>
                    <div>
                      <dt>今月報酬</dt>
                      <dd className="mt-0.5 text-sm text-zinc-200">{formatYen(creator.referralRewardMonth)}</dd>
                    </div>
                  </dl>
                </article>
              ))}
            </div>
            <div className="mt-4 hidden overflow-x-auto sm:block">
              <table className="min-w-full text-left text-sm">
                <thead className="border-b border-white/[0.06] text-xs uppercase tracking-wider text-zinc-500">
                  <tr>
                    <th className="px-4 py-3">TikTok名</th>
                    <th className="px-4 py-3">TikTok ID</th>
                    <th className="px-4 py-3">公式LINE</th>
                    <th className="px-4 py-3">今月売上</th>
                    <th className="px-4 py-3">今月報酬</th>
                  </tr>
                </thead>
                <tbody>
                  {dashboard.creators.map((creator) => (
                    <tr key={creator.creatorId} className="border-b border-white/[0.04] text-zinc-200">
                      <td className="px-4 py-3">{creator.creatorName}</td>
                      <td className="px-4 py-3 font-mono text-xs text-zinc-400">{creator.tiktokId}</td>
                      <td className="px-4 py-3">{creator.officialLineRegistered}</td>
                      <td className="px-4 py-3">{formatYen(creator.salesMonth)}</td>
                      <td className="px-4 py-3">{formatYen(creator.referralRewardMonth)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-surface-0/60 px-4 py-3">
      <p className="text-[11px] uppercase tracking-wider text-zinc-500">{label}</p>
      <p className="mt-1 text-lg font-semibold text-zinc-100">{value}</p>
    </div>
  );
}
