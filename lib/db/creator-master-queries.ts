import type { SupabaseClient } from "@supabase/supabase-js";
import { currentMonthKey } from "@/lib/db/dashboard-queries";
import { formatCreatorTiktokIdLabel } from "@/lib/creators/referral-registration";
import {
  normalizeAccountManagementType,
  type AccountManagementType,
} from "@/lib/creators/account-management-type";
import {
  isReferralTargetCreator,
  referralRewardAmount,
  resolveReferralRate,
  REFERRAL_REWARD_RATE,
} from "@/lib/referrals/referral-reward-engine";
import {
  isCountedOrderLine,
  isPayoutEligibleOrderLine,
} from "@/lib/revenue/order-line-status";
import { fetchAllFrom } from "@/lib/db/paged-select";
import { toAmount } from "@/lib/revenue/amount";

/*
  クリエイターマスタ画面のデータソース。

  creators を中心マスタとして、
  代理店 / 紹介者 / 区分 / 分配率 / 売上 を1つの行にまとめる。
*/

export type CreatorLinkState = "linked" | "pending";

export type CreatorMasterRow = {
  id: string;
  creatorName: string;
  tiktokId: string;
  tiktokIdLabel: string;
  linkState: CreatorLinkState;
  agencyId: string | null;
  agencyName: string;
  referrerId: string | null;
  referrerName: string | null;
  /**
   * 紹介者の適用開始月。登録日ではなく「何月分から適用されているか」。
   * 紹介関係が無ければ null。
   */
  referrerStartMonth: string | null;
  /** 適用終了月。継続中は null */
  referrerEndMonth: string | null;
  /** 月別確定した所属の期間（確定が無ければ null） */
  agencyAssignedStartMonth: string | null;
  agencyAssignedEndMonth: string | null;
  accountManagementType: AccountManagementType;
  /** 代理店側分配率(%) */
  commissionRate: number;
  registrationStatus: string | null;
  officialLineRegistered: boolean;
  createdAt: string;
  /** 対象月の GMV */
  salesMonth: number;
  /** 全期間の GMV */
  salesTotal: number;
  /** 対象月の紹介者報酬 */
  referralRewardMonth: number;
  /** 紹介者報酬が発生しうる区分か */
  referralEligible: boolean;
};

export type CreatorMasterData = {
  month: string;
  rows: CreatorMasterRow[];
  agencies: Array<{ id: string; name: string; defaultCommissionRate: number; isActive: boolean }>;
  referrers: Array<{ id: string; name: string; isActive: boolean }>;
  error: string | null;
};


type OrderAgg = {
  salesMonth: number;
  salesTotal: number;
  referralBaseMonth: number;
};

type CreatorOrderLine = {
  creator_id: string | null;
  target_month: string | null;
  order_amount: number | string | null;
  commission_base: number | string | null;
  order_status: string | null;
  payment_status: string | null;
  refund_status: string | null;
};

async function fetchOrderAggregates(
  supabase: SupabaseClient,
  month: string,
  agencyId: string | null,
): Promise<{ data: Map<string, OrderAgg>; error: string | null }> {
  const byCreator = new Map<string, OrderAgg>();

  const result = await fetchAllFrom<CreatorOrderLine>(
    supabase,
    "affiliate_order_lines",
    "creator_id, target_month, order_amount, commission_base, order_status, payment_status, refund_status",
    (query) => (agencyId ? query.eq("agency_id", agencyId) : query),
  );

  if (result.error) {
    return { data: byCreator, error: result.error };
  }

  for (const row of result.data) {
    const creatorId = row.creator_id;
    if (!creatorId) continue;
    if (!isCountedOrderLine(row)) continue;

    const current =
      byCreator.get(creatorId) ??
      { salesMonth: 0, salesTotal: 0, referralBaseMonth: 0 };

    current.salesTotal += toAmount(row.order_amount);

    if (row.target_month === month) {
      current.salesMonth += toAmount(row.order_amount);

      if (isPayoutEligibleOrderLine(row)) {
        current.referralBaseMonth += toAmount(row.commission_base);
      }
    }

    byCreator.set(creatorId, current);
  }

  return { data: byCreator, error: null };
}

/**
 * クリエイターマスタ一覧。
 * agencyId を渡すとその代理店所属のクリエイターだけを返す。
 */
