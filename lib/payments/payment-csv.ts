import { PAYEE_KIND_LABEL, type PayeeKind } from "@/lib/payments/payable";

/*
  振込用CSVの生成（単一ソース）。

  ■ 初期版の方針
  特定銀行の全銀フォーマットには合わせない。
  まず「日本語Excelでそのまま開ける一般的な振込一覧」を出す。
  全銀テキストが必要になったら、この行データから別の整形関数を足す。

  ■ 文字化け対策
  UTF-8 BOM + CRLF。Excel が Shift_JIS と誤認しないようにする。

  ■ 口座番号
  この関数だけが口座番号の全文を扱う。
  呼び出し側（server action）は requireAdminAction() を通したうえで、
  生成した文字列をそのままダウンロードさせる。画面には渡さない。
*/

export const PAYMENT_CSV_HEADERS = [
  "報酬種別",
  "支払先名",
  "対象期間",
  "今回振込額",
  "銀行名",
  "銀行コード",
  "支店名",
  "支店コード",
  "口座種別",
  "口座番号",
  "口座名義",
] as const;

export type PaymentCsvRow = {
  payeeKind: PayeeKind;
  payeeName: string;
  periodStartMonth: string;
  periodEndMonth: string;
  paymentAmount: number;
  bankName: string | null;
  bankCode: string | null;
  bankBranchName: string | null;
  bankBranchCode: string | null;
  bankAccountType: string | null;
  bankAccountNumber: string | null;
  bankAccountHolder: string | null;
};

const BOM = "\uFEFF";
const EOL = "\r\n";

/**
 * CSV の1セル。
 *
 * 先頭が = + - @ のときは先頭にシングルクォートを付ける。
 * Excel が数式として解釈するのを防ぐ（口座名義に記号が入ることがある）。
 */
export function csvCell(value: unknown): string {
  const raw = value == null ? "" : String(value);
  const guarded = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;

  if (/[",\r\n]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

export function formatCsvPeriod(startMonth: string, endMonth: string): string {
  return startMonth === endMonth ? startMonth : `${startMonth}〜${endMonth}`;
}

/**
 * 金額は桁区切りを入れない。
 * Excel 側で数値として扱えるようにするため。
 */
function formatCsvAmount(value: number): string {
  const rounded = Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

export function buildPaymentCsv(rows: PaymentCsvRow[]): string {
  const lines: string[] = [PAYMENT_CSV_HEADERS.map(csvCell).join(",")];

  for (const row of rows) {
    lines.push(
      [
        PAYEE_KIND_LABEL[row.payeeKind],
        row.payeeName,
        formatCsvPeriod(row.periodStartMonth, row.periodEndMonth),
        formatCsvAmount(row.paymentAmount),
        row.bankName ?? "",
        row.bankCode ?? "",
        row.bankBranchName ?? "",
        row.bankBranchCode ?? "",
        row.bankAccountType ?? "",
        row.bankAccountNumber ?? "",
        row.bankAccountHolder ?? "",
      ]
        .map(csvCell)
        .join(","),
    );
  }

  return `${BOM}${lines.join(EOL)}${EOL}`;
}

/** CSV に載せた振込額の合計。支払明細の合計と突き合わせる検算用 */
export function sumPaymentCsvAmount(rows: PaymentCsvRow[]): number {
  const total = rows.reduce(
    (sum, row) => sum + (Number.isFinite(row.paymentAmount) ? row.paymentAmount : 0),
    0,
  );
  return Math.round(total * 100) / 100;
}

/** ダウンロードファイル名。日付は呼び出し側が渡す（テストを決定的にするため） */
export function paymentCsvFileName(stamp: string, suffix?: string): string {
  const safe = String(suffix ?? "").replace(/[^0-9A-Za-z_-]/g, "");
  return safe ? `furikomi_${stamp}_${safe}.csv` : `furikomi_${stamp}.csv`;
}
