"use server";

import { currentMonthKey } from "@/lib/db/dashboard-queries";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { runTikTokOrdersSync } from "@/lib/orders/run-tiktok-orders-sync";
import { createClient } from "@/lib/supabase/server";
import { mapSupabaseErrorToJa } from "@/lib/supabase/error-ja";
import { revalidatePath } from "next/cache";

export type TikTokApiSyncResult =
  | {
      ok: true;
      message: string;
      successCount: number;
      failedCount: number;
      fetchedCount: number;
      connectionCount: number;
    }
  | { ok: false; error: string };

export async function tiktokApiSyncAction(): Promise<TikTokApiSyncResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, error: "ログインが必要です" };
  }

  const appUser = await resolveAppUserContext(supabase, user);
  if (!isAdminRole(appUser.data.role)) {
    return { ok: false, error: "この操作は親管理者のみ実行できます" };
  }

  const { result } = await runTikTokOrdersSync(supabase, {
    syncType: "tiktok_orders",
  });

  if (result.errorMessage && result.successCount === 0) {
    return { ok: false, error: mapSupabaseErrorToJa(result.errorMessage) };
  }

  revalidatePath("/orders");
  revalidatePath("/sync-jobs");
  revalidatePath("/rewards");
  revalidatePath("/dashboard");
  revalidatePath("/creators");
  revalidatePath("/admin/api-sync");
  revalidatePath("/admin/api-connections");

  return {
    ok: true,
    message: `本番 API 同期が完了しました（接続 ${result.connectionCount} 件 / 取得 ${result.fetchedCount} 件 / 成功 ${result.successCount} 件 / 失敗 ${result.failedCount} 件 / 対象月 ${currentMonthKey()}）`,
    successCount: result.successCount,
    failedCount: result.failedCount,
    fetchedCount: result.fetchedCount,
    connectionCount: result.connectionCount,
  };
}
