"use server";

import { currentMonthKey } from "@/lib/db/dashboard-queries";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { syncTikTokOrderRecords } from "@/lib/orders/sync-tiktok-order-records";
import { parseTikTokOrderApiPayload } from "@/lib/tiktok/parse-order-api-payload";
import { createClient } from "@/lib/supabase/server";
import { mapSupabaseErrorToJa } from "@/lib/supabase/error-ja";
import { revalidatePath } from "next/cache";

export type TikTokApiTestSyncResult =
  | { ok: true; message: string; successCount: number; failedCount: number }
  | { ok: false; error: string };

export async function tiktokApiTestSyncAction(
  _prev: TikTokApiTestSyncResult | null,
  formData: FormData,
): Promise<TikTokApiTestSyncResult> {
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

  const rawJson = String(formData.get("payload_json") ?? "");
  const connectionId = String(formData.get("connection_id") ?? "").trim();
  const parsed = parseTikTokOrderApiPayload(rawJson);

  if (parsed.error) {
    return { ok: false, error: parsed.error };
  }

  const { data: syncJob, error: syncJobError } = await supabase
    .from("sync_jobs")
    .insert({
      sync_type: "tiktok_orders_test",
      status: "running",
      executed_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (syncJobError || !syncJob?.id) {
    return {
      ok: false,
      error: mapSupabaseErrorToJa(
        syncJobError?.message ?? "同期ジョブの作成に失敗しました",
      ),
    };
  }

  const syncJobId = syncJob.id as string;
  const syncResult = await syncTikTokOrderRecords(supabase, parsed.records, {
    autoCreateCreators: true,
  });

  const status =
    syncResult.errorMessage && syncResult.successCount === 0
      ? "failed"
      : syncResult.failedCount > 0
        ? "failed"
        : "success";

  await supabase
    .from("sync_jobs")
    .update({
      status,
      success_count: syncResult.successCount,
      failed_count: syncResult.failedCount,
      error_message: syncResult.errorMessage,
      executed_at: new Date().toISOString(),
    })
    .eq("id", syncJobId);

  if (connectionId) {
    await supabase
      .from("tiktok_api_connections")
      .update({
        last_synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", connectionId);
  }

  if (syncResult.errorMessage && syncResult.successCount === 0) {
    return { ok: false, error: mapSupabaseErrorToJa(syncResult.errorMessage) };
  }

  revalidatePath("/orders");
  revalidatePath("/sync-jobs");
  revalidatePath("/rewards");
  revalidatePath("/dashboard");
  revalidatePath("/creators");
  revalidatePath("/admin/api-test-sync");
  revalidatePath("/admin/api-connections");

  return {
    ok: true,
    message: `テスト同期が完了しました（成功 ${syncResult.successCount} 件 / 失敗 ${syncResult.failedCount} 件 / 対象月 ${currentMonthKey()}）`,
    successCount: syncResult.successCount,
    failedCount: syncResult.failedCount,
  };
}
