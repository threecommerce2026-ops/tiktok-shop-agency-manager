"use server";

import { revalidatePath } from "next/cache";

import { requireAdminAction } from "@/lib/db/admin-access";
import {
  MAX_CHUNK_ROWS,
  MAX_CHUNK_PAYLOAD_BYTES,
  jsonByteLength,
} from "@/lib/orders/affiliate-order-import-payload";
import { buildTapAffiliateOrderSourceRowKey } from "@/lib/orders/parse-tap-affiliate-order-export";
import type { TapAffiliateOrderRow } from "@/lib/orders/parse-tap-affiliate-order-export";
import { normalizeTiktokId } from "@/lib/sales/parse-partner-sales";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

/*
  TAP注文明細の取込（親管理者専用）。

  ■ Excel 本体をサーバーへ送らない
  以前は File を multipart で Server Action へ送っていたが、
  Next.js の Server Action は既定で 1MB までしか受け取らない。
  実測で 1.5MB から 400 になり、本番の 4.15MB は取り込めなかった
  （サーバー側ログ: Body exceeded 1 MB limit.）。

  next.config.ts の bodySizeLimit を増やす対処は採らない。
  Vercel のリクエスト本体は 4.5MB が上限で、TAP の全量では結局届かない。
  既存の affiliate 取込が「設定に依存しない」方針で分割送信を実装済みなので、
  TAP もそれに揃える。

  ■ 流れ
    ブラウザで解析・プレビュー
      ↓ start   … ファイル情報だけ送る。取込セッションを作る
      ↓ chunk   … 正規化済みの行を 400KB / 300行 ずつ送る
      ↓ finish  … 全チャンクが揃ったか確かめて完了にする

  ■ クライアントを信用しない
  行数・サイズ・クリエイターの存在・一意キーは、すべてサーバーで検査し直す。
  ブラウザが計算した一意キーもそのまま使わず、同じ規則で作り直して突き合わせる。
*/

// -----------------------------------------------------------------------------
// 共通
// -----------------------------------------------------------------------------

/** クライアントの申告より少しだけ広く受ける（境界で弾かれすぎないように） */
const SERVER_MAX_CHUNK_ROWS = MAX_CHUNK_ROWS * 2;
const SERVER_MAX_CHUNK_BYTES = MAX_CHUNK_PAYLOAD_BYTES * 2;

const FILE_HASH_PATTERN = /^[0-9a-f]{64}$/;
const MONTH_PATTERN = /^\d{4}-\d{2}$/;

function fail(error: string) {
  return { ok: false as const, error };
}

/** サーバーへ送る正規化済みの1行。Excel の生の値は raw_row_json に残す */
export type TapImportPayloadRow = TapAffiliateOrderRow;

// -----------------------------------------------------------------------------
// 1. クリエイター照合（プレビュー用。DB WRITE なし）
// -----------------------------------------------------------------------------

export type TapCreatorDigestResult =
  | { ok: true; creators: Array<{ tiktokId: string; id: string }>; hasMore: boolean; nextPage: number }
  | { ok: false; error: string };

/** 1ページあたりの件数。URL には載せないので大きくてよい */
const CREATOR_PAGE_SIZE = 2_000;

/**
 * creators の「TikTok ID と id」だけをページ単位で返す。
 *
 * ■ なぜ TikTok ID を .in() で送らないのか
 * supabase-js の select は GET なので、大量の ID をクエリ文字列へ載せると
 * URL が膨らんで 414 になる（affiliate 取込で実測済み）。
 * ここでは URL にページ番号しか載せず、突き合わせは呼び出し側で行う。
 * URL の長さは Excel の大きさに左右されない。
 *
 * ■ SELECT しか行わない
 */
