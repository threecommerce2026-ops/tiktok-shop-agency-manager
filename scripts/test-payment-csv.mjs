/*
  振込CSVのテスト（DB非依存の純ロジック）。

  実行: node --test scripts/test-payment-csv.mjs
*/
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const root = process.cwd();
const jiti = createJiti(root, { alias: { "@": root }, interopDefault: true, fsCache: false });

const csv = await jiti.import(path.join(root, "lib/payments/payment-csv.ts"));

const ROWS = [
  {
    payeeKind: "agency",
    payeeName: "BUZZ L!VE",
    periodStartMonth: "2026-05",
    periodEndMonth: "2026-08",
    paymentAmount: 8016,
    bankName: "テスト銀行",
    bankCode: "0001",
    bankBranchName: "テスト支店",
    bankBranchCode: "001",
    bankAccountType: "普通",
    bankAccountNumber: "1234567",
    bankAccountHolder: "カ）テスト",
  },
  {
    payeeKind: "referrer",
    payeeName: "紹介 太郎",
    periodStartMonth: "2026-06",
    periodEndMonth: "2026-06",
    paymentAmount: 1500.5,
    bankName: "サンプル銀行",
    bankCode: "0036",
    bankBranchName: "第四営業支店",
    bankBranchCode: "254",
    bankAccountType: "普通",
    bankAccountNumber: "7654321",
    bankAccountHolder: "ショウカイ タロウ",
  },
];

test("列は仕様どおり11列", () => {
  assert.deepEqual([...csv.PAYMENT_CSV_HEADERS], [
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
  ]);
});

test("UTF-8 BOM 付き・CRLF 改行（日本語Excelで文字化けしにくい）", () => {
  const out = csv.buildPaymentCsv(ROWS);
  assert.equal(out.charCodeAt(0), 0xfeff);
  assert.ok(out.includes("\r\n"));
});

test("ヘッダー行と明細行が出る", () => {
  const lines = csv.buildPaymentCsv(ROWS).replace(/^﻿/, "").trim().split("\r\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[0], csv.PAYMENT_CSV_HEADERS.join(","));
  assert.ok(lines[1].startsWith("代理店,BUZZ L!VE,2026-05〜2026-08,8016,"));
  assert.ok(lines[2].startsWith("紹介者,紹介 太郎,2026-06,1500.50,"));
});

test("同一月は期間を1つだけ書く", () => {
  assert.equal(csv.formatCsvPeriod("2026-06", "2026-06"), "2026-06");
  assert.equal(csv.formatCsvPeriod("2026-05", "2026-08"), "2026-05〜2026-08");
});

test("金額は桁区切りを入れない（Excelで数値として扱えるように）", () => {
  const out = csv.buildPaymentCsv([{ ...ROWS[0], paymentAmount: 1234567 }]);
  assert.ok(out.includes(",1234567,"));
  assert.ok(!out.includes("1,234,567"));
});

test("口座番号はCSVに出る（画面には出さない）", () => {
  const out = csv.buildPaymentCsv(ROWS);
  assert.ok(out.includes("1234567"));
  assert.ok(out.includes("7654321"));
});

test("カンマ・引用符・改行はエスケープする", () => {
  assert.equal(csv.csvCell("あ,い"), '"あ,い"');
  assert.equal(csv.csvCell('あ"い'), '"あ""い"');
  assert.equal(csv.csvCell("あ\nい"), '"あ\nい"');
  assert.equal(csv.csvCell(null), "");
});

test("数式として解釈されうる先頭文字を無害化する", () => {
  assert.equal(csv.csvCell("=1+1"), "'=1+1");
  assert.equal(csv.csvCell("+81"), "'+81");
  assert.equal(csv.csvCell("-100"), "'-100");
  assert.equal(csv.csvCell("@name"), "'@name");
});

test("CSVの金額合計が支払明細の合計と一致する", () => {
  // 承認済み支払明細のスナップショット
  const approvedBatches = [
    { paymentAmount: 8016 },
    { paymentAmount: 1500.5 },
  ];
  const batchTotal =
    Math.round(approvedBatches.reduce((s, b) => s + b.paymentAmount, 0) * 100) / 100;

  assert.equal(csv.sumPaymentCsvAmount(ROWS), batchTotal);
  assert.equal(csv.sumPaymentCsvAmount(ROWS), 9516.5);
});

test("振込先が未登録の行でも列がずれない", () => {
  const out = csv.buildPaymentCsv([
    {
      ...ROWS[0],
      bankName: null,
      bankCode: null,
      bankBranchName: null,
      bankBranchCode: null,
      bankAccountType: null,
      bankAccountNumber: null,
      bankAccountHolder: null,
    },
  ]);
  const line = out.replace(/^﻿/, "").trim().split("\r\n")[1];
  assert.equal(line.split(",").length, csv.PAYMENT_CSV_HEADERS.length);
});

test("ファイル名は安全な文字だけになる", () => {
  assert.equal(csv.paymentCsvFileName("20260925", "代理店"), "furikomi_20260925.csv");
  assert.equal(csv.paymentCsvFileName("20260925", "3ken"), "furikomi_20260925_3ken.csv");
  assert.equal(csv.paymentCsvFileName("20260925"), "furikomi_20260925.csv");
});

test("空でもヘッダー行だけは出る", () => {
  const out = csv.buildPaymentCsv([]);
  assert.equal(out.replace(/^﻿/, "").trim(), csv.PAYMENT_CSV_HEADERS.join(","));
  assert.equal(csv.sumPaymentCsvAmount([]), 0);
});
