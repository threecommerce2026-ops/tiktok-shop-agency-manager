import type { SupabaseClient } from "@supabase/supabase-js";
import {
  collectInHouseAgencyIds,
  isInHouseCreator,
} from "@/lib/revenue/in-house-creator";
import { fetchAllFrom } from "@/lib/db/paged-select";
import {
  isReferralMonthActive,
  isReferralTargetCreator,
  referralRewardAmount,
  resolveReferralRate,
  REFERRAL_REWARD_RATE,
} from "@/lib/referrals/referral-reward-engine";
import {
  isAgencyPayoutEligibleOrderLine,
  isCountedOrderLine,
  isPayoutEligibleOrderLine,
} from "@/lib/revenue/order-line-status";
import { toAmount } from "@/lib/revenue/amount";

export type CreatorMonthlyFinanceRow = {
  creatorId: string;
  creatorName: string;
  tiktokId: string;
  agencyId: string | null;
  agencyName: string | null;
  /** 代理店の確定元。monthly=月別確定 / current=creators現在値 */
  agencySource: "monthly" | "current" | null;
  isInHouse: boolean;

  capGmv: number;
  capRevenue: number;

  tapStandardRevenue: number;
  tapShopAdsRevenue: number;
  tapBonusRevenue: number;
  tapRevenue: number;

  rawAgencySplitRate: number | null;
  rawCreatorSplitRate: number | null;
  hasMonthlyRateOverride: boolean;
  monthlyCommissionRate: number | null;
  agencySplitRate: number | null;
  commissionRate: number | null;
  creatorPayout: number;

  referrerId: string | null;
  referrerName: string | null;
  /** 紹介者報酬の計算元となった Commission Base */
  referralBase: number;
  referralReward: number;
  accountManagementType: string;

  agencyPayout: number;
  companyRevenueAfterPayouts: number;
};

export type CreatorMonthlyFinanceData = {
  targetMonth: string;
  rows: CreatorMonthlyFinanceRow[];
  totals: {
    capGmv: number;
    capRevenue: number;
    tapRevenue: number;
    creatorPayout: number;
    referralReward: number;
    agencyPayout: number;
    companyRevenueAfterPayouts: number;
  };
  error: string | null;
};


function roundYen(value: number): number {
  return Math.round(value);
}


const CREATOR_COLUMNS =
  "id, creator_name, tiktok_id, agency_id, commission_rate, account_management_type, referred_by_referrer_id";

const CAP_COLUMNS =
  "creator_id, target_month, commission_gmv, commission_base, creator_revenue_before_split, agency_split_rate, agency_revenue, order_status, payment_status, refund_status";

const TAP_COLUMNS =
  "creator_id, target_month, partner_estimated_commission, partner_shop_ads_estimated_commission, partner_bonus_estimated_commission, order_status, refund_status";

const REFERRAL_COLUMNS =
  "creator_id, referrer_id, referral_rate, start_month, end_month, is_active";


/*
  計算層への入力。
  取得のしかた（単月×全クリエイター / 1クリエイター×全月）に依存しないよう、
  取得済みの行だけを受け取る。
*/
export type CreatorFinanceInputs = {
  creators: Record<string, unknown>[];
  agencies: Record<string, unknown>[];
  capRows: Record<string, unknown>[];
  tapRows: Record<string, unknown>[];
  monthlyRates: Record<string, unknown>[];
  monthlyAgencies: Record<string, unknown>[];
  referrals: Record<string, unknown>[];
  referrers: Record<string, unknown>[];
};

