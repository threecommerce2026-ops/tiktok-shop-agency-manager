"use server";

import { revalidatePath } from "next/cache";

import { requireAdminAction } from "@/lib/db/admin-access";
import { mapSupabaseErrorToJa } from "@/lib/supabase/error-ja";
import {
  creatorAliasFromRow,
  validateCreatorAliasInput,
  type CreatorAliasRecord,
} from "@/lib/orders/creator-alias";

/*
  クリエイターの改名（旧ユーザー名 → 正式ユーザー名）の登録・削除。

  ■ 何のための機能か
  source_row_key は「クリエイターのユーザー名」を含むため、
  TikTok 側で改名されると同じ注文明細が別キーになり二重登録される。
  別名を登録しておくと、Excel 取込時に正式名へ寄せてから
  キーを作るので二重登録が起きない。

  ■ 誤登録の危険
  別人を同一人物として登録すると、別人の注文が1つの明細に統合される。
  登録は親管理者のみ。画面にも警告を出す。

  ■ 触らないもの
  affiliate_order_lines / agency_reward_items / referral_reward_items /
  creators には一切書き込まない。この表を足すだけ。
*/

export type CreatorAliasActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

const ALIAS_COLUMNS =
  "alias_tiktok_id, canonical_tiktok_id, note, created_by_email, created_at";

const MISSING_TABLE_CODES = new Set(["42P01", "PGRST205", "PGRST106"]);

const MIGRATION_HINT =
  "別名テーブルがありません。supabase/migrations/20260926100000_creator_tiktok_aliases.sql を適用してください。";

function readText(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function revalidateAliasViews() {
  revalidatePath("/admin/creator-aliases");
  revalidatePath("/admin/affiliate-orders-import");
}

export type CreatorAliasListResult =
  | { ok: true; aliases: CreatorAliasRecord[]; migrationMissing: boolean }
  | { ok: false; error: string };

export async function fetchCreatorAliasesForAdmin(): Promise<CreatorAliasListResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const { data, error } = await auth.supabase
    .from("creator_tiktok_aliases")
    .select(ALIAS_COLUMNS)
    .order("alias_tiktok_id");

  if (error) {
    if (MISSING_TABLE_CODES.has(error.code ?? "")) {
      return { ok: true, aliases: [], migrationMissing: true };
    }
    return { ok: false, error: mapSupabaseErrorToJa(error.message) };
  }

  return {
    ok: true,
    aliases: (data ?? []).map((row) =>
      creatorAliasFromRow(row as Record<string, unknown>),
    ),
    migrationMissing: false,
  };
}

/**
 * 別名を登録する。
 *
 * 自己参照・重複・循環はサーバー側で必ず検証する。
 * 正規化（trim / 小文字 / 先頭 @ 除去）は取込側と同じ normalizeTiktokId を使う。
 */
export async function createCreatorAliasAction(
  _prev: CreatorAliasActionResult | null,
  formData: FormData,
): Promise<CreatorAliasActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const aliasInput = readText(formData, "alias_tiktok_id");
  const canonicalInput = readText(formData, "canonical_tiktok_id");
  const note = readText(formData, "note") || null;

  // 既存の別名をすべて読んでから検証する（循環・重複の判定に必要）
  const { data: existing, error: existingError } = await auth.supabase
    .from("creator_tiktok_aliases")
    .select(ALIAS_COLUMNS);

  if (existingError) {
    if (MISSING_TABLE_CODES.has(existingError.code ?? "")) {
      return { ok: false, error: MIGRATION_HINT };
    }
    return { ok: false, error: mapSupabaseErrorToJa(existingError.message) };
  }

  const validation = validateCreatorAliasInput(
    { aliasTiktokId: aliasInput, canonicalTiktokId: canonicalInput },
    (existing ?? []).map((row) =>
      creatorAliasFromRow(row as Record<string, unknown>),
    ),
  );

  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }

  const { error } = await auth.supabase.from("creator_tiktok_aliases").insert({
    alias_tiktok_id: validation.aliasTiktokId,
    canonical_tiktok_id: validation.canonicalTiktokId,
    note,
    created_by: auth.user?.id ?? null,
    created_by_email: auth.user?.email ?? null,
  });

  if (error) {
    if (MISSING_TABLE_CODES.has(error.code ?? "")) {
      return { ok: false, error: MIGRATION_HINT };
    }
    return { ok: false, error: mapSupabaseErrorToJa(error.message) };
  }

  revalidateAliasViews();

  return {
    ok: true,
    message: `「${validation.aliasTiktokId}」を「${validation.canonicalTiktokId}」の旧名として登録しました。次回以降のExcel取込から適用されます。`,
  };
}

/**
 * 別名を削除する。
 *
 * 削除すると、以後の取込でその旧名が別クリエイター扱いになり、
 * 同じ注文明細が別々に登録されうる。画面側でも警告を出す。
 * 既に取り込み済みの行は変更しない（この操作では注文データに触らない）。
 */
export async function deleteCreatorAliasAction(
  _prev: CreatorAliasActionResult | null,
  formData: FormData,
): Promise<CreatorAliasActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const aliasTiktokId = readText(formData, "alias_tiktok_id");
  if (!aliasTiktokId) {
    return { ok: false, error: "削除する旧ユーザー名を指定してください" };
  }

  const { data, error } = await auth.supabase
    .from("creator_tiktok_aliases")
    .delete()
    .eq("alias_tiktok_id", aliasTiktokId)
    .select("alias_tiktok_id")
    .maybeSingle();

  if (error) {
    if (MISSING_TABLE_CODES.has(error.code ?? "")) {
      return { ok: false, error: MIGRATION_HINT };
    }
    return { ok: false, error: mapSupabaseErrorToJa(error.message) };
  }

  if (!data?.alias_tiktok_id) {
    return { ok: false, error: "対象の別名が見つかりません" };
  }

  revalidateAliasViews();

  return {
    ok: true,
    message: `「${aliasTiktokId}」の別名を削除しました。既に取り込み済みの注文明細は変更していません。`,
  };
}
