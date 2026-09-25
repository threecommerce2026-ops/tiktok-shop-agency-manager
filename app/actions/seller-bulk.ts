"use server";

import { requireAdminAction } from "@/lib/db/admin-access";
import { mapSupabaseErrorToJa } from "@/lib/supabase/error-ja";
import {
  TSP_RATE_COLUMNS,
  applyShopIdLinkBulk,
  applyTspRateBulk,
} from "@/lib/sellers/apply-seller-bulk";
import {
  parseTspRatePct,
  planTspRateBulkUpdate,
  type TspRateBulkPlan,
  type TspRateSeller,
} from "@/lib/sellers/tsp-rate-bulk";
import type { ShopIdAssignment } from "@/lib/sellers/shop-id-candidates";
import { revalidatePath } from "next/cache";

/*
  一括設定アクション。

  画面で見せたプレビューをそのまま信用せず、適用時に必ずDBを読み直して
  同じロジックで再判定する。画面を開いてから適用するまでの間に
  データが変わっていても、対象外セラーを書き換えないようにするため。

  どちらのアクションも sellers テーブル以外を更新しない。
  seller_invoices は触らないので、発行済み請求書の料率・金額は変わらない。
*/

const MAX_BULK = 500;

export type SellerBulkResult =
  | { ok: true; message: string; applied: number; skipped: number; details: string[] }
  | { ok: false; error: string };

function parseIdList(raw: FormDataEntryValue | null): string[] {
  const text = String(raw ?? "").trim();
  if (!text) return [];
  return [...new Set(text.split(",").map((s) => s.trim()).filter(Boolean))];
}

/* ---------------------------------------------------------------------------
   TSP料率の一括設定
--------------------------------------------------------------------------- */

export async function applyTspRateBulkAction(
  _prev: SellerBulkResult | null,
  formData: FormData,
): Promise<SellerBulkResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const selectedIds = parseIdList(formData.get("seller_ids"));
  if (selectedIds.length === 0) {
    return { ok: false, error: "対象セラーを選択してください" };
  }
  if (selectedIds.length > MAX_BULK) {
    return { ok: false, error: `一度に更新できるのは最大 ${MAX_BULK} 件です` };
  }

  const ratePct = parseTspRatePct(formData.get("rate_pct"));
  if (ratePct == null) {
    return { ok: false, error: "契約料率は 0〜100 の数値で入力してください" };
  }

  const onlyUnset = String(formData.get("only_unset") ?? "") === "1";

  // 本体は lib と共有する（画面からの実行と事前検証を同一コードにするため）
  const outcome = await applyTspRateBulk(auth.supabase, {
    selectedIds,
    ratePct,
    onlyUnset,
  });
  if ("error" in outcome) return { ok: false, error: outcome.error };

  if (outcome.plan.targets.length === 0) {
    return {
      ok: false,
      error:
        outcome.skipped > 0
          ? `更新対象がありません（${outcome.skipped}件はTSP請求対象外・停止・変更なしのため除外）`
          : "更新対象がありません",
    };
  }

  revalidatePath("/admin/sellers");
  revalidatePath("/admin/seller-billing");

  return {
    ok: true,
    message: `${outcome.applied}件のセラーに契約料率 ${ratePct}% を設定しました`,
    applied: outcome.applied,
    skipped: outcome.skipped,
    details: outcome.details,
  };
}

/** 画面プレビュー用（DBは変更しない） */
export async function previewTspRateBulkAction(input: {
  sellerIds: string[];
  ratePct: string;
  onlyUnset?: boolean;
}): Promise<{ ok: true; plan: TspRateBulkPlan } | { ok: false; error: string }> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const selectedIds = [...new Set(input.sellerIds.filter(Boolean))];
  if (selectedIds.length === 0) {
    return { ok: false, error: "対象セラーを選択してください" };
  }

  const ratePct = parseTspRatePct(input.ratePct);
  if (ratePct == null) {
    return { ok: false, error: "契約料率は 0〜100 の数値で入力してください" };
  }

  const { data, error } = await auth.supabase
    .from("sellers")
    .select(TSP_RATE_COLUMNS)
    .in("id", selectedIds);

  if (error) return { ok: false, error: mapSupabaseErrorToJa(error.message) };

  const sellers: TspRateSeller[] = (data ?? []).map((r) => ({
    id: r.id as string,
    seller_name: String(r.seller_name ?? ""),
    shop_name: String(r.shop_name ?? ""),
    tsp_rate: r.tsp_rate == null ? null : Number(r.tsp_rate),
    status: String(r.status ?? ""),
    is_tsp_billing_eligible: r.is_tsp_billing_eligible !== false,
    form_note: (r.form_note as string | null) ?? null,
  }));

  return {
    ok: true,
    plan: planTspRateBulkUpdate({
      sellers,
      selectedIds,
      ratePct,
      onlyUnset: input.onlyUnset,
    }),
  };
}

