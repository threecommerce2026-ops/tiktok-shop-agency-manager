import Link from "next/link";
import { redirect } from "next/navigation";

import { MonthlyAccountTypeBoardClient } from "./MonthlyAccountTypeBoardClient";
import { fetchMonthlyAccountTypeBoard } from "@/lib/db/monthly-account-type-board-queries";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export default async function MonthlyAccountManagementTypesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/admin/monthly-account-management-types");
  }

  const appUser = await resolveAppUserContext(supabase, user);
  if (!isAdminRole(appUser.data.role)) {
    redirect("/dashboard");
  }

  /*
    対象テーブルは RLS が管理者のみのため service role で読む
    （画面そのものが admin 限定）。
    確定（WRITE）はユーザーのクライアントで RPC を呼ぶので、
    auth.uid() が監査ログに残る。
  */
  const data = await fetchMonthlyAccountTypeBoard(getSupabaseAdmin());

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          親管理画面
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
          月別クリエイター区分
        </h1>
        <div className="mt-2 max-w-3xl space-y-1 rounded-lg border border-white/[0.06] bg-surface-1/40 px-3 py-2 text-[11px] leading-relaxed text-zinc-400">
          <p>
            1行 = <span className="text-zinc-200">クリエイター × 対象月</span>。
            チェックした行だけを月別確定します。
          </p>
          <p>
            区分は紹介報酬5%が発生しうるかを決めます（
            <span className="text-zinc-200">通常</span> のみ対象）。
            確定した月は、あとから現在区分を変えても動きません。
          </p>
          <p>
            埋める値はクリエイターマスタの
            <span className="text-zinc-200">現在区分</span>です。
            区分の変更履歴の日時から過去の区分を推測することはしません。
          </p>
          <p className="text-amber-200/80">
            確定しても紹介報酬の明細は変わりません。金額へ反映するには
            「売上・報酬 › 紹介報酬」で再集計してください。
          </p>
        </div>
      </div>

      {data.error ? (
        <div
          className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100"
          role="alert"
        >
          <p className="font-semibold">データの取得に失敗しました</p>
          <p className="mt-1 text-amber-200/90">{data.error}</p>
        </div>
      ) : (
        <MonthlyAccountTypeBoardClient data={data} />
      )}

      <div className="flex flex-wrap justify-center gap-4">
        <Link
          href="/admin/monthly-agency-assignments"
          className="text-sm font-medium text-[var(--accent-cyan)] hover:underline"
        >
          月別所属 一括確認・確定
        </Link>
        <Link
          href="/payments?tab=tap"
          className="text-sm font-medium text-[var(--accent-cyan)] hover:underline"
        >
          TAP実績
        </Link>
        <Link
          href="/creators"
          className="text-sm font-medium text-[var(--accent-cyan)] hover:underline"
        >
          クリエイター
        </Link>
      </div>
    </div>
  );
}
