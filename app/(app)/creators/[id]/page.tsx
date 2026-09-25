import { MonthlyTrendChart } from "@/components/dashboard/MonthlyTrendChart";
import { fetchCreatorDetail } from "@/lib/db/creator-detail-queries";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";
import { formatYen } from "@/lib/revenue/calc";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

/*
  クリエイター詳細。

  表示する数値はすべて lib/db/creator-monthly-finance-queries.ts の
  計算層を通したもの。この画面では集計しない。
*/

type Props = {
  params: Promise<{ id: string }>;
};

const th =
  "whitespace-nowrap border-b border-zinc-800 bg-zinc-900/60 px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-500";

const td = "whitespace-nowrap px-4 py-3 text-sm";

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

  /* 推移グラフは既存コンポーネントをそのまま使う（古い月が左） */
  const trend = [...creator.months].reverse().map((entry) => ({
    month: entry.targetMonth,
    sales: entry.row.capGmv,
    profit: entry.row.capRevenue,
    reward: entry.row.agencyPayout,
  }));

  const summary: Array<[string, string]> = [
    ["CAP GMV（累計）", formatYen(creator.totals.capGmv)],
    ["CAP Revenue（累計）", formatYen(creator.totals.capRevenue)],
    ["TAP Revenue（累計）", formatYen(creator.totals.tapRevenue)],
    ["クリエイター支払（累計）", formatYen(creator.totals.creatorPayout)],
    ["紹介報酬（累計）", formatYen(creator.totals.referralReward)],
    ["代理店報酬（累計）", formatYen(creator.totals.agencyPayout)],
  ];

  return (
    <div className="space-y-8">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          {creator.agency_name ?? "代理店未設定"}
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
          {creator.creator_name}
        </h1>
        <p className="mt-2 font-mono text-sm text-zinc-500">{creator.tiktok_id}</p>
        <p className="mt-1 text-xs text-zinc-500">
          区分: {creator.account_management_type ?? "—"}
          {creator.referrer_name ? ` / 紹介者: ${creator.referrer_name}` : ""}
        </p>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {summary.map(([label, value]) => (
          <div
            key={label}
            className="rounded-xl border border-white/[0.08] bg-surface-1 px-4 py-4"
          >
            <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              {label}
            </p>
            <p className="mt-3 font-mono text-xl font-bold text-zinc-50">{value}</p>
          </div>
        ))}
      </section>

      {trend.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-zinc-200">月別推移</h2>
          <MonthlyTrendChart data={trend} />
        </section>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-zinc-200">月別実績</h2>
        <p className="text-[11px] leading-relaxed text-zinc-500">
          売上・報酬の定義は「売上・報酬」画面と同じ計算を使用しています。
          代理店は対象月に確定した所属（未確定の場合は現在所属）です。
        </p>

        <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950/60">
          <table className="min-w-[960px] w-full border-collapse">
            <thead>
              <tr>
                <th className={th}>対象月</th>
                <th className={th}>代理店</th>
                <th className={`${th} text-right`}>CAP GMV</th>
                <th className={`${th} text-right`}>CAP Revenue</th>
                <th className={`${th} text-right`}>TAP Revenue</th>
                <th className={`${th} text-right`}>クリエイター支払</th>
                <th className={`${th} text-right`}>紹介報酬</th>
                <th className={`${th} text-right`}>代理店報酬</th>
              </tr>
            </thead>
            <tbody>
              {creator.months.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-sm text-zinc-500">
                    実績データがまだありません。
                  </td>
                </tr>
              ) : (
                creator.months.map(({ targetMonth, row }) => (
                  <tr key={targetMonth} className="border-b border-zinc-800/70">
                    <td className={`${td} font-mono text-zinc-200`}>{targetMonth}</td>
                    <td className={`${td} text-zinc-300`}>
                      {row.agencyName ?? "—"}
                      {row.isInHouse ? (
                        <span className="ml-2 rounded-full border border-cyan-400/25 bg-cyan-400/10 px-2 py-0.5 text-[10px] text-cyan-200">
                          自社
                        </span>
                      ) : null}
                    </td>
                    <td className={`${td} text-right font-mono text-zinc-300`}>
                      {formatYen(row.capGmv)}
                    </td>
                    <td className={`${td} text-right font-mono text-zinc-300`}>
                      {formatYen(row.capRevenue)}
                    </td>
                    <td className={`${td} text-right font-mono text-zinc-300`}>
                      {formatYen(row.tapRevenue)}
                    </td>
                    <td className={`${td} text-right font-mono text-zinc-300`}>
                      {formatYen(row.creatorPayout)}
                    </td>
                    <td className={`${td} text-right font-mono text-zinc-300`}>
                      {formatYen(row.referralReward)}
                    </td>
                    <td className={`${td} text-right font-mono text-zinc-300`}>
                      {formatYen(row.agencyPayout)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <div>
        <Link href="/creators" className="text-sm font-medium text-[var(--accent-cyan)] hover:underline">
          ← クリエイター一覧
        </Link>
      </div>
    </div>
  );
}
