import type { SupabaseClient } from "@supabase/supabase-js";

import {
  fetchCreatorFinanceHistory,
  type CreatorMonthlyFinanceRow,
} from "@/lib/db/creator-monthly-finance-queries";

/*
  クリエイター詳細。

  月別実績は lib/db/creator-monthly-finance-queries.ts の計算層
  （computeCreatorFinanceRows）をそのまま使う。
  ここで独自の集計式は持たない。

  旧実装は sales_imports（月×クリエイターの集計済みCSV）を読んでいたが、
  現在のデータモデルは affiliate_order_lines / tap_affiliate_order_lines の
  明細を都度集計する方式なので、Finance Engine に寄せている。
*/

export type CreatorMonthlyFinancePoint = {
  targetMonth: string;
  row: CreatorMonthlyFinanceRow;
};

export type CreatorDetail = {
  id: string;
  creator_name: string;
  tiktok_id: string;
  agency_id: string | null;
  agency_name: string | null;
  account_management_type: string | null;
  commission_rate: number;
  /** 月別実績（新しい月が先頭） */
  months: CreatorMonthlyFinancePoint[];
  /** 全期間の合計 */
  totals: {
    capGmv: number;
    capRevenue: number;
    tapRevenue: number;
    creatorPayout: number;
    referralReward: number;
    agencyPayout: number;
  };
  /** 直近月（months の先頭）。実績が無ければ null */
  latest: CreatorMonthlyFinancePoint | null;
  /** 最新の紹介者名（月別実績から解決できた場合） */
  referrer_name: string | null;
};

export async function fetchCreatorDetail(
  supabase: SupabaseClient,
  creatorId: string,
): Promise<{ data: CreatorDetail | null; error: string | null }> {
  const { data: creator, error: creatorError } = await supabase
    .from("creators")
    .select(
      "id, creator_name, tiktok_id, agency_id, commission_rate, account_management_type, agencies ( name )",
    )
    .eq("id", creatorId)
    .maybeSingle();

  if (creatorError) {
    return { data: null, error: creatorError.message };
  }
  if (!creator) {
    return { data: null, error: null };
  }

  const agencies = creator.agencies as { name: string } | { name: string }[] | null;
  const agency = Array.isArray(agencies) ? agencies[0] : agencies;

  const history = await fetchCreatorFinanceHistory(supabase, creatorId);
  if (history.error) {
    return { data: null, error: history.error };
  }

  const totals = history.months.reduce(
    (acc, entry) => {
      acc.capGmv += entry.row.capGmv;
      acc.capRevenue += entry.row.capRevenue;
      acc.tapRevenue += entry.row.tapRevenue;
      acc.creatorPayout += entry.row.creatorPayout;
      acc.referralReward += entry.row.referralReward;
      acc.agencyPayout += entry.row.agencyPayout;
      return acc;
    },
    {
      capGmv: 0,
      capRevenue: 0,
      tapRevenue: 0,
      creatorPayout: 0,
      referralReward: 0,
      agencyPayout: 0,
    },
  );

  const latest = history.months[0] ?? null;

  return {
    data: {
      id: creator.id as string,
      creator_name: String(creator.creator_name ?? ""),
      tiktok_id: String(creator.tiktok_id ?? ""),
      agency_id: (creator.agency_id as string | null) ?? null,
      agency_name: agency?.name ?? null,
      account_management_type:
        (creator.account_management_type as string | null) ?? null,
      commission_rate: Number(creator.commission_rate ?? 0),
      months: history.months,
      totals,
      latest,
      referrer_name:
        history.months.find((m) => m.row.referrerName)?.row.referrerName ?? null,
    },
    error: null,
  };
}
