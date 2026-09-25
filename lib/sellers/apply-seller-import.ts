import type { SupabaseClient } from "@supabase/supabase-js";

import { mapSupabaseErrorToJa } from "@/lib/supabase/error-ja";
import {
  findExistingSellerId,
  refreshSnapshotRow,
  upsertSnapshotAfterInsert,
} from "@/lib/sellers/import-match";
import {
  BLANK_PRESERVING_SELLER_FIELDS,
  mergeSellerUpdatePatch,
} from "@/lib/sellers/import-merge";
import type {
  SellerImportSourceRow,
  SellerMatchSnapshot,
} from "@/lib/sellers/import-types";
import { validateSellerImportRow } from "@/lib/sellers/import-validate";
import { applyShopNameOverride } from "@/lib/sellers/shop-name-overrides";

/*
  セラー取込の本体（1行ずつ sellers へ INSERT / UPDATE する）。

  サーバーアクションと検証スクリプトの両方がこの関数を使うことで、
  「画面から実行した結果」と「事前に確認した結果」が必ず一致する。
  この関数は sellers テーブル以外を一切更新しない。
*/

/** 空欄上書き防止のため UPDATE 前に読み直す列 */
const SELLER_MERGE_COLUMNS = ["id", ...BLANK_PRESERVING_SELLER_FIELDS].join(", ");

const ERROR_LOG_CAP = 40;

export type ApplySellerImportResult = {
  newCount: number;
  updateCount: number;
  errorCount: number;
  /** 空欄だったため既存値を維持した列の延べ件数 */
  preservedFieldCount: number;
  /** ステータス後退を拒否して既存値を維持した列の延べ件数 */
  blockedRegressionCount: number;
  errors: Array<{ index: number; message: string }>;
};

