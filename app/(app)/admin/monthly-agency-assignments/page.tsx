import Link from "next/link";
import { redirect } from "next/navigation";

import { MonthlyAssignmentBoardClient } from "./MonthlyAssignmentBoardClient";
import { fetchMonthlyAssignmentBoard } from "@/lib/db/monthly-assignment-board-queries";
import { currentMonthKey } from "@/lib/db/dashboard-queries";
import { rewardYearOf } from "@/lib/agency/agency-reward-engine";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export default async function MonthlyAgencyAssignmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/admin/monthly-agency-assignments");
  }

  const appUser = await resolveAppUserContext(supabase, user);
  if (!isAdminRole(appUser.data.role)) {
    redirect("/dashboard");
  }

  const params = await searchParams;
  const year =
    params.year && /^\d{4}$/.test(params.year)
      ? params.year
      : rewardYearOf(currentMonthKey());

  // 対象テーブルは RLS が管理者のみのため service role で読む（画面は admin 限定）
  const data = await fetchMonthlyAssignmentBoard(getSupabaseAdmin(), year);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          親管理画面
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
          月別所属 一括確認・確定
        </h1>
        <div className="mt-2 max-w-3xl space-y-1 rounded-lg border border-white/[0.06] bg-surface-1/40 px-3 py-2 text-[11px] leading-relaxed text-zinc-400">
          <p>
            1行 = <span className="text-zinc-200">クリエイター × 対象月</span>。
            チェックした行だけを月別確定します。
          </p>
          <p>
            現在所属を自動で過去月へ確定することはありません。内容を確認してから確定してください。
          </p>
          <p className="text-amber-200/80">
            確定しても代理店報酬の明細は変わりません。金額へ反映するには「売上・報酬 › 代理店報酬」で再集計してください。
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
        <MonthlyAssignmentBoardClient data={data} />
      )}

      <div className="flex flex-wrap justify-center gap-4">
        <Link
          href="/revenue?tab=agency"
          className="text-sm font-medium text-[var(--accent-cyan)] hover:underline"
        >
          ← 代理店報酬
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