/*
  月次財務の計算本体。

  fetchCreatorMonthlyFinance()（単月×全クリエイター）と
  fetchCreatorFinanceHistory()（1クリエイター×全月）の両方がこれを呼ぶ。
  計算式はここ1箇所だけに置き、複製しない。
*/
export function computeCreatorFinanceRows(
  inputs: CreatorFinanceInputs,
  targetMonth: string,
): CreatorMonthlyFinanceRow[] {
  const inHouseAgencyIds = collectInHouseAgencyIds(
    inputs.agencies as Array<{ id: string; is_in_house?: boolean | null }>,
  );
  const agencyNameById = new Map<string, string>();

  for (const agency of inputs.agencies) {
    agencyNameById.set(
      agency.id as string,
      String(agency.name ?? ""),
    );
  }

  const monthlyRateByCreator = new Map<string, number>();

  for (const rate of inputs.monthlyRates) {
    monthlyRateByCreator.set(
      rate.creator_id as string,
      toAmount(rate.commission_rate),
    );
  }

  /*
    代理店支払・自社判定は現在所属ではなく、
    対象月に確定保存された代理店を使用する。
    月別設定がないクリエイターは未確定として扱う。
  */
  const monthlyAgencyByCreator = new Map<string, string>();

  for (const assignment of inputs.monthlyAgencies) {
    const agencyId =
      (assignment.agency_id as string | null) ?? null;

    if (!agencyId) continue;

    monthlyAgencyByCreator.set(
      assignment.creator_id as string,
      agencyId,
    );
  }

  const referrerNameById = new Map<string, string>();

  for (const referrer of inputs.referrers) {
    referrerNameById.set(
      referrer.id as string,
      String(
        referrer.referrer_name ??
        referrer.name ??
        "紹介者",
      ),
    );
  }

  const referralByCreator = new Map<
    string,
    {
      referrerId: string;
      referralRate: number;
    }
  >();

  for (const referral of inputs.referrals) {
    if (!referral.is_active) continue;

    const startMonth = (referral.start_month as string | null) ?? null;
    const endMonth = (referral.end_month as string | null) ?? null;

    if (!isReferralMonthActive(targetMonth, startMonth, endMonth)) continue;

    const creatorId = referral.creator_id as string;

    if (referralByCreator.has(creatorId)) continue;

    referralByCreator.set(creatorId, {
      referrerId: referral.referrer_id as string,
      referralRate: resolveReferralRate(referral.referral_rate),
    });
  }

  const capByCreator = new Map<
    string,
    {
      gmv: number;
      revenueBeforeSplit: number;
      revenue: number;
      agencySplitWeighted: number;
      agencySplitWeight: number;
      /* 紹介者報酬の計算元。支払い済み明細のみを積み上げる */
      referralBase: number;
      /* 代理店報酬の計算元。支払い済み明細の agency_revenue 実額 */
      payableAgencyRevenue: number;
    }
  >();

  for (const row of inputs.capRows) {
    const creatorId = row.creator_id as string | null;
    if (!creatorId) continue;

    const statusFields = {
      order_status: (row.order_status as string | null) ?? null,
      payment_status: (row.payment_status as string | null) ?? null,
      refund_status: (row.refund_status as string | null) ?? null,
    };

    const bucket = capByCreator.get(creatorId) ?? {
      gmv: 0,
      revenueBeforeSplit: 0,
      revenue: 0,
      agencySplitWeighted: 0,
      agencySplitWeight: 0,
      referralBase: 0,
      payableAgencyRevenue: 0,
    };
    capByCreator.set(creatorId, bucket);

    /*
      代理店報酬（lib/agency/agency-reward-engine.ts と同一ルール）:
      対象は AU「支払い状況」= 支払い済み の明細のみ。
      金額は AP「エージェンシーの収益総額」の実額をそのまま積み上げる。
    */
    if (isAgencyPayoutEligibleOrderLine(statusFields)) {
      bucket.payableAgencyRevenue += toAmount(row.agency_revenue);
    }

    // CAP の表示集計（GMV・収益）は 決済済み + 返金なし を対象にする
    if (!isCountedOrderLine(statusFields)) continue;

    const current = bucket;

    /*
      紹介者報酬は「TikTok側で実際に支払われた」明細のみが対象。
      CAP実績の集計条件より厳しいため個別に判定する。
    */
    if (isPayoutEligibleOrderLine(statusFields)) {
      current.referralBase += toAmount(row.commission_base);
    }

    const beforeSplit = toAmount(row.creator_revenue_before_split);
    const agencySplitRate = toAmount(row.agency_split_rate);

    current.gmv += toAmount(row.commission_gmv);
    current.revenueBeforeSplit += beforeSplit;
    current.revenue += toAmount(row.agency_revenue);

    if (beforeSplit > 0) {
      current.agencySplitWeighted +=
        beforeSplit * agencySplitRate;
      current.agencySplitWeight += beforeSplit;
    }

    capByCreator.set(creatorId, current);
  }

  const tapByCreator = new Map<
    string,
    {
      standard: number;
      shopAds: number;
      bonus: number;
    }
  >();

  for (const row of inputs.tapRows) {
    const creatorId = row.creator_id as string | null;
    if (!creatorId) continue;

    if (
      !isCountedOrderLine({
        order_status: (row.order_status as string | null) ?? null,
        refund_status: (row.refund_status as string | null) ?? null,
      })
    ) {
      continue;
    }

    const current = tapByCreator.get(creatorId) ?? {
      standard: 0,
      shopAds: 0,
      bonus: 0,
    };

    current.standard += toAmount(row.partner_estimated_commission);
    current.shopAds += toAmount(
      row.partner_shop_ads_estimated_commission,
    );
    current.bonus += toAmount(
      row.partner_bonus_estimated_commission,
    );

    tapByCreator.set(creatorId, current);
  }

  const rows: CreatorMonthlyFinanceRow[] = [];

  for (const creator of inputs.creators) {
    const creatorId = creator.id as string;

    /*
      対象月に確定保存された代理店を優先する。
      月別確定がない月は creators の現在所属へフォールバックする。
      （月別確定は運用上まだ一部の月しか作成されていないため、
        フォールバックがないと代理店報酬が全件ゼロになる）
    */
    const monthlyAgencyId = monthlyAgencyByCreator.get(creatorId) ?? null;
    const currentAgencyId = (creator.agency_id as string | null) ?? null;
    const agencyId = monthlyAgencyId ?? currentAgencyId;

    const agencySource: "monthly" | "current" | null = monthlyAgencyId
      ? "monthly"
      : currentAgencyId
        ? "current"
        : null;

    const agencyName = agencyId
      ? agencyNameById.get(agencyId) ?? null
      : null;

    const inHouse = isInHouseCreator({
      agencyId,
      agencyIsInHouse: agencyId ? inHouseAgencyIds.has(agencyId) : false,
    });

    const cap = capByCreator.get(creatorId) ?? {
      gmv: 0,
      revenueBeforeSplit: 0,
      revenue: 0,
      agencySplitWeighted: 0,
      agencySplitWeight: 0,
      referralBase: 0,
      payableAgencyRevenue: 0,
    };

    const tap = tapByCreator.get(creatorId) ?? {
      standard: 0,
      shopAds: 0,
      bonus: 0,
    };

    /*
      CAP Excelの「エージェンシー成果報酬分配の一部」は
      エージェンシー側の取り分率。
      画面ではクリエイター側の率に反転して表示する。
    */
    const hasCapSplitRate = cap.agencySplitWeight > 0;
    const rawAgencySplitRate = hasCapSplitRate
      ? cap.agencySplitWeighted / cap.agencySplitWeight
      : null;

    /*
      月別手動分配率はクリエイター側の取り分率として扱う。

      月別設定がある場合は、所属先やTikTok実分配率に関係なく
      手動設定を計算上の分配率として優先する。

      月別設定がない場合はTikTok / CAP実データをそのまま使用する。
      TikTok実データ自体は書き換えない。
    */
    const monthlyCommissionRate = monthlyRateByCreator.get(creatorId);

    const hasMonthlyRateOverride =
      monthlyCommissionRate !== undefined;

    const commissionRate =
      hasMonthlyRateOverride
        ? Math.max(0, Math.min(100, monthlyCommissionRate))
        : rawAgencySplitRate === null
          ? null
          : Math.max(0, Math.min(100, 100 - rawAgencySplitRate));

    const agencySplitRate =
      hasMonthlyRateOverride
        ? 100 - (commissionRate ?? 0)
        : rawAgencySplitRate;

    const tapRevenue =
      tap.standard +
      tap.shopAds +
      tap.bonus;

    /*
      月別手動補正がある場合は、分配前収益に対して
      手動設定したクリエイター側率を使って再計算する。

      手動補正がない場合はTikTok / CAP実金額をそのまま使用する。
    */
    const creatorPayout = inHouse
      ? hasMonthlyRateOverride
        ? roundYen(
            Math.max(
              cap.revenueBeforeSplit *
                ((commissionRate ?? 0) / 100),
              0,
            ),
          )
        : roundYen(
            Math.max(
              cap.revenueBeforeSplit - cap.revenue,
              0,
            ),
          )
      : 0;

    /*
      代理店報酬（lib/agency/agency-reward-engine.ts と同一ルール）:

      ・AP「エージェンシーの収益総額」(agency_revenue) の実額を100%採用する
        （AK = agency_split_rate は掛けない）
      ・対象は AU「支払い状況」= 支払い済み の明細のみ
      ・THREE.inc 所属 / 代理店未設定 は 0円
      ・月別手動分配率は代理店報酬には適用しない
        （TikTok実データの agency_split_rate を正とするため）
    */
    const agencyPayout =
      !inHouse && agencyId ? roundYen(cap.payableAgencyRevenue) : 0;

    const referral = referralByCreator.get(creatorId);

    const accountManagementType = String(
      creator.account_management_type ?? "standard",
    );

    const referrerId =
      (creator.referred_by_referrer_id as string | null) ??
      referral?.referrerId ??
      null;

    /*
      紹介者報酬：
      CAP実績（affiliate_order_lines）の Commission Base × 紹介料率。

      対象は通常クリエイター（standard）のみ。
      自社運用・アカウント貸出は5%の対象外。
    */
    const referralTarget = isReferralTargetCreator({
      creatorId,
      referrerId,
      accountManagementType,
    });

    const referralBase = referralTarget ? cap.referralBase : 0;

    const referralReward = referralTarget
      ? referralRewardAmount(
          referralBase,
          referral?.referralRate ?? REFERRAL_REWARD_RATE,
        )
      : 0;

    /*
      自社の月次収支上の残額。

      CAPのcap.revenueは、すでにクリエイター分配後の
      エージェンシー側収益なので、creatorPayoutは再控除しない。

      自社所属：
      CAPエージェンシー収益 + TAP収益 - 紹介者報酬

      代理店所属：
      CAPエージェンシー収益を代理店へ支払うため、
      agencyPayoutを控除。
    */
    const effectiveAgencyRevenue =
      hasMonthlyRateOverride
        ? roundYen(
            cap.revenueBeforeSplit *
              ((agencySplitRate ?? 0) / 100),
          )
        : roundYen(cap.revenue);

    /*
      代理店未設定のクリエイターは帰属先が確定していないため、
      CAP / TAPの実績値は表示するが、会社収益・代理店支払には算入しない。
    */
    const companyRevenueAfterPayouts =
      !agencyId
        ? 0
        : roundYen(
            effectiveAgencyRevenue +
            tapRevenue -
            referralReward -
            agencyPayout,
          );

    if (
      cap.gmv === 0 &&
      cap.revenue === 0 &&
      tapRevenue === 0
    ) {
      continue;
    }

    rows.push({
      creatorId,
      creatorName: String(
        creator.creator_name ??
        creator.tiktok_id ??
        "—",
      ),
      tiktokId: String(creator.tiktok_id ?? ""),
      agencyId,
      agencyName,
      agencySource,
      isInHouse: inHouse,

      capGmv: roundYen(cap.gmv),
      capRevenue: roundYen(cap.revenue),

      tapStandardRevenue: roundYen(tap.standard),
      tapShopAdsRevenue: roundYen(tap.shopAds),
      tapBonusRevenue: roundYen(tap.bonus),
      tapRevenue: roundYen(tapRevenue),

      rawAgencySplitRate,
      rawCreatorSplitRate:
        rawAgencySplitRate === null
          ? null
          : Math.max(
              0,
              Math.min(100, 100 - rawAgencySplitRate),
            ),
      hasMonthlyRateOverride,
      monthlyCommissionRate:
        hasMonthlyRateOverride
          ? Math.max(
              0,
              Math.min(100, monthlyCommissionRate ?? 0),
            )
          : null,
      agencySplitRate,
      commissionRate,
      creatorPayout,

      referrerId,
      referrerName: referrerId
        ? referrerNameById.get(referrerId) ?? "紹介者"
        : null,
      referralBase,
      referralReward,
      accountManagementType,

      agencyPayout,
      companyRevenueAfterPayouts,
    });
  }

  rows.sort((a, b) => {
    const aRevenue = a.capRevenue + a.tapRevenue;
    const bRevenue = b.capRevenue + b.tapRevenue;
    return bRevenue - aRevenue;
  });

  return rows;
}


