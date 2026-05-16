import type { SupabaseClient } from "@supabase/supabase-js";
import { currentMonthKey } from "@/lib/db/dashboard-queries";
import {
  aggregateCreatorOrderMetrics,
  createEmptyCreatorOrderMetrics,
} from "@/lib/db/order-metrics";
import { fetchOrderMetricRows } from "@/lib/db/orders-queries";
import { formatCreatorTiktokIdLabel } from "@/lib/creators/referral-registration";

export type CreatorListDisplayState = "unassigned" | "active" | "stopped";

export type CreatorListRow = {
  id: string;
  creator_name: string;
  tiktok_id: string;
  agency_id: string | null;
  agency_name: string;
  commission_rate: number;
  created_at: string;
  registration_status: string | null;
  official_line_registered: boolean | null;
  salesMonth: number;
  salesTotal: number;
  profitMonth: number;
  profitTotal: number;
  /** 代理店報酬（今月） */
  agency_reward_month: number;
  /** 代理店報酬（累計） */
  agency_reward_total: number;
  last_sales_at: string | null;
  referrer_name: string | null;
  /** 紹介者報酬（今月・対象明細合計） */
  referral_reward_month: number;
  /** 紹介者報酬（累計・対象明細合計） */
  referral_reward_total: number;
  display_state: CreatorListDisplayState;
};

function unwrapAgency(value: unknown): { name: string } | null {
  if (!value) return null;
  if (Array.isArray(value)) return (value[0] as { name: string }) ?? null;
  return value as { name: string };
}

function resolveDisplayState(row: {
  agency_id: string | null;
  registration_status: string | null;
}): CreatorListDisplayState {
  if (row.registration_status === "inactive") {
    return "stopped";
  }
  if (row.agency_id == null) {
    return "unassigned";
  }
  return "active";
}

export function formatCreatorSalesStatusLabel(row: {
  agency_id: string | null;
  registration_status: string | null;
}): string {
  if (row.agency_id == null) return "未振り分け";
  if (row.registration_status === "inactive") return "停止";
  if (row.registration_status === "pending") return "仮登録";
  return "稼働中";
}

export async function fetchCreatorsWithMetrics(
  supabase: SupabaseClient,
  options: { agencyId?: string | null } = {},
): Promise<{ data: CreatorListRow[]; error: string | null; month: string }> {
  const month = currentMonthKey();

  let creatorsQuery = supabase
    .from("creators")
    .select(
      "id, creator_name, tiktok_id, agency_id, commission_rate, created_at, registration_status, official_line_registered, agencies ( name )",
    )
    .order("creator_name");

  if (options.agencyId) {
    creatorsQuery = creatorsQuery.eq("agency_id", options.agencyId);
  }

  const ordersQuery = fetchOrderMetricRows(supabase, {
    agencyId: options.agencyId ?? null,
  });

  const [{ data: creators, error: cErr }, ordersResult] = await Promise.all([
    creatorsQuery,
    ordersQuery,
  ]);

  if (cErr) {
    return { data: [], error: cErr.message, month };
  }

  if (ordersResult.error) {
    return { data: [], error: ordersResult.error, month };
  }

  const commissionRateByCreator = new Map<string, number>();
  const creatorIds: string[] = [];
  for (const creator of creators ?? []) {
    const id = creator.id as string;
    creatorIds.push(id);
    commissionRateByCreator.set(id, Number(creator.commission_rate));
  }

  const byCreator = aggregateCreatorOrderMetrics(
    ordersResult.data,
    commissionRateByCreator,
    month,
  );

  const referralByCreator = new Map<string, { referrer_name: string }>();
  const referralMonthByCreator = new Map<string, number>();
  const referralTotalByCreator = new Map<string, number>();

  if (creatorIds.length > 0) {
    const [refRes, rmRes, raRes] = await Promise.all([
      supabase
        .from("creator_referrals")
        .select("creator_id, referrers ( referrer_name )")
        .in("creator_id", creatorIds)
        .eq("is_active", true)
        .order("created_at", { ascending: false }),
      supabase
        .from("referral_reward_items")
        .select("creator_id, reward_amount, is_reward_target")
        .eq("target_month", month)
        .in("creator_id", creatorIds),
      supabase
        .from("referral_reward_items")
        .select("creator_id, reward_amount")
        .eq("is_reward_target", true)
        .in("creator_id", creatorIds),
    ]);

    if (!refRes.error) {
      for (const referral of refRes.data ?? []) {
        const cid = referral.creator_id as string;
        if (referralByCreator.has(cid)) continue;
        const join = referral.referrers as
          | { referrer_name: string }
          | { referrer_name: string }[]
          | null;
        const ref = Array.isArray(join) ? join[0] : join;
        referralByCreator.set(cid, {
          referrer_name: ref?.referrer_name ?? "—",
        });
      }
    }

    if (!rmRes.error) {
      for (const item of rmRes.data ?? []) {
        if (!item.is_reward_target) continue;
        const cid = item.creator_id as string;
        const amt = Number(item.reward_amount);
        referralMonthByCreator.set(cid, (referralMonthByCreator.get(cid) ?? 0) + amt);
      }
    }

    if (!raRes.error) {
      for (const item of raRes.data ?? []) {
        const cid = item.creator_id as string;
        const amt = Number(item.reward_amount);
        referralTotalByCreator.set(cid, (referralTotalByCreator.get(cid) ?? 0) + amt);
      }
    }
  }

  const rows: CreatorListRow[] = (creators ?? []).map((c) => {
    const id = c.id as string;
    const rate = Number(c.commission_rate);
    const agg = byCreator.get(id) ?? createEmptyCreatorOrderMetrics();
    const ref = referralByCreator.get(id);
    const referralMonth = referralMonthByCreator.get(id) ?? 0;
    const referralTotal = referralTotalByCreator.get(id) ?? 0;
    const registrationStatus = (c.registration_status as string | null) ?? null;
    const agencyId = (c.agency_id as string | null) ?? null;

    return {
      id,
      creator_name: c.creator_name as string,
      tiktok_id: formatCreatorTiktokIdLabel(c.tiktok_id as string),
      agency_id: agencyId,
      agency_name: unwrapAgency(c.agencies)?.name ?? "未振り分け",
      commission_rate: rate,
      created_at: c.created_at as string,
      registration_status: registrationStatus,
      official_line_registered: (c.official_line_registered as boolean | null) ?? null,
      salesMonth: agg.salesMonth,
      salesTotal: agg.salesTotal,
      profitMonth: agg.profitMonth,
      profitTotal: agg.profitTotal,
      agency_reward_month: agg.rewardMonth,
      agency_reward_total: agg.rewardTotal,
      last_sales_at: agg.lastSalesAt,
      referrer_name: ref?.referrer_name ?? null,
      referral_reward_month: referralMonth,
      referral_reward_total: referralTotal,
      display_state: resolveDisplayState({ agency_id: agencyId, registration_status: registrationStatus }),
    };
  });

  return { data: rows, error: null, month };
}

