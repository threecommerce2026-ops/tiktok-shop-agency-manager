"use server";

import {
  buildCreatorLookup,
  resolveCreatorByTiktokId,
} from "@/lib/creators/resolve-creator-by-tiktok";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { parseAffiliateOrderFile } from "@/lib/orders/parse-affiliate-order-export";
import { normalizeTiktokId } from "@/lib/sales/parse-partner-sales";
import { createClient } from "@/lib/supabase/server";
import { mapSupabaseErrorToJa } from "@/lib/supabase/error-ja";
import { revalidatePath } from "next/cache";

export type ImportAffiliateOrdersResult =
  | {
      ok: true;
      message: string;
      rowCount: number;
      successCount: number;
      failedCount: number;
      creatorsTouched: number;
      creatorsCreatedOrResolved: number;
      sellersLinked: number;
      batchId: string;
      failures: Array<{ rowNumber: number; error: string }>;
    }
  | {
      ok: false;
      error: string;
      failures?: Array<{ rowNumber: number; error: string }>;
    };

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];

  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }

  return result;
}

export async function importAffiliateOrdersAction(
  _prev: ImportAffiliateOrdersResult | null,
  formData: FormData,
): Promise<ImportAffiliateOrdersResult> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return {
      ok: false,
      error: "ログインが必要です",
    };
  }

  const appUser = await resolveAppUserContext(supabase, user);

  if (!isAdminRole(appUser.data.role)) {
    return {
      ok: false,
      error: "管理者のみ実行できます",
    };
  }

  const file = formData.get("file");

  if (!(file instanceof File) || file.size === 0) {
    return {
      ok: false,
      error: "Partner Center のExcelファイルを選択してください",
    };
  }

  const parsed = await parseAffiliateOrderFile(file);

  if (!parsed.rows.length) {
    return {
      ok: false,
      error:
        parsed.failures[0]?.error ??
        "取り込み可能なPartner Center注文データがありません",
      failures: parsed.failures,
    };
  }

  // ------------------------------------------------------------
  // 取込バッチ
  // ------------------------------------------------------------

  const { data: batch, error: batchError } = await supabase
    .from("affiliate_order_import_batches")
    .insert({
      file_name: file.name,
      row_total: parsed.rows.length,
      upserted_count: 0,
      failed_count: parsed.failures.length,
      imported_by: user.id,
    })
    .select("id")
    .single();

  if (batchError || !batch?.id) {
    return {
      ok: false,
      error: mapSupabaseErrorToJa(
        batchError?.message ?? "取込履歴を作成できませんでした",
      ),
    };
  }

  const batchId = batch.id as string;

  // ------------------------------------------------------------
  // Creator読込
  // ------------------------------------------------------------

  const { data: existingCreators, error: creatorsError } = await supabase
    .from("creators")
    .select("id, tiktok_id, agency_id, creator_name");

  if (creatorsError) {
    return {
      ok: false,
      error: mapSupabaseErrorToJa(creatorsError.message),
    };
  }

  const creatorLookup = buildCreatorLookup(
    (existingCreators ?? []).map((creator) => ({
      id: creator.id as string,
      tiktok_id: creator.tiktok_id as string,
      agency_id: (creator.agency_id as string | null) ?? null,
      creator_name: creator.creator_name as string,
    })),
  );

  // ------------------------------------------------------------
  // Seller読込
  // shop_code と sellers.shop_id を優先照合
  // ------------------------------------------------------------

  const { data: sellers, error: sellersError } = await supabase
    .from("sellers")
    .select("id, shop_id, shop_name, seller_name");

  if (sellersError) {
    return {
      ok: false,
      error: mapSupabaseErrorToJa(sellersError.message),
    };
  }

  const sellerByShopId = new Map<string, string>();
  const sellerByShopName = new Map<string, string>();

  for (const seller of sellers ?? []) {
    const sellerId = seller.id as string;

    const shopId = String(seller.shop_id ?? "").trim();
    if (shopId) {
      sellerByShopId.set(shopId, sellerId);
    }

    const shopName = String(
      seller.shop_name ?? seller.seller_name ?? "",
    )
      .trim()
      .toLowerCase();

    if (shopName) {
      sellerByShopName.set(shopName, sellerId);
    }
  }

  // ------------------------------------------------------------
  // Creatorを先に一意単位で解決
  // 16,000行すべてでDB照会しない
  // ------------------------------------------------------------

  const uniqueCreators = new Map<
    string,
    {
      tiktokId: string;
      creatorName: string;
    }
  >();

  for (const row of parsed.rows) {
    const tiktokId = normalizeTiktokId(row.creatorTiktokId);

    if (!tiktokId) continue;

    if (!uniqueCreators.has(tiktokId)) {
      uniqueCreators.set(tiktokId, {
        tiktokId,
        // 現エクスポートには nickname が無いため
        // 初回はusernameを表示名として使用
        creatorName: tiktokId,
      });
    }
  }

  const resolvedCreators = new Map<
    string,
    {
      id: string;
      agencyId: string | null;
      creatorName: string;
    }
  >();

  const failures = [...parsed.failures];

  for (const creatorInput of uniqueCreators.values()) {
    const resolved = await resolveCreatorByTiktokId(supabase, {
      tiktokId: creatorInput.tiktokId,
      creatorName: creatorInput.creatorName,
      lookup: creatorLookup,
      autoCreate: true,
    });

    if (!resolved.creator) {
      failures.push({
        rowNumber: 0,
        error: `${creatorInput.tiktokId}: ${
          resolved.error ?? "クリエイターを登録できませんでした"
        }`,
      });
      continue;
    }

    resolvedCreators.set(creatorInput.tiktokId, {
      id: resolved.creator.id,
      agencyId: resolved.creator.agency_id,
      creatorName: resolved.creator.creator_name,
    });
  }

  // ------------------------------------------------------------
  // Affiliate注文行へ変換
  // ------------------------------------------------------------

  const insertRows = [];
  let sellersLinked = 0;

  for (const row of parsed.rows) {
    const creatorKey = normalizeTiktokId(row.creatorTiktokId);
    const creator = resolvedCreators.get(creatorKey);

    if (!creator) {
      failures.push({
        rowNumber: row.rowNumber,
        error: `クリエイターを解決できません: ${row.creatorTiktokId}`,
      });
      continue;
    }

    let sellerId: string | null = null;

    if (row.shopCode) {
      sellerId = sellerByShopId.get(row.shopCode.trim()) ?? null;
    }

    if (!sellerId && row.shopName) {
      sellerId =
        sellerByShopName.get(row.shopName.trim().toLowerCase()) ?? null;
    }

    if (sellerId) {
      sellersLinked += 1;
    }

    insertRows.push({
      source_row_key: row.sourceRowKey,

      order_id: row.orderId,

      sku_id: row.skuId,
      product_id: row.productId,
      product_name: row.productName,
      sku: row.skuId,

      shop_name: row.shopName,
      shop_code: row.shopCode,
      seller_id: sellerId,

      creator_id: creator.id,
      creator_tiktok_id: creatorKey,
      creator_name: creator.creatorName,

      agency_id: creator.agencyId,

      target_month: row.targetMonth,

      content_type: row.contentType,
      content_id: row.contentId,

      factor_type: row.factorType,
      commission_type: row.commissionType,

      product_price: row.productPrice,
      quantity: row.quantity,

      order_amount: row.productPrice * row.quantity,

      refund_amount: row.isFullyRefunded
        ? row.productPrice * row.quantity
        : 0,

      refund_status: row.isFullyRefunded
        ? "fully_refunded"
        : null,

      commission_gmv: row.commissionGmv,
      commission_base: row.commissionBase,

      standard_commission_rate: row.standardCommissionRate,
      shop_ads_commission_rate: row.shopAdsCommissionRate,
      tiktok_bonus_commission_rate: row.tiktokBonusCommissionRate,
      partner_bonus_commission_rate: row.partnerBonusCommissionRate,

      creator_revenue_before_split:
        row.creatorRevenueBeforeSplit,

      agency_split_rate: row.agencySplitRate,

      agency_revenue_before_tax:
        row.agencyRevenueBeforeTax,

      agency_revenue: row.agencyRevenue,

      payment_id: row.paymentId,
      payment_status: row.payoutStatus,

      order_status: row.paymentStatus,

      ordered_at: row.orderedAt,
      delivered_at: row.deliveredAt,

      paid_at:
        row.payoutStatus &&
        /paid|支払済|支払い済/i.test(row.payoutStatus)
          ? row.deliveredAt ?? row.orderedAt
          : null,

      import_batch_id: batchId,

      raw_row_json: row.raw,

      updated_at: new Date().toISOString(),
    });
  }

  // ------------------------------------------------------------
  // 500件ずつupsert
  // source_row_keyで同じ明細を二重登録しない
  // ------------------------------------------------------------

  let successCount = 0;

  for (const rowsChunk of chunk(insertRows, 500)) {
    const { error } = await supabase
      .from("affiliate_order_lines")
      .upsert(rowsChunk, {
        onConflict: "source_row_key",
      });

    if (error) {
      for (const row of rowsChunk) {
        failures.push({
          rowNumber: 0,
          error: `${row.order_id}: ${mapSupabaseErrorToJa(error.message)}`,
        });
      }

      continue;
    }

    successCount += rowsChunk.length;
  }

  const failedCount = failures.length;

  await supabase
    .from("affiliate_order_import_batches")
    .update({
      upserted_count: successCount,
      failed_count: failedCount,
    })
    .eq("id", batchId);

  revalidatePath("/orders");
  revalidatePath("/creators");
  revalidatePath("/admin/creator-assignment");

  if (successCount === 0) {
    return {
      ok: false,
      error: `取り込みに成功した明細がありません（失敗 ${failedCount} 件）`,
      failures,
    };
  }

  return {
    ok: true,
    message: `${successCount.toLocaleString("ja-JP")}件のPartner Center注文明細を取り込みました`,
    rowCount: parsed.rows.length,
    successCount,
    failedCount,
    creatorsTouched: resolvedCreators.size,
    creatorsCreatedOrResolved: resolvedCreators.size,
    sellersLinked,
    batchId,
    failures,
  };
}
