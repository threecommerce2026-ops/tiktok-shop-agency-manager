"use server";

import { requireAdminAction } from "@/lib/db/admin-access";
import { applySellerImportRows } from "@/lib/sellers/apply-seller-import";
import { mapSupabaseErrorToJa } from "@/lib/supabase/error-ja";
import type {
  SellerImportExecuteResult,
  SellerImportPreviewResult,
  SellerImportSourceRow,
  SellerMatchSnapshot,
} from "@/lib/sellers/import-types";
import { simulateSellerImport } from "@/lib/sellers/seller-import-simulation";
import { revalidatePath } from "next/cache";

const MAX_ROWS = 3000;

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
    .select("id, seller_name, shop_name, contact_email, contact_phone, shop_id");

  if (error) {
    return { ok: false, error: mapSupabaseErrorToJa(error.message) };
  }

  const snapshot: SellerMatchSnapshot[] = (dbRows ?? []).map((r) => ({
    id: r.id as string,
    seller_name: String(r.seller_name ?? ""),
    shop_name: String(r.shop_name ?? ""),
    contact_email: (r.contact_email as string | null) ?? null,
    contact_phone: (r.contact_phone as string | null) ?? null,
    shop_id: (r.shop_id as string | null) ?? null,
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

  const importSource = sourceType === "csv" ? "csv" : "excel";

  // 取込本体は lib と共有する（画面からの実行と事前検証を同一コードにするため）
  const result = await applySellerImportRows(supabase, rows, importSource);
  if ("error" in result) {
    return { ok: false, error: result.error };
  }

  const {
    newCount,
    updateCount,
    errorCount,
    preservedFieldCount,
    blockedRegressionCount,
  } = result;
  const loggedErrors = result.errors;

  const applied = newCount + updateCount;
  const executorEmail = user.email ?? "";

  const raw_result = {
    sourceType,
    fileName: fileName.trim() || null,
    totalRows: rows.length,
    newCount,
    updateCount,
    errorCount,
    // 空欄だったため既存値を維持した列の延べ件数
    preservedFieldCount,
    // ステータス後退を拒否して既存値を維持した列の延べ件数
    blockedRegressionCount,
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
