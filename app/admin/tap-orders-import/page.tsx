import { redirect } from "next/navigation";

import { TapOrdersImportClient } from "@/app/admin/tap-orders-import/TapOrdersImportClient";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";

/*
  TAP注文明細の取込（親管理者専用）。

  ■ なぜ画面にも認証を置くか
  ここで取り込んだ明細がそのまま紹介者報酬の計算元になる。
  画面を開けること自体を管理者に限る。
  server action 側にも同じ判定を入れてあり、画面を通さず
  直接呼ばれた場合も拒否される（画面の制御だけに頼らない）。

  判定は他の親管理画面と同じ resolveAppUserContext / isAdminRole を使う。
*/
export const dynamic = "force-dynamic";

export default async function TapOrdersImportPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/admin/tap-orders-import");
  }

  const appUser = await resolveAppUserContext(supabase, user);
  if (!isAdminRole(appUser.data.role)) {
    redirect("/dashboard");
  }

  return <TapOrdersImportClient />;
}
