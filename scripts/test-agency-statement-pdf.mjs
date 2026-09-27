/*
  代理店別PDFとZIPの検証。

  ■ DBへ書き込まない
  PDF生成（renderAgencyStatementPdf）と ZIP 組み立て（createZip）は
  AgencyStatement を受け取るだけの処理なので、DBに触らずに検証できる。

  ■ 何を確かめるか
  ・出せる状態／出せない状態の切り分け（承認済み以降だけ）
  ・payment_amount と明細合計がずれていたら生成しない
  ・紹介制度報酬が混ざっていたら生成しない
  ・PDFがA4縦で、日本語・金額・分配率が欠けずに入っている
  ・ZIPが壊れず、1社1ファイルで、同名を上書きしない

  実行:
    node --test scripts/test-agency-statement-pdf.mjs
*/
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const root = process.cwd();
const jiti = createJiti(root, {
  alias: { "@": root },
  interopDefault: true,
  fsCache: false,
});

const stmt = await jiti.import(path.join(root, "lib/payments/agency-statement.ts"));
const pdfMod = await jiti.import(path.join(root, "lib/pdf/agency-statement-pdf.ts"));
const zipMod = await jiti.import(path.join(root, "lib/pdf/zip.ts"));

const MIN_PAYOUT = 1000;

// -----------------------------------------------------------------------------
// 雛形
// -----------------------------------------------------------------------------
function month(targetMonth, gmv, base, ratePct, reward, opts = {}) {
  return {
    targetMonth,
    gmv,
    baseAmount: base,
    ratePct,
    hasMixedRate: opts.hasMixedRate ?? false,
    rewardAmount: reward,
    itemCount: opts.itemCount ?? 1,
  };
}

function creator(id, name, months, opts = {}) {
  const sum = (k) => months.reduce((a, m) => a + m[k], 0);
  const rates = new Set(months.map((m) => m.ratePct));
  return {
    creatorId: id,
    creatorName: name,
    tiktokId: opts.tiktokId ?? name,
    referrerName: null,
    periodStartMonth: months[0].targetMonth,
    periodEndMonth: months[months.length - 1].targetMonth,
    gmv: sum("gmv"),
    baseAmount: sum("baseAmount"),
    ratePct:
      months.some((m) => m.hasMixedRate) || rates.size > 1 ? null : months[0].ratePct,
    rewardAmount: sum("rewardAmount"),
    itemCount: sum("itemCount"),
    months,
  };
}

function detailOf({
  status = "approved",
  payeeKind = "agency",
  payeeName = "テスト代理店",
  paymentAmount,
  creators,
  referralCreators = [],
  bank = { state: "ok" },
} = {}) {
  const agencyTotal =
    Math.round(creators.reduce((a, c) => a + c.rewardAmount, 0) * 100) / 100;
  const referralTotal =
    Math.round(referralCreators.reduce((a, c) => a + c.rewardAmount, 0) * 100) / 100;
  return {
    batch: {
      id: "11111111-2222-3333-4444-555555555555",
      payeeKind,
      payeeId: "agency-1",
      payeeName,
      cutoffMonth: "2026-07",
      periodStartMonth: "2026-01",
      periodEndMonth: "2026-07",
      itemCount: creators.reduce((a, c) => a + c.itemCount, 0),
      grossAmount: paymentAmount ?? agencyTotal,
      paymentAmount: paymentAmount ?? agencyTotal,
      status,
      memo: null,
      failureReason: null,
      createdAt: "2026-09-26T09:00:00Z",
      approvedAt: "2026-09-26T09:41:00Z",
      paidAt: null,
      paidOn: null,
      bank,
    },
    items: [],
    auditLogs: [],
    itemsTotalAmount: agencyTotal + referralTotal,
    agencyRewardAmount: agencyTotal,
    referralRewardAmount: referralTotal,
    agencyBreakdown: {
      rewardKind: "agency",
      creators,
      totalAmount: agencyTotal,
      itemCount: creators.reduce((a, c) => a + c.itemCount, 0),
    },
    referralBreakdown: {
      rewardKind: "referral",
      creators: referralCreators,
      totalAmount: referralTotal,
      itemCount: 0,
    },
    totalsMatchBatch: true,
    error: null,
  };
}

