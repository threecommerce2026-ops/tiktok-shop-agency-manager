"use server";

import { revalidatePath } from "next/cache";

import {
  buildCreatorLookup,
  resolveCreatorByTiktokId,
} from "@/lib/creators/resolve-creator-by-tiktok";
import { requireAdminAction } from "@/lib/db/admin-access";
import { normalizeTiktokId } from "@/lib/sales/parse-partner-sales";
import { mapSupabaseErrorToJa } from "@/lib/supabase/error-ja";
import {
  FINGERPRINT_DB_COLUMNS,
  fingerprintFromDbRow,
  MAX_CHUNK_ROWS,
  MAX_COMPARE_CHUNK_ROWS,
  validateAffiliateOrderPayloadRow,
  type AffiliateOrderPayloadRow,
  type CompareItem,
} from "@/lib/orders/affiliate-order-import-payload";
import type { AffiliateOrderCompareTotals } from "@/lib/orders/affiliate-order-preview";

/*
  Partner Center 注文Excelの取込（チャンク方式）。

  ■ Excelファイルはサーバーへ送らない
  Vercel Functions のボディ上限 4.5MB（実測で 5MB は 413）と
  Next.js Server Action の既定上限 1MB を避けるため、
  解析はブラウザ側で行い、ここへは小さなJSONチャンクだけが届く。
  next.config.ts の bodySizeLimit には依存しない。

  ■ ブラウザの値を信用しない
  チャンクごとに
    管理者判定 → 行の再検証 → source_row_key の再生成と一致確認 → UPSERT
  を必ず通す。

  ■ 二重計上しない
  UNIQUE(source_row_key) + onConflict: "source_row_key" の既存仕様を維持。
  同じExcelの再投入・期間が重なるExcel・途中失敗後の再実行、いずれでも増えない。

  ■ 報酬は自動再集計しない
  既存運用どおり、取込後に「代理店報酬の再集計」「紹介者報酬の再集計」を
  管理者が明示的に実行する。
*/

export type StartImportResult =
  | { ok: true; batchId: string }
  | { ok: false; error: string };

export type CompareChunkResult =
  | { ok: true; totals: AffiliateOrderCompareTotals }
  | { ok: false; error: string };

export type ImportChunkResult =
  | {
      ok: true;
      upsertedCount: number;
      failedCount: number;
      creatorsResolved: number;
      sellersLinked: number;
      failures: Array<{ rowNumber: number; error: string }>;
    }
  | { ok: false; error: string; failures?: Array<{ rowNumber: number; error: string }> };

export type FinishImportResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

/** 1リクエストで受け付ける行数の上限（クライアントの分割と合わせる） */
const SERVER_MAX_CHUNK_ROWS = MAX_CHUNK_ROWS * 2;

function failureList(
  rows: Array<{ rowNumber: number; error: string }>,
  limit = 50,
): Array<{ rowNumber: number; error: string }> {
  return rows.slice(0, limit);
}

// =============================================================================
// 1. 取込セッションの開始
// =============================================================================

/**
 * Excel 1ファイル = 1 import session。
 * チャンクごとにバッチを作らない。
 */
export async function startAffiliateOrderImportAction(input: {
  fileName: string;
  rowTotal: number;
}): Promise<StartImportResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const fileName = String(input?.fileName ?? "").trim();
  const rowTotal = Number(input?.rowTotal ?? 0);

  if (!fileName) return { ok: false, error: "ファイル名がありません" };
  if (!Number.isInteger(rowTotal) || rowTotal <= 0) {
    return { ok: false, error: "取込対象の行数が不正です" };
  }

  const { data, error } = await auth.supabase
    .from("affiliate_order_import_batches")
    .insert({
      file_name: fileName,
      row_total: rowTotal,
      upserted_count: 0,
      failed_count: 0,
      imported_by: auth.user?.id ?? null,
    })
    .select("id")
    .single();

  if (error || !data?.id) {
    return {
      ok: false,
      error: mapSupabaseErrorToJa(
        error?.message ?? "取込履歴を作成できませんでした",
      ),
    };
  }

  return { ok: true, batchId: data.id as string };
}

