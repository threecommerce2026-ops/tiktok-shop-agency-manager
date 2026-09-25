/*
  適格請求書（インボイス）の税額計算。単一ソース。

  ■ 大前提: 請求金額は税込
    invoice_amount = 請求対象GMV × 契約料率 / 100
    これが最終のお支払金額。ここに消費税を加算しない。
      invoice_amount + 税  ← 絶対にしない

  ■ 内消費税（税込総額に含まれる消費税額）
    標準税率10%の役務として扱う。

      10%対象（税込） = invoice_amount
      内消費税額       = invoice_amount × 10 / 110
      税抜相当額       = invoice_amount − 内消費税額

  ■ 端数処理
    適格請求書では「一の請求書につき、税率ごとに1回」だけ端数処理する。
    そのため請求書1通の税込総額に対して1回だけ丸める。
    明細ごとに税額を丸めて合計する方式にはしない。

    丸め方は四捨五入。
    既存の請求額計算（Math.round）と同じ方式に揃えてある。

    現在の税区分は10%のみ。軽減税率は扱わない。
*/

/** 標準税率（%） */
export const STANDARD_TAX_RATE_PCT = 10;

export type InvoiceTaxBreakdown = {
  /** 適用税率（%） */
  taxRatePct: number;
  /** その税率の対象となる税込金額 */
  taxableAmountIncludingTax: number;
  /** 税込金額に含まれる消費税額（請求書につき税率ごとに1回だけ丸める） */
  taxAmount: number;
  /** 税抜相当額（税込 − 内消費税） */
  amountExcludingTax: number;
};

/**
 * 税込総額から内消費税額を求める。
 *
 * @param invoiceAmountIncludingTax 請求金額（税込）。この値は変更しない。
 * @param taxRatePct                適用税率（既定 10%）
 */
export function computeInvoiceTax(
  invoiceAmountIncludingTax: number | null | undefined,
  taxRatePct: number = STANDARD_TAX_RATE_PCT,
): InvoiceTaxBreakdown {
  const gross = toFinite(invoiceAmountIncludingTax);
  const rate = toFinite(taxRatePct);

  // 請求書につき税率ごとに1回だけの端数処理（四捨五入）
  const taxAmount = Math.round((gross * rate) / (100 + rate));

  return {
    taxRatePct: rate,
    taxableAmountIncludingTax: gross,
    taxAmount,
    amountExcludingTax: gross - taxAmount,
  };
}

/**
 * 保存済みの税情報を優先して使う。
 *
 * 発行済み請求書は、その時点の税率・税額をDBに持つ。
 * 将来ここの計算式や税率が変わっても、発行済みの帳票は変わらない。
 * 保存値が無い（古い下書きなど）場合だけ、その場で計算する。
 */
export function resolveInvoiceTax(invoice: {
  invoiceAmount: number;
  taxRatePct: number | null;
  taxAmount: number | null;
}): InvoiceTaxBreakdown {
  if (invoice.taxRatePct != null && invoice.taxAmount != null) {
    const rate = toFinite(invoice.taxRatePct);
    const tax = toFinite(invoice.taxAmount);
    return {
      taxRatePct: rate,
      taxableAmountIncludingTax: invoice.invoiceAmount,
      taxAmount: tax,
      amountExcludingTax: invoice.invoiceAmount - tax,
    };
  }

  return computeInvoiceTax(invoice.invoiceAmount);
}

function toFinite(value: number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
