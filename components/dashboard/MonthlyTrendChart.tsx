import type { MonthlyTrendPoint } from "@/lib/db/dashboard-queries";
import { formatYen } from "@/lib/revenue/calc";

export function MonthlyTrendChart({ data }: { data: MonthlyTrendPoint[] }) {
  if (!data.length) {
    return (
      <p className="rounded-2xl border border-dashed border-white/[0.1] bg-surface-1/40 px-6 py-12 text-center text-sm text-zinc-500">
        月別データがありません。CSV をアップロードすると推移が表示されます。
      </p>
    );
  }

  const maxVal = Math.max(...data.map((d) => Math.max(d.sales, d.profit, 1)), 1);

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-surface-1/50 p-4 sm:p-6">
      <h3 className="text-sm font-semibold text-zinc-200">月別推移（売上・収益）</h3>
      <p className="mt-1 text-xs text-zinc-600">
        棒の高さは売上。収益はツールチップ相当の数値表示。
      </p>
      <div className="mt-6 flex h-48 items-end justify-between gap-1.5 sm:gap-2">
        {data.map((d) => {
          const maxPx = 140;
          const barSales = Math.round((d.sales / maxVal) * maxPx);
          const barProfit = Math.round((d.profit / maxVal) * maxPx);
          return (
            <div
              key={d.month}
              className="flex min-w-0 flex-1 flex-col items-center gap-2"
            >
              <div className="flex h-[140px] w-full max-w-[3rem] items-end justify-center gap-0.5 sm:max-w-none">
                <div
                  className="w-1/2 min-w-[6px] rounded-t-md bg-gradient-to-t from-[var(--accent-cyan)]/30 to-[var(--accent-cyan)]/70"
                  style={{ height: `${Math.max(4, barSales)}px` }}
                  title={`売上 ${formatYen(d.sales)}`}
                />
                <div
                  className="w-1/2 min-w-[6px] rounded-t-md bg-gradient-to-t from-[var(--accent-magenta)]/25 to-[var(--accent-magenta)]/60"
                  style={{ height: `${Math.max(4, barProfit)}px` }}
                  title={`収益 ${formatYen(d.profit)}`}
                />
              </div>
              <span className="truncate text-[10px] font-mono text-zinc-500 sm:text-xs">
                {d.month}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-4 flex flex-wrap justify-center gap-6 text-xs text-zinc-500">
        <span className="inline-flex items-center gap-2">
          <span className="h-2 w-2 rounded-sm bg-[var(--accent-cyan)]/70" />
          売上
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="h-2 w-2 rounded-sm bg-[var(--accent-magenta)]/60" />
          収益
        </span>
      </div>
    </div>
  );
}