// =============================================================================
// 2. プレビュー用の既存行照合（DB WRITE なし）
// =============================================================================

/**
 * source_row_key と指紋だけを受け取り、
 * 新規 / 更新あり / 変更なし を数える。
 *
 * 明細そのものは送らないので、1リクエストで2,000件ほど照合できる。
 * このアクションは SELECT しか行わない。
 */
export async function compareAffiliateOrderChunkAction(input: {
  items: CompareItem[];
}): Promise<CompareChunkResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const items = Array.isArray(input?.items) ? input.items : null;
  if (!items) return { ok: false, error: "照合データの形式が不正です" };
  if (items.length === 0) {
    return { ok: true, totals: { newRows: 0, changedRows: 0, unchangedRows: 0 } };
  }
  if (items.length > MAX_COMPARE_CHUNK_ROWS * 2) {
    return { ok: false, error: "1回の照合件数が多すぎます" };
  }

  const fingerprintByKey = new Map<string, string>();
  for (const item of items) {
    const key = String(item?.k ?? "");
    const fingerprint = String(item?.f ?? "");
    if (!key || !fingerprint) {
      return { ok: false, error: "照合データの形式が不正です" };
    }
    fingerprintByKey.set(key, fingerprint);
  }

  const keys = [...fingerprintByKey.keys()];

  const { data, error } = await auth.supabase
    .from("affiliate_order_lines")
    .select(FINGERPRINT_DB_COLUMNS)
    .in("source_row_key", keys);

  if (error) {
    return { ok: false, error: mapSupabaseErrorToJa(error.message) };
  }

  let changedRows = 0;
  let unchangedRows = 0;

  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const key = String(row.source_row_key ?? "");
    const incoming = fingerprintByKey.get(key);
    if (!incoming) continue;

    if (fingerprintFromDbRow(row) === incoming) unchangedRows += 1;
    else changedRows += 1;
  }

  return {
    ok: true,
    totals: {
      newRows: keys.length - changedRows - unchangedRows,
      changedRows,
      unchangedRows,
    },
  };
}

// =============================================================================
// 3. チャンク取込（UPSERT）
// =============================================================================

/**
 * 1チャンク分の明細を取り込む。
 *
 * 途中のチャンクが失敗しても、成功済みのチャンクは
 * source_row_key の UPSERT で入っているため、
 * 同じExcelを最初から流し直しても二重計上にならない。
 */
