"use server";

import { requireAdminAction } from "@/lib/db/admin-access";
import { mapSupabaseErrorToJa } from "@/lib/supabase/error-ja";
import { findExistingSellerId, refreshSnapshotRow, upsertSnapshotAfterInsert } from "@/lib/sellers/import-match";
import type {
  SellerImportExecuteResult,
  SellerImportPreviewResult,
  SellerImportSourceRow,
  SellerMatchSnapshot,
} from "@/lib/sellers/import-types";
import { validateSellerImportRow } from "@/lib/sellers/import-validate";
import { simulateSellerImport } from "@/lib/sellers/seller-import-simulation";
import { revalidatePath } from "next/cache";

const MAX_ROWS = 3000;
const ERROR_LOG_CAP = 40;

export async function previewSellerImportRowsAction(rowsJson: string): Promise<SellerImportPreviewResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  let rows: SellerImportSourceRow[];
  try {
    rows = JSON.parse(rowsJson);
  } catch {
    return { ok: false, error: "JSON の解析に失敗しました" };
  }
  if (!Array.isArray(rows)) {
    return { ok: false, error: "データは配列である必要があります" };
  }
  if (rows.length > MAX_ROWS) {
    return { ok: false, error: `一度に取り込めるのは最大 ${MAX_ROWS} 行です` };
  }

  const { data: dbRows, error } = await auth.supabase
    .from("sellers")
    .select("id, seller_name, shop_name, contact_email, contact_phone");

  if (error) {
    return { ok: false, error: mapSupabaseErrorToJa(error.message) };
  }

  const snapshot: SellerMatchSnapshot[] = (dbRows ?? []).map((r) => ({
    id: r.id as string,
    seller_name: String(r.seller_name ?? ""),
    shop_name: String(r.shop_name ?? ""),
    contact_email: (r.contact_email as string | null) ?? null,
    contact_phone: (r.contact_phone as string | null) ?? null,
  }));

  const { previewRows, counts } = simulateSellerImport(rows, snapshot);
  return { ok: true, rows: previewRows, counts };
}

export async function executeSellerImportRowsAction(
  rowsJson: string,
  fileName: string,
  sourceType: "excel" | "csv",
): Promise<SellerImportExecuteResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };
  const { supabase, user } = auth;
  if (!user) {
    return { ok: false, error: "ユーザー情報を取得できませんでした" };
  }

  let rows: SellerImportSourceRow[];
  try {
    rows = JSON.parse(rowsJson);
  } catch {
    return { ok: false, error: "JSON の解析に失敗しました" };
  }
  if (!Array.isArray(rows)) {
    return { ok: false, error: "データは配列である必要があります" };
  }
  if (rows.length > MAX_ROWS) {
    return { ok: false, error: `一度に取り込めるのは最大 ${MAX_ROWS} 行です` };
  }

  const { data: dbRows, error: loadErr } = await supabase
    .from("sellers")
    .select("id, seller_name, shop_name, contact_email, contact_phone");

  if (loadErr) {
    return { ok: false, error: mapSupabaseErrorToJa(loadErr.message) };
  }

  const snapshot: SellerMatchSnapshot[] = (dbRows ?? []).map((r) => ({
    id: r.id as string,
    seller_name: String(r.seller_name ?? ""),
    shop_name: String(r.shop_name ?? ""),
    contact_email: (r.contact_email as string | null) ?? null,
    contact_phone: (r.contact_phone as string | null) ?? null,
  }));

  const importSource = sourceType === "csv" ? "csv" : "excel";
  const loggedErrors: Array<{ index: number; message: string }> = [];

  let newCount = 0;
  let updateCount = 0;
  let errorCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const seller_name = row.seller_name.trim();
    const shop_name = row.shop_name.trim();
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

    const patch = {
      seller_name,
      shop_name,
      contact_person,
      contact_email,
      contact_phone,
      source_created_at: normalized.source_created_at,
      raw_import_json: normalized.raw_import_json,
      import_source: importSource,
    };

    const existingId = findExistingSellerId(snapshot, normalized);

    if (existingId && !existingId.startsWith("__virt__")) {
      const { error: upErr } = await supabase.from("sellers").update(patch).eq("id", existingId);
      if (upErr) {
        errorCount++;
        if (loggedErrors.length < ERROR_LOG_CAP) {
          loggedErrors.push({ index: i, message: mapSupabaseErrorToJa(upErr.message) });
        }
        continue;
      }
      updateCount++;
      refreshSnapshotRow(snapshot, existingId, {
        seller_name,
        shop_name,
        contact_email,
        contact_phone,
      });
    } else {
      const insertPayload = {
        ...patch,
        has_smp: false,
        seller_live_available: false,
        status: "pending",
        category: null,
        sample_condition: null,
        tap_rate: null,
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

  const applied = newCount + updateCount;
  const executorEmail = user.email ?? "";

  const raw_result = {
    sourceType,
    fileName: fileName.trim() || null,
    totalRows: rows.length,
    newCount,
    updateCount,
    errorCount,
    errors: loggedErrors.length > 0 ? loggedErrors : undefined,
  };

  const { error: logErr } = await supabase.from("seller_import_histories").insert({
    file_name: fileName.trim() || null,
    total_count: rows.length,
    inserted_count: newCount,
    updated_count: updateCount,
    error_count: errorCount,
    imported_by: executorEmail || null,
    raw_result,
  });

  revalidatePath("/admin/sellers");
  revalidatePath("/admin/seller-import-histories");

  if (logErr) {
    const warnDetail = mapSupabaseErrorToJa(logErr.message);
    return {
      ok: true,
      message:
        applied > 0
          ? `${applied}件のセラーを取り込みました（履歴保存のみ失敗）`
          : `取込を完了しました（反映 ${applied} 件）。履歴保存のみ失敗しました。`,
      warning: warnDetail,
      newCount,
      updateCount,
      errorCount,
    };
  }

  return {
    ok: true,
    message: `取込が完了しました（新規 ${newCount} / 更新 ${updateCount} / 行エラー ${errorCount}）`,
    newCount,
    updateCount,
    errorCount,
  };
}