export async function applySellerImportRows(
  supabase: SupabaseClient,
  rows: SellerImportSourceRow[],
  importSource: string,
): Promise<ApplySellerImportResult | { error: string }> {
  const { data: dbRows, error: loadErr } = await supabase
    .from("sellers")
    .select("id, seller_name, shop_name, contact_email, contact_phone, shop_id");

  if (loadErr) {
    return { error: mapSupabaseErrorToJa(loadErr.message) };
  }

  const snapshot: SellerMatchSnapshot[] = (dbRows ?? []).map((r) => ({
    id: r.id as string,
    seller_name: String(r.seller_name ?? ""),
    shop_name: String(r.shop_name ?? ""),
    contact_email: (r.contact_email as string | null) ?? null,
    contact_phone: (r.contact_phone as string | null) ?? null,
    shop_id: (r.shop_id as string | null) ?? null,
  }));

  let preservedFieldCount = 0;
  let blockedRegressionCount = 0;
  const loggedErrors: Array<{ index: number; message: string }> = [];

  let newCount = 0;
  let updateCount = 0;
  let errorCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const seller_name = row.seller_name.trim();
    /*
      同一ショップと人が確認済みの改称は、SHOP名を正の表記へ揃える。
      クライアント解析側でも同じ処理をしているが、
      サーバー側の判定が渡されたデータに依存しないように再適用する（冪等）。
    */
    const shop_name = applyShopNameOverride(
      row.seller_name.trim(),
      row.shop_name.trim(),
    ).shopName;
    const contact_person = row.contact_person?.trim() || null;
    const contact_phone = row.contact_phone?.trim() || null;
    const contact_email = row.contact_email?.trim() || null;

    const normalized: SellerImportSourceRow = {
      ...row,
      seller_name,
      shop_name,
      contact_person,
      contact_phone,
      contact_email,
    };

    const err = validateSellerImportRow(normalized);
    if (err) {
      errorCount++;
      if (loggedErrors.length < ERROR_LOG_CAP) {
        loggedErrors.push({ index: i, message: err });
      }
      continue;
    }

    /*
      更新時の上書きルール。

      ■ 上書きするもの
      登録フォームに列があり、フォームが最新である項目だけ。
      （会社名 / SHOP名 / 担当者 / 連絡先 / 運用列 / 備考由来のフラグ）

      ■ 絶対に上書きしないもの
        tsp_rate  … 契約料率。フォームに列が無いので、書くと必ずNULLへ戻る
        shop_id   … フォームに無い。推測もしない
        status    … 手動で active にした状態を pending へ戻さない
                    （辞退のときだけ stopped を明示的に設定する）
      これらは patch に入れない。

      seller_shop_aliases / seller_invoices はこのアクションが触らない。
    */
    const patch: Record<string, unknown> = {
      seller_name,
      shop_name,
      contact_person,
      contact_email,
      contact_phone,
      raw_import_json: normalized.raw_import_json,
      import_source: importSource,
      contract_status: normalized.contract_status ?? null,
      tsp_link_status: normalized.tsp_link_status ?? null,
      sales_status: normalized.sales_status ?? null,
      initial_fee_note: normalized.initial_fee_note ?? null,
      payment_status_note: normalized.payment_status_note ?? null,
      form_note: normalized.form_note ?? null,
      is_tsp_billing_eligible: normalized.is_tsp_billing_eligible !== false,
    };

    /*
      創建時間は解釈できたときだけ書く。
      解釈できない値で既存の日時を消さない（要確認としてプレビューに出る）。
    */
    if (normalized.source_created_at) {
      patch.source_created_at = normalized.source_created_at;
    }

    // 辞退のときだけ status を stopped にする
    if (normalized.import_status === "stopped") {
      patch.status = "stopped";
    }

    const existingId = findExistingSellerId(snapshot, normalized);

    if (existingId && !existingId.startsWith("__virt__")) {
      /*
        空欄で既存の非空値を消さない。

        同一セラーと判定された後続行に値が無い列は patch から取り除き、
        DBに入っている値をそのまま残す。
        （ファイル内重複でも、2回目の取込でも同じ扱いになる）
      */
      const { data: currentRow, error: curErr } = await supabase
        .from("sellers")
        .select(SELLER_MERGE_COLUMNS)
        .eq("id", existingId)
        .maybeSingle();

      if (curErr) {
        errorCount++;
        if (loggedErrors.length < ERROR_LOG_CAP) {
          loggedErrors.push({ index: i, message: mapSupabaseErrorToJa(curErr.message) });
        }
        continue;
      }

      const merged = mergeSellerUpdatePatch(
        currentRow as Record<string, unknown> | null,
        patch,
      );
      if (merged.preservedFields.length > 0) {
        preservedFieldCount += merged.preservedFields.length;
      }
      if (merged.blockedRegressions.length > 0) {
        blockedRegressionCount += merged.blockedRegressions.length;
      }

      const { error: upErr } = await supabase
        .from("sellers")
        .update(merged.patch)
        .eq("id", existingId);
      if (upErr) {
        errorCount++;
        if (loggedErrors.length < ERROR_LOG_CAP) {
          loggedErrors.push({ index: i, message: mapSupabaseErrorToJa(upErr.message) });
        }
        continue;
      }
      updateCount++;
      // 実際にDBへ書いた値でスナップショットを更新する
      // （空欄で維持した列は既存値のままにしないと後続行の判定がずれる）
      const written: Record<string, unknown> = {
        ...((currentRow ?? {}) as Record<string, unknown>),
        ...merged.patch,
      };
      refreshSnapshotRow(snapshot, existingId, {
        seller_name: String(written.seller_name ?? seller_name),
        shop_name: String(written.shop_name ?? shop_name),
        contact_email: (written.contact_email as string | null) ?? null,
        contact_phone: (written.contact_phone as string | null) ?? null,
      });
    } else {
      const insertPayload = {
        ...patch,
        has_smp: false,
        seller_live_available: false,
        // 辞退なら stopped、それ以外は pending から始める
        status: normalized.import_status ?? "pending",
        category: null,
        sample_condition: null,
        tap_rate: null,
        // 契約料率はフォームに無い。新規は未設定のまま。既定値を入れない。
        tsp_rate: null,
        last_meeting_date: null,
        last_meeting_note: null,
        discount_condition: null,
        memo: null,
      };

      const { data: inserted, error: insErr } = await supabase
        .from("sellers")
        .insert(insertPayload)
        .select("id")
        .maybeSingle();

      if (insErr || !inserted?.id) {
        errorCount++;
        if (loggedErrors.length < ERROR_LOG_CAP) {
          loggedErrors.push({
            index: i,
            message: mapSupabaseErrorToJa(insErr?.message ?? "挿入に失敗しました"),
          });
        }
        continue;
      }

      newCount++;
      upsertSnapshotAfterInsert(snapshot, {
        id: inserted.id as string,
        seller_name,
        shop_name,
        contact_email,
        contact_phone,
      });
    }
  }


  return {
    newCount,
    updateCount,
    errorCount,
    preservedFieldCount,
    blockedRegressionCount,
    errors: loggedErrors,
  };
}