export async function importAffiliateOrderChunkAction(input: {
  batchId: string;
  rows: unknown[];
}): Promise<ImportChunkResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const batchId = String(input?.batchId ?? "").trim();
  if (!batchId) return { ok: false, error: "取込セッションが不明です" };

  const incoming = Array.isArray(input?.rows) ? input.rows : null;
  if (!incoming) return { ok: false, error: "明細データの形式が不正です" };
  if (incoming.length === 0) {
    return {
      ok: true,
      upsertedCount: 0,
      failedCount: 0,
      creatorsResolved: 0,
      sellersLinked: 0,
      failures: [],
    };
  }
  if (incoming.length > SERVER_MAX_CHUNK_ROWS) {
    return { ok: false, error: "1回の送信件数が多すぎます" };
  }

  // 取込セッションの存在確認（勝手なIDで書かせない）
  const { data: batch, error: batchError } = await auth.supabase
    .from("affiliate_order_import_batches")
    .select("id, upserted_count, failed_count")
    .eq("id", batchId)
    .maybeSingle();

  if (batchError) {
    return { ok: false, error: mapSupabaseErrorToJa(batchError.message) };
  }
  if (!batch?.id) {
    return { ok: false, error: "取込セッションが見つかりません" };
  }

  // ---- 行ごとの再検証（source_row_key の再生成を含む）----
  const failures: Array<{ rowNumber: number; error: string }> = [];
  const validRows: AffiliateOrderPayloadRow[] = [];
  const seenKeys = new Set<string>();

  for (const candidate of incoming) {
    const result = validateAffiliateOrderPayloadRow(candidate);

    if (!result.ok) {
      failures.push({ rowNumber: result.rowNumber, error: result.error });
      continue;
    }

    /*
      チャンク内の重複はブラウザ側で除去済みだが、
      ここでも弾いておく。
      同じキーが1文に2回現れると Postgres が 21000 で失敗するため。
    */
    if (seenKeys.has(result.row.sourceRowKey)) {
      failures.push({
        rowNumber: result.row.rowNumber,
        error: "同じ明細キーが1回の送信に重複しています",
      });
      continue;
    }

    seenKeys.add(result.row.sourceRowKey);
    validRows.push(result.row);
  }

  if (validRows.length === 0) {
    return {
      ok: false,
      error: "このチャンクに取り込める明細がありません",
      failures: failureList(failures),
    };
  }

  // ---- クリエイター解決（未登録は仮登録。既存仕様を維持）----
  const { data: existingCreators, error: creatorsError } = await auth.supabase
    .from("creators")
    .select("id, tiktok_id, agency_id, creator_name");

  if (creatorsError) {
    return { ok: false, error: mapSupabaseErrorToJa(creatorsError.message) };
  }

  const creatorLookup = buildCreatorLookup(
    (existingCreators ?? []).map((creator) => ({
      id: creator.id as string,
      tiktok_id: creator.tiktok_id as string,
      agency_id: (creator.agency_id as string | null) ?? null,
      creator_name: creator.creator_name as string,
    })),
  );

  const resolvedCreators = new Map<
    string,
    { id: string; agencyId: string | null; creatorName: string }
  >();

  const uniqueTiktokIds = new Set<string>();
  for (const row of validRows) {
    const key = normalizeTiktokId(row.creatorTiktokId);
    if (key) uniqueTiktokIds.add(key);
  }

  for (const tiktokId of uniqueTiktokIds) {
    const resolved = await resolveCreatorByTiktokId(auth.supabase, {
      tiktokId,
      // 現エクスポートに nickname が無いため username を表示名にする既存仕様
      creatorName: tiktokId,
      lookup: creatorLookup,
      autoCreate: true,
    });

    if (!resolved.creator) {
      failures.push({
        rowNumber: 0,
        error: `${tiktokId}: ${resolved.error ?? "クリエイターを登録できませんでした"}`,
      });
      continue;
    }

    resolvedCreators.set(tiktokId, {
      id: resolved.creator.id,
      agencyId: resolved.creator.agency_id,
      creatorName: resolved.creator.creator_name,
    });
  }

  // ---- セラー照合（shop_id 優先。既存仕様を維持）----
  const { data: sellers, error: sellersError } = await auth.supabase
    .from("sellers")
    .select("id, shop_id, shop_name, seller_name");

  if (sellersError) {
    return { ok: false, error: mapSupabaseErrorToJa(sellersError.message) };
  }

  const sellerByShopId = new Map<string, string>();
  const sellerByShopName = new Map<string, string>();

  for (const seller of sellers ?? []) {
    const sellerId = seller.id as string;

    const shopId = String(seller.shop_id ?? "").trim();
    if (shopId) sellerByShopId.set(shopId, sellerId);

    const shopName = String(seller.shop_name ?? seller.seller_name ?? "")
      .trim()
      .toLowerCase();
    if (shopName) sellerByShopName.set(shopName, sellerId);
  }

  // ---- DB 行へ変換（列の組み立ては従来と同一）----
  const nowIso = new Date().toISOString();
  const insertRows: Array<Record<string, unknown>> = [];
  let sellersLinked = 0;

  for (const row of validRows) {
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
      sellerId = sellerByShopName.get(row.shopName.trim().toLowerCase()) ?? null;
    }
    if (sellerId) sellersLinked += 1;

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

      refund_amount: row.isFullyRefunded ? row.productPrice * row.quantity : 0,

      refund_status: row.isFullyRefunded ? "fully_refunded" : null,

      commission_gmv: row.commissionGmv,
      commission_base: row.commissionBase,

      standard_commission_rate: row.standardCommissionRate,
      shop_ads_commission_rate: row.shopAdsCommissionRate,
      tiktok_bonus_commission_rate: row.tiktokBonusCommissionRate,
      partner_bonus_commission_rate: row.partnerBonusCommissionRate,

      creator_revenue_before_split: row.creatorRevenueBeforeSplit,

      agency_split_rate: row.agencySplitRate,

      agency_revenue_before_tax: row.agencyRevenueBeforeTax,

      agency_revenue: row.agencyRevenue,

      payment_id: row.paymentId,
      payment_status: row.payoutStatus,

      order_status: row.paymentStatus,

      ordered_at: row.orderedAt,
      delivered_at: row.deliveredAt,

      paid_at:
        row.payoutStatus && /paid|支払済|支払い済/i.test(row.payoutStatus)
          ? row.deliveredAt ?? row.orderedAt
          : null,

      import_batch_id: batchId,

      raw_row_json: row.raw,

      updated_at: nowIso,
    });
  }

  if (insertRows.length === 0) {
    return {
      ok: false,
      error: "このチャンクに取り込める明細がありません",
      failures: failureList(failures),
    };
  }

  // ---- UPSERT（既存仕様どおり source_row_key で後勝ち）----
  const { error: upsertError } = await auth.supabase
    .from("affiliate_order_lines")
    .upsert(insertRows, { onConflict: "source_row_key" });

  if (upsertError) {
    return {
      ok: false,
      error: mapSupabaseErrorToJa(upsertError.message),
      failures: failureList(failures),
    };
  }

  // ---- import session の進捗を更新 ----
  const upsertedCount = insertRows.length;
  const failedCount = failures.length;

  await auth.supabase
    .from("affiliate_order_import_batches")
    .update({
      upserted_count: Number(batch.upserted_count ?? 0) + upsertedCount,
      failed_count: Number(batch.failed_count ?? 0) + failedCount,
    })
    .eq("id", batchId);

  return {
    ok: true,
    upsertedCount,
    failedCount,
    creatorsResolved: resolvedCreators.size,
    sellersLinked,
    failures: failureList(failures),
  };
}

