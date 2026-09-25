/*
  TSP契約料率の一括設定ロジック。

  ■ 業務ルール
  基本料率は 10%。ただし契約条件によって異なるセラーがある。
  「基本10% + 例外セラーのみ個別変更」という運用。

  ■ 自動設定はしない
  新規セラー作成時に 10% を自動で入れてはいけない。
  契約前・辞退・TAP連携のみ のセラーが混ざるため、
  必ず管理者が対象を選択してから適用する。
*/

/** 基本料率。DBの既定値ではなく、画面の入力補助としてのみ使う */
export const DEFAULT_TSP_RATE_PCT = 10;

export type TspRateSeller = {
  id: string;
  seller_name: string;
  shop_name: string;
  tsp_rate: number | null;
  status: string;
  is_tsp_billing_eligible: boolean;
  form_note: string | null;
};

/** 一括設定の対象外にする理由。既存DBの値のみを根拠にする */
export type TspRateExclusionReason = "not_billing_eligible" | "stopped";

export const TSP_RATE_EXCLUSION_LABEL: Record<TspRateExclusionReason, string> = {
  // 辞退 / TAP連携のみ は取込時に is_tsp_billing_eligible = false になる
  not_billing_eligible: "TSP請求対象外",
  // sellers.status は 'active' | 'pending' | 'stopped' のみ（CHECK制約）
  stopped: "停止",
};

/**
 * 一括設定してよいセラーか。
 * 請求側（lib/db/seller-billing-queries.ts）と同じく
 * is_tsp_billing_eligible のみを請求対象の根拠にする。
 */
export function resolveTspRateExclusion(
  seller: TspRateSeller,
): TspRateExclusionReason | null {
  if (seller.is_tsp_billing_eligible === false) return "not_billing_eligible";
  if (seller.status === "stopped") return "stopped";
  return null;
}

export type TspRateCategory =
  /** 未設定で、一括設定してよい */
  | "unset_eligible"
  /** 既に料率が入っている */
  | "already_set"
  /** TSP請求対象外・停止 */
  | "excluded";

export const TSP_RATE_CATEGORY_LABEL: Record<TspRateCategory, string> = {
  unset_eligible: "未設定（設定可）",
  already_set: "設定済み",
  excluded: "TSP請求対象外",
};

export function classifySellerForTspRate(seller: TspRateSeller): TspRateCategory {
  if (resolveTspRateExclusion(seller)) return "excluded";
  return seller.tsp_rate == null ? "unset_eligible" : "already_set";
}

/** 0〜100 のパーセント値として解釈する。admin-sellers の個別編集と同じ規則 */
export function parseTspRatePct(raw: unknown): number | null {
  const normalized = String(raw ?? "").trim().replace(/%/g, "").replace(/,/g, "");
  if (!normalized) return null;
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0 || value > 100) return null;
  return value;
}

export type TspRateBulkTarget = {
  sellerId: string;
  sellerName: string;
  shopName: string;
  beforeRate: number | null;
  afterRate: number;
};

export type TspRateBulkSkipped = {
  sellerId: string;
  sellerName: string;
  shopName: string;
  reason: string;
};

export type TspRateBulkPlan = {
  ratePct: number;
  targets: TspRateBulkTarget[];
  skipped: TspRateBulkSkipped[];
};

/**
 * 選択されたセラーのうち、実際に更新するものだけを決める。
 *
 * ・選択されていないセラーは一切触らない
 * ・TSP請求対象外 / 停止 は除外する
 * ・値が変わらないものは除外する（無駄なUPDATEをしない）
 */
export function planTspRateBulkUpdate(params: {
  sellers: TspRateSeller[];
  selectedIds: string[];
  ratePct: number;
  /** true なら、既に料率が入っているセラーを除外する（未設定だけに適用） */
  onlyUnset?: boolean;
}): TspRateBulkPlan {
  const selected = new Set(params.selectedIds);
  const targets: TspRateBulkTarget[] = [];
  const skipped: TspRateBulkSkipped[] = [];

  for (const seller of params.sellers) {
    if (!selected.has(seller.id)) continue;

    const base = {
      sellerId: seller.id,
      sellerName: seller.seller_name,
      shopName: seller.shop_name,
    };

    const exclusion = resolveTspRateExclusion(seller);
    if (exclusion) {
      skipped.push({ ...base, reason: TSP_RATE_EXCLUSION_LABEL[exclusion] });
      continue;
    }
    if (params.onlyUnset && seller.tsp_rate != null) {
      skipped.push({ ...base, reason: "既に料率が設定されています" });
      continue;
    }
    if (seller.tsp_rate != null && Number(seller.tsp_rate) === params.ratePct) {
      skipped.push({ ...base, reason: "料率が同じため変更ありません" });
      continue;
    }

    targets.push({
      ...base,
      beforeRate: seller.tsp_rate == null ? null : Number(seller.tsp_rate),
      afterRate: params.ratePct,
    });
  }

  return { ratePct: params.ratePct, targets, skipped };
}

export function summarizeTspRateCategories(
  sellers: TspRateSeller[],
): Record<TspRateCategory, number> {
  const out: Record<TspRateCategory, number> = {
    unset_eligible: 0,
    already_set: 0,
    excluded: 0,
  };
  for (const s of sellers) out[classifySellerForTspRate(s)] += 1;
  return out;
}
