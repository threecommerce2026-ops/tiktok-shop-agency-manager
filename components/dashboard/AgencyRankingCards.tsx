import type { AgencyRankingRow } from "@/lib/db/admin-dashboard-queries";
import { formatYen } from "@/lib/revenue/calc";

function rankAccent(rank: number) {
  if (rank === 1) return "from-amber-400/30 to-amber-500/10 text-amber-100 ring-amber-400/30";
  if (rank === 2) return "from-zinc-300/20 to-zinc-400/10 text-zinc-100 ring-zinc-300/20";
  if (rank === 3) return "from-orange-400/20 to-orange-500/10 text-orange-100 ring-orange-400/25";
  return "from-white/[0.06] to-white/[0.02] text-zinc-300 ring-white/[0.08]";
}

export function AgencyRankingCards({ rows }: { rows: AgencyRankingRow[] }) {
  if (!rows.length) {
    return (
      <p className="rounded-2xl border border-dashed border-white/[0.1] bg-surface-1/40 px-6 py-12 text-center text-sm text-zinc-500">
        代理店ランキングを表示するデータがありません。
      </p>
    );
  }

  return (
    <ol className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {rows.map((row) => (
        <li
          key={row.agencyId}
          className="rounded-2xl border border-white/[0.08] bg-gradient-to-br from-surface-1/90 to-surface-0/70 p-5 ring-glow"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <span
                className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br font-mono text-sm font-bold ring-1 ${rankAccent(row.rank)}`}
              >
                #{row.rank}
              </span>
              <div className="min-w-0">
                <p className="truncate text-lg font-semibold text-zinc-50">{row.agencyName}</p>
                <p className="mt-1 text-xs text-zinc-500">今月収益で並び替え</p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                今月収益
              </p>
              <p className="mt-1 font-mono text-lg font-bold text-[var(--accent-cyan)]">
                {formatYen(row.profitMonth)}
              </p>
            </div>
          </div>

          <dl className="mt-5 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            <div className="rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2.5">
              <dt className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
                今月売上
              </dt>
              <dd className="mt-1 font-mono font-semibold text-zinc-100">
                {formatYen(row.salesMonth)}
              </dd>
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2.5">
              <dt className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
                代理店報酬
              </dt>
              <dd className="mt-1 font-mono font-semibold text-gradient-brand">
                {formatYen(row.rewardMonth)}
              </dd>
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2.5">
              <dt className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
                紹介クリエイター
              </dt>
              <dd className="mt-1 font-mono font-semibold text-zinc-200">
                {row.creatorCount}
              </dd>
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2.5 sm:col-span-2 lg:col-span-1">
              <dt className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
                稼働クリエイター
              </dt>
              <dd className="mt-1 font-mono font-semibold text-zinc-200">
                {row.activeCreatorCount}
              </dd>
            </div>
          </dl>
        </li>
      ))}
    </ol>
  );
}