// =============================================================================
// 4. 取込セッションの完了
// =============================================================================

/**
 * 取込完了を記録する。
 *
 * affiliate_order_import_batches には completed_at 列が無いため、
 * ここでは最終的な件数の確定だけを行う。
 * 途中で中断した場合は upserted_count が row_total に満たない状態で残り、
 * 「どこまで入ったか」が履歴から分かる。
 */
export async function finishAffiliateOrderImportAction(input: {
  batchId: string;
  upsertedCount: number;
  failedCount: number;
}): Promise<FinishImportResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const batchId = String(input?.batchId ?? "").trim();
  if (!batchId) return { ok: false, error: "取込セッションが不明です" };

  const upsertedCount = Number(input?.upsertedCount ?? 0);
  const failedCount = Number(input?.failedCount ?? 0);

  if (!Number.isInteger(upsertedCount) || upsertedCount < 0) {
    return { ok: false, error: "取込件数が不正です" };
  }
  if (!Number.isInteger(failedCount) || failedCount < 0) {
    return { ok: false, error: "失敗件数が不正です" };
  }

  const { error } = await auth.supabase
    .from("affiliate_order_import_batches")
    .update({ upserted_count: upsertedCount, failed_count: failedCount })
    .eq("id", batchId);

  if (error) {
    return { ok: false, error: mapSupabaseErrorToJa(error.message) };
  }

  /*
    報酬の再集計はここでは行わない（既存運用を維持）。
    全期間の取込が終わってから、管理者が
    「代理店報酬の再集計」「紹介者報酬の再集計」を実行する。
  */
  revalidatePath("/orders");
  revalidatePath("/creators");
  revalidatePath("/admin/creator-assignment");
  revalidatePath("/admin/affiliate-orders-import");

  return {
    ok: true,
    message: `${upsertedCount.toLocaleString("ja-JP")}件の注文明細を取り込みました`,
  };
}
