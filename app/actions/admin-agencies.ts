"use server";

import { requireAdminAction } from "@/lib/db/admin-access";
import { mapSupabaseErrorToJa } from "@/lib/supabase/error-ja";
import { revalidatePath } from "next/cache";

/*
  代理店の設定（有効 / 無効）の保存と、新規代理店の追加。

  ■ デフォルト分配率は扱わない
  agencies.default_commission_rate は現在どの計算にも使用していないため
  管理画面から非表示にした。カラムと既存値はそのまま残し、
  このアクションでは読み書きしない（UPDATE では既存値を維持、
  INSERT では DB のデフォルト値 5 が入る）。

  ■ 代理店名の変更はここでは行わない
  既存代理店の名称変更は app/actions/master-name-edit.ts の renameAgencyAction に
  一本化している（変更前後の確認 + master_name_change_logs への履歴記録つき）。
  このアクションの UPDATE では name を書き換えない。
  新規追加時のみ、初期名称として name を設定する。
*/

export type AdminActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

function readText(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function readOptionalText(formData: FormData, key: string): string | null {
  const value = readText(formData, key);
  return value.length > 0 ? value : null;
}

function readBoolean(formData: FormData, key: string): boolean {
  const value = String(formData.get(key) ?? "").trim().toLowerCase();
  return value === "on" || value === "true" || value === "1";
}

export async function saveAgencyAction(
  _prev: AdminActionResult | null,
  formData: FormData,
): Promise<AdminActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const agencyId = readOptionalText(formData, "agency_id");
  const name = readText(formData, "name");
  const isActive = readBoolean(formData, "is_active");

  if (agencyId) {
    /*
      名称は含めない（renameAgencyAction に一本化）。
      default_commission_rate も含めないため既存値がそのまま維持される。
    */
    const { error } = await auth.supabase
      .from("agencies")
      .update({ is_active: isActive })
      .eq("id", agencyId);
    if (error) return { ok: false, error: mapSupabaseErrorToJa(error.message) };
  } else {
    if (!name) {
      return { ok: false, error: "代理店名は必須です" };
    }
    // default_commission_rate は指定しない（DB のデフォルト値が入る）
    const { error } = await auth.supabase.from("agencies").insert({
      name,
      is_active: isActive,
    });
    if (error) return { ok: false, error: mapSupabaseErrorToJa(error.message) };
  }

  revalidatePath("/admin/agencies");
  return {
    ok: true,
    message: agencyId
      ? "代理店設定を更新しました（代理店名は「名称編集」から変更してください）"
      : "代理店を追加しました",
  };
}
