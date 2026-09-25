import type { SupabaseClient } from "@supabase/supabase-js";

import {
  computeSellerInvoice,
  isTestSeller,
  type SellerBillingStatus,
  type SellerInvoiceComputation,
} from "@/lib/billing/seller-invoice";

/*
  セラー請求のプレビュー用データ。

  ■ 請求根拠は「ショップ実績CSV」だけ
  shop_performance_imports には source='csv'（月次のショップ実績CSV）と
  source='partner_api'（API取得）が混在し、同じセラー・同じ月に
  両方の行が存在する。これは同一期間の別スナップショットであり、
  足すと二重計上になる。
  確定した業務ルールどおり CSV を正とし、csv 行だけを集計する。

  ■ 再取込で二重加算しない
  同じ (セラー, 対象月, ショップ) に複数の csv 行がある場合は
  最後に取り込んだ行だけを採用する。
  再取込しても金額が積み上がらない。

  ■ 請求額の計算は lib/billing/seller-invoice.ts に集約
  ここでは金額計算をしない。
*/

export type SellerBillingRow = {
  sellerId: string;
  sellerName: string;
  shopName: string;
  contractRatePct: number | null;
  targetMonth: string;
  periodStart: string | null;
  periodEnd: string | null;
  /** CSV B列 GMV の合計 */
  gmvAmount: number;
  /** CSV I列 Refunds の合計 */
  refundAmount: number;
  /** 集計に使ったショップ数 */
  shopCount: number;
  computation: SellerInvoiceComputation;
  /** 既存の請求書（あれば） */
  invoice: SellerInvoiceSummary | null;
  /** テスト用セラー。本番の請求対象・合計から外す */
  isTest: boolean;
  /** TSP請求対象か。辞退・TAP連携のみ は false */
  isBillingEligible: boolean;
  /** セラーの稼働状態 */
  sellerStatus: string | null;
};

export type SellerInvoiceSummary = {
  id: string;
  invoiceNumber: string | null;
  targetMonth: string;
  status: "draft" | "issued" | "paid" | "cancelled";
  gmvAmount: number;
  refundAmount: number;
  billingGmvAmount: number;
  contractRatePct: number;
  invoiceAmount: number;
  issuedAt: string | null;
  dueDate: string | null;
  paidAt: string | null;
  memo: string | null;
  /** 適用税率（%）。発行済み帳票を不変にするためDBに保存した値 */
  taxRatePct: number | null;
  /** 税込請求額に含まれる消費税額（内税）。加算するものではない */
  taxAmount: number | null;
  periodStart: string;
  periodEnd: string;
  sellerId: string;
  sellerName: string;
  /** テスト用セラーの請求書。本番一覧から外す */
  isTest: boolean;
};

export type SellerBillingData = {
  targetMonth: string;
  rows: SellerBillingRow[];
  /** セラーに紐付いていない取込行（請求できない） */
  unlinkedShops: Array<{
    shopName: string;
    gmvAmount: number;
    refundAmount: number;
  }>;
  months: string[];
  totals: {
    /** 本番（テストを除く）の集計 */
    sellerCount: number;
    billableCount: number;
    billableAmount: number;
    needsReviewCount: number;
    rateMissingCount: number;
    invoicedCount: number;
    /** 除外したテスト用セラーの件数 */
    testSellerCount: number;
    /** TSP請求対象外（辞退 / TAP連携のみ）の件数 */
    notEligibleCount: number;
  };
  error: string | null;
};

/** 請求の根拠にするソース。CSV のみ */
const BILLING_SOURCE = "csv";

type ImportRow = {
  id: string;
  seller_id: string | null;
  shop_name: string | null;
  shop_name_normalized: string | null;
  target_month: string | null;
  period_start: string | null;
  period_end: string | null;
  gmv_amount: number | string | null;
  refund_amount: number | string | null;
  source: string | null;
  created_at: string | null;
};