export async function fetchTapCreatorDigestAction(input: {
  page?: number;
}): Promise<TapCreatorDigestResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return fail(auth.error);

  const page = Number(input?.page ?? 0);
  if (!Number.isInteger(page) || page < 0 || page > 100_000) {
    return fail("ページ指定が不正です");
  }

  const from = page * CREATOR_PAGE_SIZE;
  const to = from + CREATOR_PAGE_SIZE - 1;

  /*
    order を付けずに range を繰り返すと、重複取得と取りこぼしが同時に起きる。
  */
  const { data, error } = await getSupabaseAdmin()
    .from("creators")
    .select("id, tiktok_id")
    .order("id", { ascending: true })
    .range(from, to);

  if (error) return fail(error.message);

  const rows = data ?? [];
  return {
    ok: true,
    creators: rows.map((row) => ({
      tiktokId: normalizeTiktokId(String(row.tiktok_id ?? "")),
      id: String(row.id),
    })),
    hasMore: rows.length === CREATOR_PAGE_SIZE,
    nextPage: page + 1,
  };
}

export type TapExistingKeysResult =
  | { ok: true; keys: string[]; hasMore: boolean; nextPage: number }
  | { ok: false; error: string };

/**
 * 対象月に既に入っている一意キーをページ単位で返す。
 *
 * ■ キーを .in() で送らない
 * TAP の一意キーは長く、日本語や「|」を含む。大量に URL へ載せると
 * 414 になる（affiliate 取込で実測済み）。
 * ここでは URL に載せるのは対象月とページ番号だけにして、
 * 突き合わせは呼び出し側で行う。
 *
 * ■ SELECT しか行わない
 */
export async function fetchTapExistingKeysAction(input: {
  months: string[];
  page?: number;
}): Promise<TapExistingKeysResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return fail(auth.error);

  const months = Array.isArray(input?.months) ? input.months : null;
  if (!months) return fail("対象月の形式が不正です");

  const normalized = [...new Set(months.map((m) => String(m ?? "").trim()))].filter((m) =>
    MONTH_PATTERN.test(m),
  );
  if (normalized.length === 0) return { ok: true, keys: [], hasMore: false, nextPage: 0 };
  if (normalized.length > 60) return fail("対象月が多すぎます");

  const page = Number(input?.page ?? 0);
  if (!Number.isInteger(page) || page < 0 || page > 100_000) {
    return fail("ページ指定が不正です");
  }

  const from = page * CREATOR_PAGE_SIZE;
  const to = from + CREATOR_PAGE_SIZE - 1;

  const { data, error } = await getSupabaseAdmin()
    .from("tap_affiliate_order_lines")
    .select("source_row_key")
    .in("target_month", normalized)
    .order("source_row_key", { ascending: true })
    .range(from, to);

  if (error) return fail(error.message);

  const rows = data ?? [];
  return {
    ok: true,
    keys: rows.map((row) => String(row.source_row_key)),
    hasMore: rows.length === CREATOR_PAGE_SIZE,
    nextPage: page + 1,
  };
}

// -----------------------------------------------------------------------------
// 2. 取込セッションの開始
// -----------------------------------------------------------------------------

export type StartTapImportResult =
  | { ok: true; batchId: string; resumedChunkIndexes: number[] }
  | { ok: false; error: string };

/**
 * 取込セッションを作る（または未完了のものを再開する）。
 *
 * ファイル本体は受け取らない。名前・ハッシュ・行数だけ。
 */