const CREATORS = [
  creator("c1", "zero_0416", [
    month("2026-05", 47448, 1634, 10, 162, { itemCount: 14 }),
    month("2026-06", 255677, 7802, 10, 786, { itemCount: 76 }),
    month("2026-07", 510375, 16383, 10, 1634, { itemCount: 140 }),
  ]),
];

/** 承認済みの statement を1つ作る */
function statementOf(overrides = {}) {
  const built = stmt.buildAgencyStatement(detailOf({ creators: CREATORS, ...overrides }));
  assert.equal(built.ok, true, built.ok ? "" : built.rejection?.message);
  return built.statement;
}

async function renderPdf(statement) {
  return pdfMod.renderAgencyStatementPdf(statement, MIN_PAYOUT);
}

/** PDFの生の中身から文字列を拾う。埋め込みフォントは圧縮されるため構造だけ見る */
function pdfHeader(bytes) {
  return Buffer.from(bytes.slice(0, 8)).toString("latin1");
}

function pdfTail(bytes) {
  return Buffer.from(bytes.slice(-32)).toString("latin1");
}

/*
  PDFはオブジェクトストリームで圧縮されるため、生のバイト列を正規表現で
  読んでも構造は取り出せない。pdf-lib で読み直して確かめる。
  「書いた側の申告」ではなく「出来上がったPDF」を見ることになる。
*/
async function loadPages(bytes) {
  const { PDFDocument } = require("pdf-lib");
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => page.getSize());
}

// -----------------------------------------------------------------------------
// 1〜3: 出力できる状態
// -----------------------------------------------------------------------------
for (const status of ["approved", "processing", "paid"]) {
  test(`${status} の支払明細はPDFを作れる`, async () => {
    const { bytes, report } = await renderPdf(statementOf({ status }));
    assert.equal(pdfHeader(bytes).startsWith("%PDF-"), true);
    assert.match(pdfTail(bytes), /%%EOF/);
    assert.ok(bytes.length > 5000, `サイズが小さすぎる: ${bytes.length}`);
    assert.equal(report.pageCount >= 1, true);
  });
}

// -----------------------------------------------------------------------------
// 4〜7: 出力を拒否する
// -----------------------------------------------------------------------------
for (const status of ["draft", "cancelled", "failed"]) {
  test(`${status} は正式なPDFの対象外`, () => {
    const built = stmt.buildAgencyStatement(detailOf({ status, creators: CREATORS }));
    assert.equal(built.ok, false);
    assert.equal(built.rejection.reason, "status_not_issuable");
  });
}

test("紹介者への支払明細はPDFの対象外", () => {
  const built = stmt.buildAgencyStatement(
    detailOf({ payeeKind: "referrer", creators: CREATORS }),
  );
  assert.equal(built.ok, false);
  assert.equal(built.rejection.reason, "not_agency");
});

// -----------------------------------------------------------------------------
// 8〜9: 権限と存在しないID
// -----------------------------------------------------------------------------
test("ダウンロード経路は必ず親管理者判定を通る", () => {
  const source = fs.readFileSync("lib/payments/statement-download.ts", "utf8");
  // 認可前にDBを読まないこと
  assert.match(source, /async function authorize\(\)/);
  assert.match(source, /isAdminRole\(appUser\.data\.role\)/);
  const pdfFn = source.slice(source.indexOf("export async function buildAgencyStatementPdf"));
  const zipFn = source.slice(source.indexOf("export async function buildAgencyStatementZip"));
  for (const [name, fn] of [["PDF", pdfFn], ["ZIP", zipFn]]) {
    const authAt = fn.indexOf("await authorize()");
    const fetchAt = fn.search(/fetchPayment(BatchDetail|Overview)/);
    assert.ok(authAt >= 0, `${name}: authorize を呼んでいない`);
    assert.ok(authAt < fetchAt, `${name}: 認可より先にDBを読んでいる`);
  }
  // 未ログインは401、非adminは403
  assert.match(source, /status: 401/);
  assert.match(source, /status: 403/);
});

