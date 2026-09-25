import Link from "next/link";
import { redirect } from "next/navigation";

import { PartnerCenterImportClient } from "@/app/admin/partner-center-import/PartnerCenterImportClient";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function PartnerCenterImportPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/admin/partner-center-import");
  }

  // 画面側も API と同じ管理者判定を使う（代理店ユーザーは入れない）
  const appUser = await resolveAppUserContext(supabase, user);
  if (!isAdminRole(appUser.data.role)) {
    redirect("/dashboard");
  }

  return (
    <div className="space-y-8">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">親管理画面</p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
          Partner Center データ取込
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-500">
          Partner Center から取得した Shop ID 付きのショップ情報を取り込みます。
          ここで取り込んだ Shop ID は「セラー管理 › TikTok Shop紐付け」の候補になります。
          この画面から sellers.shop_id を直接変更することはできません。
        </p>
      </div>

      <PartnerCenterImportClient />

      <div className="flex justify-center gap-4">
        <Link href="/admin/sellers" className="text-sm font-medium text-[var(--accent-cyan)] hover:underline">
          セラー管理へ
        </Link>
        <Link href="/dashboard" className="text-sm font-medium text-[var(--accent-cyan)] hover:underline">
          ← ダッシュボード
        </Link>
      </div>
    </div>
  );
}
