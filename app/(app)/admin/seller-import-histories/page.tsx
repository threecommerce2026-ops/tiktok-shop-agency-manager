import { fetchSellerImportHistories } from "@/lib/db/seller-import-history-queries";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function SellerImportHistoriesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/admin/seller-import-histories");
  }

  const appUser = await resolveAppUserContext(supabase, user);
  if (!isAdminRole(appUser.data.role)) {
    redirect("/dashboard");
  }

  const result = await fetchSellerImportHistories(supabase, 200);

  return (
    <div className="space-y-8">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">親管理画面</p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">セラー取込履歴</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-500">
          CSV / Excel からのセラー一括取込の履歴です。
        </p>
        <p className="mt-3 flex flex-wrap gap-3 text-sm">
          <Link href="/admin/sellers" className="font-medium text-[var(--accent-cyan)] hover:underline">
            ← セラー管理
          </Link>
        </p>
      </div>

      {result.error ? (
        <div
          className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100"
          role="alert"
        >
          <p className="font-semibold">履歴の取得に失敗しました</p>
          <p className="mt-1 text-amber-200/90">{result.error}</p>
          {result.error.includes("relation") || result.error.includes("does not exist") ? (
            <p className="mt-2 text-xs text-amber-200/80">
              seller_import_histories テーブルが未作成の可能性があります。supabase/sql/seller_import_histories_schema.sql
              を実行してください。
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-xl border border-white/[0.06] bg-surface-1/40">
        <table className="min-w-[800px] w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-white/[0.06] bg-surface-1/80 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              <th className="px-4 py-3">日時</th>
              <th className="px-4 py-3">ファイル名</th>
              <th className="px-4 py-3 text-right">対象行</th>
              <th className="px-4 py-3 text-right">新規</th>
              <th className="px-4 py-3 text-right">更新</th>
              <th className="px-4 py-3 text-right">エラー</th>
              <th className="px-4 py-3">実行者</th>
            </tr>
          </thead>
          <tbody>
            {result.data.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-sm text-zinc-500">
                  履歴がありません。
                </td>
              </tr>
            ) : (
              result.data.map((row) => (
                <tr key={row.id} className="border-b border-white/[0.04] hover:bg-white/[0.02]">
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-zinc-400">
                    {new Date(row.created_at).toLocaleString("ja-JP")}
                  </td>
                  <td className="max-w-[14rem] truncate px-4 py-3 text-zinc-200" title={row.file_name ?? ""}>
                    {row.file_name ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs text-zinc-300">{row.total_count}</td>
                  <td className="px-4 py-3 text-right font-mono text-xs text-emerald-400">{row.inserted_count}</td>
                  <td className="px-4 py-3 text-right font-mono text-xs text-amber-300">{row.updated_count}</td>
                  <td className="px-4 py-3 text-right font-mono text-xs text-red-400">{row.error_count}</td>
                  <td className="max-w-[12rem] truncate px-4 py-3 text-xs text-zinc-500">{row.imported_by ?? "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex justify-center">
        <Link href="/dashboard" className="text-sm font-medium text-[var(--accent-cyan)] hover:underline">
          ← ダッシュボード
        </Link>
      </div>
    </div>
  );
}
