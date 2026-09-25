/*
  セラー請求額の計算（単一ソース）。

  ■ 確定した業務ルール
    請求対象GMV = ショップ実績CSVの B列「GMV」 − I列「Refunds」
    請求額（税込） = 請求対象GMV × セラーごとの契約料率(%)

  ■ 消費税を足さないこと
    算出した金額が「税込請求額」そのもの。
    ここから更に 10% を加算してはいけない。
    例) GMV 10,000,000 / Refunds 500,000 / 料率10%
        → 請求対象GMV 9,500,000 → 請求額（税込）950,000
        （1,045,000 にしない）

  ■ 使わないもの
    affiliate_order_lines の AP / AK / Commission base 等は
    セラー請求の根拠に使わない。代理店報酬・紹介者報酬とは無関係。

  ■ 料率の保存形式
    sellers.tsp_rate はパーセント値で保存されている（10 = 10%）。
    計算時に /100 するのはこの1か所だけ。二重変換しないこと。
*/

/** 請求プレビューの状態 */
export type SellerBillingStatus =
  /** 計算できた */
  | "ok"
  /** セラーが紐付いていない */
  | "unlinked"
  /** 契約料率が未設定 */
  | "rate_missing"
  /** 請求対象GMVがマイナス。自動で請求書を作らない */
  | "needs_review";

export const SELLER_BILLING_STATUS_LABEL: Record<SellerBillingStatus, string> = {
  ok: "計算済",
  unlinked: "未紐付け",
  rate_missing: "契約料率 未設定",
  needs_review: "要確認（請求対象GMVがマイナス）",
};

export type SellerInvoiceComputation = {
  status: SellerBillingStatus;
  /** GMV − Refunds。マイナスでもそのまま返す（判断材料にする） */
  billingGmvAmount: number;
  /** 請求額（税込）。計算できないときは null */
  invoiceAmount: number | null;
  label: string;
};

/**
 * 請求額を計算する。
 *
 * @param gmvAmount       CSV B列「GMV」
 * @param refundAmount    CSV I列「Refunds」
 * @param contractRatePct セラーの契約料率（パーセント値。10 = 10%）
 * @param sellerId        セラーが紐付いていなければ null
 */
export function computeSellerInvoice(params: {
  gmvAmount: number | null | undefined;
  refundAmount: number | null | undefined;
  contractRatePct: number | null | undefined;
  sellerId: string | null | undefined;
}): SellerInvoiceComputation {
  const gmv = toFiniteNumber(params.gmvAmount);
  const refund = toFiniteNumber(params.refundAmount);

  // マイナスでも丸めずそのまま出す。請求してよいかは人が判断する。
  const billingGmvAmount = round2(gmv - refund);

  if (!params.sellerId) {
    return withLabel("unlinked", billingGmvAmount, null);
  }

  const rate = params.contractRatePct;
  if (rate == null || !Number.isFinite(Number(rate))) {
    return withLabel("rate_missing", billingGmvAmount, null);
  }

  if (billingGmvAmount < 0) {
    return withLabel("needs_review", billingGmvAmount, null);
  }

  // 税込請求額。ここに消費税を足さない。
  const invoiceAmount = Math.round((billingGmvAmount * Number(rate)) / 100);

  return withLabel("ok", billingGmvAmount, invoiceAmount);
}

function withLabel(
  status: SellerBillingStatus,
  billingGmvAmount: number,
  invoiceAmount: number | null,
): SellerInvoiceComputation {
  return {
    status,
    billingGmvAmount,
    invoiceAmount,
    label: SELLER_BILLING_STATUS_LABEL[status],
  };
}

function toFiniteNumber(value: number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 請求書を作ってよい状態か */
export function canCreateInvoice(computation: SellerInvoiceComputation): boolean {
  return computation.status === "ok" && computation.invoiceAmount != null;
}

/** 料率の表示（10 → "10%"） */
export function formatContractRate(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(Number(rate))) return "未設定";
  const value = Number(rate);
  const text = Number.isInteger(value) ? String(value) : String(round2(value));
  return `${text}%`;
}

/*
  テスト用セラーの判定。

  本番の請求対象・一括請求・合計金額からは除外するが、
  DBからは削除しない（過去の検証記録として残す）。
  画面では「テストデータを表示」の切替で確認できる。

  判定はセラー名の接頭辞 [TEST]。
  DBにフラグ列を増やさず、既存の命名規約をそのまま使う。
*/
const TEST_SELLER_PREFIX = "[TEST]";

export function isTestSeller(sellerName: string | null | undefined): boolean {
  return String(sellerName ?? "").trim().toUpperCase().startsWith(TEST_SELLER_PREFIX);
}
