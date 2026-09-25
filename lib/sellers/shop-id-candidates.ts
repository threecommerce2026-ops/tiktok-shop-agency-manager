import { normalizeShopName } from "@/lib/shop-performance/normalize";

/*
  TikTok Shop ID の候補生成。

  ■ 設計方針
  候補の「供給元」と「判定ロジック」を分離する。
  供給元は ShopIdCandidateSource[] という形に揃えて渡すだけでよい。

    供給元: shop_performance_imports → lib/db/shop-id-candidate-queries.ts

  この関数は供給元を知らない。供給元が増減しても UI と判定は変更不要。

  ■ 外部APIは使わない
  Shop ID 候補の生成に TikTok API / OAuth は使用しない方針。
  実績データに現れないショップは候補を作らず、管理画面の手動設定で登録する。

  ■ 禁止事項
  affiliate_order_lines.shop_code は sellers.shop_id とは別識別子（英数字 vs 19桁数値）。
  shop_code を shop_id として扱ってはいけないので、供給元には含めない。
*/

/** 候補の供給元1件（どこから来たかを問わない共通形） */
export type ShopIdCandidateSource = {
  /** TikTok Shop ID（19桁数値） */
  shopId: string;
  /** 供給元でのショップ名 */
  shopName: string;
  /** どこから取得したか（画面に一致根拠として出す） */
  sourceLabel: string;
  /** 参考情報（GMV など） */
  note?: string | null;
};

export type ShopIdLinkSeller = {
  id: string;
  seller_name: string;
  shop_name: string;
  shop_id: string | null;
};

/** shop_id が TikTok Shop ID の形式か（19桁前後の数値のみ） */
export function isTikTokShopIdFormat(value: unknown): boolean {
  return /^[0-9]{10,25}$/.test(String(value ?? "").trim());
}

export type ShopIdLinkState =
  /** sellers.shop_id が設定済み */
  | "linked"
  /** 供給元と名前が完全一致し、候補が1件だけ */
  | "confident"
  /** 候補はあるが自動確定できない（名前が近いだけ / 候補が複数 / 衝突） */
  | "review"
  /** 対応する候補が無い */
  | "none";

export const SHOP_ID_LINK_STATE_LABEL: Record<ShopIdLinkState, string> = {
  linked: "紐付け済み",
  confident: "確定候補",
  review: "要確認",
  none: "候補なし",
};

export type ShopIdCandidate = ShopIdCandidateSource & {
  /** 一致根拠 */
  matchReason: "exact_name" | "alias" | "similar_name";
  /** 同じ shop_id が既に他の seller に設定されている場合その seller 名 */
  conflictWithSellerName?: string | null;
};

export const SHOP_ID_MATCH_REASON_LABEL: Record<
  ShopIdCandidate["matchReason"],
  string
> = {
  exact_name: "ショップ名が一致",
  alias: "別名が一致",
  similar_name: "ショップ名が近い（要確認）",
};

export type ShopIdLinkRow = {
  sellerId: string;
  sellerName: string;
  /** sellers.shop_name */
  shopName: string;
  /** 現在の sellers.shop_id */
  currentShopId: string | null;
  state: ShopIdLinkState;
  candidates: ShopIdCandidate[];
  /** state が confident のときの確定候補 */
  suggestedShopId: string | null;
  /** 自動確定できない理由 */
  reviewReason: string | null;
};

/** 「名前が近い」の判定。完全一致は別途扱うのでここでは扱わない */
function isSimilarShopName(a: string, b: string): boolean {
  if (!a || !b || a === b) return false;
  // 片方がもう片方を含む（「ビジュエルパフェ」⊂「ビジュエルパフェ｜誕生日…」）
  if (a.includes(b) || b.includes(a)) return true;
  // 空白の有無だけの違い（「味噌煮込みうどん まことや天白」↔「味噌煮込みうどんまことや天白」）
  const squeeze = (v: string) => v.replace(/\s+/g, "");
  return squeeze(a) === squeeze(b);
}