export async function fetchCreatorMasterRows(
  supabase: SupabaseClient,
  options: { month?: string; agencyId?: string | null } = {},
): Promise<CreatorMasterData> {
  const month = options.month ?? currentMonthKey();
  const agencyId = options.agencyId ?? null;

  let creatorsQuery = supabase
    .from("creators")
    .select(
      "id, creator_name, tiktok_id, agency_id, commission_rate, registration_status, official_line_registered, account_management_type, referred_by_referrer_id, created_at",
    )
    .order("creator_name");

  if (agencyId) {
    creatorsQuery = creatorsQuery.eq("agency_id", agencyId);
  }

  const [
    creatorsResult,
    agenciesResult,
    referrersResult,
    referralsResult,
    ordersResult,
    monthlyAssignmentsResult,
  ] = await Promise.all([
    creatorsQuery,
    supabase
      .from("agencies")
      .select("id, name, default_commission_rate, is_active")
      .order("name"),
    supabase
      .from("referrers")
      .select("id, name, referrer_name, is_active")
      .order("referrer_name"),
    supabase
      .from("creator_referrals")
      .select("creator_id, referrer_id, referral_rate, is_active, start_month, end_month")
      .eq("is_active", true),
    fetchOrderAggregates(supabase, month, agencyId),
    /*
      月別確定した所属の期間。「現在所属」とは別物なので、
      画面で取り違えないよう期間つきで出す。
    */
    supabase
      .from("creator_monthly_agency_assignments")
      .select("creator_id, target_month"),
  ]);

  const error =
    creatorsResult.error?.message ??
    agenciesResult.error?.message ??
    referrersResult.error?.message ??
    referralsResult.error?.message ??
    ordersResult.error ??
    monthlyAssignmentsResult.error?.message ??
    null;

  if (error) {
    return { month, rows: [], agencies: [], referrers: [], error };
  }

  const agencyNameById = new Map<string, string>();
  const agencies = (agenciesResult.data ?? []).map((row) => {
    agencyNameById.set(row.id as string, String(row.name ?? ""));
    return {
      id: row.id as string,
      name: String(row.name ?? ""),
      defaultCommissionRate: toAmount(row.default_commission_rate),
      isActive: row.is_active !== false,
    };
  });

  const referrerNameById = new Map<string, string>();
  const referrers = (referrersResult.data ?? []).map((row) => {
    const name = String(row.referrer_name ?? row.name ?? "");
    referrerNameById.set(row.id as string, name);
    // 無効な紹介者も名前解決のために保持する（新規選択からは呼び出し側で除外）
    return { id: row.id as string, name, isActive: row.is_active !== false };
  });

  const rateByCreator = new Map<string, number>();
  /* 紹介者の適用期間。登録日ではなく「何月分から」を画面に出すために持つ */
  const referralPeriodByCreator = new Map<
    string,
    { startMonth: string | null; endMonth: string | null }
  >();

  for (const referral of referralsResult.data ?? []) {
    const creatorId = referral.creator_id as string;
    if (rateByCreator.has(creatorId)) continue;
    rateByCreator.set(creatorId, resolveReferralRate(referral.referral_rate));
    referralPeriodByCreator.set(creatorId, {
      startMonth: (referral.start_month as string | null) ?? null,
      endMonth: (referral.end_month as string | null) ?? null,
    });
  }

  /*
    月別確定した所属の期間。連続しているとは限らないので、
    最小月と最大月だけを出して「確定されている範囲」を示す。
  */
  const assignedMonthsByCreator = new Map<string, string[]>();
  for (const row of monthlyAssignmentsResult.data ?? []) {
    const creatorId = String(row.creator_id);
    const list = assignedMonthsByCreator.get(creatorId) ?? [];
    list.push(String(row.target_month));
    assignedMonthsByCreator.set(creatorId, list);
  }

  const rows: CreatorMasterRow[] = (creatorsResult.data ?? []).map((creator) => {
    const id = creator.id as string;
    const tiktokId = String(creator.tiktok_id ?? "");
    const tiktokIdLabel = formatCreatorTiktokIdLabel(tiktokId);
    const accountManagementType = normalizeAccountManagementType(
      creator.account_management_type,
    );
    const referrerId = (creator.referred_by_referrer_id as string | null) ?? null;
    const agg = ordersResult.data.get(id) ?? {
      salesMonth: 0,
      salesTotal: 0,
      referralBaseMonth: 0,
    };

    const referralEligible = isReferralTargetCreator({
      creatorId: id,
      referrerId,
      accountManagementType,
    });

    return {
      id,
      creatorName: String(creator.creator_name ?? "—"),
      tiktokId,
      tiktokIdLabel,
      linkState: tiktokIdLabel === "未登録" ? "pending" : "linked",
      agencyId: (creator.agency_id as string | null) ?? null,
      agencyName: creator.agency_id
        ? agencyNameById.get(creator.agency_id as string) ?? "—"
        : "未振り分け",
      referrerId,
      referrerName: referrerId ? referrerNameById.get(referrerId) ?? "—" : null,
      referrerStartMonth: referralPeriodByCreator.get(id)?.startMonth ?? null,
      referrerEndMonth: referralPeriodByCreator.get(id)?.endMonth ?? null,
      agencyAssignedStartMonth:
        (assignedMonthsByCreator.get(id) ?? []).slice().sort()[0] ?? null,
      agencyAssignedEndMonth:
        (assignedMonthsByCreator.get(id) ?? []).slice().sort().at(-1) ?? null,
      accountManagementType,
      commissionRate: toAmount(creator.commission_rate),
      registrationStatus: (creator.registration_status as string | null) ?? null,
      officialLineRegistered: Boolean(creator.official_line_registered),
      createdAt: String(creator.created_at ?? ""),
      salesMonth: agg.salesMonth,
      salesTotal: agg.salesTotal,
      referralRewardMonth: referralEligible
        ? referralRewardAmount(
            agg.referralBaseMonth,
            rateByCreator.get(id) ?? REFERRAL_REWARD_RATE,
          )
        : 0,
      referralEligible,
    };
  });

  return { month, rows, agencies, referrers, error: null };
}