export async function startTapAffiliateOrderImportAction(input: {
  fileName: string;
  fileHash: string;
  rowCount: number;
  chunkCount: number;
  unknownCreatorCount: number;
}): Promise<StartTapImportResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return fail(auth.error);

  const fileName = String(input?.fileName ?? "").trim();
  const fileHash = String(input?.fileHash ?? "").trim().toLowerCase();
  const rowCount = Number(input?.rowCount ?? 0);
  const chunkCount = Number(input?.chunkCount ?? 0);
  const unknownCreatorCount = Number(input?.unknownCreatorCount ?? 0);

  if (!fileName) return fail("ファイル名がありません");
  if (!FILE_HASH_PATTERN.test(fileHash)) return fail("ファイルの識別子が不正です");
  if (!Number.isInteger(rowCount) || rowCount <= 0) return fail("取込対象の行数が不正です");
  if (!Number.isInteger(chunkCount) || chunkCount <= 0) return fail("分割数が不正です");

  /*
    未登録クリエイターが残っている状態では始めさせない。
    一部のクリエイターが抜けたまま取り込むと、その月を
    「全部入った」として扱えなくなる。画面でも止めているが、
    サーバーでも必ず拒否する。
  */
  if (!Number.isInteger(unknownCreatorCount) || unknownCreatorCount > 0) {
    return fail(
      "未登録のクリエイターがあります。先にクリエイター登録または別名設定を行ってください。",
    );
  }

  const admin = getSupabaseAdmin();

  /*
    同じファイルの扱い。
      completed  … 取込済み。もう一度は入れない
      processing / failed … 途中で終わっている。同じセッションを再開する
    「失敗したファイルは二度と入れられない」状態にはしない。
  */
  const { data: existing, error: existingError } = await admin
    .from("tap_affiliate_order_import_batches")
    .select("id, status, completed_chunk_indexes, chunk_count")
    .eq("file_hash", fileHash)
    .order("imported_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingError) return fail(existingError.message);

  if (existing?.status === "completed") {
    return fail("このファイルはすでに取り込み済みです。");
  }

  if (existing?.id) {
    // 途中まで終わっているセッションを引き継ぐ
    const { error: resumeError } = await admin
      .from("tap_affiliate_order_import_batches")
      .update({
        file_name: fileName,
        row_count: rowCount,
        chunk_count: chunkCount,
        status: "processing",
        error_message: null,
        started_at: new Date().toISOString(),
        imported_by: auth.user?.id ?? null,
      })
      .eq("id", existing.id);

    if (resumeError) return fail(resumeError.message);

    return {
      ok: true,
      batchId: String(existing.id),
      resumedChunkIndexes: (existing.completed_chunk_indexes as number[] | null) ?? [],
    };
  }

  const { data, error } = await admin
    .from("tap_affiliate_order_import_batches")
    .insert({
      file_name: fileName,
      file_hash: fileHash,
      row_count: rowCount,
      chunk_count: chunkCount,
      inserted_count: 0,
      updated_count: 0,
      skipped_count: 0,
      status: "processing",
      started_at: new Date().toISOString(),
      imported_by: auth.user?.id ?? null,
    })
    .select("id")
    .single();

  if (error || !data?.id) {
    return fail(error?.message ?? "取込履歴を作成できませんでした");
  }

  return { ok: true, batchId: String(data.id), resumedChunkIndexes: [] };
}

// -----------------------------------------------------------------------------
// 3. チャンクの取込
// -----------------------------------------------------------------------------

export type TapChunkResult =
  | { ok: true; upsertedCount: number; skippedCount: number; completedChunks: number }
  | { ok: false; error: string };

const UPSERT_CHUNK_SIZE = 500;

/**
 * 正規化済みの行を取り込む。
 *
 * 同じチャンクを何度送っても結果が変わらない
 * （source_row_key で upsert し、完了記録も番号の集合で持つ）。
 */
