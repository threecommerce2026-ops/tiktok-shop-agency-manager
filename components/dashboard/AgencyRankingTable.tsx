import type { AgencyRankingRow } from "@/lib/db/admin-dashboard-queries";
import { formatYen } from "@/lib/revenue/calc";

export function AgencyRankingTable({ rows }: { rows: AgencyRankingRow[] }) {
  if (!rows.length) {
    return (
      <p className="rounded-2xl border border-dashed border-white/[0.1] bg-surface-1/40 px-6 py-10 text-center text-sm text-zinc-500">
        代理店ランキングを表示するデータがありません。
      </p>
    );
  }

  return (
    <>
      <div className="hidden overflow-x-auto rounded-2xl border border-white/[0.06] md:block">
        <table className="w-full min-w-[920px] text-left text-sm">
          <thead>
            <tr className="border-b border-white/[0.06] bg-surface-1/80 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              <th className="px-4 py-3">順位</th>
              <th className="px-4 py-3">代理店名</th>
              <th className="px-4 py-3 text-right">今月売上</th>
              <th className="px-4 py-3 text-right">今月収益</th>
              <th className="px-4 py-3 text-right">代理店報酬</th>
              <th className="px-4 py-3 text-right">紹介クリエイター数</th>
              <th className="px-4 py-3 text-right">稼働クリエイター数</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.agencyId} className="border-b border-white/[0.04]">
                <td className="px-4 py-3 font-mono text-zinc-400">{row.rank}</td>
                <td className="px-4 py-3 font-medium text-zinc-100">{row.agencyName}</td>
                <td className="px-4 py-3 text-right font-mono">{formatYen(row.salesMonth)}</td>
                <td className="px-4 py-3 text-right font-mono text-[var(--accent-cyan)]">
                  {formatYen(row.profitMonth)}
                </td>
                <td className="px-4 py-3 text-right font-mono text-gradient-brand">
                  {formatYen(row.rewardMonth)}
                </td>
                <td className="px-4 py-3 text-right font-mono">{row.creatorCount}</td>
                <td className="px-4 py-3 text-right font-mono">{row.activeCreatorCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="flex flex-col gap-3 md:hidden">
        {rows.map((row) => (
          <li
            key={row.agencyId}
            className="rounded-2xl border border-white/[0.07] bg-surface-1/50 p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-mono text-zinc-500">#{row.rank}</p>
                <p className="mt-1 font-semibold text-zinc-100">{row.agencyName}</p>
              </div>
              <p className="font-mono text-sm font-semibold text-zinc-100">
                {formatYen(row.salesMonth)}
              </p>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
              <div>
                <dt className="text-[10px] text-zinc-600">今月収益</dt>
                <dd className="font-mono text-[var(--accent-cyan)]">
                  {formatYen(row.profitMonth)}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] text-zinc-600">代理店報酬</dt>
                <dd className="font-mono text-gradient-brand">
                  {formatYen(row.rewardMonth)}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] text-zinc-600">紹介クリエイター</dt>
                <dd className="font-mono">{row.creatorCount}</dd>
              </div>
              <div>
                <dt className="text-[10px] text-zinc-600">稼働クリエイター</dt>
                <dd className="font-mono">{row.activeCreatorCount}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}
