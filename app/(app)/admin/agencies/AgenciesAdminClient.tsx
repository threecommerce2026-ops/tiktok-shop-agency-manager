"use client";

import {
  saveAgencyAction,
  type AdminActionResult,
} from "@/app/actions/admin-agencies";
import type {
  AgencyAdminRow,
  AgencyCreatorRow,
  AgencyMonthlyRewardRow,
} from "@/lib/db/agency-admin-queries";
import { formatPercent, formatYen } from "@/lib/revenue/calc";
import Link from "next/link";
import { useActionState } from "react";

type Props = {
  agencies: AgencyAdminRow[];
  selectedAgencyId: string | null;
  creators: AgencyCreatorRow[];
  monthlyRewards: AgencyMonthlyRewardRow[];
};

const inputClass =
  "mt-1.5 w-full rounded-xl border border-white/[0.08] bg-surface-0 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-[var(--accent-cyan)]/40";
const labelClass = "text-[11px] font-medium uppercase tracking-wider text-zinc-500";

function AgencyForm({ agency }: { agency?: AgencyAdminRow }) {
  const [state, formAction, isPending] = useActionState(saveAgencyAction, null as AdminActionResult | null);

  return (
    <form action={formAction} className="space-y-4 rounded-2xl border border-white/[0.06] bg-surface-1/40 p-4 sm:p-5">
      {agency ? <input type="hidden" name="agency_id" value={agency.id} /> : null}
      <h2 className="text-sm font-semibold text-zinc-100">
        {agency ? `${agency.name} の設定を編集` : "代理店を追加"}
      </h2>
      <p className="rounded-lg border border-white/[0.06] bg-surface-0/50 px-3 py-2 text-[11px] leading-relaxed text-zinc-500">
        代理店報酬は TikTok の AP「エージェンシーの収益総額」を100%支払う計算です
        （対象は AU「支払い状況」= 支払い済みの明細のみ）。
        代理店ごとの分配率設定は使用しません。
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        {agency ? (
          <div className="sm:col-span-2 rounded-xl border border-white/[0.08] bg-surface-0 px-3 py-2.5">
            <p className={labelClass}>代理店名</p>
            <p className="mt-1 text-sm font-medium text-zinc-100">{agency.name}</p>
            <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
              代理店名はこのフォームからは変更できません。上部の「代理店マスタ（名称編集）」の
              <span className="text-zinc-300">名称編集</span>
              から、影響件数を確認したうえで変更してください（変更履歴が残ります）。
            </p>
          </div>
        ) : (
          <div>
            <label className={labelClass} htmlFor="agency-name-new">代理店名</label>
            <input id="agency-name-new" name="name" defaultValue="" required className={inputClass} />
          </div>
        )}
        <label className="flex min-h-[44px] items-center gap-2 rounded-xl border border-white/[0.08] bg-surface-0 px-3 py-2 text-sm text-zinc-300 sm:col-span-2">
          <input type="checkbox" name="is_active" defaultChecked={agency?.isActive ?? true} />
          有効な代理店として扱う
        </label>
      </div>
      {state?.ok ? <p className="text-sm text-emerald-300">{state.message}</p> : null}
      {state && !state.ok ? <p className="text-sm text-red-300">{state.error}</p> : null}
      <button type="submit" disabled={isPending} className="inline-flex min-h-[40px] items-center justify-center rounded-lg bg-gradient-to-r from-[var(--accent-cyan)]/90 to-[var(--accent-magenta)]/80 px-4 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-50">
        {isPending ? "保存中…" : agency ? "設定を更新" : "代理店を追加"}
      </button>
    </form>
  );
}