export type CreatorReferralUnpaidExportRow = {
  creator_id: string;
  creator_name: string;
  tiktok_id: string;
  referrer_name: string;
  unpaid_amount: number;
};

export async function fetchReferralUnpaidExportRows(
  supabase: SupabaseClient,
  targetMonth: string,
  options: { agencyId?: string | null } = {},
): Promise<{ data: CreatorReferralUnpaidExportRow[]; error: string | null }> {
  const { data: items, error: itemsError } = await supabase
    .from("referral_reward_items")
    .select("creator_id, referrer_id, reward_amount, is_reward_target, is_paid")
    .eq("target_month", targetMonth);

  if (itemsError) {
    return { data: [], error: itemsError.message };
  }

  const creatorIds = [...new Set((items ?? []).map((i) => i.creator_id as string))];
  if (creatorIds.length === 0) {
    return { data: [], error: null };
  }

  let creatorsQuery = supabase
    .from("creators")
    .select("id, creator_name, tiktok_id, agency_id")
    .in("id", creatorIds);

  if (options.agencyId) {
    creatorsQuery = creatorsQuery.eq("agency_id", options.agencyId);
  }

  const [{ data: creators, error: cErr }, { data: referrers, error: rErr }] = await Promise.all([
    creatorsQuery,
    supabase.from("referrers").select("id, referrer_name"),
  ]);

  if (cErr || rErr) {
    return { data: [], error: cErr?.message ?? rErr?.message ?? null };
  }

  const creatorById = new Map(
    (creators ?? []).map((row) => [
      row.id as string,
      {
        creator_name: row.creator_name as string,
        tiktok_id: formatCreatorTiktokIdLabel(row.tiktok_id as string),
      },
    ]),
  );
  const referrerNameById = new Map(
    (referrers ?? []).map((r) => [r.id as string, r.referrer_name as string]),
  );

  const sums = new Map<string, { referrer_id: string; unpaid: number }>();
  for (const item of items ?? []) {
    if (!item.is_reward_target || item.is_paid) continue;
    const cid = item.creator_id as string;
    if (!creatorById.has(cid)) continue;
    const rid = item.referrer_id as string;
    const key = `${cid}:${rid}`;
    const prev = sums.get(key) ?? { referrer_id: rid, unpaid: 0 };
    prev.unpaid += Number(item.reward_amount);
    sums.set(key, prev);
  }

  const data: CreatorReferralUnpaidExportRow[] = [];
  for (const [key, agg] of sums) {
    const { referrer_id, unpaid } = agg;
    if (unpaid <= 0) continue;
    const creator_id = key.split(":")[0]!;
    const meta = creatorById.get(creator_id);
    if (!meta) continue;
    data.push({
      creator_id,
      creator_name: meta.creator_name,
      tiktok_id: meta.tiktok_id,
      referrer_name: referrerNameById.get(referrer_id) ?? "—",
      unpaid_amount: unpaid,
    });
  }

  data.sort((a, b) => b.unpaid_amount - a.unpaid_amount);
  return { data, error: null };
}
