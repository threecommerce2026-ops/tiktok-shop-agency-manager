"use server";

import { requireAdminAction } from "@/lib/db/admin-access";
import {
  identityKeyForName,
  identityKeyForSeller,
  normalizeShopName,
  parsePeriodFromShopListFilename,
  targetMonthFromPeriodEnd,
} from "@/lib/shop-performance/normalize";
import {
  parseShopListFile,
  type ShopListParsedRow,
} from "@/lib/shop-performance/parse-shop-list";
import { mapSupabaseErrorToJa } from "@/lib/supabase/error-ja";
import { revalidatePath } from "next/cache";

export type ShopPerformancePreviewCandidate = {
  sellerId: string;
  sellerName: string;
  shopName: string;
  matchReason: "alias" | "shop_name" | "seller_name";
};

export type ShopPerformancePreviewRow = {
  shopName: string;
  shopNameNormalized: string;
  gmvAmount: number;
  itemsSold: number | null;
  liveGmvAmount: number | null;
  videoGmvAmount: number | null;
  affiliateGmvAmount: number | null;
  identityKey: string;
  resolvedSellerId: string | null;
  linkStatus: "auto_alias" | "candidates" | "unlinked";
  candidates: ShopPerformancePreviewCandidate[];
  willUpdateExisting: boolean;
};

export type ShopPerformancePreviewResult =
  | {
      ok: true;
      periodStart: string;
      periodEnd: string;
      suggestedPeriodStart: string | null;
      suggestedPeriodEnd: string | null;
      fileName: string;
      rows: ShopPerformancePreviewRow[];
      parseFailures: Array<{ rowNumber: number; shopName: string | null; reason: string }>;
    }
  | { ok: false; error: string };

function isValidIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

async function loadAliasAndSellerMaps(
  supabase: Awaited<ReturnType<typeof requireAdminAction>>["supabase"],
) {
  const [{ data: aliases }, { data: sellers }] = await Promise.all([
    supabase
      .from("seller_shop_aliases")
      .select("seller_id, alias_normalized, alias_shop_name"),
    supabase
      .from("sellers")
      .select("id, seller_name, shop_name, status")
      .order("seller_name", { ascending: true }),
  ]);

  const aliasToSeller = new Map<string, string>();
  for (const row of aliases ?? []) {
    aliasToSeller.set(
      String(row.alias_normalized),
      String(row.seller_id),
    );
  }

  const sellerList = (sellers ?? []).map((s) => ({
    id: String(s.id),
    sellerName: String(s.seller_name),
    shopName: String(s.shop_name ?? ""),
    shopNameNorm: normalizeShopName(String(s.shop_name ?? "")),
    sellerNameNorm: normalizeShopName(String(s.seller_name ?? "")),
  }));

  return { aliasToSeller, sellerList };
}

function buildCandidates(
  normalized: string,
  sellerList: Array<{
    id: string;
    sellerName: string;
    shopName: string;
    shopNameNorm: string;
    sellerNameNorm: string;
  }>,
  excludeSellerId: string | null,
): ShopPerformancePreviewCandidate[] {
  const out: ShopPerformancePreviewCandidate[] = [];
  for (const s of sellerList) {
    if (excludeSellerId && s.id === excludeSellerId) continue;
    if (s.shopNameNorm && s.shopNameNorm === normalized) {
      out.push({
        sellerId: s.id,
        sellerName: s.sellerName,
        shopName: s.shopName,
        matchReason: "shop_name",
      });
      continue;
    }
    if (s.sellerNameNorm && s.sellerNameNorm === normalized) {
      out.push({
        sellerId: s.id,
        sellerName: s.sellerName,
        shopName: s.shopName,
        matchReason: "seller_name",
      });
    }
  }
  return out;
}

