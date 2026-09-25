import Link from "next/link";
import { redirect } from "next/navigation";

import { currentMonthKey } from "@/lib/db/dashboard-queries";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type LinkCard = {
  href: string;
  title: string;
  description: string;
};

const IMPORT_LINKS: LinkCard[] = [
  {
    href: "/admin/affiliate-orders-import",
    title: "アフィリエイト注文 CSV 取込",
    description:
      "CAP エクスポート（affiliate_order_lines）を取り込みます。売上・代理店報酬・紹介者報酬のすべての計算元です。",
  },
  {
    href: "/admin/tap-orders-import",
    title: "TAP 注文 CSV 取込",
    description: "TAP 推定報酬（tap_affiliate_order_lines）の取り込み。参考値として保持します。",
  },
  {
    href: "/admin/partner-center-import",
    title: "Partner Center 取込",
    description: "Partner Center のエクスポートを取り込みます。",
  },
  {
    href: "/admin/shop-performance",
    title: "ショップ実績CSV取込",
    description: "ショップランキングCSVを取り込みます。セラー請求の根拠データです。",
  },
  {
    href: "/admin/seller-billing",
    title: "セラー請求",
    description:
      "取り込んだショップ実績から請求額を計算し、請求書の作成・発行・入金管理を行います。",
  },
];

const API_LINKS: LinkCard[] = [
  {
    href: "/admin/api-connections",
    title: "TikTok API 接続設定",
    description: "ショップ単位の OAuth 接続とトークンを管理します。",
  },
  {
    href: "/admin/api-sync",
    title: "API 同期実行",
    description: "TikTok Shop API から注文データを取得します。",
  },
];

const HISTORY_LINKS: LinkCard[] = [
  {
    href: "/csv-logs",
    title: "CSV 取込履歴",
    description: "取込件数・失敗件数・失敗理由を確認できます。",
  },
  {
    href: "/sync-jobs",
    title: "同期ジョブ履歴",
    description: "API 同期の実行履歴です。",
  },
  {
    href: "/admin/seller-import-histories",
    title: "セラー取込履歴",
    description: "セラーマスタ取込の履歴です。",
  },
];

function CardGrid({ title, links }: { title: string; links: LinkCard[] }) {
  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold text-zinc-300">{title}</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {links.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="group rounded-xl border border-white/[0.07] bg-surface-1/50 p-4 transition hover:border-white/[0.14] hover:bg-surface-1/80"
          >
            <p className="text-sm font-semibold text-zinc-100 group-hover:text-white">
              {link.title}
            </p>
            <p className="mt-1.5 text-xs leading-relaxed text-zinc-500">{link.description}</p>
          </Link>
        ))}
      </div>
    </section>
  );
}

export default async function DataSyncPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/data-sync");
  }

  const appUser = await resolveAppUserContext(supabase, user);
  if (!isAdminRole(appUser.data.role)) {
    redirect("/dashboard");
  }

  const admin = getSupabaseAdmin();
  const month = currentMonthKey();

  const [ordersResult, batchesResult, csvLogsResult] = await Promise.all([
    admin
      .from("affiliate_order_lines")
      .select("id", { count: "exact", head: true })
      .eq("target_month", month),
    admin
      .from("affiliate_order_import_batches")
      .select("id, file_name, row_total, upserted_count, failed_count, created_at")
      .order("created_at", { ascending: false })
      .limit(5),
    admin
      .from("csv_import_logs")
      .select("id, created_at, target_month, file_name, success_count, failed_count")
      .order("created_at", { ascending: false })
      .limit(5),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">親管理画面</p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
          データ連携
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-500">
          CSV 取込・TikTok API 連携・同期履歴をここに集約しています。通常業務ではこの画面以外を触る必要はありません。
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-white/[0.07] bg-surface-1/60 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
            今月の注文明細
          </p>
          <p className="mt-2 font-mono text-xl font-bold text-zinc-50">
            {(ordersResult.count ?? 0).toLocaleString("ja-JP")}
          </p>
          <p className="mt-1 text-[11px] text-zinc-600">{month}</p>
        </div>
        <div className="rounded-2xl border border-white/[0.07] bg-surface-1/60 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
            直近の注文取込
          </p>
          <p className="mt-2 truncate font-mono text-sm text-zinc-200">
            {batchesResult.data?.[0]?.file_name ?? "—"}
          </p>
          <p className="mt-1 text-[11px] text-zinc-600">
            {batchesResult.data?.[0]?.created_at
              ? new Date(batchesResult.data[0].created_at as string).toLocaleString("ja-JP")
              : "履歴なし"}
          </p>
        </div>
        <div className="rounded-2xl border border-white/[0.07] bg-surface-1/60 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
            直近の CSV 取込
          </p>
          <p className="mt-2 truncate font-mono text-sm text-zinc-200">
            {csvLogsResult.data?.[0]?.file_name ?? "—"}
          </p>
          <p className="mt-1 text-[11px] text-zinc-600">
            {csvLogsResult.data?.[0]?.created_at
              ? new Date(csvLogsResult.data[0].created_at as string).toLocaleString("ja-JP")
              : "履歴なし"}
          </p>
        </div>
      </div>

      <CardGrid title="CSV 取込" links={IMPORT_LINKS} />
      <CardGrid title="TikTok API" links={API_LINKS} />
      <CardGrid title="履歴" links={HISTORY_LINKS} />

      {batchesResult.data && batchesResult.data.length > 0 ? (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-zinc-300">直近の注文取込バッチ</h2>
          <div className="overflow-x-auto rounded-xl border border-zinc-800">
            <table className="w-full min-w-[620px] text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-800 bg-surface-1/80 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                  <th className="px-4 py-2.5">日時</th>
                  <th className="px-4 py-2.5">ファイル</th>
                  <th className="px-4 py-2.5 text-right">行数</th>
                  <th className="px-4 py-2.5 text-right">取込</th>
                  <th className="px-4 py-2.5 text-right">失敗</th>
                </tr>
              </thead>
              <tbody>
                {batchesResult.data.map((batch) => (
                  <tr key={batch.id as string} className="border-b border-zinc-800/60">
                    <td className="px-4 py-2.5 font-mono text-xs text-zinc-400">
                      {new Date(batch.created_at as string).toLocaleString("ja-JP")}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-zinc-200">
                      {String(batch.file_name ?? "—")}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs text-zinc-400">
                      {Number(batch.row_total ?? 0).toLocaleString("ja-JP")}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs text-emerald-300">
                      {Number(batch.upserted_count ?? 0).toLocaleString("ja-JP")}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs text-red-300">
                      {Number(batch.failed_count ?? 0).toLocaleString("ja-JP")}
                    </td>
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
