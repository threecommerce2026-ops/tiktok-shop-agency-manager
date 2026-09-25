import type { SupabaseClient } from "@supabase/supabase-js";

import { mapSupabaseErrorToJa } from "@/lib/supabase/error-ja";
import {
  planTspRateBulkUpdate,
  type TspRateBulkPlan,
  type TspRateSeller,
} from "@/lib/sellers/tsp-rate-bulk";
import {
  validateShopIdAssignments,
  type ShopIdAssignment,
  type ShopIdAssignmentCheck,
  type ShopIdLinkSeller,
} from "@/lib/sellers/shop-id-candidates";

/*
  一括設定の本体。

  サーバーアクションと検証スクリプトの両方がこの関数を使うことで、
  「画面から実行した結果」と「事前に確認した結果」が必ず一致する。

  どちらも sellers テーブルの対象列だけを更新する。
  seller_invoices / seller_shop_aliases / affiliate_order_lines /
  shop_performance_imports には一切アクセスしない。
*/

export const TSP_RATE_COLUMNS =
  "id, seller_name, shop_name, tsp_rate, status, is_tsp_billing_eligible, form_note";

export const SHOP_ID_LINK_COLUMNS = "id, seller_name, shop_name, shop_id";

export type BulkApplyOutcome = {
  applied: number;
  failed: number;
  skipped: number;
  details: string[];
};

function toTspRateSeller(r: Record<string, unknown>): TspRateSeller {
  return {
    id: r.id as string,
    seller_name: String(r.seller_name ?? ""),
    shop_name: String(r.shop_name ?? ""),
    tsp_rate: r.tsp_rate == null ? null : Number(r.tsp_rate),
    status: String(r.status ?? ""),
    is_tsp_billing_eligible: r.is_tsp_billing_eligible !== false,
    form_note: (r.form_note as string | null) ?? null,
  };
}

function toShopIdLinkSeller(r: Record<string, unknown>): ShopIdLinkSeller {
  return {
    id: r.id as string,
    seller_name: String(r.seller_name ?? ""),
    shop_name: String(r.shop_name ?? ""),
    shop_id: (r.shop_id as string | null) ?? null,
  };
}

/* ---------------------------------------------------------------------------
   TSP料率の一括設定
--------------------------------------------------------------------------- */

export async function applyTspRateBulk(
  supabase: SupabaseClient,
  params: { selectedIds: string[]; ratePct: number; onlyUnset?: boolean },
): Promise<{ error: string } | (BulkApplyOutcome & { plan: TspRateBulkPlan })> {
  // 適用直前にDBを読み直して再判定する
  const { data, error } = await supabase
    .from("sellers")
    .select(TSP_RATE_COLUMNS)
    .in("id", params.selectedIds);

  if (error) return { error: mapSupabaseErrorToJa(error.message) };

  const sellers = (data ?? []).map((r) => toTspRateSeller(r as Record<string, unknown>));
  const plan = planTspRateBulkUpdate({
    sellers,
    selectedIds: params.selectedIds,
    ratePct: params.ratePct,
    onlyUnset: params.onlyUnset,
  });

  const details: string[] = [];
  let applied = 0;
  let failed = 0;

  for (const target of plan.targets) {
    // tsp_rate だけを更新する。他の列には触らない
    const { error: upErr } = await supabase
      .from("sellers")
      .update({ tsp_rate: params.ratePct })
      .eq("id", target.sellerId);

    if (upErr) {
      failed++;
      details.push(
        `${target.sellerName}: 更新に失敗（${mapSupabaseErrorToJa(upErr.message)}）`,
      );
      continue;
    }
    applied++;
  }

  for (const s of plan.skipped) {
    details.push(`${s.sellerName}: ${s.reason}のためスキップ`);
  }

  return { applied, failed, skipped: plan.skipped.length, details, plan };
}

/* ---------------------------------------------------------------------------
   Shop ID の一括紐付け
--------------------------------------------------------------------------- */

export async function applyShopIdLinkBulk(
  supabase: SupabaseClient,
  assignments: ShopIdAssignment[],
): Promise<{ error: string } | (BulkApplyOutcome & { check: ShopIdAssignmentCheck })> {
  /*
    衝突検証には全セラーが必要。
    選択分だけ読むと「別のセラーが既に同じ shop_id を持っている」を見落とす。
  */
  const { data, error } = await supabase.from("sellers").select(SHOP_ID_LINK_COLUMNS);
  if (error) return { error: mapSupabaseErrorToJa(error.message) };

  const sellers = (data ?? []).map((r) => toShopIdLinkSeller(r as Record<string, unknown>));
  const nameById = new Map(sellers.map((s) => [s.id, s.seller_name]));
  const check = validateShopIdAssignments(sellers, assignments);

  const details: string[] = [];
  for (const r of check.rejected) {
    details.push(`${nameById.get(r.sellerId) ?? r.sellerId}: ${r.reason}`);
  }

  let applied = 0;
  let failed = 0;

  for (const a of check.accepted) {
    /*
      shop_id だけを更新する。
      .is("shop_id", null) を付けて、事前検証をすり抜けた同時実行でも
      既存の shop_id を上書きしないようにする（UNIQUE制約にも依存する）。
    */
    const { error: upErr } = await supabase
      .from("sellers")
      .update({ shop_id: a.shopId })
      .eq("id", a.sellerId)
      .is("shop_id", null);

    if (upErr) {
      failed++;
      details.push(
        `${nameById.get(a.sellerId) ?? a.sellerId}: 紐付けに失敗（${mapSupabaseErrorToJa(upErr.message)}）`,
      );
      continue;
    }
    applied++;
  }

  return { applied, failed, skipped: check.rejected.length, details, check };
}