/* ---------------------------------------------------------------------------
   Shop ID の一括紐付け
--------------------------------------------------------------------------- */

/** "sellerId:shopId,sellerId:shopId" 形式 */
function parseAssignments(raw: FormDataEntryValue | null): ShopIdAssignment[] {
  const text = String(raw ?? "").trim();
  if (!text) return [];
  const out: ShopIdAssignment[] = [];
  for (const pair of text.split(",")) {
    const [sellerId, shopId] = pair.split(":").map((s) => s?.trim() ?? "");
    if (sellerId && shopId) out.push({ sellerId, shopId });
  }
  return out;
}

export async function applyShopIdLinkBulkAction(
  _prev: SellerBulkResult | null,
  formData: FormData,
): Promise<SellerBulkResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const assignments = parseAssignments(formData.get("assignments"));
  if (assignments.length === 0) {
    return { ok: false, error: "紐付ける候補を選択してください" };
  }
  if (assignments.length > MAX_BULK) {
    return { ok: false, error: `一度に紐付けできるのは最大 ${MAX_BULK} 件です` };
  }

  const outcome = await applyShopIdLinkBulk(auth.supabase, assignments);
  if ("error" in outcome) return { ok: false, error: outcome.error };

  if (outcome.check.accepted.length === 0) {
    return {
      ok: false,
      error: `紐付けできる候補がありません（${outcome.skipped}件が衝突のため除外）`,
    };
  }

  revalidatePath("/admin/sellers");
  revalidatePath("/admin/shop-performance");

  return {
    ok: true,
    message: `${outcome.applied}件のセラーに Shop ID を紐付けました`,
    applied: outcome.applied,
    skipped: outcome.skipped,
    details: outcome.details,
  };
}

/* ---------------------------------------------------------------------------
   Shop ID の手動設定

   実績にまだ現れないショップ（売上が立っていないセラー）は候補を作れない。
   その場合だけ、管理者が Shop ID を直接入力して設定する。

   通常操作では既存 shop_id を上書きしない。
   付け替えが必要な場合はセラー編集画面（updateSellerAction）で行う。
--------------------------------------------------------------------------- */

export async function setSellerShopIdManuallyAction(
  _prev: SellerBulkResult | null,
  formData: FormData,
): Promise<SellerBulkResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const sellerId = String(formData.get("seller_id") ?? "").trim();
  const shopId = String(formData.get("shop_id") ?? "").trim();

  if (!sellerId) return { ok: false, error: "セラーを選択してください" };
  if (!shopId) return { ok: false, error: "Shop ID を入力してください" };

  // 形式・重複・既存値はサーバー側で必ず再検証する（画面の値を信用しない）
  const outcome = await applyShopIdLinkBulk(auth.supabase, [{ sellerId, shopId }]);
  if ("error" in outcome) return { ok: false, error: outcome.error };

  if (outcome.check.accepted.length === 0) {
    return {
      ok: false,
      error: outcome.details[0] ?? "この Shop ID は設定できません",
    };
  }
  if (outcome.applied === 0) {
    return { ok: false, error: outcome.details[0] ?? "設定に失敗しました" };
  }

  revalidatePath("/admin/sellers");
  revalidatePath("/admin/shop-performance");

  return {
    ok: true,
    message: `Shop ID (${shopId}) を設定しました`,
    applied: outcome.applied,
    skipped: 0,
    details: [],
  };
}
