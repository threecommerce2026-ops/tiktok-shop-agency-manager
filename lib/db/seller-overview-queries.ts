import type { SupabaseClient } from "@supabase/supabase-js";

import { currentMonthKey } from "@/lib/db/dashboard-queries";
import { fetchAllFrom } from "@/lib/db/paged-select";
import { isCountedOrderLine } from "@/lib/revenue/order-line-status";
import { toAmount } from "@/lib/revenue/amount";

/*
  セラー画面のデータソース。

  sellers マスタと affiliate_order_lines の実績を、
  shop_id / shop_code / ショップ名（seller_shop_aliases 経由）で突き合わせる。
*/

const ORDER_LINE_COLUMNS =
  "order_id, creator_id, seller_id, shop_name, shop_code, target_month, order_amount, commission_base, agency_revenue, order_status, refund_status";

type SellerOrderLine = {
  order_id: string | null;
  creator_id: string | null;
  seller_id: string | null;
  shop_name: string | null;
  shop_code: string | null;
  target_month: string | null;
  order_amount: number | string | null;
  commission_base: number | string | null;
  agency_revenue: number | string | null;
  order_status: string | null;
  refund_status: string | null;
};

function normalizeShopName(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

export type SellerOverviewRow = {
  sellerId: string | null;
  sellerName: string;
  shopName: string;
  shopId: string | null;
  status: string;
  /** 対象月に実績があるか */
  hasMonthData: boolean;
  /** マスタ未登録（実績のみ）のショップか */
  isUnregistered: boolean;
  gmvMonth: number;
  gmvTotal: number;
  commissionBaseMonth: number;
  agencyRevenueMonth: number;
  orderCountMonth: number;
  creatorCountMonth: number;
  tapRate: number | null;
  /** 契約料率（請求に使う。sellers.tsp_rate） */
  tspRate: number | null;
  /** 最新の請求書（請求済み管理用） */
  latestInvoice: {
    id: string;
    invoiceNumber: string | null;
    targetMonth: string;
    status: "draft" | "issued" | "paid" | "cancelled";
    invoiceAmount: number;
  } | null;
};

export type SellerMonthlyPoint = {
  month: string;
  gmv: number;
  orderCount: number;
};

export type SellerOverviewData = {
  month: string;
  rows: SellerOverviewRow[];
  monthlyTrend: SellerMonthlyPoint[];
  totals: {
    sellerCount: number;
    connectedCount: number;
    gmvMonth: number;
    agencyRevenueMonth: number;
    orderCountMonth: number;
  };
  error: string | null;
};

type ShopAgg = {
  shopName: string;
  gmvMonth: number;
  gmvTotal: number;
  commissionBaseMonth: number;
  agencyRevenueMonth: number;
  orderIdsMonth: Set<string>;
  creatorIdsMonth: Set<string>;
  sellerId: string | null;
};


/**
 * agencyId を渡すと、その代理店に紐付く注文明細だけで実績を集計し、
 * 自社に関係のないセラーは一覧から除外する。
 */
export async function fetchSellerOverview(
  supabase: SupabaseClient,
  options: { month?: string; agencyId?: string | null } = {},
): Promise<SellerOverviewData> {
  const month = options.month ?? currentMonthKey();
  const agencyId = options.agencyId ?? null;

  const empty: SellerOverviewData = {
    month,
    rows: [],
    monthlyTrend: [],
    totals: {
      sellerCount: 0,
      connectedCount: 0,
      gmvMonth: 0,
      agencyRevenueMonth: 0,
      orderCountMonth: 0,
    },
    error: null,
  };

  const [sellersResult, aliasesResult, invoicesResult] = await Promise.all([
    supabase
      .from("sellers")
      .select("id, seller_name, shop_name, shop_id, status, tap_rate, tsp_rate")
      .order("seller_name"),
    supabase.from("seller_shop_aliases").select("seller_id, alias_normalized"),
    // 最新の請求書（セラー一覧に請求ステータスを出すため）
    supabase
      .from("seller_invoices")
      .select("id, seller_id, invoice_number, target_month, status, invoice_amount")
      .order("target_month", { ascending: false }),
  ]);

  if (sellersResult.error) {
    return { ...empty, error: sellersResult.error.message };
  }

  /*
    最新請求（対象月の降順で先に来たものを採用）。
    請求書テーブルが無い環境でも一覧を止めない。
  */
  const latestInvoiceBySeller = new Map<
    string,
    {
      id: string;
      invoiceNumber: string | null;
      targetMonth: string;
      status: "draft" | "issued" | "paid" | "cancelled";
      invoiceAmount: number;
    }
  >();

  if (!invoicesResult.error) {
    for (const invoice of invoicesResult.data ?? []) {
      const sellerId = invoice.seller_id as string;
      if (latestInvoiceBySeller.has(sellerId)) continue;
      latestInvoiceBySeller.set(sellerId, {
        id: invoice.id as string,
        invoiceNumber: (invoice.invoice_number as string | null) ?? null,
        targetMonth: String(invoice.target_month ?? ""),
        status: invoice.status as "draft" | "issued" | "paid" | "cancelled",
        invoiceAmount: Number(invoice.invoice_amount ?? 0),
      });
    }
  }

  // ショップ名 → seller_id の索引（マスタ名 + 別名）
  const sellerIdByShopKey = new Map<string, string>();

  for (const seller of sellersResult.data ?? []) {
    const id = seller.id as string;
    const shopName = normalizeShopName(seller.shop_name as string | null);
    const sellerName = normalizeShopName(seller.seller_name as string | null);
    const shopId = String(seller.shop_id ?? "").trim();

    if (shopName) sellerIdByShopKey.set(shopName, id);
    if (sellerName && !sellerIdByShopKey.has(sellerName)) {
      sellerIdByShopKey.set(sellerName, id);
    }
    if (shopId) sellerIdByShopKey.set(shopId.toLowerCase(), id);
  }

  if (!aliasesResult.error) {
    for (const alias of aliasesResult.data ?? []) {
      const key = normalizeShopName(alias.alias_normalized as string | null);
      if (key && !sellerIdByShopKey.has(key)) {
        sellerIdByShopKey.set(key, alias.seller_id as string);
      }
    }
  }

  // --- 実績の集計 -------------------------------------------------------------
  const linesResult = await fetchAllFrom<SellerOrderLine>(
    supabase,
    "affiliate_order_lines",
    ORDER_LINE_COLUMNS,
    (query) => (agencyId ? query.eq("agency_id", agencyId) : query),
  );

  if (linesResult.error) {
    return { ...empty, error: linesResult.error };
  }

  const byShop = new Map<string, ShopAgg>();
  const monthlyMap = new Map<string, { gmv: number; orderIds: Set<string> }>();

  for (const row of linesResult.data) {
    if (!isCountedOrderLine(row)) continue;

    const shopName = String(row.shop_name ?? "").trim();
    const shopCode = String(row.shop_code ?? "").trim();
    const targetMonth = String(row.target_month ?? "");
    const amount = toAmount(row.order_amount);
    const orderId = String(row.order_id ?? "");

    const matchedSellerId =
      row.seller_id ??
      sellerIdByShopKey.get(shopCode.toLowerCase()) ??
      sellerIdByShopKey.get(normalizeShopName(shopName)) ??
      null;

    const key =
      matchedSellerId ?? `shop:${normalizeShopName(shopName) || shopCode || "unknown"}`;

    const agg =
      byShop.get(key) ??
      {
        shopName: shopName || shopCode || "（ショップ不明）",
        gmvMonth: 0,
        gmvTotal: 0,
        commissionBaseMonth: 0,
        agencyRevenueMonth: 0,
        orderIdsMonth: new Set<string>(),
        creatorIdsMonth: new Set<string>(),
        sellerId: matchedSellerId,
      };

    agg.gmvTotal += amount;

    if (targetMonth === month) {
      agg.gmvMonth += amount;
      agg.commissionBaseMonth += toAmount(row.commission_base);
      agg.agencyRevenueMonth += toAmount(row.agency_revenue);
      if (orderId) agg.orderIdsMonth.add(orderId);
      if (row.creator_id) agg.creatorIdsMonth.add(row.creator_id);
    }

    byShop.set(key, agg);

    if (targetMonth) {
      const trend =
        monthlyMap.get(targetMonth) ?? { gmv: 0, orderIds: new Set<string>() };
      trend.gmv += amount;
      if (orderId) trend.orderIds.add(orderId);
      monthlyMap.set(targetMonth, trend);
    }
  }

  // --- マスタ行 + 実績のみの行をマージ -----------------------------------------
  const rows: SellerOverviewRow[] = [];
  const usedKeys = new Set<string>();

  for (const seller of sellersResult.data ?? []) {
    const id = seller.id as string;
    const agg = byShop.get(id);
    if (agg) usedKeys.add(id);

    // 代理店ユーザーには、自社の実績があるセラーだけを見せる
    if (agencyId && !agg) continue;

    rows.push({
      sellerId: id,
      sellerName: String(seller.seller_name ?? "—"),
      shopName: String(seller.shop_name ?? agg?.shopName ?? ""),
      shopId: (seller.shop_id as string | null) ?? null,
      status: String(seller.status ?? "pending"),
      hasMonthData: (agg?.gmvMonth ?? 0) > 0,
      isUnregistered: false,
      gmvMonth: agg?.gmvMonth ?? 0,
      gmvTotal: agg?.gmvTotal ?? 0,
      commissionBaseMonth: agg?.commissionBaseMonth ?? 0,
      agencyRevenueMonth: agg?.agencyRevenueMonth ?? 0,
      orderCountMonth: agg?.orderIdsMonth.size ?? 0,
      creatorCountMonth: agg?.creatorIdsMonth.size ?? 0,
      tapRate: seller.tap_rate == null ? null : Number(seller.tap_rate),
      tspRate: seller.tsp_rate == null ? null : Number(seller.tsp_rate),
      latestInvoice: latestInvoiceBySeller.get(seller.id as string) ?? null,
    });
  }

  for (const [key, agg] of byShop) {
    if (usedKeys.has(key)) continue;
    if (agg.sellerId) continue;

    rows.push({
      sellerId: null,
      sellerName: agg.shopName,
      shopName: agg.shopName,
      shopId: null,
      status: "unregistered",
      hasMonthData: agg.gmvMonth > 0,
      isUnregistered: true,
      gmvMonth: agg.gmvMonth,
      gmvTotal: agg.gmvTotal,
      commissionBaseMonth: agg.commissionBaseMonth,
      agencyRevenueMonth: agg.agencyRevenueMonth,
      orderCountMonth: agg.orderIdsMonth.size,
      creatorCountMonth: agg.creatorIdsMonth.size,
      tapRate: null,
      tspRate: null,
      latestInvoice: null,
    });
  }

  rows.sort((a, b) => b.gmvMonth - a.gmvMonth || b.gmvTotal - a.gmvTotal);

  const monthlyTrend = [...monthlyMap.entries()]
    .map(([m, value]) => ({
      month: m,
      gmv: Math.round(value.gmv),
      orderCount: value.orderIds.size,
    }))
    .sort((a, b) => a.month.localeCompare(b.month));

  return {
    month,
    rows,
    monthlyTrend,
    totals: {
      sellerCount: rows.length,
      connectedCount: rows.filter((row) => row.hasMonthData).length,
      gmvMonth: rows.reduce((sum, row) => sum + row.gmvMonth, 0),
      agencyRevenueMonth: rows.reduce((sum, row) => sum + row.agencyRevenueMonth, 0),
      orderCountMonth: rows.reduce((sum, row) => sum + row.orderCountMonth, 0),
    },
    error: null,
  };
}
