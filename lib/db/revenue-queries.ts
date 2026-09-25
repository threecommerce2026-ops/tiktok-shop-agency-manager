import type { SupabaseClient } from "@supabase/supabase-js";

import { currentMonthKey } from "@/lib/db/dashboard-queries";
import { fetchAllFrom } from "@/lib/db/paged-select";
import {
  isCountedOrderLine,
  isPayoutEligibleOrderLine,
} from "@/lib/revenue/order-line-status";
import { toAmount } from "@/lib/revenue/amount";

/*
  売上タブのデータソース。

  affiliate_order_lines を唯一の売上ソースとして、
  月 / クリエイター / 代理店 / セラー の切り口で集計する。
*/

const SALES_COLUMNS =
  "order_id, creator_id, creator_name, creator_tiktok_id, agency_id, shop_name, shop_code, seller_id, order_amount, commission_gmv, commission_base, agency_revenue, order_status, payment_status, refund_status";

type SalesLine = {
  order_id: string | null;
  creator_id: string | null;
  creator_name: string | null;
  creator_tiktok_id: string | null;
  agency_id: string | null;
  shop_name: string | null;
  shop_code: string | null;
  seller_id: string | null;
  order_amount: number | string | null;
  commission_gmv: number | string | null;
  commission_base: number | string | null;
  agency_revenue: number | string | null;
  order_status: string | null;
  payment_status: string | null;
  refund_status: string | null;
};

export type SalesCreatorRow = {
  creatorId: string | null;
  creatorName: string;
  tiktokId: string;
  agencyId: string | null;
  agencyName: string;
  orderCount: number;
  shopCount: number;
  gmv: number;
  commissionBase: number;
  agencyRevenue: number;
  /** 紹介報酬の計算対象になった Commission Base */
  paidCommissionBase: number;
};

export type SalesShopRow = {
  shopKey: string;
  shopName: string;
  sellerId: string | null;
  orderCount: number;
  creatorCount: number;
  gmv: number;
  commissionBase: number;
  agencyRevenue: number;
};

export type MonthlySalesSummary = {
  targetMonth: string;
  totals: {
    gmv: number;
    commissionBase: number;
    paidCommissionBase: number;
    agencyRevenue: number;
    orderCount: number;
    lineCount: number;
    creatorCount: number;
    shopCount: number;
  };
  creatorRows: SalesCreatorRow[];
  shopRows: SalesShopRow[];
  error: string | null;
};


async function fetchSalesLines(
  supabase: SupabaseClient,
  targetMonth: string,
  agencyId: string | null,
): Promise<{ data: SalesLine[]; error: string | null }> {
  return fetchAllFrom<SalesLine>(
    supabase,
    "affiliate_order_lines",
    SALES_COLUMNS,
    (query) => {
      const scoped = query.eq("target_month", targetMonth);
      return agencyId ? scoped.eq("agency_id", agencyId) : scoped;
    },
  );
}

/**
 * 対象月の売上を、クリエイター別 / セラー別に集計する。
 * agencyId を渡すとその代理店に紐付く明細だけを対象にする。
 */