test("存在しない支払明細は404で返す", () => {
  const source = fs.readFileSync("lib/payments/statement-download.ts", "utf8");
  assert.match(source, /status: 404, message: "支払明細が見つかりません。"/);
});

// -----------------------------------------------------------------------------
// 10〜11: 整合性
// -----------------------------------------------------------------------------
test("payment_amount と明細合計がずれていたらPDFを作らない", () => {
  const built = stmt.buildAgencyStatement(
    detailOf({ creators: CREATORS, paymentAmount: 9999 }),
  );
  assert.equal(built.ok, false);
  assert.equal(built.rejection.reason, "amount_mismatch");
});

test("紹介制度報酬が占有されていたらPDFを作らない", () => {
  const referral = [creator("r1", "someone", [month("2026-06", 1000, 500, 5, 25)])];
  const built = stmt.buildAgencyStatement(
    detailOf({ creators: CREATORS, referralCreators: referral }),
  );
  assert.equal(built.ok, false);
  assert.equal(built.rejection.reason, "referral_included");
});

// -----------------------------------------------------------------------------
// 12〜13: 日本語
// -----------------------------------------------------------------------------
test("日本語の代理店名でもPDFを作れる（文字を落とさない）", async () => {
  const { report } = await renderPdf(
    statementOf({ payeeName: "株式会社ハイライト髙島" }),
  );
  assert.deepEqual(report.droppedCharacters, []);
});

test("日本語のクリエイター名でもPDFを作れる（文字を落とさない）", async () => {
  const jp = [
    creator("c9", "夜更かしの引き出し", [month("2026-07", 10000, 1000, 10, 100)], {
      tiktokId: "yofukashi",
    }),
  ];
  const { report } = await renderPdf(statementOf({ creators: jp }));
  assert.deepEqual(report.droppedCharacters, []);
});

test("フォントに無い絵文字は落とし、例外にしない", async () => {
  const emoji = [
    creator("c10", "きらきら🌸✨", [month("2026-07", 10000, 1000, 10, 100)], {
      tiktokId: "kirakira",
    }),
  ];
  const { bytes, report } = await renderPdf(statementOf({ creators: emoji }));
  assert.ok(bytes.length > 5000);
  assert.ok(report.droppedCharacters.length > 0, "絵文字が落ちた記録がない");
  // 名前の日本語部分は残る
  assert.ok(!report.droppedCharacters.includes("き"));
});

// -----------------------------------------------------------------------------
// 14〜15: ファイル名
// -----------------------------------------------------------------------------
test("ファイル名の危険な文字をsanitizeする", () => {
  for (const ch of ["/", "\\", ":", "*", "?", '"', "<", ">", "|"]) {
    const name = stmt.statementFileBaseName("2026-07", `A${ch}B`);
    assert.ok(!name.includes(ch), `${ch} が残っている: ${name}`);
  }
  assert.equal(
    stmt.statementFileBaseName("2026-07", "BUZZ L!VE"),
    "2026-07_BUZZ-L!VE_支払明細",
  );
  assert.equal(stmt.statementFileBaseName("2026-07", "LUMN"), "2026-07_LUMN_支払明細");
  assert.equal(stmt.statementZipFileName("2026-07"), "2026-07_代理店支払明細.zip");
  // パス上位へ抜けない
  assert.ok(!stmt.sanitizeStatementFileName("../../etc/passwd").startsWith("."));
});

test("同名の代理店があってもZIP内で上書きしない", () => {
  const used = new Set();
  const a = zipMod.uniqueZipName(used, "2026-07_同名_支払明細", ".pdf");
  const b = zipMod.uniqueZipName(used, "2026-07_同名_支払明細", ".pdf");
  const c = zipMod.uniqueZipName(used, "2026-07_同名_支払明細", ".pdf");
  assert.equal(a, "2026-07_同名_支払明細.pdf");
  assert.equal(b, "2026-07_同名_支払明細_2.pdf");
  assert.equal(c, "2026-07_同名_支払明細_3.pdf");
  assert.equal(new Set([a, b, c]).size, 3);
});