export function buildShopIdLinkRows(params: {
  sellers: ShopIdLinkSeller[];
  sources: ShopIdCandidateSource[];
  /** seller_shop_aliases（別名 → seller_id） */
  aliases?: Array<{ seller_id: string; alias_normalized: string }>;
}): ShopIdLinkRow[] {
  const { sellers, sources } = params;

  // shop_id が既に使われている seller（UNIQUE制約と同じ観点）
  const sellerByShopId = new Map<string, ShopIdLinkSeller>();
  for (const s of sellers) {
    const id = String(s.shop_id ?? "").trim();
    if (id) sellerByShopId.set(id, s);
  }

  // 供給元を正規化ショップ名で索引化（shop_id 形式でないものは捨てる）
  const byName = new Map<string, ShopIdCandidateSource[]>();
  const validSources: ShopIdCandidateSource[] = [];
  for (const src of sources) {
    if (!isTikTokShopIdFormat(src.shopId)) continue;
    validSources.push(src);
    const key = normalizeShopName(src.shopName);
    if (!key) continue;
    byName.set(key, [...(byName.get(key) ?? []), src]);
  }

  // 別名 → seller の逆引き
  const aliasKeysBySeller = new Map<string, string[]>();
  for (const a of params.aliases ?? []) {
    aliasKeysBySeller.set(a.seller_id, [
      ...(aliasKeysBySeller.get(a.seller_id) ?? []),
      a.alias_normalized,
    ]);
  }

  const rows: ShopIdLinkRow[] = [];

  for (const seller of sellers) {
    const currentShopId = String(seller.shop_id ?? "").trim() || null;
    const key = normalizeShopName(seller.shop_name);

    /* 候補を集める。同じ shop_id は1回だけ、根拠は強い順に上書きしない */
    const found = new Map<string, ShopIdCandidate>();

    const add = (src: ShopIdCandidateSource, reason: ShopIdCandidate["matchReason"]) => {
      if (found.has(src.shopId)) return;
      const owner = sellerByShopId.get(src.shopId);
      found.set(src.shopId, {
        ...src,
        matchReason: reason,
        conflictWithSellerName:
          owner && owner.id !== seller.id ? owner.seller_name : null,
      });
    };

    for (const src of byName.get(key) ?? []) add(src, "exact_name");

    for (const aliasKey of aliasKeysBySeller.get(seller.id) ?? []) {
      for (const src of byName.get(aliasKey) ?? []) add(src, "alias");
    }

    for (const src of validSources) {
      if (isSimilarShopName(key, normalizeShopName(src.shopName))) {
        add(src, "similar_name");
      }
    }

    const candidates = [...found.values()];

    let state: ShopIdLinkState;
    let suggestedShopId: string | null = null;
    let reviewReason: string | null = null;

    if (currentShopId) {
      state = "linked";
    } else if (candidates.length === 0) {
      state = "none";
    } else {
      const exact = candidates.filter((c) => c.matchReason !== "similar_name");

      if (exact.length === 1 && !exact[0].conflictWithSellerName) {
        state = "confident";
        suggestedShopId = exact[0].shopId;
      } else if (exact.length > 1) {
        state = "review";
        reviewReason = `ショップ名が一致する候補が ${exact.length} 件あります`;
      } else if (exact.length === 1 && exact[0].conflictWithSellerName) {
        state = "review";
        reviewReason = `候補の Shop ID は既に「${exact[0].conflictWithSellerName}」が使用しています`;
      } else {
        state = "review";
        reviewReason = "ショップ名が近いだけで完全一致していません";
      }
    }

    rows.push({
      sellerId: seller.id,
      sellerName: seller.seller_name,
      shopName: seller.shop_name,
      currentShopId,
      state,
      candidates,
      suggestedShopId,
      reviewReason,
    });
  }

  return rows;
}

/* ---------------------------------------------------------------------------
   保存前の安全チェック
   UNIQUE制約に任せきりにせず、アプリ側でも先に検証する。
--------------------------------------------------------------------------- */

export type ShopIdAssignment = { sellerId: string; shopId: string };

export type ShopIdAssignmentCheck = {
  accepted: ShopIdAssignment[];
  rejected: Array<ShopIdAssignment & { reason: string }>;
};

export function validateShopIdAssignments(
  sellers: ShopIdLinkSeller[],
  assignments: ShopIdAssignment[],
): ShopIdAssignmentCheck {
  const sellerById = new Map(sellers.map((s) => [s.id, s]));

  // 既に使われている shop_id
  const ownerByShopId = new Map<string, ShopIdLinkSeller>();
  for (const s of sellers) {
    const id = String(s.shop_id ?? "").trim();
    if (id) ownerByShopId.set(id, s);
  }

  // 今回の指定内での重複
  const countInBatch = new Map<string, number>();
  for (const a of assignments) {
    const id = String(a.shopId ?? "").trim();
    countInBatch.set(id, (countInBatch.get(id) ?? 0) + 1);
  }

  const accepted: ShopIdAssignment[] = [];
  const rejected: ShopIdAssignmentCheck["rejected"] = [];
  const seenSeller = new Set<string>();

  for (const a of assignments) {
    const shopId = String(a.shopId ?? "").trim();
    const seller = sellerById.get(a.sellerId);

    if (!seller) {
      rejected.push({ ...a, reason: "セラーが見つかりません" });
      continue;
    }
    if (!isTikTokShopIdFormat(shopId)) {
      // shop_code（英数字）を shop_id として保存させない
      rejected.push({
        ...a,
        reason: "Shop ID の形式ではありません（数値のみ。注文CSVのShop Codeは使用できません）",
      });
      continue;
    }
    if (seenSeller.has(a.sellerId)) {
      rejected.push({ ...a, reason: "同じセラーが重複して指定されています" });
      continue;
    }
    if (String(seller.shop_id ?? "").trim()) {
      rejected.push({
        ...a,
        reason: `既に Shop ID (${seller.shop_id}) が設定されています`,
      });
      continue;
    }
    if ((countInBatch.get(shopId) ?? 0) > 1) {
      rejected.push({ ...a, reason: "同じ Shop ID が複数セラーに指定されています" });
      continue;
    }
    const owner = ownerByShopId.get(shopId);
    if (owner && owner.id !== a.sellerId) {
      rejected.push({
        ...a,
        reason: `この Shop ID は既に「${owner.seller_name}」が使用しています`,
      });
      continue;
    }

    seenSeller.add(a.sellerId);
    accepted.push({ sellerId: a.sellerId, shopId });
  }

  return { accepted, rejected };
}

export function summarizeShopIdLinkRows(rows: ShopIdLinkRow[]): Record<
  ShopIdLinkState,
  number
> {
  const out: Record<ShopIdLinkState, number> = {
    linked: 0,
    confident: 0,
    review: 0,
    none: 0,
  };
  for (const r of rows) out[r.state] += 1;
  return out;
}