export function AgenciesAdminClient({ agencies, selectedAgencyId, creators, monthlyRewards }: Props) {
  const selectedAgency = agencies.find((agency) => agency.id === selectedAgencyId) ?? null;

  return (
    <div className="space-y-6">
      <AgencyForm />

      <div className="overflow-x-auto rounded-2xl border border-white/[0.06] bg-surface-1/40">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b border-white/[0.06] text-xs uppercase tracking-wider text-zinc-500">
            <tr>
              <th className="px-4 py-3">代理店名</th>
              <th className="px-4 py-3">登録CR</th>
              <th className="px-4 py-3">稼働CR</th>
              <th className="px-4 py-3">今月売上</th>
              <th className="px-4 py-3">今月収益</th>
              <th className="px-4 py-3">今月報酬</th>
              <th className="px-4 py-3">状態</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {agencies.map((agency) => (
              <tr key={agency.id} className="border-b border-white/[0.04] text-zinc-200">
                <td className="px-4 py-3 font-medium">{agency.name}</td>
                <td className="px-4 py-3">{agency.creatorCount}</td>
                <td className="px-4 py-3">{agency.activeCreatorCount}</td>
                <td className="px-4 py-3">{formatYen(agency.paidSalesMonth)}</td>
                <td className="px-4 py-3">{formatYen(agency.paidProfitMonth)}</td>
                <td className="px-4 py-3">{formatYen(agency.agencyRewardMonth)}</td>
                <td className="px-4 py-3">{agency.isActive ? "有効" : "無効"}</td>
                <td className="px-4 py-3">
                  <Link href={`/admin/agencies?agencyId=${agency.id}`} className="text-[var(--accent-cyan)] hover:underline">
                    詳細
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selectedAgency ? (
        <div className="space-y-6">
          <AgencyForm agency={selectedAgency} />

          <section className="space-y-3 rounded-2xl border border-white/[0.06] bg-surface-1/40 p-4 sm:p-5">
            <h2 className="text-sm font-semibold text-zinc-100">{selectedAgency.name} のクリエイター一覧</h2>
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="border-b border-white/[0.06] text-xs uppercase tracking-wider text-zinc-500">
                  <tr>
                    <th className="px-3 py-2">クリエイター</th>
                    <th className="px-3 py-2">TikTok ID</th>
                    <th className="px-3 py-2">分配率</th>
                    <th className="px-3 py-2">今月売上</th>
                    <th className="px-3 py-2">今月収益</th>
                    <th className="px-3 py-2">今月報酬</th>
                  </tr>
                </thead>
                <tbody>
                  {creators.map((creator) => (
                    <tr key={creator.id} className="border-b border-white/[0.04] text-zinc-200">
                      <td className="px-3 py-2">{creator.creatorName}</td>
                      <td className="px-3 py-2 font-mono text-xs text-zinc-400">{creator.tiktokId}</td>
                      <td className="px-3 py-2">{formatPercent(creator.commissionRate)}</td>
                      <td className="px-3 py-2">{formatYen(creator.paidSalesMonth)}</td>
                      <td className="px-3 py-2">{formatYen(creator.paidProfitMonth)}</td>
                      <td className="px-3 py-2">{formatYen(creator.agencyRewardMonth)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="space-y-3 rounded-2xl border border-white/[0.06] bg-surface-1/40 p-4 sm:p-5">
            <h2 className="text-sm font-semibold text-zinc-100">月次報酬一覧</h2>
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="border-b border-white/[0.06] text-xs uppercase tracking-wider text-zinc-500">
                  <tr>
                    <th className="px-3 py-2">対象月</th>
                    <th className="px-3 py-2">売上</th>
                    <th className="px-3 py-2">収益</th>
                    <th className="px-3 py-2">報酬</th>
                    <th className="px-3 py-2">稼働CR</th>
                  </tr>
                </thead>
                <tbody>
                  {monthlyRewards.map((row) => (
                    <tr key={row.targetMonth} className="border-b border-white/[0.04] text-zinc-200">
                      <td className="px-3 py-2 font-mono text-xs">{row.targetMonth}</td>
                      <td className="px-3 py-2">{formatYen(row.paidSales)}</td>
                      <td className="px-3 py-2">{formatYen(row.paidProfit)}</td>
                      <td className="px-3 py-2">{formatYen(row.agencyReward)}</td>
                      <td className="px-3 py-2">{row.activeCreatorCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