// -----------------------------------------------------------------------------
// 16〜19: 1社1PDF / ZIP
// -----------------------------------------------------------------------------
const FIVE = [
  { name: "BUZZ L!VE", amount: 8392 },
  { name: "ZUNii", amount: 7754 },
  { name: "RevReel", amount: 7090 },
  { name: "ピクノア", amount: 5722 },
  { name: "LUMN", amount: 2582 },
];

async function buildFive() {
  const used = new Set();
  const files = [];
  for (const agency of FIVE) {
    /*
      金額は明細の実額から積み上げる。
      期待額に合わせるため、1クリエイター1月ぶんへ全額を置く。
    */
    const creators = [
      creator("c", `creator_${agency.name}`, [
        month("2026-07", agency.amount * 100, agency.amount * 10, 10, agency.amount, {
          itemCount: 10,
        }),
      ]),
    ];
    const statement = statementOf({ payeeName: agency.name, creators });
    const { bytes, report } = await renderPdf(statement);
    files.push({
      name: zipMod.uniqueZipName(
        used,
        stmt.statementFileBaseName("2026-07", agency.name),
        ".pdf",
      ),
      data: bytes,
      amount: statement.paymentAmount,
      pageCount: report.pageCount,
    });
  }
  return files;
}

test("1社につき1PDFになる", async () => {
  const files = await buildFive();
  assert.equal(files.length, 5);
  assert.equal(new Set(files.map((f) => f.name)).size, 5);
  for (const f of files) assert.equal(pdfHeader(f.data).startsWith("%PDF-"), true);
});

test("5社で5PDF、ZIPに5件入る", async () => {
  const files = await buildFive();
  const zip = zipMod.createZip(
    files.map((f) => ({ name: f.name, data: f.data })),
    new Date("2026-07-01T00:00:00Z"),
  );
  // end of central directory のエントリ数
  const buf = Buffer.from(zip);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > 0, "end of central directory が無い");
  assert.equal(buf.readUInt16LE(eocd + 8), 5);
  assert.equal(buf.readUInt16LE(eocd + 10), 5);
});