export async function fetchMonthlySalesSummary(
  supabase: SupabaseClient,
  options: { targetMonth?: string; agencyId?: string | null } = {},
): Promise<MonthlySalesSummary> {
  const targetMonth = options.targetMonth ?? currentMonthKey();
  const agencyId = options.agencyId ?? null;

  const empty: MonthlySalesSummary = {
    targetMonth,
    totals: {
      gmv: 0,
      commissionBase: 0,
      paidCommissionBase: 0,
      agencyRevenue: 0,
      orderCount: 0,
      lineCount: 0,
      creatorCount: 0,
      shopCount: 0,
    },
    creatorRows: [],
    shopRows: [],
    error: null,
  };

  const [linesResult, agenciesResult] = await Promise.all([
    fetchSalesLines(supabase, targetMonth, agencyId),
    supabase.from("agencies").select("id, name"),
  ]);

  const error = linesResult.error ?? agenciesResult.error?.message ?? null;
  if (error) {
    return { ...empty, error };
  }

  const agencyNameById = new Map<string, string>();
  for (const agency of agenciesResult.data ?? []) {
    agencyNameById.set(agency.id as string, String(agency.name ?? ""));
  }

  const creatorMap = new Map<
    string,
    SalesCreatorRow & { orderIds: Set<string>; shopKeys: Set<string> }
  >();
  const shopMap = new Map<
    string,
    SalesShopRow & { orderIds: Set<string>; creatorIds: Set<string> }
  >();

  const allOrderIds = new Set<string>();
  let lineCount = 0;
  let gmv = 0;
  let commissionBase = 0;
  let paidCommissionBase = 0;
  let agencyRevenue = 0;

  for (const line of linesResult.data) {
    if (!isCountedOrderLine(line)) continue;

    lineCount += 1;

    const lineGmv = toAmount(line.order_amount);
    const lineBase = toAmount(line.commission_base);
    const lineAgencyRevenue = toAmount(line.agency_revenue);
    const orderId = String(line.order_id ?? "");
    const isPaidLine = isPayoutEligibleOrderLine(line);

    gmv += lineGmv;
    commissionBase += lineBase;
    agencyRevenue += lineAgencyRevenue;
    if (isPaidLine) paidCommissionBase += lineBase;
    if (orderId) allOrderIds.add(orderId);

    const creatorKey = line.creator_id ?? `name:${line.creator_name ?? "—"}`;
    const shopKey =
      line.shop_code?.trim() || line.shop_name?.trim() || "（ショップ不明）";

    const creatorRow =
      creatorMap.get(creatorKey) ??
      {
        creatorId: line.creator_id ?? null,
        creatorName: String(line.creator_name ?? "—"),
        tiktokId: String(line.creator_tiktok_id ?? ""),
        agencyId: line.agency_id ?? null,
        agencyName: line.agency_id
          ? agencyNameById.get(line.agency_id) ?? "—"
          : "未振り分け",
        orderCount: 0,
        shopCount: 0,
        gmv: 0,
        commissionBase: 0,
        agencyRevenue: 0,
        paidCommissionBase: 0,
        orderIds: new Set<string>(),
        shopKeys: new Set<string>(),
      };

    creatorRow.gmv += lineGmv;
    creatorRow.commissionBase += lineBase;
    creatorRow.agencyRevenue += lineAgencyRevenue;
    if (isPaidLine) creatorRow.paidCommissionBase += lineBase;
    if (orderId) creatorRow.orderIds.add(orderId);
    creatorRow.shopKeys.add(shopKey);
    creatorMap.set(creatorKey, creatorRow);

    const shopRow =
      shopMap.get(shopKey) ??
      {
        shopKey,
        shopName: String(line.shop_name ?? shopKey),
        sellerId: line.seller_id ?? null,
        orderCount: 0,
        creatorCount: 0,
        gmv: 0,
        commissionBase: 0,
        agencyRevenue: 0,
        orderIds: new Set<string>(),
        creatorIds: new Set<string>(),
      };

    shopRow.gmv += lineGmv;
    shopRow.commissionBase += lineBase;
    shopRow.agencyRevenue += lineAgencyRevenue;
    if (orderId) shopRow.orderIds.add(orderId);
    shopRow.creatorIds.add(creatorKey);
    if (!shopRow.sellerId && line.seller_id) shopRow.sellerId = line.seller_id;
    shopMap.set(shopKey, shopRow);
  }

  const creatorRows: SalesCreatorRow[] = [...creatorMap.values()]
    .map(({ orderIds, shopKeys, ...row }) => ({
      ...row,
      orderCount: orderIds.size,
      shopCount: shopKeys.size,
    }))
    .sort((a, b) => b.gmv - a.gmv);

  const shopRows: SalesShopRow[] = [...shopMap.values()]
    .map(({ orderIds, creatorIds, ...row }) => ({
      ...row,
      orderCount: orderIds.size,
      creatorCount: creatorIds.size,
    }))
    .sort((a, b) => b.gmv - a.gmv);

  return {
    targetMonth,
    totals: {
      gmv,
      commissionBase,
      paidCommissionBase,
      agencyRevenue,
      orderCount: allOrderIds.size,
      lineCount,
      creatorCount: creatorRows.length,
      shopCount: shopRows.length,
    },
    creatorRows,
    shopRows,
    error: null,
  };
}

export type AvailableMonth = {
  month: string;
  lineCount: number;
};

/**
 * 実績のある対象月一覧。
 * RPC が未適用の環境では直近12ヶ月を返す。
 */
export async function fetchAvailableMonths(
  supabase: SupabaseClient,
): Promise<AvailableMonth[]> {
  const { data, error } = await supabase.rpc("get_affiliate_order_months");

  if (!error && Array.isArray(data) && data.length > 0) {
    return data.map((row) => ({
      month: String((row as { target_month: string }).target_month),
      lineCount: Number((row as { line_count: number }).line_count ?? 0),
    }));
  }

  const months: AvailableMonth[] = [];
  const now = new Date();
  for (let i = 0; i < 12; i += 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ month: currentMonthKey(d), lineCount: 0 });
  }
  return months;
}
