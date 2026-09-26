/*
  代理店向け支払明細書の検証。

  ■ DBへ書き込まない
  純関数（ビューモデルの組み立てと表示整形）だけを対象にする。
  fetchPaymentBatchDetail の戻り値の形を模して渡す。

  ■ 何を確かめるか
  1) 承認前・取消の支払明細は明細書として出せない
  2) 支払明細の金額と明細合計がずれていたら出力を拒否する
  3) 紹介制度報酬が含まれていたら出力を拒否する
  4) 代理店以外の支払先は対象にしない
  5) 分配率は混在時に代表値を作らず「複数」と出す
  6) 金額は明細の実額を使い、基準額×率で作り直さない
  7) ファイル名に危険な文字が残らない

  実行:
    node scripts/test-agency-statement.mjs
*/
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const root = process.cwd();
const jiti = createJiti(root, {
  alias: { "@": root },
  interopDefault: true,
  fsCache: false,
});

const mod = await jiti.import(path.join(root, "lib/payments/agency-statement.ts"));

let passed = 0;
const failures = [];

function check(label, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

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
  const sum = (key) => months.reduce((acc, m) => acc + m[key], 0);
  const rates = new Set(months.map((m) => m.ratePct));
  return {
    creatorId: id,
    creatorName: name,
    tiktokId: opts.tiktokId ?? `${id}_tt`,
    referrerName: null,
    periodStartMonth: months[0].targetMonth,
    periodEndMonth: months[months.length - 1].targetMonth,
    gmv: sum("gmv"),
    baseAmount: sum("baseAmount"),
    ratePct:
      months.some((m) => m.hasMixedRate) || rates.size > 1
        ? null
        : months[0].ratePct,
    rewardAmount: sum("rewardAmount"),
    itemCount: sum("itemCount"),
    months,
  };
}

function detailOf({
  status = "approved",
  payeeKind = "agency",
  paymentAmount,
  creators,
  referralCreators = [],
  bank = { state: "ok" },
} = {}) {
  const agencyTotal =
    Math.round(creators.reduce((acc, c) => acc + c.rewardAmount, 0) * 100) / 100;
  const referralTotal =
    Math.round(
      referralCreators.reduce((acc, c) => acc + c.rewardAmount, 0) * 100,
    ) / 100;

  return {
    batch: {
      id: "batch-1",
      payeeKind,
      payeeId: "agency-1",
      payeeName: "テスト代理店",
      cutoffMonth: "2026-07",
      periodStartMonth: "2026-01",
      periodEndMonth: "2026-07",
      itemCount: creators.reduce((acc, c) => acc + c.itemCount, 0),
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
      itemCount: creators.reduce((acc, c) => acc + c.itemCount, 0),
    },
    referralBreakdown: {
      rewardKind: "referral",
      creators: referralCreators,
      totalAmount: referralTotal,
      itemCount: referralCreators.reduce((acc, c) => acc + c.itemCount, 0),
    },
    totalsMatchBatch: true,
    error: null,
  };
}

const okCreators = [
  creator("c1", "クリエイターA", [
    month("2026-05", 120000, 30000, 10, 3000, { itemCount: 12 }),
    month("2026-06", 80000, 20000, 10, 2000, { itemCount: 8 }),
  ]),
  creator("c2", "クリエイターB", [
    month("2026-07", 40000, 10000, 10, 1000.55, { itemCount: 4 }),
  ]),
];

// -----------------------------------------------------------------------------
console.log("=== 代理店向け支払明細書の検証 ===");
console.log("");

console.log("【1】出力できる状態");
for (const status of ["approved", "processing", "paid"]) {
  const built = mod.buildAgencyStatement(detailOf({ status, creators: okCreators }));
  check(`${status} は出力できる`, built.ok === true, built.ok ? "" : built.rejection.message);
}
console.log("");

console.log("【2】出力を拒否する状態");
for (const status of ["draft", "cancelled", "failed"]) {
  const built = mod.buildAgencyStatement(detailOf({ status, creators: okCreators }));
  check(
    `${status} は拒否される`,
    built.ok === false && built.rejection.reason === "status_not_issuable",
  );
}
{
  const built = mod.buildAgencyStatement(
    detailOf({ payeeKind: "referrer", creators: okCreators }),
  );
  check(
    "紹介者への支払明細は対象外",
    built.ok === false && built.rejection.reason === "not_agency",
  );
}
{
  const built = mod.buildAgencyStatement(detailOf({ creators: [] }));
  check(
    "対象明細が0件なら拒否",
    built.ok === false && built.rejection.reason === "no_items",
  );
}
{
  const built = mod.buildAgencyStatement({
    ...detailOf({ creators: okCreators }),
    batch: null,
  });
  check(
    "支払明細が無ければ拒否",
    built.ok === false && built.rejection.reason === "not_found",
  );
}
console.log("");

console.log("【3】金額整合性");
{
  const built = mod.buildAgencyStatement(
    detailOf({ creators: okCreators, paymentAmount: 6000 }),
  );
  check(
    "支払明細の金額と明細合計がずれていたら拒否",
    built.ok === false && built.rejection.reason === "amount_mismatch",
    built.ok ? "" : built.rejection.message,
  );
  check(
    "拒否メッセージに両方の金額が出る",
    built.ok === false &&
      built.rejection.message.includes("6,000") &&
      built.rejection.message.includes("6,001"),
    built.ok ? "" : built.rejection.message,
  );
}
{
  // 1円未満のずれは丸め由来。0.005 以内は同額として扱う
  const base = detailOf({ creators: okCreators });
  const built = mod.buildAgencyStatement({
    ...base,
    batch: { ...base.batch, paymentAmount: base.agencyRewardAmount + 0.004 },
  });
  check("0.005以内のずれは許容", built.ok === true);
}
console.log("");

