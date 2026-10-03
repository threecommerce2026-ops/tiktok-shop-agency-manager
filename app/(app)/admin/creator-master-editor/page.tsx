import Link from "next/link";
import { RelationRepairPanel } from "@/components/referrer/RelationRepairPanel";
import { BuildMarker } from "@/components/app/BuildMarker";
import { redirect } from "next/navigation";

import { CreatorMasterEditorClient } from "./CreatorMasterEditorClient";
import { fetchCreatorMasterEditorData } from "@/lib/db/creator-master-editor-queries";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export default async function CreatorMasterEditorPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/admin/creator-master-editor");
  }

  const appUser = await resolveAppUserContext(supabase, user);
  if (!isAdminRole(appUser.data.role)) {
    redirect("/dashboard");
  }

  // creators / agencies / referrers は RLS が管理者のみ。画面自体も admin 限定。
  const data = await fetchCreatorMasterEditorData(getSupabaseAdmin());

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          親管理画面
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
          クリエイターマスタ 一括編集
        </h1>
        <div className="mt-2 max-w-3xl space-y-1 rounded-lg border border-white/[0.06] bg-surface-1/40 px-3 py-2 text-[11px] leading-relaxed text-zinc-400">
          <p>
            一覧を見ながら{" "}
            <span className="text-zinc-200">所属代理店 / 紹介者 / 区分</span>{" "}
            を直接変更できます。変更した行には「未保存」が付きます。
          </p>
          <p>
            保存前に「変更内容を確認」で 変更前 → 変更後 を必ず確認してください。
          </p>
          <p className="text-amber-200/80">
            保存してもDBの報酬明細（代理店報酬・紹介者報酬）と月別確定所属は変更しません。
            マスタ整理 → 月別所属の確定 → 代理店報酬の再集計 の順で進めてください。
          </p>
          <p className="text-zinc-500">
            TikTok ID は一意キーのためこの画面では変更できません（クリエイター画面の個別編集から）。
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
        <CreatorMasterEditorClient data={data} />
      )}

      {/*
        紹介者の付け替えで「終了月 < 開始月」になった関係を直すパネル。

        この画面はクリエイターマスタの整理をする場所で、
        紹介者の異常に気づくのもここなので同じ画面から直せるようにする。
        2026-10-03: /creators と /admin/creator-referrals だけに置いていて
        気づけなかった。
      */}
      <RelationRepairPanel />

      <div className="flex flex-wrap justify-center gap-4">
        <Link
          href="/creators"
          className="text-sm font-medium text-[var(--accent-cyan)] hover:underline"
        >
          ← クリエイター
        </Link>
        <Link
          href="/admin/monthly-agency-assignments"
          className="text-sm font-medium text-[var(--accent-cyan)] hover:underline"
        >
          月別所属 一括確認・確定
        </Link>
        <Link
          href="/admin/monthly-account-management-types"
          className="text-sm font-medium text-[var(--accent-cyan)] hover:underline"
        >
          月別クリエイター区分
        </Link>
        <Link
          href="/revenue?tab=agency"
          className="text-sm font-medium text-[var(--accent-cyan)] hover:underline"
        >
          代理店報酬
        </Link>
      </div>

      {/* いま見ているページとビルドを管理者が判別できるようにする */}
      <BuildMarker page="/admin/creator-master-editor" />
    </div>
  );
}
