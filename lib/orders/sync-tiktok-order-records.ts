import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildCreatorLookup,
  resolveCreatorByTiktokId,
} from "@/lib/creators/resolve-creator-by-tiktok";
import { mapTikTokOrderToUpsert } from "@/lib/tiktok/map-order-response";
import type { TikTokOrderApiRecord } from "@/lib/tiktok/order-types";

export type SyncTikTokOrderRecordsResult = {
  successCount: number;
  failedCount: number;
  errorMessage: string | null;
};

export async function syncTikTokOrderRecords(
  supabase: SupabaseClient,
  records: TikTokOrderApiRecord[],
  options: { autoCreateCreators?: boolean } = {},
): Promise<SyncTikTokOrderRecordsResult> {
  const autoCreateCreators = options.autoCreateCreators ?? false;
  let successCount = 0;
  let failedCount = 0;
  let errorMessage: string | null = null;

  const { data: creators, error: creatorsError } = await supabase
    .from("creators")
    .select("id, tiktok_id, agency_id, creator_name");

  if (creatorsError) {
    return {
      successCount: 0,
      failedCount: records.length,
      errorMessage: creatorsError.message,
    };
  }

  const creatorLookup = buildCreatorLookup(
    (creators ?? []).map((creator) => ({
      id: creator.id as string,
      tiktok_id: creator.tiktok_id as string,
      agency_id: (creator.agency_id as string | null) ?? null,
      creator_name: creator.creator_name as string,
    })),
  );

  for (const record of records) {
    const resolved = await resolveCreatorByTiktokId(supabase, {
      tiktokId: record.creator_tiktok_id,
      creatorName: record.creator_name?.trim() || record.creator_tiktok_id,
      lookup: creatorLookup,
      autoCreate: autoCreateCreators,
    });

    if (resolved.error && !errorMessage) {
      errorMessage = resolved.error;
    }

    const creator = resolved.creator;
    const mapped = mapTikTokOrderToUpsert(record, {
      creatorId: creator?.id ?? null,
      agencyId: creator?.agency_id ?? null,
    });

    if (!mapped) {
      failedCount += 1;
      continue;
    }

    if (!mapped.creator_name && creator?.creator_name) {
      mapped.creator_name = creator.creator_name;
    }

    const { error } = await supabase.from("orders").upsert(
      {
        ...mapped,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "order_id" },
    );

    if (error) {
      failedCount += 1;
      if (!errorMessage) {
        errorMessage = error.message;
      }
      continue;
    }

    successCount += 1;
  }

  return { successCount, failedCount, errorMessage };
}