console.log("【4】紹介制度報酬を載せない");
{
  const referral = [creator("c9", "クリエイターZ", [month("2026-06", 1000, 500, 5, 25)])];
  const built = mod.buildAgencyStatement(
    detailOf({ creators: okCreators, referralCreators: referral }),
  );
  check(
    "紹介制度報酬が占有されていたら拒否",
    built.ok === false && built.rejection.reason === "referral_included",
  );
}
{
  const built = mod.buildAgencyStatement(detailOf({ creators: okCreators }));
  const names = built.ok
    ? built.statement.creators.map((c) => c.creatorName).join(",")
    : "";
  check("正常時のクリエイターは代理店ぶんだけ", names === "クリエイターA,クリエイターB");
  check(
    "明細書の金額は代理店分配報酬の合計",
    built.ok && built.statement.agencyRewardAmount === 6000.55,
    built.ok ? String(built.statement.agencyRewardAmount) : "",
  );
}
console.log("");

console.log("【5】分配率の表示");
check("10% は 10%", mod.formatStatementRate(10) === "10%");
check("小数は2桁まで", mod.formatStatementRate(7.125) === "7.13%");
check("混在は「複数」", mod.formatStatementRate(null) === "複数");
check("0 は —", mod.formatStatementRate(0) === "—");
{
  const mixed = creator("c3", "クリエイターC", [
    month("2026-05", 1000, 500, 10, 50),
    month("2026-06", 1000, 500, 20, 100),
  ]);
  check("月ごとに率が違えば creator は null", mixed.ratePct === null);
  const inMonth = creator("c4", "クリエイターD", [
    month("2026-05", 1000, 500, 10, 50, { hasMixedRate: true }),
  ]);
  check("月内で混在していれば creator は null", inMonth.ratePct === null);
}
console.log("");

console.log("【6】金額を作り直さない");
{
  // 基準額10000 × 10% = 1000 だが、実額は 1000.55
  const c = okCreators[1];
  check(
    "実額を基準額×率で置き換えない",
    c.rewardAmount === 1000.55 && c.baseAmount * (c.ratePct / 100) === 1000,
  );
  const built = mod.buildAgencyStatement(detailOf({ creators: okCreators }));
  check(
    "明細書も実額をそのまま持つ",
    built.ok && built.statement.creators[1].rewardAmount === 1000.55,
  );
}
console.log("");

console.log("【7】表示整形");
check("締め月ラベル", mod.formatStatementCutoffLabel("2026-07") === "2026年7月末");
check("月ラベル", mod.formatStatementMonthLabel("2026-01") === "2026年1月");
check("期間（複数月）", mod.formatStatementPeriodLabel("2026-01", "2026-07") === "2026年1月〜2026年7月");
check("期間（単月）", mod.formatStatementPeriodLabel("2026-07", "2026-07") === "2026年7月");
console.log("");

console.log("【8】ファイル名");
check(
  "通常",
  mod.statementFileBaseName("2026-07", "LUMN") === "2026-07_LUMN_代理店報酬支払明細書",
  mod.statementFileBaseName("2026-07", "LUMN"),
);
check(
  "スラッシュを含む代理店名",
  !mod.sanitizeStatementFileName("A/B:C*D?E").includes("/") &&
    !mod.sanitizeStatementFileName("A/B:C*D?E").includes(":"),
  mod.sanitizeStatementFileName("A/B:C*D?E"),
);
check(
  "日本語は残す",
  mod.sanitizeStatementFileName("株式会社ハイライト") === "株式会社ハイライト",
);
check(
  "感嘆符を含む代理店名（BUZZ L!VE）",
  mod.statementFileBaseName("2026-07", "BUZZ L!VE") ===
    "2026-07_BUZZ-L!VE_代理店報酬支払明細書",
  mod.statementFileBaseName("2026-07", "BUZZ L!VE"),
);
check("空文字は既定名", mod.sanitizeStatementFileName("   ") === "支払明細");
check(
  "パス上位への移動を作らない",
  !mod.sanitizeStatementFileName("../../etc/passwd").startsWith("."),
  mod.sanitizeStatementFileName("../../etc/passwd"),
);
console.log("");

console.log("【9】口座情報を持ち出さない");
{
  const built = mod.buildAgencyStatement(detailOf({ creators: okCreators }));
  const json = JSON.stringify(built);
  check("明細書に口座番号の項目が無い", !json.includes("accountNumber"));
  check("明細書に口座名義の項目が無い", !json.includes("bankAccountHolder"));
  check("登録済みかどうかだけ持つ", built.ok && built.statement.bankRegistered === true);
  const noBank = mod.buildAgencyStatement(
    detailOf({ creators: okCreators, bank: null }),
  );
  check("未登録なら false", noBank.ok && noBank.statement.bankRegistered === false);
}
console.log("");

console.log(`結果: ${passed} 件成功 / ${failures.length} 件失敗`);
if (failures.length > 0) {
  console.log("");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log("✓ すべて期待どおりです");