export async function previewShopPerformanceImportAction(
  formData: FormData,
): Promise<ShopPerformancePreviewResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "ファイルを選択してください" };
  }

  const suggested = parsePeriodFromShopListFilename(file.name);
  const periodStart =
    String(formData.get("period_start") ?? "").trim() ||
    suggested?.periodStart ||
    "";
  const periodEnd =
    String(formData.get("period_end") ?? "").trim() ||
    suggested?.periodEnd ||
    "";

  if (!isValidIsoDate(periodStart) || !isValidIsoDate(periodEnd)) {
    return {
      ok: false,
      error: "対象期間（開始日・終了日）を YYYY-MM-DD で指定してください",
    };
  }
  if (periodEnd < periodStart) {
    return { ok: false, error: "終了日は開始日以降にしてください" };
  }

  const parsed = await parseShopListFile(file);
  if (parsed.rows.length === 0 && parsed.failures.length > 0) {
    return {
      ok: false,
      error: parsed.failures[0]?.reason ?? "ファイルを解析できませんでした",
    };
  }

  const { aliasToSeller, sellerList } = await loadAliasAndSellerMaps(
    auth.supabase,
  );

  const identityKeys = parsed.rows.map((row) => {
    const sellerId = aliasToSeller.get(row.shopNameNormalized) ?? null;
    return sellerId
      ? identityKeyForSeller(sellerId)
      : identityKeyForName(row.shopNameNormalized);
  });

  const { data: existingRows } = await auth.supabase
    .from("shop_performance_imports")
    .select("identity_key")
    .eq("period_start", periodStart)
    .eq("period_end", periodEnd)
    .in("identity_key", identityKeys.length ? identityKeys : ["__none__"]);

  const existingSet = new Set(
    (existingRows ?? []).map((r) => String(r.identity_key)),
  );

  const rows: ShopPerformancePreviewRow[] = parsed.rows.map((row) => {
    const aliasSellerId = aliasToSeller.get(row.shopNameNormalized) ?? null;
    if (aliasSellerId) {
      const key = identityKeyForSeller(aliasSellerId);
      return {
        shopName: row.shopName,
        shopNameNormalized: row.shopNameNormalized,
        gmvAmount: row.gmvAmount,
        itemsSold: row.itemsSold,
        liveGmvAmount: row.liveGmvAmount,
        videoGmvAmount: row.videoGmvAmount,
        affiliateGmvAmount: row.affiliateGmvAmount,
        identityKey: key,
        resolvedSellerId: aliasSellerId,
        linkStatus: "auto_alias" as const,
        candidates: [],
        willUpdateExisting: existingSet.has(key),
      };
    }

    const candidates = buildCandidates(
      row.shopNameNormalized,
      sellerList,
      null,
    );
    const key = identityKeyForName(row.shopNameNormalized);
    return {
      shopName: row.shopName,
      shopNameNormalized: row.shopNameNormalized,
      gmvAmount: row.gmvAmount,
      itemsSold: row.itemsSold,
      liveGmvAmount: row.liveGmvAmount,
      videoGmvAmount: row.videoGmvAmount,
      affiliateGmvAmount: row.affiliateGmvAmount,
      identityKey: key,
      resolvedSellerId: null,
      linkStatus: candidates.length > 0 ? ("candidates" as const) : ("unlinked" as const),
      candidates,
      willUpdateExisting: existingSet.has(key),
    };
  });

  return {
    ok: true,
    periodStart,
    periodEnd,
    suggestedPeriodStart: suggested?.periodStart ?? null,
    suggestedPeriodEnd: suggested?.periodEnd ?? null,
    fileName: file.name,
    rows,
    parseFailures: parsed.failures,
  };
}

function toUpsertPayload(
  row: ShopListParsedRow,
  opts: {
    periodStart: string;
    periodEnd: string;
    batchId: string;
    userId: string;
    sellerId: string | null;
  },
) {
  const identity_key = opts.sellerId
    ? identityKeyForSeller(opts.sellerId)
    : identityKeyForName(row.shopNameNormalized);

  return {
    identity_key,
    shop_name: row.shopName,
    shop_name_normalized: row.shopNameNormalized,
    shop_id: null as string | null,
    seller_id: opts.sellerId,
    period_start: opts.periodStart,
    period_end: opts.periodEnd,
    target_month: targetMonthFromPeriodEnd(opts.periodEnd),
    gmv_amount: row.gmvAmount,
    currency: "JPY",
    items_sold: row.itemsSold,
    live_gmv_amount: row.liveGmvAmount,
    video_gmv_amount: row.videoGmvAmount,
    affiliate_gmv_amount: row.affiliateGmvAmount,
    avg_customers: row.avgCustomers,
    refund_amount: row.refundAmount,
    impressions: row.impressions,
    avg_visitors: row.avgVisitors,
    avg_conversion_rate_pct: row.avgConversionRatePct,
    raw_row_json: {
      ...row.raw,
      unnamed_col_6: row.raw.unnamed_col_6 ?? null,
      unnamed_col_6_parsed: row.unnamedCol6Amount,
    },
    source: "csv",
    import_batch_id: opts.batchId,
    imported_by: opts.userId,
    updated_at: new Date().toISOString(),
  };
}

