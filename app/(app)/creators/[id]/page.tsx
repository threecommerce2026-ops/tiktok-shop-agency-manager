import { MonthlyTrendChart } from "@/components/dashboard/MonthlyTrendChart";
import { fetchCreatorDetail } from "@/lib/db/creator-detail-queries";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";
import { formatPercent, formatYen } from "@/lib/revenue/calc";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

type Props = {
  params: Promise<{ id: string }>;
};

export default async function CreatorDetailPage({ params }: Props) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?next=/creators/${id}`);
  }

  const appUser = await resolveAppUserContext(supabase, user);
  const detail = await fetchCreatorDetail(supabase, id);

  if (detail.error) {
    return (
      <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
        {detail.error}
      </div>
    );
  }

  if (!detail.data) {
    notFound();
  }

  if (
    !isAdminRole(appUser.data.role) &&
    detail.data.agency_id !== appUser.data.agencyId
  ) {
    notFound();
  }

  const creator = detail.data;
  const salesTrend = creator.monthlySalesTrend.map((point) => ({
    month: point.month,
    sales: point.sales,
    profit: point.profit,
    reward: 0,
  }));

  return (
    <div className="space-y-8">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          {creator.agency_name}
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
          {creator.creator_name}
        </h1>
        <p className="mt-2 font-mono text-sm text-zinc-500">{creator.tiktok_id}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[
          ["所属代理店", creator.agency_name],
          ["収益分配率", formatPercent(creator.commission_rate)],
          ["今月売上", formatYen(creator.salesMonth)],
          ["累計売上", formatYen(creator.salesTotal)],
          ["今月収益", formatYen(creator.profitMonth)],
          ["累計収益", formatYen(creator.profitTotal)],
          ["代理店報酬予定", formatYen(creator.rewardMonth)],
          [
            "最終更新日",
            creator.lastUpdatedAt
              ? new Date(creator.lastUpdatedAt).toLocaleString("ja-JP")
              : "—",
          ],
        ].map(([label, value]) => (
          <div
            key={label}
            className="rounded-2xl border border-white/[0.07] bg-surface-1/60 p-5 ring-glow"
          >
            <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-zinc-500">
              {label}
            </p>
            <p className="mt-3 font-mono text-xl font-bold text-zinc-50">{value}</p>
          </div>
        ))}
      </div>

      <section>
        <h2 className="text-lg font-semibold text-zinc-200">月別売上推移</h2>
        <div className="mt-4">
          <MonthlyTrendChart data={salesTrend} />
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-zinc-200">CSV 取込履歴</h2>
        <div className="mt-4 overflow-x-auto rounded-2xl border border-white/[0.06]">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-white/[0.06] bg-surface-1/80 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                <th className="px-4 py-3">保存日時</th>
                <th className="px-4 py-3">対象月</th>
                <th className="px-4 py-3 text-right">売上</th>
                <th className="px-4 py-3 text-right">収益</th>
                <th className="px-4 py-3 text-right">注文</th>
              </tr>
            </thead>
            <tbody>
              {creator.importHistory.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-zinc-500">
                    履歴がありません
                  </td>
                </tr>
              ) : (
                creator.importHistory.map((row) => (
                  <tr key={row.id} className="border-b border-white/[0.04]">
                    <td className="px-4 py-3 font-mono text-xs text-zinc-400">
                      {new Date(row.created_at).toLocaleString("ja-JP")}
                    </td>
                    <td className="px-4 py-3 font-mono">{row.target_month}</td>
                    <td className="px-4 py-3 text-right font-mono">
                      {formatYen(row.sales_amount)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-[var(--accent-cyan)]">
                      {formatYen(row.profit_amount)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">{row.order_count}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <div className="flex justify-center">
        <Link
          href="/creators"
          className="text-sm font-medium text-[var(--accent-cyan)] hover:underline"
        >
          ← クリエイター売上一覧
        </Link>
      </div>
    </div>
  );
}