type LoadScope = { targetMonth: string } | { creatorId: string };

/*
  取得層。計算層と分離しておき、絞り込み条件だけを差し替える。
    { targetMonth } … 単月 × 全クリエイター
    { creatorId }   … 1クリエイター × 全月
*/
async function loadFinanceInputs(
  supabase: SupabaseClient,
  scope: LoadScope,
): Promise<{ inputs: CreatorFinanceInputs; error: string | null }> {
  const byMonth = "targetMonth" in scope;
  const empty: CreatorFinanceInputs = {
    creators: [],
    agencies: [],
    capRows: [],
    tapRows: [],
    monthlyRates: [],
    monthlyAgencies: [],
    referrals: [],
    referrers: [],
  };

  const scopeColumn = byMonth ? "target_month" : "creator_id";
  const scopeValue = byMonth
    ? (scope as { targetMonth: string }).targetMonth
    : (scope as { creatorId: string }).creatorId;

  const [
    creatorsResult,
    agenciesResult,
    capResult,
    tapResult,
    monthlyRatesResult,
    monthlyAgenciesResult,
    referralsResult,
    referrersResult,
  ] = await Promise.all([
    byMonth
      ? supabase
          .from("creators")
          .select(CREATOR_COLUMNS)
      : supabase
          .from("creators")
          .select(CREATOR_COLUMNS)
          .eq("id", (scope as { creatorId: string }).creatorId),

    supabase.from("agencies").select("id, name, is_in_house"),

    fetchAllFrom<Record<string, unknown>>(
      supabase,
      "affiliate_order_lines",
      CAP_COLUMNS,
      (query) => query.eq(scopeColumn, scopeValue),
    ),

    fetchAllFrom<Record<string, unknown>>(
      supabase,
      "tap_affiliate_order_lines",
      TAP_COLUMNS,
      (query) => query.eq(scopeColumn, scopeValue),
    ),

    byMonth
      ? supabase
          .from("creator_monthly_commission_rates")
          .select("creator_id, commission_rate, target_month")
          .eq("target_month", (scope as { targetMonth: string }).targetMonth)
      : supabase
          .from("creator_monthly_commission_rates")
          .select("creator_id, commission_rate, target_month")
          .eq("creator_id", (scope as { creatorId: string }).creatorId),

    byMonth
      ? supabase
          .from("creator_monthly_agency_assignments")
          .select("creator_id, agency_id, target_month")
          .eq("target_month", (scope as { targetMonth: string }).targetMonth)
      : supabase
          .from("creator_monthly_agency_assignments")
          .select("creator_id, agency_id, target_month")
          .eq("creator_id", (scope as { creatorId: string }).creatorId),

    byMonth
      ? supabase.from("creator_referrals").select(REFERRAL_COLUMNS)
      : supabase
          .from("creator_referrals")
          .select(REFERRAL_COLUMNS)
          .eq("creator_id", (scope as { creatorId: string }).creatorId),

    supabase.from("referrers").select("id, name, referrer_name"),
  ]);

  const error =
    creatorsResult.error?.message ??
    agenciesResult.error?.message ??
    capResult.error ??
    tapResult.error ??
    monthlyRatesResult.error?.message ??
    monthlyAgenciesResult.error?.message ??
    referralsResult.error?.message ??
    referrersResult.error?.message ??
    null;

  if (error) return { inputs: empty, error };

  return {
    inputs: {
      creators: (creatorsResult.data ?? []) as Record<string, unknown>[],
      agencies: (agenciesResult.data ?? []) as Record<string, unknown>[],
      capRows: capResult.data,
      tapRows: tapResult.data,
      monthlyRates: (monthlyRatesResult.data ?? []) as Record<string, unknown>[],
      monthlyAgencies: (monthlyAgenciesResult.data ?? []) as Record<string, unknown>[],
      referrals: (referralsResult.data ?? []) as Record<string, unknown>[],
      referrers: (referrersResult.data ?? []) as Record<string, unknown>[],
    },
    error: null,
  };
}