export async function importTapAffiliateOrderChunkAction(input: {
  batchId: string;
  chunkIndex: number;
  rows: TapImportPayloadRow[];
}): Promise<TapChunkResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return fail(auth.error);

  const batchId = String(input?.batchId ?? "").trim();
  if (!batchId) return fail("取込セッションが不明です");

  const chunkIndex = Number(input?.chunkIndex ?? -1);
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
    return fail("分割番号が不正です");
  }

  const rows = Array.isArray(input?.rows) ? input.rows : null;
  if (!rows) return fail("明細データの形式が不正です");
  if (rows.length === 0) return fail("明細データが空です");

  /*
    クライアントの申告を信じない。件数もサイズもここで見る。
  */
  if (rows.length > SERVER_MAX_CHUNK_ROWS) {
    return fail("1回の送信件数が多すぎます");
  }
  if (jsonByteLength(rows) > SERVER_MAX_CHUNK_BYTES) {
    return fail("1回の送信サイズが大きすぎます");
  }

  const admin = getSupabaseAdmin();

  const { data: batch, error: batchError } = await admin
    .from("tap_affiliate_order_import_batches")
    .select("id, status, chunk_count")
    .eq("id", batchId)
    .maybeSingle();

  if (batchError) return fail(batchError.message);
  if (!batch?.id) return fail("取込セッションが見つかりません");
  if (batch.status === "completed") return fail("この取込は完了済みです");
  if (typeof batch.chunk_count === "number" && chunkIndex >= batch.chunk_count) {
    return fail("分割番号が範囲外です");
  }

  // ---- クリエイターの照合（未登録があれば取り込まない） ----------------------
  const tiktokIds = [
    ...new Set(rows.map((row) => normalizeTiktokId(row.creatorTikTokId ?? "")).filter(Boolean)),
  ];
  if (tiktokIds.length === 0) return fail("クリエイターを特定できません");

  /*
    1チャンクのクリエイター数は多くても数百なので .in() で引ける。
    全行ぶんの ID をまとめて送らないので URL は短いままになる。
  */
  const { data: creators, error: creatorsError } = await admin
    .from("creators")
    .select("id, tiktok_id")
    .in("tiktok_id", tiktokIds);

  if (creatorsError) return fail(creatorsError.message);

  const creatorByTiktokId = new Map<string, string>();
  for (const creator of creators ?? []) {
    creatorByTiktokId.set(normalizeTiktokId(String(creator.tiktok_id ?? "")), String(creator.id));
  }

  const unknown = tiktokIds.filter((id) => !creatorByTiktokId.has(id));
  if (unknown.length > 0) {
    return fail(
      `未登録のクリエイターが含まれています（${unknown.slice(0, 5).join(", ")}${unknown.length > 5 ? " ほか" : ""}）。`,
    );
  }

  // ---- 行の組み立て（一意キーはサーバーで作り直す） --------------------------
  const payload: Array<Record<string, unknown>> = [];
  const now = new Date().toISOString();

  for (const row of rows) {
    const tiktokId = normalizeTiktokId(row.creatorTikTokId ?? "");
    const creatorId = creatorByTiktokId.get(tiktokId);
    if (!creatorId) return fail("クリエイターの解決に失敗しました");

    if (!row.orderId) return fail("注文IDが無い行があります");
    if (row.targetMonth && !MONTH_PATTERN.test(row.targetMonth)) {
      return fail(`対象月の形式が不正です: ${row.targetMonth}`);
    }

    /*
      一意キーはクライアントが送ってきた値をそのまま使わず、
      同じ規則で作り直す。改ざんや古い実装での送信で
      別キーの行が増えるのを防ぐ。
    */
    const sourceRowKey = buildTapAffiliateOrderSourceRowKey({
      orderId: row.orderId,
      skuId: row.skuId,
      productId: row.productId,
      creatorTikTokId: tiktokId,
      contentId: row.contentId,
      invitationId: row.invitationId,
      commissionType: row.commissionType,
    });

    payload.push({
      source_row_key: sourceRowKey,
      order_id: row.orderId,
      sku_id: row.skuId,
      product_id: row.productId,
      product_name: row.productName,
      creator_id: creatorId,
      creator_tiktok_id: tiktokId,
      creator_name: row.creatorName,
      shop_name: row.shopName,
      shop_code: row.shopCode,
      target_month: row.targetMonth,
      content_type: row.contentType,
      content_id: row.contentId,
      invitation_id: row.invitationId,
      commission_type: row.commissionType,
      product_price: row.productPrice,
      quantity: row.quantity,
      commission_gmv: row.commissionGmv,
      commission_base: row.commissionBase,
      partner_estimated_commission: row.partnerEstimatedCommission,
      partner_shop_ads_estimated_commission: row.partnerShopAdsEstimatedCommission,
      partner_bonus_estimated_commission: row.partnerBonusEstimatedCommission,
      tap_revenue: row.tapRevenue,
      payment_status: row.paymentStatus,
      order_status: row.orderStatus,
      refund_status: row.refundStatus,
      ordered_at: row.orderedAt,
      delivered_at: row.deliveredAt,
      paid_at: row.paidAt,
      import_batch_id: batchId,
      raw_row_json: row.rawRowJson,
      updated_at: now,
    });
  }

  /*
    同じチャンクを再送しても二重行にならない。
    source_row_key に金額や支払状況を含めていないので、
    後日の更新も同じ行に収まる。
  */
  for (let i = 0; i < payload.length; i += UPSERT_CHUNK_SIZE) {
    const slice = payload.slice(i, i + UPSERT_CHUNK_SIZE);
    const { error } = await admin
      .from("tap_affiliate_order_lines")
      .upsert(slice, { onConflict: "source_row_key", ignoreDuplicates: false });

    if (error) {
      await admin
        .from("tap_affiliate_order_import_batches")
        .update({ status: "failed", error_message: error.message })
        .eq("id", batchId);
      return fail(error.message);
    }
  }

  const { data: completed, error: markError } = await admin.rpc(
    "mark_tap_import_chunk_done",
    { p_batch_id: batchId, p_chunk_index: chunkIndex },
  );

  if (markError) return fail(markError.message);

  return {
    ok: true,
    upsertedCount: payload.length,
    skippedCount: rows.length - payload.length,
    completedChunks: Number(completed ?? 0),
  };
}

