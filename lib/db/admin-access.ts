import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";

export async function requireAdminAction() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false as const, error: "ログインが必要です", supabase, user: null };
  }

  const appUser = await resolveAppUserContext(supabase, user);
  if (!isAdminRole(appUser.data.role)) {
    return {
      ok: false as const,
      error: "この操作は親管理者のみ実行できます",
      supabase,
      user: null,
    };
  }

  return { ok: true as const, supabase, user };
}
