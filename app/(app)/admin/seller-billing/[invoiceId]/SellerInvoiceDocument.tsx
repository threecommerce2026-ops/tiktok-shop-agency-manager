"use client";

import { INVOICE_ISSUER } from "@/lib/billing/issuer";
import { resolveInvoiceTax } from "@/lib/billing/invoice-tax";
import {
  calculateSellerInvoiceDueDate,
  formatDueDateLabel,
} from "@/lib/billing/due-date";
import { formatContractRate } from "@/lib/billing/seller-invoice";
import type { SellerInvoiceSummary } from "@/lib/db/seller-billing-queries";

/*
  請求書の帳票。

  ■ PDF について
  外部のPDFライブラリは使わず、ブラウザの「PDFとして保存」を使う。
    ・日本語フォントの埋め込みが不要で文字化けしない
    ・画面に出している数値をそのまま印刷するため、
      画面金額とPDF金額が必ず一致する（別経路で再計算しない）
    ・請求書番号・金額はDBの保存値をそのまま表示するので、
      何度ダウンロードしても変わらない

  印刷時は操作ボタンと画面装飾を消し、帳票だけが出るようにしている。
*/

const yen = (value: number) => `¥${Math.round(value).toLocaleString("ja-JP")}`;

const STATUS_LABEL: Record<SellerInvoiceSummary["status"], string> = {
  draft: "下書き",
  issued: "発行済み",
  paid: "入金済み",
  cancelled: "取消",
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("ja-JP", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
}

/** 2026-08 → 2026年8月 */
function monthLabel(targetMonth: string): string {
  const [year, month] = String(targetMonth ?? "").split("-");
  if (!year || !month) return targetMonth;
  return `${year}年${Number(month)}月`;
}

export function SellerInvoiceDocument({
  invoice,
}: {
  invoice: SellerInvoiceSummary;
}) {
  /*
    税情報は保存値を優先する。
    発行済みの請求書は、将来この計算式が変わっても記載内容が変わらない。
  */
  const tax = resolveInvoiceTax(invoice);

  return (
    <div className="space-y-4">
      {/* 操作バー（印刷しない） */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-surface-1/40 p-4 print:hidden">
        <div className="text-[11px] leading-relaxed text-zinc-400">
          <p>
            請求書番号{" "}
            <span className="font-mono text-zinc-100">
              {invoice.invoiceNumber ?? "（未採番）"}
            </span>
            <span className="mx-2 text-zinc-600">/</span>
            状態 <span className="text-zinc-100">{STATUS_LABEL[invoice.status]}</span>
          </p>
          <p className="mt-1">
            お支払金額（税込）{" "}
            <span className="font-mono text-zinc-100">{yen(invoice.invoiceAmount)}</span>
            <span className="mx-2 text-zinc-600">/</span>
            内消費税（{tax.taxRatePct}%）{" "}
            <span className="font-mono text-zinc-300">{yen(tax.taxAmount)}</span>
          </p>
          <p className="mt-1 text-zinc-500">
            「PDFとして保存」を選ぶとPDFになります。金額・請求書番号は保存済みの値をそのまま印字するため、
            何度出力しても変わりません。内消費税は税込金額に含まれており、加算されません。
          </p>
        </div>
        <button
          type="button"
          onClick={() => window.print()}
          className="min-h-[38px] rounded-lg bg-white px-5 text-sm font-semibold text-zinc-950 transition hover:bg-zinc-200"
        >
          PDFとして保存 / 印刷
        </button>
      </div>

      {/* 帳票本体（適格請求書） */}
      <article className="mx-auto w-full max-w-[820px] rounded-xl border border-zinc-800 bg-white p-10 text-zinc-900 print:max-w-none print:rounded-none print:border-0 print:p-0">
        {/* 上部: 左にタイトル・番号 / 右に日付類 */}
        <header className="flex items-start justify-between gap-6">
          <div>
            <h1 className="text-[28px] font-bold tracking-[0.3em]">請求書</h1>
            <p className="mt-2 text-xs text-zinc-600">
              請求書番号{" "}
              <span className="font-mono text-zinc-900">
                {invoice.invoiceNumber ?? "（未採番）"}
              </span>
            </p>
          </div>
          <dl className="text-right text-xs leading-6">
            <div>
              <dt className="inline text-zinc-500">発行日：</dt>
              <dd className="inline">{formatDate(invoice.issuedAt)}</dd>
            </div>
            <div>
              <dt className="inline text-zinc-500">取引対象期間：</dt>
              <dd className="inline">
                {invoice.periodStart} 〜 {invoice.periodEnd}
              </dd>
            </div>
            <div>
              <dt className="inline text-zinc-500">支払期限：</dt>
              {/*
                保存済みの due_date をそのまま表示する。
                発行時に確定した値なので、将来ルールが変わっても変化しない。
                未発行（draft）で未保存のときだけ、参考として予定日を出す。
              */}
              <dd className="inline">
                {invoice.dueDate
                  ? formatDueDateLabel(invoice.dueDate)
                  : formatDueDateLabel(
                      calculateSellerInvoiceDueDate(invoice.targetMonth),
                    )}
                {invoice.dueDate ? null : (
                  <span className="ml-1 text-[10px] text-zinc-400">（発行時に確定）</span>
                )}
              </dd>
            </div>
          </dl>
        </header>

        <div className="mt-8 h-px bg-zinc-900" />

        {/* 左に請求先 / 右に発行者 */}
        <div className="mt-6 flex flex-wrap items-start justify-between gap-8">
          <div className="min-w-[280px]">
            <p className="border-b border-zinc-400 pb-1 text-xl font-semibold">
              {invoice.sellerName}　御中
            </p>
            <p className="mt-3 text-xs leading-6 text-zinc-600">
              下記のとおりご請求申し上げます。
            </p>
          </div>

          <div className="text-xs leading-6 text-zinc-700">
            <p className="text-sm font-semibold text-zinc-900">
              {INVOICE_ISSUER.companyName}
            </p>
            <p>{INVOICE_ISSUER.postalCode}</p>
            <p>{INVOICE_ISSUER.address}</p>
            <p>TEL：{INVOICE_ISSUER.tel}</p>
            <p className="mt-1">
              適格請求書発行事業者登録番号
              <br />
              <span className="font-mono text-zinc-900">
                {INVOICE_ISSUER.registrationNumber}
              </span>
            </p>
          </div>
        </div>

        {/* 中央: ご請求金額（税込） */}
        <div className="mt-8 border-2 border-zinc-900">
          <p className="bg-zinc-900 px-4 py-1.5 text-center text-[13px] font-semibold tracking-widest text-white">
            ご請求金額（税込）
          </p>
          <p className="px-4 py-5 text-center font-mono text-[34px] font-bold leading-none">
            {yen(invoice.invoiceAmount)}
          </p>
        </div>

        {/* 請求明細 */}
        <section className="mt-8">
          <h2 className="border-l-4 border-zinc-900 pl-2 text-sm font-semibold">請求明細</h2>
          <table className="mt-2 w-full border-collapse text-sm">
            <thead>
              <tr className="bg-zinc-100">
                <th className="border border-zinc-300 px-3 py-2 text-left font-semibold">品目</th>
                <th className="border border-zinc-300 px-3 py-2 text-right font-semibold">
                  金額（税込）
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="border border-zinc-300 px-3 py-2">
                  TikTok Shop 運営支援手数料（{monthLabel(invoice.targetMonth)}分）
                  <span className="ml-2 align-middle text-[11px] text-zinc-500">10%対象</span>
                </td>
                <td className="border border-zinc-300 px-3 py-2 text-right font-mono">
                  {yen(invoice.invoiceAmount)}
                </td>
              </tr>
              <tr className="bg-zinc-900 text-white">
                <td className="border border-zinc-900 px-3 py-2.5 font-semibold">合計（税込）</td>
                <td className="border border-zinc-900 px-3 py-2.5 text-right font-mono text-base font-bold">
                  {yen(invoice.invoiceAmount)}
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        {/* 算定内容 */}
        <section className="mt-6 break-inside-avoid">
          <h2 className="border-l-4 border-zinc-400 pl-2 text-sm font-semibold">算定内容</h2>
          <p className="mt-1 text-[11px] text-zinc-500">
            上記ご請求金額の算定根拠です。
          </p>
          <table className="mt-2 w-full border-collapse text-sm">
            <tbody>
              <tr>
                <td className="w-1/2 border border-zinc-300 px-3 py-2 text-zinc-600">GMV</td>
                <td className="border border-zinc-300 px-3 py-2 text-right font-mono">
                  {yen(invoice.gmvAmount)}
                </td>
              </tr>
              <tr>
                <td className="border border-zinc-300 px-3 py-2 text-zinc-600">返金額</td>
                <td className="border border-zinc-300 px-3 py-2 text-right font-mono">
                  − {yen(invoice.refundAmount)}
                </td>
              </tr>
              <tr className="bg-zinc-50">
                <td className="border border-zinc-300 px-3 py-2 font-semibold">請求対象GMV</td>
                <td className="border border-zinc-300 px-3 py-2 text-right font-mono font-semibold">
                  {yen(invoice.billingGmvAmount)}
                </td>
              </tr>
              <tr>
                <td className="border border-zinc-300 px-3 py-2 text-zinc-600">契約料率</td>
                <td className="border border-zinc-300 px-3 py-2 text-right font-mono">
                  {formatContractRate(invoice.contractRatePct)}
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        {/* 税区分 */}
        <section className="mt-6 break-inside-avoid">
          <h2 className="border-l-4 border-zinc-400 pl-2 text-sm font-semibold">税区分</h2>
          <table className="mt-2 w-full border-collapse text-sm">
            <thead>
              <tr className="bg-zinc-100">
                <th className="border border-zinc-300 px-3 py-2 text-left font-semibold">
                  適用税率
                </th>
                <th className="border border-zinc-300 px-3 py-2 text-right font-semibold">
                  対象金額（税込）
                </th>
                <th className="border border-zinc-300 px-3 py-2 text-right font-semibold">
                  内消費税額
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="border border-zinc-300 px-3 py-2">{tax.taxRatePct}%</td>
                <td className="border border-zinc-300 px-3 py-2 text-right font-mono">
                  {yen(tax.taxableAmountIncludingTax)}
                </td>
                <td className="border border-zinc-300 px-3 py-2 text-right font-mono">
                  {yen(tax.taxAmount)}
                </td>
              </tr>
            </tbody>
          </table>
          <p className="mt-2 text-[11px] leading-relaxed text-zinc-600">
            ※ ご請求金額は税込です。上記の内消費税額は税込金額に含まれており、
            別途申し受けるものではありません。お支払金額は{" "}
            <span className="font-semibold">{yen(invoice.invoiceAmount)}</span> です。
          </p>
        </section>

        {/* 振込先 */}
        <section className="mt-6 break-inside-avoid">
          <h2 className="border-l-4 border-zinc-400 pl-2 text-sm font-semibold">お振込先</h2>
          <table className="mt-2 text-sm leading-7">
            <tbody>
              <tr>
                <td className="pr-6 align-top text-zinc-500">銀行</td>
                <td>
                  {INVOICE_ISSUER.bank.bankName}（{INVOICE_ISSUER.bank.bankCode}）
                </td>
              </tr>
              <tr>
                <td className="pr-6 align-top text-zinc-500">支店</td>
                <td>
                  {INVOICE_ISSUER.bank.branchName}（{INVOICE_ISSUER.bank.branchCode}）
                </td>
              </tr>
              <tr>
                <td className="pr-6 align-top text-zinc-500">口座</td>
                <td>
                  {INVOICE_ISSUER.bank.accountType} {INVOICE_ISSUER.bank.accountNumber}
                </td>
              </tr>
              <tr>
                <td className="pr-6 align-top text-zinc-500">名義</td>
                {/* 指定表記のまま表示する（全角ハイフン・全角スペースを変換しない） */}
                <td className="whitespace-pre font-medium">
                  {INVOICE_ISSUER.bank.accountHolder}
                </td>
              </tr>
            </tbody>
          </table>
          <p className="mt-1 text-[11px] text-zinc-500">
            ※ 振込手数料は御社にてご負担をお願いいたします。
          </p>
        </section>

        {invoice.memo ? (
          <p className="mt-6 whitespace-pre-wrap text-xs text-zinc-600">{invoice.memo}</p>
        ) : null}

        {invoice.status !== "issued" && invoice.status !== "paid" ? (
          <p className="mt-8 border border-dashed border-zinc-400 px-3 py-2 text-center text-xs text-zinc-500">
            この請求書は「{STATUS_LABEL[invoice.status]}」です。発行前の内容確認用です。
          </p>
        ) : null}
      </article>
    </div>
  );
}