/** target_month で絞り込んだ入力を作る（1クリエイター×全月を月ごとに分ける） */
function narrowToMonth(
  inputs: CreatorFinanceInputs,
  targetMonth: string,
): CreatorFinanceInputs {
  const sameMonth = (row: Record<string, unknown>) =>
    String(row.target_month ?? "") === targetMonth;

  return {
    ...inputs,
    capRows: inputs.capRows.filter(sameMonth),
    tapRows: inputs.tapRows.filter(sameMonth),
    monthlyRates: inputs.monthlyRates.filter(sameMonth),
    monthlyAgencies: inputs.monthlyAgencies.filter(sameMonth),
  };
}

export type CreatorFinanceHistoryEntry = {
  targetMonth: string;
  row: CreatorMonthlyFinanceRow;
};

export type CreatorFinanceHistory = {
  creatorId: string;
  months: CreatorFinanceHistoryEntry[];
  error: string | null;
};

/*
  1クリエイターの月別実績。

  fetchCreatorMonthlyFinance() を月数ぶんループしない。
  creator_id で一度だけ取得し、target_month ごとに分けて
  同じ計算層 computeCreatorFinanceRows() を通す。
*/
export async function fetchCreatorFinanceHistory(
  supabase: SupabaseClient,
  creatorId: string,
): Promise<CreatorFinanceHistory> {
  const loaded = await loadFinanceInputs(supabase, { creatorId });
  if (loaded.error) {
    return { creatorId, months: [], error: loaded.error };
  }

  const months = new Set<string>();
  for (const row of [...loaded.inputs.capRows, ...loaded.inputs.tapRows]) {
    const month = String(row.target_month ?? "");
    if (month) months.add(month);
  }

  const entries: CreatorFinanceHistoryEntry[] = [];
  for (const targetMonth of [...months].sort().reverse()) {
    const rows = computeCreatorFinanceRows(
      narrowToMonth(loaded.inputs, targetMonth),
      targetMonth,
    );
    const row = rows.find((r) => r.creatorId === creatorId);
    if (row) entries.push({ targetMonth, row });
  }

  return { creatorId, months: entries, error: null };
}


