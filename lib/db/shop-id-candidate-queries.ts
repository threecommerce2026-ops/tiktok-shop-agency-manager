import type { SupabaseClient } from "@supabase/supabase-js";

import { fetchAllFrom } from "@/lib/db/paged-select";
import {
  buildShopIdLinkRows,
  isTikTokShopIdFormat,
  summarizeShopIdLinkRows,
  type ShopIdCandidateSource,
  type ShopIdLinkRow,
  type ShopIdLinkState,
} from "@/lib/sellers/shop-id-candidates";

/*
  Shop ID 候補の供給元アダプタ。

  候補生成ロジック（lib/sellers/shop-id-candidates.ts）は供給元を知らない。
  ここが「DBの実績テーブル → ShopIdCandidateSource[]」の変換だけを担当する。

  Shop ID 候補の生成に TikTok API / OAuth は使用しない（方針決定済み）。
  供給元を足したい場合も、同じ ShopIdCandidateSource[] を返す関数を
  fetchShopIdCandidateSources() で結合するだけでよい。UI と判定は変更不要。

  ■ affiliate_order_lines は供給元にしない
  shop_code は英数字（例 JPJPLCJLLL4C）で、sellers.shop_id（19桁数値）とは
  別の識別子。実データでも数値形式は0件。ここでは一切参照しない。
*/

export const SHOP_PERFORMANCE_SOURCE_LABEL = "ショップ実績";

/** shop_performance_imports から Shop ID 候補を作る */
export async function fetchShopIdCandidatesFromPerformance(
  supabase: SupabaseClient,
): Promise<{ sources: ShopIdCandidateSource[]; error: string | null }> {
  const result = await fetchAllFrom<{
    shop_name: string | null;
    shop_id: string | null;
    target_month: string | null;
    gmv_amount: number | string | null;
  }>(
    supabase,
    "shop_performance_imports",
    "id, shop_name, shop_id, target_month, gmv_amount",
  );

  if (result.error) return { sources: [], error: result.error };

  /* 同じ shop_id が複数期間ぶん並ぶので、最新の対象月の行にまとめる */
  const byShopId = new Map<
    string,
    { shopName: string; latestMonth: string; gmv: number }
  >();

  for (const row of result.data) {
    const shopId = String(row.shop_id ?? "").trim();
    if (!isTikTokShopIdFormat(shopId)) continue;

    const month = String(row.target_month ?? "");
    const gmv = Number(row.gmv_amount ?? 0);
    const current = byShopId.get(shopId);

    if (!current || month > current.latestMonth) {
      byShopId.set(shopId, {
        shopName: String(row.shop_name ?? ""),
        latestMonth: month,
        gmv: Number.isFinite(gmv) ? gmv : 0,
      });
    }
  }

  const sources: ShopIdCandidateSource[] = [...byShopId].map(
    ([shopId, info]) => ({
      shopId,
      shopName: info.shopName,
      sourceLabel: SHOP_PERFORMANCE_SOURCE_LABEL,
      note: info.latestMonth ? `${info.latestMonth} 実績あり` : null,
    }),
  );

  sources.sort((a, b) => a.shopName.localeCompare(b.shopName, "ja"));

  return { sources, error: null };
}

/**
 * 画面が使う候補一覧。
 * 供給元が増えたらここで結合する（外部APIは使わない）。
 */
export async function fetchShopIdCandidateSources(
  supabase: SupabaseClient,
): Promise<{ sources: ShopIdCandidateSource[]; error: string | null }> {
  return fetchShopIdCandidatesFromPerformance(supabase);
}

/* ---------------------------------------------------------------------------
   画面・取込完了通知が使う集計
--------------------------------------------------------------------------- */

export type ShopIdLinkSummary = {
  rows: ShopIdLinkRow[];
  counts: Record<ShopIdLinkState, number>;
  sources: ShopIdCandidateSource[];
  error: string | null;
};

const EMPTY_COUNTS: Record<ShopIdLinkState, number> = {
  linked: 0,
  confident: 0,
  review: 0,
  none: 0,
};

/**
 * 現在のDB状態から Shop ID 紐付け状況を計算する。
 * 判定は buildShopIdLinkRows() ただ1つ。別実装は作らない。
 */
export async function fetchShopIdLinkSummary(
  supabase: SupabaseClient,
): Promise<ShopIdLinkSummary> {
  const [sellersResult, aliasResult, candidateResult] = await Promise.all([
    supabase.from("sellers").select("id, seller_name, shop_name, shop_id"),
    supabase.from("seller_shop_aliases").select("seller_id, alias_normalized"),
    fetchShopIdCandidateSources(supabase),
  ]);

  const error =
    sellersResult.error?.message ?? candidateResult.error ?? null;
  if (error) {
    return { rows: [], counts: { ...EMPTY_COUNTS }, sources: [], error };
  }

  const rows = buildShopIdLinkRows({
    sellers: (sellersResult.data ?? []).map((r) => ({
      id: r.id as string,
      seller_name: String(r.seller_name ?? ""),
      shop_name: String(r.shop_name ?? ""),
      shop_id: (r.shop_id as string | null) ?? null,
    })),
    sources: candidateResult.sources,
    aliases: (aliasResult.data ?? []).map((a) => ({
      seller_id: String(a.seller_id),
      alias_normalized: String(a.alias_normalized),
    })),
  });

  return {
    rows,
    counts: summarizeShopIdLinkRows(rows),
    sources: candidateResult.sources,
    error: null,
  };
}

/** 取込完了時に見せる差分（migration不要。取込の前後で同じ集計を取るだけ） */
export type ShopIdCandidateDelta = {
  confident: number;
  review: number;
  none: number;
  linked: number;
  /** 取込によって新しく確定候補になったセラー */
  newlyConfident: Array<{ sellerName: string; shopName: string; shopId: string }>;
  /** 取込によって新しく要確認になったセラー */
  newlyReview: Array<{ sellerName: string; shopName: string }>;
  /** 候補の供給元になった Shop ID の総数 */
  sourceCount: number;
};

export function diffShopIdLinkSummary(
  before: ShopIdLinkSummary,
  after: ShopIdLinkSummary,
): ShopIdCandidateDelta {
  const beforeState = new Map(before.rows.map((r) => [r.sellerId, r.state]));

  const newlyConfident = after.rows
    .filter(
      (r) => r.state === "confident" && beforeState.get(r.sellerId) !== "confident",
    )
    .map((r) => ({
      sellerName: r.sellerName,
      shopName: r.shopName,
      shopId: r.suggestedShopId ?? "",
    }));

  const newlyReview = after.rows
    .filter((r) => r.state === "review" && beforeState.get(r.sellerId) !== "review")
    .map((r) => ({ sellerName: r.sellerName, shopName: r.shopName }));

  return {
    confident: after.counts.confident,
    review: after.counts.review,
    none: after.counts.none,
    linked: after.counts.linked,
    newlyConfident,
    newlyReview,
    sourceCount: after.sources.length,
  };
}
