import { NextResponse } from "next/server";

import {
  diffShopIdLinkSummary,
  fetchShopIdLinkSummary,
} from "@/lib/db/shop-id-candidate-queries";
import { requireAdminApiAccess } from "@/lib/tiktok/require-admin-api";
import {
  identityKeyForName,
  identityKeyForSeller,
  normalizeShopName,
} from "@/lib/shop-performance/normalize";
import {
  defaultPeriodEnd,
  defaultPeriodStart,
  isValidTargetMonth,
  parsePartnerCenterResponse,
  partnerResponseError,
  validatePartnerCenterShops,
} from "@/lib/shop-performance/partner-center-payload";
import { createServiceRoleClient } from "@/lib/supabase/admin";

/*
  Partner Center JSON の取込。

  ■ この endpoint の役割
  「Shop ID 付きショップ情報の供給元」として shop_performance_imports に保存する。
  ShopList CSV には Shop ID 列が無いので、Shop ID はここからしか入らない。

  ■ sellers.shop_id は絶対に更新しない
  Shop ID の確定は /admin/sellers の「TikTok Shop紐付け」へ一本化する。
    候補確認 → プレビュー → 明示的に適用 → サーバー側で再検証
  ここで自動補完すると、管理者の確認を経ない Shop ID が入ってしまう。

  ■ 触らないテーブル
  sellers（参照のみ） / seller_shop_aliases（参照のみ） / seller_invoices /
  affiliate_order_lines
*/

type PartnerCenterSyncPayload = {
  target_month?: unknown;
  period_start?: unknown;
  period_end?: unknown;
  shops?: unknown;
};

function isValidDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export async function POST(request: Request) {
  /*
    認証。

    既存の管理者判定（requireAdminApiAccess → isAdminRole）をそのまま使う。
    独自の権限判定は作らない。代理店ユーザーは 403 になる。

    共有シークレット（x-partner-sync-secret / PARTNER_CENTER_SYNC_SECRET）は
    呼び出し元が1つも存在しないため廃止した。
    環境変数自体は用途が確定するまで残してよい（このコードは参照しない）。
  */
  const auth = await requireAdminApiAccess();
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: auth.status },
    );
  }

  let payload: PartnerCenterSyncPayload;
  try {
    payload = (await request.json()) as PartnerCenterSyncPayload;
  } catch {
    return NextResponse.json(
      { ok: false, error: "JSONの形式が正しくありません" },
      { status: 400 },
    );
  }

  /*
    Partner Center の実レスポンス（{ code, data: { time_descriptor, list_control, stats } }）
    と、旧来の簡易形（{ target_month, shops: [...] }）の両方を受け付ける。
    解釈は parsePartnerCenterResponse() に集約する。
  */
  const envelope = parsePartnerCenterResponse(payload);
  if (!envelope) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "ショップデータを読み取れません（data.stats または shops が見つかりません）",
      },
      { status: 400 },
    );
  }

  const responseError = partnerResponseError(envelope);
  if (responseError) {
    return NextResponse.json({ ok: false, error: responseError }, { status: 400 });
  }

  /*
    件数の整合性。
    has_more = true / stats が total に足りない場合は、
    Shop ID 候補の供給元として不完全なので取り込まない。
  */
  if (!envelope.completeness.isComplete) {
    return NextResponse.json(
      {
        ok: false,
        error: `Partner Center の全ショップが含まれていない可能性があります。${envelope.completeness.reason}`,
        completeness: envelope.completeness,
      },
      { status: 400 },
    );
  }

  const shops = envelope.shops;

  // 対象月は JSON 側を正とし、無い形式のときだけリクエスト値を使う
  const targetMonth =
    envelope.targetMonth ?? String(payload.target_month ?? "").trim();
  if (!isValidTargetMonth(targetMonth)) {
    return NextResponse.json(
      { ok: false, error: "対象月を特定できません（YYYY-MM）" },
      { status: 400 },
    );
  }

  const periodStart =
    envelope.periodStart ||
    String(payload.period_start ?? "").trim() ||
    defaultPeriodStart(targetMonth);
  const periodEnd =
    envelope.periodEnd ||
    String(payload.period_end ?? "").trim() ||
    defaultPeriodEnd(targetMonth);

  if (!isValidDate(periodStart) || !isValidDate(periodEnd) || periodEnd < periodStart) {
    return NextResponse.json(
      { ok: false, error: "対象期間が正しくありません" },
      { status: 400 },
    );
  }

  /*
    Shop ID の形式・重複を検証する。
    1件でも不正があれば取込全体を止める（部分的に保存して原因を分かりにくくしない）。
    形式判定は isTikTokShopIdFormat() のみ。
  */
  const validation = validatePartnerCenterShops(shops);

  if (validation.issues.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        error: validation.issues[0].message,
        issues: validation.issues,
        counts: validation.counts,
      },
      { status: 400 },
    );
  }

  if (validation.rows.length === 0) {
    return NextResponse.json(
      { ok: false, error: "取込可能なショップがありません" },
      { status: 400 },
    );
  }

  const supabase = createServiceRoleClient();

  // sellers / alias は照合のために読むだけ。どちらも更新しない
  const [
    { data: sellers, error: sellersError },
    { data: aliases, error: aliasesError },
  ] = await Promise.all([
    supabase.from("sellers").select("id, seller_name, shop_name, shop_id"),
    supabase
      .from("seller_shop_aliases")
      .select("seller_id, alias_shop_name, alias_normalized"),
  ]);

  if (sellersError) {
    return NextResponse.json(
      { ok: false, error: sellersError.message },
      { status: 500 },
    );
  }
  if (aliasesError) {
    return NextResponse.json(
      { ok: false, error: aliasesError.message },
      { status: 500 },
    );
  }

  const sellerByShopId = new Map<string, string>();
  const sellerByShopName = new Map<string, string>();
  const aliasToSeller = new Map<string, string>();

  for (const seller of sellers ?? []) {
    const sellerId = String(seller.id);
    if (seller.shop_id) sellerByShopId.set(String(seller.shop_id), sellerId);

    const normalizedShopName = normalizeShopName(String(seller.shop_name ?? ""));
    if (normalizedShopName) sellerByShopName.set(normalizedShopName, sellerId);
  }

  for (const alias of aliases ?? []) {
    const normalized = String(alias.alias_normalized ?? "");
    if (normalized) aliasToSeller.set(normalized, String(alias.seller_id));
  }

  let matchedByShopId = 0;
  let matchedByAlias = 0;
  let matchedByName = 0;
  let unlinked = 0;

  const now = new Date().toISOString();

  const rows = validation.rows.map((row) => {
    /*
      seller_id の解決は「どの実績行がどのセラーのものか」を示すだけ。
      ここで解決できても sellers.shop_id は書き換えない。
    */
    let sellerId: string | null = null;
    let matchType: "shop_id" | "alias" | "shop_name" | "unlinked" = "unlinked";

    const shopIdSeller = sellerByShopId.get(row.shopId) ?? null;
    if (shopIdSeller) {
      sellerId = shopIdSeller;
      matchType = "shop_id";
      matchedByShopId += 1;
    } else {
      const aliasSeller = aliasToSeller.get(row.shopNameNormalized) ?? null;
      if (aliasSeller) {
        sellerId = aliasSeller;
        matchType = "alias";
        matchedByAlias += 1;
      } else {
        const nameSeller = sellerByShopName.get(row.shopNameNormalized) ?? null;
        if (nameSeller) {
          sellerId = nameSeller;
          matchType = "shop_name";
          matchedByName += 1;
        } else {
          unlinked += 1;
        }
      }
    }

    return {
      identity_key: sellerId
        ? identityKeyForSeller(sellerId)
        : identityKeyForName(row.shopNameNormalized),

      shop_name: row.shopName,
      shop_name_normalized: row.shopNameNormalized,
      shop_id: row.shopId,
      seller_id: sellerId,

      period_start: periodStart,
      period_end: periodEnd,
      target_month: targetMonth,

      gmv_amount: row.revenue,
      currency: "JPY",
      shop_ranking: row.shopRanking,
      revenue_percentage: row.revenuePercentage,

      raw_row_json: {
        partner_center: true,
        match_type: matchType,

        shop_id: row.shopId,
        shop_name: row.shopName,

        revenue: row.revenue,
        orders: row.raw.orders ?? null,
        buyers: row.raw.buyers ?? null,
        product_viewers: row.raw.product_viewers ?? null,
        product_clicks: row.raw.product_clicks ?? null,
        shop_ranking: row.shopRanking,
        revenue_percentage: row.revenuePercentage,
        cmp_revenue: row.raw.cmp_revenue ?? null,
      },

      source: "partner_api",
      import_batch_id: null,
      imported_by: auth.user.id,
      updated_at: now,
    };
  });

  /*
    取込前の Shop ID 候補状況を控えておく。
    取込後に同じ集計を取って差分を出す（migration なしで新規候補を判定できる）。
  */
  const candidatesBefore = await fetchShopIdLinkSummary(supabase);

  const { error: upsertError } = await supabase
    .from("shop_performance_imports")
    .upsert(rows, { onConflict: "identity_key,period_start,period_end" });

  if (upsertError) {
    return NextResponse.json(
      { ok: false, error: upsertError.message },
      { status: 500 },
    );
  }

  /*
    取込後に候補を再計算する。
    判定は buildShopIdLinkRows() ただ1つ（別実装は作らない）。
    sellers.shop_id はここでも一切更新しない。表示するだけ。
  */
  const candidatesAfter = await fetchShopIdLinkSummary(supabase);
  const shopIdCandidates =
    candidatesBefore.error || candidatesAfter.error
      ? null
      : diffShopIdLinkSummary(candidatesBefore, candidatesAfter);

  return NextResponse.json({
    ok: true,

    targetMonth,
    periodStart,
    periodEnd,

    receivedCount: shops.length,
    upsertedCount: rows.length,
    completeness: envelope.completeness,

    matchedByShopId,
    matchedByAlias,
    matchedByName,
    unlinked,

    shopIdCandidates,

    preview: rows.slice(0, 3).map((row) => ({
      shop_id: row.shop_id,
      shop_name: row.shop_name,
      seller_id: row.seller_id,
      gmv_amount: row.gmv_amount,
      match_type: row.raw_row_json.match_type,
    })),
  });
}