function amount(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function mapInvoiceRow(
  row: Record<string, unknown>,
  sellerName: string,
): SellerInvoiceSummary {
  return {
    id: row.id as string,
    invoiceNumber: (row.invoice_number as string | null) ?? null,
    targetMonth: String(row.target_month ?? ""),
    status: (row.status as SellerInvoiceSummary["status"]) ?? "draft",
    gmvAmount: amount(row.gmv_amount as number | null),
    refundAmount: amount(row.refund_amount as number | null),
    billingGmvAmount: amount(row.billing_gmv_amount as number | null),
    contractRatePct: amount(row.tsp_rate as number | null),
    invoiceAmount: amount(row.invoice_amount as number | null),
    issuedAt: (row.issued_at as string | null) ?? null,
    dueDate: (row.due_date as string | null) ?? null,
    paidAt: (row.paid_at as string | null) ?? null,
    memo: (row.memo as string | null) ?? null,
    taxRatePct: row.tax_rate_pct == null ? null : Number(row.tax_rate_pct),
    taxAmount: row.tax_amount == null ? null : Number(row.tax_amount),
    periodStart: String(row.period_start ?? ""),
    periodEnd: String(row.period_end ?? ""),
    sellerId: row.seller_id as string,
    sellerName,
    isTest: isTestSeller(sellerName),
  };
}

export async function fetchSellerBillingData(
  supabase: SupabaseClient,
  targetMonth: string,
): Promise<SellerBillingData> {
  const empty: SellerBillingData = {
    targetMonth,
    rows: [],
    unlinkedShops: [],
    months: [],
    totals: {
      sellerCount: 0,
      billableCount: 0,
      billableAmount: 0,
      needsReviewCount: 0,
      rateMissingCount: 0,
      invoicedCount: 0,
      testSellerCount: 0,
      notEligibleCount: 0,
    },
    error: null,
  };

  const [importsResult, sellersResult, invoicesResult, monthsResult] =
    await Promise.all([
      supabase
        .from("shop_performance_imports")
        .select(
          "id, seller_id, shop_name, shop_name_normalized, target_month, period_start, period_end, gmv_amount, refund_amount, source, created_at",
        )
        .eq("target_month", targetMonth)
        .eq("source", BILLING_SOURCE)
        .order("created_at", { ascending: true }),
      supabase
        .from("sellers")
        .select(
          "id, seller_name, shop_name, tsp_rate, status, is_tsp_billing_eligible",
        )
        .order("seller_name"),
      supabase
        .from("seller_invoices")
        .select(
          "id, invoice_number, seller_id, target_month, status, gmv_amount, refund_amount, billing_gmv_amount, tsp_rate, invoice_amount, tax_rate_pct, tax_amount, issued_at, due_date, paid_at, memo, period_start, period_end",
        )
        .eq("target_month", targetMonth),
      supabase
        .from("shop_performance_imports")
        .select("target_month")
        .eq("source", BILLING_SOURCE),
    ]);

  const error =
    importsResult.error?.message ??
    sellersResult.error?.message ??
    invoicesResult.error?.message ??
    null;

  if (error) return { ...empty, error };

  const sellerById = new Map(
    (sellersResult.data ?? []).map((row) => [row.id as string, row]),
  );

  const invoiceBySeller = new Map<string, SellerInvoiceSummary>();
  for (const row of invoicesResult.data ?? []) {
    const sellerId = row.seller_id as string;
    const seller = sellerById.get(sellerId);
    invoiceBySeller.set(
      sellerId,
      mapInvoiceRow(row, String(seller?.seller_name ?? "（不明なセラー）")),
    );
  }

  /*
    同じ (セラー, ショップ) に複数の csv 行があれば最後の取込だけを使う。
    created_at 昇順で走査し、後勝ちで上書きする。
  */
  const latestByShop = new Map<string, ImportRow>();
  const unlinked = new Map<string, { gmv: number; refund: number }>();

  for (const raw of (importsResult.data ?? []) as ImportRow[]) {
    const shopKey = raw.shop_name_normalized ?? raw.shop_name ?? raw.id;

    if (!raw.seller_id) {
      const current = unlinked.get(shopKey) ?? { gmv: 0, refund: 0 };
      unlinked.set(shopKey, {
        gmv: amount(raw.gmv_amount),
        refund: amount(raw.refund_amount),
      });
      void current;
      continue;
    }

    latestByShop.set(`${raw.seller_id}:${shopKey}`, raw);
  }

  const bySeller = new Map<
    string,
    { gmv: number; refund: number; shops: Set<string>; start: string | null; end: string | null }
  >();

  for (const [key, row] of latestByShop) {
    const sellerId = key.split(":")[0];
    const current =
      bySeller.get(sellerId) ??
      { gmv: 0, refund: 0, shops: new Set<string>(), start: null, end: null };

    current.gmv += amount(row.gmv_amount);
    current.refund += amount(row.refund_amount);
    current.shops.add(String(row.shop_name ?? ""));
    if (!current.start || (row.period_start && row.period_start < current.start)) {
      current.start = row.period_start;
    }
    if (!current.end || (row.period_end && row.period_end > current.end)) {
      current.end = row.period_end;
    }

    bySeller.set(sellerId, current);
  }

  const rows: SellerBillingRow[] = [];

  for (const [sellerId, agg] of bySeller) {
    const seller = sellerById.get(sellerId);
    const contractRatePct =
      seller?.tsp_rate == null ? null : Number(seller.tsp_rate);

    const sellerName = String(seller?.seller_name ?? "（不明なセラー）");
    /*
      TSP請求対象外（辞退 / TAP連携のみ）は請求書を作らせない。
      判定は sellers.is_tsp_billing_eligible のみを根拠にする。
    */
    const isBillingEligible = seller?.is_tsp_billing_eligible !== false;

    rows.push({
      sellerId,
      sellerName,
      isTest: isTestSeller(sellerName),
      isBillingEligible,
      sellerStatus: (seller?.status as string | null) ?? null,
      shopName: [...agg.shops].join(" / "),
      contractRatePct,
      targetMonth,
      periodStart: agg.start,
      periodEnd: agg.end,
      gmvAmount: Math.round(agg.gmv * 100) / 100,
      refundAmount: Math.round(agg.refund * 100) / 100,
      shopCount: agg.shops.size,
      computation: computeSellerInvoice({
        gmvAmount: agg.gmv,
        refundAmount: agg.refund,
        contractRatePct,
        // 請求対象外なら sellerId を渡さず「未紐付け」ではなく請求不可にする
        sellerId: isBillingEligible ? sellerId : null,
      }),
      invoice: invoiceBySeller.get(sellerId) ?? null,
    });
  }

  rows.sort(
    (a, b) =>
      (b.computation.invoiceAmount ?? 0) - (a.computation.invoiceAmount ?? 0) ||
      b.gmvAmount - a.gmvAmount,
  );

  // 集計は本番セラーのみ。テスト用セラー・TSP請求対象外は件数・金額に含めない。
  const productionRows = rows.filter((row) => !row.isTest && row.isBillingEligible);

  const countBy = (status: SellerBillingStatus) =>
    productionRows.filter((row) => row.computation.status === status).length;

  return {
    targetMonth,
    rows,
    unlinkedShops: [...unlinked.entries()].map(([shopName, value]) => ({
      shopName,
      gmvAmount: value.gmv,
      refundAmount: value.refund,
    })),
    months: [
      ...new Set(
        (monthsResult.data ?? [])
          .map((row) => String(row.target_month ?? ""))
          .filter(Boolean),
      ),
    ].sort((a, b) => b.localeCompare(a)),
    totals: {
      sellerCount: productionRows.length,
      billableCount: countBy("ok"),
      billableAmount: productionRows.reduce(
        (sum, row) => sum + (row.computation.invoiceAmount ?? 0),
        0,
      ),
      needsReviewCount: countBy("needs_review"),
      rateMissingCount: countBy("rate_missing"),
      invoicedCount: productionRows.filter((row) => row.invoice != null).length,
      testSellerCount: rows.filter((row) => row.isTest).length,
      notEligibleCount: rows.filter((row) => !row.isTest && !row.isBillingEligible)
        .length,
    },
    error: null,
  };
}

/** 請求書1件を取得（請求書ページ・PDF用） */
export async function fetchSellerInvoice(
  supabase: SupabaseClient,
  invoiceId: string,
): Promise<{ data: SellerInvoiceSummary | null; error: string | null }> {
  const { data, error } = await supabase
    .from("seller_invoices")
    .select(
      "id, invoice_number, seller_id, target_month, status, gmv_amount, refund_amount, billing_gmv_amount, tsp_rate, invoice_amount, tax_rate_pct, tax_amount, issued_at, due_date, paid_at, memo, period_start, period_end, sellers ( seller_name, shop_name, contact_person, contact_email )",
    )
    .eq("id", invoiceId)
    .maybeSingle();

  if (error) return { data: null, error: error.message };
  if (!data) return { data: null, error: null };

  const sellerJoin = data.sellers as
    | { seller_name?: string }
    | Array<{ seller_name?: string }>
    | null;
  const seller = Array.isArray(sellerJoin) ? sellerJoin[0] : sellerJoin;

  return {
    data: mapInvoiceRow(data, String(seller?.seller_name ?? "（不明なセラー）")),
    error: null,
  };
}

/** 請求書一覧（請求済み管理） */
export async function fetchSellerInvoiceList(
  supabase: SupabaseClient,
): Promise<{ data: SellerInvoiceSummary[]; error: string | null }> {
  const { data, error } = await supabase
    .from("seller_invoices")
    .select(
      "id, invoice_number, seller_id, target_month, status, gmv_amount, refund_amount, billing_gmv_amount, tsp_rate, invoice_amount, tax_rate_pct, tax_amount, issued_at, due_date, paid_at, memo, period_start, period_end, sellers ( seller_name )",
    )
    .order("target_month", { ascending: false })
    .order("invoice_amount", { ascending: false });

  if (error) return { data: [], error: error.message };

  return {
    data: (data ?? []).map((row) => {
      const sellerJoin = row.sellers as
        | { seller_name?: string }
        | Array<{ seller_name?: string }>
        | null;
      const seller = Array.isArray(sellerJoin) ? sellerJoin[0] : sellerJoin;
      return mapInvoiceRow(row, String(seller?.seller_name ?? "（不明なセラー）"));
    }),
    error: null,
  };
}
