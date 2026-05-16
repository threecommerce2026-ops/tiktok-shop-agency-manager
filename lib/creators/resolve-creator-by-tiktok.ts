import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeTiktokId } from "@/lib/sales/parse-partner-sales";
import { isPendingReferralTiktokId } from "@/lib/creators/referral-registration";

export const DEFAULT_CREATOR_COMMISSION_RATE = 5;

export type CreatorLookupRow = {
  id: string;
  agency_id: string | null;
  creator_name: string;
};

export function buildCreatorLookup(
  creators: Array<{
    id: string;
    tiktok_id: string;
    agency_id: string | null;
    creator_name: string;
  }>,
): Map<string, CreatorLookupRow> {
  const lookup = new Map<string, CreatorLookupRow>();
  for (const creator of creators) {
    if (isPendingReferralTiktokId(creator.tiktok_id)) {
      continue;
    }
    const key = normalizeTiktokId(creator.tiktok_id);
    if (!key) continue;
    lookup.set(key, {
      id: creator.id,
      agency_id: creator.agency_id,
      creator_name: creator.creator_name,
    });
  }
  return lookup;
}

function isUniqueViolation(message: string): boolean {
  return /unique|duplicate|violates unique constraint/i.test(message);
}

export async function resolveCreatorByTiktokId(
  supabase: SupabaseClient,
  options: {
    tiktokId: string;
    creatorName: string;
    lookup: Map<string, CreatorLookupRow>;
    autoCreate: boolean;
  },
): Promise<{ creator: CreatorLookupRow | null; error: string | null }> {
  const tiktokId = normalizeTiktokId(options.tiktokId);
  if (!tiktokId) {
    return { creator: null, error: null };
  }

  const creatorName = options.creatorName.trim() || tiktokId;
  const existing = options.lookup.get(tiktokId);
  if (existing) {
    if (creatorName !== existing.creator_name) {
      const { error } = await supabase
        .from("creators")
        .update({ creator_name: creatorName, tiktok_id: tiktokId })
        .eq("id", existing.id);

      if (error) {
        return { creator: existing, error: error.message };
      }

      existing.creator_name = creatorName;
    }

    return { creator: existing, error: null };
  }

  if (!options.autoCreate) {
    return { creator: null, error: null };
  }

  const { data: created, error: createError } = await supabase
    .from("creators")
    .insert({
      agency_id: null,
      tiktok_id: tiktokId,
      creator_name: creatorName,
      commission_rate: DEFAULT_CREATOR_COMMISSION_RATE,
    })
    .select("id, agency_id, creator_name")
    .single();

  if (created?.id) {
    const next: CreatorLookupRow = {
      id: created.id as string,
      agency_id: (created.agency_id as string | null) ?? null,
      creator_name: created.creator_name as string,
    };
    options.lookup.set(tiktokId, next);
    return { creator: next, error: null };
  }

  if (createError && isUniqueViolation(createError.message)) {
    const { data: raced } = await supabase
      .from("creators")
      .select("id, tiktok_id, agency_id, creator_name")
      .eq("tiktok_id", tiktokId)
      .maybeSingle();

    if (raced?.id) {
      const next: CreatorLookupRow = {
        id: raced.id as string,
        agency_id: (raced.agency_id as string | null) ?? null,
        creator_name: raced.creator_name as string,
      };
      options.lookup.set(tiktokId, next);

      if (creatorName !== next.creator_name) {
        await supabase
          .from("creators")
          .update({ creator_name: creatorName })
          .eq("id", next.id);
        next.creator_name = creatorName;
      }

      return { creator: next, error: null };
    }
  }

  return {
    creator: null,
    error: createError?.message ?? "クリエイターの登録に失敗しました",
  };
}
