"use server";

import { createClient } from "@supabase/supabase-js";
import {
  getTapFileHash,
  parseTapAffiliateOrderExport,
} from "@/lib/orders/parse-tap-affiliate-order-export";

type ImportResult = {
  ok: boolean;
  message: string;
  parsedCount?: number;
  insertedOrUpdatedCount?: number;
  creatorCount?: number;
  duplicateFile?: boolean;
};

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error("Supabase環境変数が設定されていません。");
  }

  return createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function normalizeTikTokId(value: string | null | undefined) {
  return (value ?? "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
}

export async function importTapAffiliateOrdersAction(
  formData: FormData,
): Promise<ImportResult> {
  try {
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return {
        ok: false,
        message: "TAP Excelファイルを選択してください。",
      };
    }

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    const fileHash = getTapFileHash(buffer);
    const supabase = getSupabaseAdmin();

    /*
      完全に同じファイルが過去に正常取込済みなら
      二重取込を防止。
    */
    const { data: existingBatch, error: existingBatchError } =
      await supabase
        .from("tap_affiliate_order_import_batches")
        .select("id, file_name, imported_at")
        .eq("file_hash", fileHash)
        .maybeSingle();

    if (existingBatchError) {
      throw new Error(
        `既存ファイル確認に失敗しました: ${existingBatchError.message}`,
      );
    }

    if (existingBatch) {
      return {
        ok: true,
        duplicateFile: true,
        message:
          "このファイルはすでに取り込み済みです。重複登録は行いませんでした。",
      };
    }

    const rows = parseTapAffiliateOrderExport(buffer);

    if (rows.length === 0) {
      return {
        ok: false,
        message: "TAP注文明細をExcelから取得できませんでした。",
      };
    }

    const { data: batch, error: batchError } = await supabase
      .from("tap_affiliate_order_import_batches")
      .insert({
        file_name: file.name,
        file_hash: fileHash,
        row_count: rows.length,
        inserted_count: 0,
        updated_count: 0,
        skipped_count: 0,
      })
      .select("id")
      .single();

    if (batchError || !batch) {
      throw new Error(
        `取込履歴の作成に失敗しました: ${
          batchError?.message ?? "unknown error"
        }`,
      );
    }

    /*
      まずExcel内のTikTok IDをユニーク化。
    */
    const creatorTikTokIds = [
      ...new Set(
        rows
          .map((row) => normalizeTikTokId(row.creatorTikTokId))
          .filter(Boolean),
      ),
    ];

    /*
      既存クリエイターを一括取得。
    */
    const creatorMap = new Map<
      string,
      {
        id: string;
        agency_id: string | null;
      }
    >();

    if (creatorTikTokIds.length > 0) {
      const { data: existingCreators, error: creatorsError } =
        await supabase
          .from("creators")
          .select("id, tiktok_id, agency_id")
          .in("tiktok_id", creatorTikTokIds);

      if (creatorsError) {
        throw new Error(
          `クリエイター取得に失敗しました: ${creatorsError.message}`,
        );
      }

      for (const creator of existingCreators ?? []) {
        creatorMap.set(normalizeTikTokId(creator.tiktok_id), {
          id: creator.id,
          agency_id: creator.agency_id ?? null,
        });
      }
    }

    /*
      未登録クリエイターは仮登録。
      commission_rateは既存仕様に合わせて5を初期値にする。
    */
    const missingCreatorIds = creatorTikTokIds.filter(
      (id) => !creatorMap.has(id),
    );

    if (missingCreatorIds.length > 0) {
      const newCreators = missingCreatorIds.map((tiktokId) => ({
        tiktok_id: tiktokId,
        creator_name: tiktokId,
        agency_id: null,
        commission_rate: 5,
        registration_status: "pending",
        official_line_registered: false,
      }));

      const { data: createdCreators, error: createCreatorsError } =
        await supabase
          .from("creators")
          .upsert(newCreators, {
            onConflict: "tiktok_id",
            ignoreDuplicates: false,
          })
          .select("id, tiktok_id, agency_id");

      if (createCreatorsError) {
        throw new Error(
          `未登録クリエイターの作成に失敗しました: ${createCreatorsError.message}`,
        );
      }

      for (const creator of createdCreators ?? []) {
        creatorMap.set(normalizeTikTokId(creator.tiktok_id), {
          id: creator.id,
          agency_id: creator.agency_id ?? null,
        });
      }
    }

    /*
      source_row_keyを一意キーとしてupsert。
      金額や支払い状況が後日変わった場合は既存行を更新。
    */
    const payload = rows.map((row) => {
      const creator = creatorMap.get(
        normalizeTikTokId(row.creatorTikTokId),
      );

      return {
        source_row_key: row.sourceRowKey,

        order_id: row.orderId,
        sku_id: row.skuId,
        product_id: row.productId,
        product_name: row.productName,

        creator_id: creator?.id ?? null,
        creator_tiktok_id: row.creatorTikTokId
          ? normalizeTikTokId(row.creatorTikTokId)
          : null,
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

        partner_estimated_commission:
          row.partnerEstimatedCommission,

        partner_shop_ads_estimated_commission:
          row.partnerShopAdsEstimatedCommission,

        partner_bonus_estimated_commission:
          row.partnerBonusEstimatedCommission,

        tap_revenue: row.tapRevenue,

        payment_status: row.paymentStatus,
        order_status: row.orderStatus,
        refund_status: row.refundStatus,

        ordered_at: row.orderedAt,
        delivered_at: row.deliveredAt,
        paid_at: row.paidAt,

        import_batch_id: batch.id,
        raw_row_json: row.rawRowJson,

        updated_at: new Date().toISOString(),
      };
    });

    /*
      大量データなので1000件ずつupsert。
    */
    const chunkSize = 1000;
    let processedCount = 0;

    for (let i = 0; i < payload.length; i += chunkSize) {
      const chunk = payload.slice(i, i + chunkSize);

      const { error: upsertError } = await supabase
        .from("tap_affiliate_order_lines")
        .upsert(chunk, {
          onConflict: "source_row_key",
          ignoreDuplicates: false,
        });

      if (upsertError) {
        throw new Error(
          `TAP注文明細の保存に失敗しました: ${upsertError.message}`,
        );
      }

      processedCount += chunk.length;
    }

    const { error: updateBatchError } = await supabase
      .from("tap_affiliate_order_import_batches")
      .update({
        inserted_count: processedCount,
      })
      .eq("id", batch.id);

    if (updateBatchError) {
      console.error(
        "TAP取込履歴更新エラー:",
        updateBatchError.message,
      );
    }

    return {
      ok: true,
      message: `${processedCount.toLocaleString(
        "ja-JP",
      )}件のTAP注文明細を取り込みました。`,
      parsedCount: rows.length,
      insertedOrUpdatedCount: processedCount,
      creatorCount: creatorTikTokIds.length,
    };
  } catch (error) {
    console.error(error);

    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "TAP注文の取込中にエラーが発生しました。",
    };
  }
}
