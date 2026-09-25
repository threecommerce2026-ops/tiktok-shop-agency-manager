import { CreatorMasterClient } from "@/app/(app)/creators/CreatorMasterClient";
import { fetchCreatorMasterRows } from "@/lib/db/creator-master-queries";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function CreatorsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/creators");
  }

  const appUser = await resolveAppUserContext(supabase, user);
  const isAdmin = isAdminRole(appUser.data.role);

  if (!isAdmin && !appUser.data.agencyId) {
    return (
      <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-6 text-sm text-red-200">
        {appUser.error ?? "代理店を初期化できませんでした"}
      </div>
    );
  }

  /*
    creators / affiliate_order_lines は RLS が管理者のみ SELECT 可のため
    読み取りは service role で行い、代理店スコープはサーバー側で必ず絞る。
    書き込みはログインユーザーのクライアント経由（RLS維持）。
  */
  const data = await fetchCreatorMasterRows(getSupabaseAdmin(), {
    agencyId: isAdmin ? null : appUser.data.agencyId,
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
            {isAdmin ? "親管理画面" : appUser.data.agencyName}
          </p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
            クリエイター
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-500">
            クリエイターマスタです。TikTok ID を一意キーとして、所属代理店・紹介者・区分・分配率をここで管理します。
            {isAdmin ? "変更履歴は自動で保存されます。" : null}
          </p>
        </div>

        {isAdmin ? (
          <Link
            href="/admin/creator-master-editor"
            className="inline-flex min-h-[40px] shrink-0 items-center rounded-lg border border-white/[0.1] px-4 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.06]"
          >
            マスタを一括編集
          </Link>
        ) : null}
      </div>

      {data.error ? (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          {data.error}
        </div>
      ) : null}

      <CreatorMasterClient
        rows={data.rows}
        agencies={data.agencies}
        referrers={data.referrers}
        month={data.month}
        isAdmin={isAdmin}
      />
    </div>
  );
}
