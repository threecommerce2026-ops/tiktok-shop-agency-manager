import type { MonthlyTrendPoint } from "@/lib/db/dashboard-queries";

import { formatYen } from "@/lib/revenue/calc";

export function MonthlyTrendChart({ data }: { data: MonthlyTrendPoint[] }) {
  const hasData = data.some(
    (d) => d.sales > 0 || d.profit > 0 || d.reward > 0,
  );

  if (!hasData) {
    return (
      <p className="rounded-2xl border border-dashed border-white/[0.1] bg-surface-1/40 px-6 py-12 text-center text-sm text-zinc-500">
        対象期間のCAP実績・代理店報酬データはありません。
      </p>
    );
  }

  const maxVal = Math.max(
    ...data.map((d) => Math.max(d.sales, d.profit, d.reward, 1)),
    1,
  );

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-surface-1/50 p-4 sm:p-6">
      <h3 className="text-sm font-semibold text-zinc-200">
        月別推移（CAP GMV・代理店収益・代理店報酬）
      </h3>

      <p className="mt-1 text-xs text-zinc-600">
        月別のCAP実績と正式な代理店支払予定額を表示しています。
      </p>

      <div className="mt-6 flex h-48 items-end justify-between gap-1.5 sm:gap-2">
        {data.map((d) => {
          const maxPx = 140;
          const barSales = Math.round((d.sales / maxVal) * maxPx);
          const barProfit = Math.round((d.profit / maxVal) * maxPx);
          const barReward = Math.round((d.reward / maxVal) * maxPx);

          return (
            <div
              key={d.month}
              className="flex min-w-0 flex-1 flex-col items-center gap-2"
            >
              <div className="flex h-[140px] w-full max-w-[3rem] items-end justify-center gap-0.5 sm:max-w-none">
                <div
                  className="w-1/3 min-w-[5px] rounded-t-md bg-gradient-to-t from-[var(--accent-cyan)]/30 to-[var(--accent-cyan)]/70"
                  style={{ height: `${Math.max(4, barSales)}px` }}
                  title={`CAP GMV ${formatYen(d.sales)}`}
                />
                <div
                  className="w-1/3 min-w-[5px] rounded-t-md bg-gradient-to-t from-[var(--accent-magenta)]/25 to-[var(--accent-magenta)]/60"
                  style={{ height: `${Math.max(4, barProfit)}px` }}
                  title={`CAP代理店収益 ${formatYen(d.profit)}`}
                />
                <div
                  className="w-1/3 min-w-[5px] rounded-t-md bg-white/30"
                  style={{ height: `${Math.max(4, barReward)}px` }}
                  title={`代理店報酬 ${formatYen(d.reward)}`}
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
          CAP GMV
        </span>

        <span className="inline-flex items-center gap-2">
          <span className="h-2 w-2 rounded-sm bg-[var(--accent-magenta)]/60" />
          CAP代理店収益
        </span>

        <span className="inline-flex items-center gap-2">
          <span className="h-2 w-2 rounded-sm bg-white/30" />
          代理店報酬
        </span>
      </div>
    </div>
  );
}
