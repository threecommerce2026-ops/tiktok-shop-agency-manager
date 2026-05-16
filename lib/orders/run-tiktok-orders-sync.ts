import type { SupabaseClient } from "@supabase/supabase-js";
import type { TikTokApiConnectionRow } from "@/lib/db/tiktok-api-connection-queries";
import { syncTikTokOrderRecords } from "@/lib/orders/sync-tiktok-order-records";
import { fetchShopOrdersFromConnection } from "@/lib/tiktok/fetch-shop-orders";
import type { TikTokOrderApiRecord } from "@/lib/tiktok/order-types";

export type RunTikTokOrdersSyncResult = {
  successCount: number;
  failedCount: number;
  fetchedCount: number;
  connectionCount: number;
  errorMessage: string | null;
};

export async function fetchActiveTikTokApiConnections(
  supabase: SupabaseClient,
): Promise<{ data: TikTokApiConnectionRow[]; error: string | null }> {
  const { data, error } = await supabase
    .from("tiktok_api_connections")
    .select(
      "id, app_key, app_secret, access_token, refresh_token, shop_cipher, shop_id, token_expired_at, is_active, last_synced_at, created_at, updated_at",
    )
    .eq("is_active", true)
    .order("updated_at", { ascending: false });

  if (error) {
    return { data: [], error: error.message };
  }

  return {
    data: (data ?? []).map((row) => ({
      id: row.id as string,
      app_key: row.app_key as string,
      app_secret: row.app_secret as string,
      access_token: row.access_token as string,
      refresh_token: (row.refresh_token as string | null) ?? null,
      shop_cipher: (row.shop_cipher as string | null) ?? null,
      shop_id: row.shop_id as string,
      token_expired_at: (row.token_expired_at as string | null) ?? null,
      is_active: Boolean(row.is_active),
      last_synced_at: (row.last_synced_at as string | null) ?? null,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    })),
    error: null,
  };
}

async function markConnectionSynced(
  supabase: SupabaseClient,
  connectionId: string,
): Promise<void> {
  await supabase
    .from("tiktok_api_connections")
    .update({
      last_synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", connectionId);
}

export async function runTikTokOrdersSync(
  supabase: SupabaseClient,
  options: { syncType?: string } = {},
): Promise<{
  result: RunTikTokOrdersSyncResult;
  syncJobId: string | null;
}> {
  const syncType = options.syncType ?? "tiktok_orders";
  const connectionsResult = await fetchActiveTikTokApiConnections(supabase);
  if (connectionsResult.error) {
    return {
      syncJobId: null,
      result: {
        successCount: 0,
        failedCount: 0,
        fetchedCount: 0,
        connectionCount: 0,
        errorMessage: connectionsResult.error,
      },
    };
  }

  const connections = connectionsResult.data;
  if (connections.length === 0) {
    return {
      syncJobId: null,
      result: {
        successCount: 0,
        failedCount: 0,
        fetchedCount: 0,
        connectionCount: 0,
        errorMessage: "有効な TikTok API 接続がありません。API 設定で is_active を有効にしてください。",
      },
    };
  }

  const { data: syncJob, error: syncJobError } = await supabase
    .from("sync_jobs")
    .insert({
      sync_type: syncType,
      status: "running",
      executed_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (syncJobError || !syncJob?.id) {
    return {
      syncJobId: null,
      result: {
        successCount: 0,
        failedCount: 0,
        fetchedCount: 0,
        connectionCount: connections.length,
        errorMessage: syncJobError?.message ?? "同期ジョブの作成に失敗しました",
      },
    };
  }

  const syncJobId = syncJob.id as string;
  const records: TikTokOrderApiRecord[] = [];
  const errors: string[] = [];

  for (const connection of connections) {
    const fetched = await fetchShopOrdersFromConnection(connection);
    if (fetched.error) {
      errors.push(fetched.error);
      continue;
    }

    records.push(...fetched.records);
    if (fetched.records.length > 0) {
      await markConnectionSynced(supabase, connection.id);
    }
  }

  if (records.length === 0) {
    const errorMessage =
      errors.join(" / ") ||
      "Order API から取得できる注文がありません。接続情報と TIKTOK_SHOP_ORDERS_API_URL を確認してください。";

    await supabase
      .from("sync_jobs")
      .update({
        status: "failed",
        success_count: 0,
        failed_count: 0,
        error_message: errorMessage,
        executed_at: new Date().toISOString(),
      })
      .eq("id", syncJobId);

    return {
      syncJobId,
      result: {
        successCount: 0,
        failedCount: 0,
        fetchedCount: 0,
        connectionCount: connections.length,
        errorMessage,
      },
    };
  }

  const syncResult = await syncTikTokOrderRecords(supabase, records, {
    autoCreateCreators: true,
  });

  const errorMessage = [errors.join(" / "), syncResult.errorMessage]
    .filter((value) => Boolean(value))
    .join(" / ") || null;

  const status =
    errorMessage && syncResult.successCount === 0
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
      error_message: errorMessage,
      executed_at: new Date().toISOString(),
    })
    .eq("id", syncJobId);

  return {
    syncJobId,
    result: {
      successCount: syncResult.successCount,
      failedCount: syncResult.failedCount,
      fetchedCount: records.length,
      connectionCount: connections.length,
      errorMessage,
    },
  };
}