export async function fetchCreatorMonthlyFinance(
  supabase: SupabaseClient,
  targetMonth: string,
): Promise<CreatorMonthlyFinanceData> {
  const empty: CreatorMonthlyFinanceData = {
    targetMonth,
    rows: [],
    totals: {
      capGmv: 0,
      capRevenue: 0,
      tapRevenue: 0,
      creatorPayout: 0,
      referralReward: 0,
      agencyPayout: 0,
      companyRevenueAfterPayouts: 0,
    },
    error: null,
  };

  const loaded = await loadFinanceInputs(supabase, { targetMonth });
  if (loaded.error) return { ...empty, error: loaded.error };

  const rows = computeCreatorFinanceRows(loaded.inputs, targetMonth);

  const totals = rows.reduce(
    (acc, row) => {
      acc.capGmv += row.capGmv;
      acc.capRevenue += row.capRevenue;
      acc.tapRevenue += row.tapRevenue;
      acc.creatorPayout += row.creatorPayout;
      acc.referralReward += row.referralReward;
      acc.agencyPayout += row.agencyPayout;
      acc.companyRevenueAfterPayouts +=
        row.companyRevenueAfterPayouts;

      return acc;
    },
    {
      capGmv: 0,
      capRevenue: 0,
      tapRevenue: 0,
      creatorPayout: 0,
      referralReward: 0,
      agencyPayout: 0,
      companyRevenueAfterPayouts: 0,
    },
  );

  return {
    targetMonth,
    rows,
    totals,
    error: null,
  };
}