// -----------------------------------------------------------------------------
// 4. 取込の完了
// -----------------------------------------------------------------------------

export type FinishTapImportResult =
  | { ok: true; message: string; insertedCount: number }
  | { ok: false; error: string };

/**
 * 全チャンクが揃ったことを確かめて完了にする。
 * 足りなければ完了にしない（途中までの取込を「済み」と見せない）。
 */
export async function finishTapAffiliateOrderImportAction(input: {
  batchId: string;
  insertedCount: number;
  skippedCount: number;
}): Promise<FinishTapImportResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return fail(auth.error);

  const batchId = String(input?.batchId ?? "").trim();
  if (!batchId) return fail("取込セッションが不明です");

  const insertedCount = Number(input?.insertedCount ?? 0);
  const skippedCount = Number(input?.skippedCount ?? 0);
  if (!Number.isInteger(insertedCount) || insertedCount < 0) return fail("取込件数が不正です");
  if (!Number.isInteger(skippedCount) || skippedCount < 0) return fail("スキップ件数が不正です");

  const admin = getSupabaseAdmin();

  const { data: batch, error: batchError } = await admin
    .from("tap_affiliate_order_import_batches")
    .select("id, status, chunk_count, completed_chunk_indexes")
    .eq("id", batchId)
    .maybeSingle();

  if (batchError) return fail(batchError.message);
  if (!batch?.id) return fail("取込セッションが見つかりません");
  if (batch.status === "completed") return fail("この取込は完了済みです");

  const chunkCount = Number(batch.chunk_count ?? 0);
  const done = new Set(((batch.completed_chunk_indexes as number[] | null) ?? []).map(Number));
  const missing: number[] = [];
  for (let i = 0; i < chunkCount; i += 1) {
    if (!done.has(i)) missing.push(i);
  }

  if (missing.length > 0) {
    return fail(
      `まだ送信できていない分があります（${missing.length} / ${chunkCount} 件）。もう一度お試しください。`,
    );
  }

  const { error } = await admin
    .from("tap_affiliate_order_import_batches")
    .update({
      status: "completed",
      inserted_count: insertedCount,
      skipped_count: skippedCount,
      completed_at: new Date().toISOString(),
      error_message: null,
    })
    .eq("id", batchId);

  if (error) return fail(error.message);

  /*
    紹介者報酬の再集計はここでは行わない。
    全期間の取込が終わってから、管理者が明示的に実行する。
  */
  revalidatePath("/admin/tap-orders-import");

  return {
    ok: true,
    insertedCount,
    message: `${insertedCount.toLocaleString("ja-JP")}件のTAP注文明細を取り込みました。`,
  };
}

// -----------------------------------------------------------------------------
// 5. 失敗の記録
// -----------------------------------------------------------------------------

/** 途中で失敗したことを残す。次回は同じセッションを再開できる */
export async function failTapAffiliateOrderImportAction(input: {
  batchId: string;
  message: string;
}): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const batchId = String(input?.batchId ?? "").trim();
  if (!batchId) return { ok: false, error: "取込セッションが不明です" };

  const { error } = await getSupabaseAdmin()
    .from("tap_affiliate_order_import_batches")
    .update({
      status: "failed",
      error_message: String(input?.message ?? "").slice(0, 500),
    })
    .eq("id", batchId);

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
