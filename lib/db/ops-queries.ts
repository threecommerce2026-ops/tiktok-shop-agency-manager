import type { SupabaseClient } from "@supabase/supabase-js";

export type SyncJobRow = {
  id: string;
  sync_type: string;
  executed_at: string | null;
  status: string;
  success_count: number;
  failed_count: number;
  error_message: string | null;
  created_at: string;
};

export type NotificationLogRow = {
  id: string;
  destination: string;
  body: string;
  notification_type: string;
  status: string;
  created_at: string;
};

export async function fetchSyncJobs(
  supabase: SupabaseClient,
  limit = 50,
): Promise<{ data: SyncJobRow[]; error: string | null }> {
  const { data, error } = await supabase
    .from("sync_jobs")
    .select(
      "id, sync_type, executed_at, status, success_count, failed_count, error_message, created_at",
    )
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    return { data: [], error: error.message };
  }

  return {
    data: (data ?? []).map((row) => ({
      id: row.id as string,
      sync_type: row.sync_type as string,
      executed_at: (row.executed_at as string | null) ?? null,
      status: row.status as string,
      success_count: Number(row.success_count),
      failed_count: Number(row.failed_count),
      error_message: (row.error_message as string | null) ?? null,
      created_at: row.created_at as string,
    })),
    error: null,
  };
}

export async function fetchNotificationLogs(
  supabase: SupabaseClient,
  limit = 50,
): Promise<{ data: NotificationLogRow[]; error: string | null }> {
  const { data, error } = await supabase
    .from("notification_logs")
    .select("id, destination, body, notification_type, status, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    return { data: [], error: error.message };
  }

  return {
    data: (data ?? []).map((row) => ({
      id: row.id as string,
      destination: row.destination as string,
      body: row.body as string,
      notification_type: row.notification_type as string,
      status: row.status as string,
      created_at: row.created_at as string,
    })),
    error: null,
  };
}
