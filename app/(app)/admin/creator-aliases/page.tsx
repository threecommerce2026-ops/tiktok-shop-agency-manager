import { redirect } from "next/navigation";

import { CreatorAliasesClient } from "@/app/(app)/admin/creator-aliases/CreatorAliasesClient";
import { fetchCreatorAliasesForAdmin } from "@/app/actions/creator-aliases";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/*
  クリエイター改名（旧ユーザー名 → 正式ユーザー名）の管理。

  source_row_key は「クリエイターのユーザー名」を含むため、
  TikTok 側で改名されると同じ注文明細が別キーになり二重登録される。
  ここで旧名を登録しておくと、Excel取込時に正式名へ寄せてから
  キーを作るので二重登録が起きない。
*/
export default async function CreatorAliasesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login?next=/admin/creator-aliases");

  const appUser = await resolveAppUserContext(supabase, user);
  if (!isAdminRole(appUser.data.role)) redirect("/dashboard");

  const result = await fetchCreatorAliasesForAdmin();

  return (
    <CreatorAliasesClient
      aliases={result.ok ? result.aliases : []}
      loadError={result.ok ? null : result.error}
      migrationMissing={result.ok ? result.migrationMissing : false}
    />
  );
}