test("ZIPが壊れていない（unzip と Python の両方で展開できる）", async (t) => {
  const files = await buildFive();
  const zip = zipMod.createZip(
    files.map((f) => ({ name: f.name, data: f.data })),
    new Date("2026-07-01T00:00:00Z"),
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmt-zip-"));
  const zipPath = path.join(dir, "2026-07_代理店支払明細.zip");
  fs.writeFileSync(zipPath, zip);

  try {
    // 1) unzip -t で整合性
    const out = execFileSync("unzip", ["-t", zipPath], { encoding: "utf8" });
    assert.match(out, /No errors detected/);

    // 2) 実際に展開して中身を確かめる
    const extractDir = path.join(dir, "out");
    fs.mkdirSync(extractDir);
    execFileSync("unzip", ["-q", zipPath, "-d", extractDir]);
    const extracted = fs.readdirSync(extractDir).sort();
    assert.equal(extracted.length, 5, `余計なファイルがある: ${extracted.join(", ")}`);
    for (const f of files) {
      const target = path.join(extractDir, f.name);
      assert.ok(fs.existsSync(target), `欠落: ${f.name}`);
      const round = fs.readFileSync(target);
      assert.equal(Buffer.compare(round, Buffer.from(f.data)), 0, `内容が変わった: ${f.name}`);
    }

    // 3) 別実装（Python zipfile）でも壊れていないこと
    const py = execFileSync(
      "python3",
      [
        "-c",
        [
          "import zipfile,sys",
          "z=zipfile.ZipFile(sys.argv[1])",
          "bad=z.testzip()",
          "names=z.namelist()",
          "print('BAD' if bad else 'OK', len(names))",
          "print('\\n'.join(names))",
        ].join("\n"),
        zipPath,
      ],
      { encoding: "utf8" },
    );
    assert.match(py, /^OK 5/m);
    // 日本語ファイル名が化けていないこと
    assert.match(py, /ピクノア/);
  } catch (error) {
    if (error.code === "ENOENT") {
      t.skip("unzip / python3 が無い環境のためスキップ");
      return;
    }
    throw error;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// 20〜21: A4 / 複数ページ
// -----------------------------------------------------------------------------
test("A4縦で出る", async () => {
  const { bytes } = await renderPdf(statementOf());
  const sizes = await loadPages(bytes);
  assert.ok(sizes.length >= 1, "ページが無い");
  for (const { width, height } of sizes) {
    assert.ok(Math.abs(width - 595.28) < 0.5, `幅が A4 でない: ${width}`);
    assert.ok(Math.abs(height - 841.89) < 0.5, `高さが A4 でない: ${height}`);
    assert.ok(height > width, "縦向きでない");
  }
});

test("明細が多いときは複数ページへ分かれる", async () => {
  // 1ページに収まらない件数を入れる
  const many = Array.from({ length: 40 }, (_, i) =>
    creator(`m${i}`, `creator_${i}`, [
      month("2026-06", 10000, 1000, 10, 50, { itemCount: 5 }),
      month("2026-07", 20000, 2000, 10, 50, { itemCount: 5 }),
    ]),
  );
  const { bytes, report } = await renderPdf(statementOf({ creators: many }));
  const sizes = await loadPages(bytes);
  assert.ok(sizes.length > 1, `複数ページになっていない: ${sizes.length}`);
  assert.equal(sizes.length, report.pageCount, "報告したページ数と実際が違う");
  // どのページもA4縦
  for (const { width, height } of sizes) {
    assert.ok(Math.abs(height - 841.89) < 0.5);
    assert.ok(Math.abs(width - 595.28) < 0.5);
  }
});

// -----------------------------------------------------------------------------
// 22〜28: 金額・分配率が欠けない
// -----------------------------------------------------------------------------
test("列幅の合計がA4の本文幅に収まる", () => {
  const source = fs.readFileSync("lib/pdf/agency-statement-pdf.ts", "utf8");
  const widths = [...source.matchAll(/width:\s*(\d+),\s*align:/g)].map((m) => Number(m[1]));
  assert.equal(widths.length, 6, "列が6つない");
  const total = widths.reduce((a, b) => a + b, 0);
  assert.ok(total <= 515.28, `表が本文幅を超える: ${total}`);
});

test("金額・期間・分配率は縮小して全桁出す（切り捨てない）", async () => {
  /*
    桁数の多い金額と、最長の期間表記を入れて、
    省略記号を付けられた箇所が無いことを確かめる。
  */
  const wide = [
    creator("c", "creator_wide", [
      month("2026-04", 98765432.1, 12345678.9, 12.345, 1234567.89, { itemCount: 12345 }),
      month("2026-07", 1.11, 1.11, 7.5, 1.11, { itemCount: 1 }),
    ]),
  ];
  const { report } = await renderPdf(statementOf({ creators: wide }));
  const clippedNumbers = report.truncatedTexts.filter(
    (t) => t.startsWith("¥") || t.includes("年") || t.endsWith("%") || t === "複数",
  );
  assert.deepEqual(clippedNumbers, [], `金額・期間が省略された: ${clippedNumbers}`);
});

test("分配率が混在していれば平均を作らず「複数」と出す", () => {
  const mixed = creator("c", "creator_mixed", [
    month("2026-06", 1000, 500, 10, 50),
    month("2026-07", 1000, 500, 20, 100),
  ]);
  assert.equal(mixed.ratePct, null);
  assert.equal(stmt.formatStatementRate(mixed.ratePct), "複数");
  assert.equal(stmt.formatStatementRate(10), "10%");
});

test("5社の金額と合計が期待どおり", async () => {
  const files = await buildFive();
  for (const f of files) {
    const agency = FIVE.find((a) =>
      f.name.includes(stmt.sanitizeStatementFileName(a.name)),
    );
    assert.ok(agency, `代理店を特定できない: ${f.name}`);
    assert.equal(f.amount, agency.amount);
  }
  assert.equal(
    files.reduce((a, f) => a + f.amount, 0),
    31540,
  );
  assert.equal(files.find((f) => f.name.includes("BUZZ")).amount, 8392);
  assert.equal(files.find((f) => f.name.includes("LUMN")).amount, 2582);
});

// -----------------------------------------------------------------------------
// 29: 銀行情報を載せない
// -----------------------------------------------------------------------------
test("PDFに口座番号・口座名義・銀行名・支店名を載せない", async () => {
  const statement = statementOf({
    bank: {
      state: "ok",
      bankName: "楽天銀行",
      bankCode: "0036",
      bankBranchName: "第四営業支店",
      bankBranchCode: "254",
      bankAccountType: "普通",
      accountNumberMasked: "***4610",
      bankAccountHolder: "カ）テスト",
    },
  });
  // view model は登録済みかどうかしか持たない
  assert.equal(statement.bankRegistered, true);
  assert.equal(JSON.stringify(statement).includes("楽天銀行"), false);
  assert.equal(JSON.stringify(statement).includes("7674610"), false);

  const source = fs.readFileSync("lib/pdf/agency-statement-pdf.ts", "utf8");
  for (const field of [
    "bankName",
    "bankAccountHolder",
    "accountNumberMasked",
    "bankBranchName",
    "bankCode",
  ]) {
    assert.equal(source.includes(field), false, `${field} を描いている`);
  }
  // 文言は「登録済み口座へ振り込む」だけ
  assert.match(source, /ご登録いただいている口座へお振り込みいたします。/);
});

test("PDFに紹介制度報酬を載せない", () => {
  const source = fs.readFileSync("lib/pdf/agency-statement-pdf.ts", "utf8");
  // 描画する文言に「紹介」が出ないこと（コメントは除く）
  const drawn = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.equal(
    drawn.includes("紹介"),
    false,
    "描画するコードに「紹介」が出てくる",
  );
  assert.equal(source.includes("referralBreakdown"), false);
  assert.equal(source.includes("referralRewardAmount"), false);
});

test("帳票の注記は3点で、最低支払額は渡された値を使う", async () => {
  const source = fs.readFileSync("lib/pdf/agency-statement-pdf.ts", "utf8");
  assert.match(source, /※GMVは参考値です。/);
  assert.match(source, /※明細単位の端数処理により、/);
  assert.match(source, /※最低支払額は\$\{threshold\}円です。/);
  // 1000 を直接書かない
  const notesBlock = source.slice(source.indexOf("const notes = ["), source.indexOf("];", source.indexOf("const notes = [")));
  assert.equal(notesBlock.includes("1,000"), false);
  assert.equal(notesBlock.includes("1000"), false);
  // 振込先の説明を注記へ重複させない
  assert.equal(notesBlock.includes("振込先"), false);
});

// -----------------------------------------------------------------------------
// 30: DBへ書き込まない
// -----------------------------------------------------------------------------
test("PDF/ZIP生成はDBへ書き込まない", () => {
  for (const file of [
    "lib/pdf/agency-statement-pdf.ts",
    "lib/pdf/zip.ts",
    "lib/payments/statement-download.ts",
    "app/api/statements/agency/route.ts",
    "app/api/statements/agency/[batchId]/route.ts",
  ]) {
    const source = fs.readFileSync(file, "utf8");
    for (const banned of [".insert(", ".update(", ".upsert(", ".delete(", ".rpc("]) {
      assert.equal(source.includes(banned), false, `${file} に ${banned} がある`);
    }
  }
});

test("経路は GET のみ（書き込みメソッドを持たない）", () => {
  for (const file of [
    "app/api/statements/agency/route.ts",
    "app/api/statements/agency/[batchId]/route.ts",
  ]) {
    const source = fs.readFileSync(file, "utf8");
    assert.match(source, /export async function GET/);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.equal(
        source.includes(`export async function ${method}`),
        false,
        `${file} に ${method} がある`,
      );
    }
  }
});

test("Content-Disposition が日本語ファイル名を壊さない", async () => {
  const dl = await jiti.import(path.join(root, "lib/payments/agency-statement.ts"));
  const name = dl.statementZipFileName("2026-07");
  // RFC 5987 形式を含み、ASCII用のフォールバックも持つ
  const source = fs.readFileSync("lib/payments/statement-download.ts", "utf8");
  assert.match(source, /filename\*=UTF-8''\$\{encodeURIComponent\(/);
  assert.match(source, /asciiFallback/);
  assert.equal(name, "2026-07_代理店支払明細.zip");
});
