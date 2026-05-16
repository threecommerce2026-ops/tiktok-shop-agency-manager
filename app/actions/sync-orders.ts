"use server";

import { tiktokApiSyncAction, type TikTokApiSyncResult } from "@/app/actions/tiktok-api-sync";

export type SyncOrdersResult = TikTokApiSyncResult;

export async function syncOrdersAction(): Promise<SyncOrdersResult> {
  return tiktokApiSyncAction();
}