export async function executeShopPerformanceImportAction(
  formData: FormData,
): Promise<{ ok: true; message: string; batchId: string } | { ok: false; error: string }> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "ファイルを選択してください" };
  }

  const periodStart = String(formData.get("period_start") ?? "").trim();
  const periodEnd = String(formData.get("period_end") ?? "").trim();
  if (!isValidIsoDate(periodStart) || !isValidIsoDate(periodEnd)) {
    return { ok: false, error: "対象期間が不正です" };
  }
  if (periodEnd < periodStart) {
    return { ok: false, error: "終了日は開始日以降にしてください" };
  }

  const parsed = await parseShopListFile(file);
  if (parsed.rows.length === 0) {
    return {
      ok: false,
      error: parsed.failures[0]?.reason ?? "取込可能な行がありません",
    };
  }

  const { aliasToSeller } = await loadAliasAndSellerMaps(auth.supabase);

  const format = file.name.toLowerCase().endsWith(".xls") ? "xls" : "xlsx";
  const { data: batch, error: batchError } = await auth.supabase
    .from("shop_performance_import_batches")
    .insert({
      file_name: file.name,
      file_format: format,
      period_start: periodStart,
      period_end: periodEnd,
      row_total: parsed.rows.length,
      uploaded_by: auth.user.id,
      failure_reasons: parsed.failures,
    })
    .select("id")
    .single();

  if (batchError || !batch?.id) {
    return {
      ok: false,
      error: mapSupabaseErrorToJa(
        batchError?.message ?? "取込バッチを作成できませんでした",
      ),
    };
  }

  const payloads = parsed.rows.map((row) =>
    toUpsertPayload(row, {
      periodStart,
      periodEnd,
      batchId: batch.id as string,
      userId: auth.user.id,
      sellerId: aliasToSeller.get(row.shopNameNormalized) ?? null,
    }),
  );

  const { error: upsertError } = await auth.supabase
    .from("shop_performance_imports")
    .upsert(payloads, { onConflict: "identity_key,period_start,period_end" });

  if (upsertError) {
    await auth.supabase
      .from("shop_performance_import_batches")
      .update({
        failed_count: parsed.rows.length,
        failure_reasons: [
          ...parsed.failures,
          { rowNumber: 0, shopName: null, reason: upsertError.message },
        ],
      })
      .eq("id", batch.id);

    return { ok: false, error: mapSupabaseErrorToJa(upsertError.message) };
  }

  await auth.supabase
    .from("shop_performance_import_batches")
    .update({
      upserted_count: payloads.length,
      skipped_count: 0,
      failed_count: parsed.failures.length,
    })
    .eq("id", batch.id);

  revalidatePath("/admin/shop-performance");
  return {
    ok: true,
    batchId: batch.id as string,
    message: `${payloads.length} 件を取り込みました（同期間は更新）`,
  };
}

export async function linkShopPerformanceToSellerAction(input: {
  importId: string;
  sellerId: string;
  aliasShopName: string;
}): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const importId = input.importId.trim();
  const sellerId = input.sellerId.trim();
  const aliasShopName = input.aliasShopName.trim();
  if (!importId || !sellerId || !aliasShopName) {
    return { ok: false, error: "紐付けパラメータが不足しています" };
  }

  const aliasNormalized = normalizeShopName(aliasShopName);
  const { data, error } = await auth.supabase.rpc(
    "link_shop_performance_to_seller",
    {
      p_import_id: importId,
      p_seller_id: sellerId,
      p_alias_shop_name: aliasShopName,
      p_alias_normalized: aliasNormalized,
    },
  );

  if (error) {
    return { ok: false, error: mapSupabaseErrorToJa(error.message) };
  }

  const action =
    data && typeof data === "object" && "action" in data
      ? String((data as { action?: string }).action)
      : "linked";

  revalidatePath("/admin/shop-performance");
  revalidatePath("/admin/sellers");
  return {
    ok: true,
    message:
      action === "merged"
        ? "既存の同期間行へマージし、別名を保存しました"
        : "セラーへ紐付け、別名を保存しました",
  };
}
