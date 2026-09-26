/*
  最低支払額（¥1,000）のテスト。

  ■ DBへ触らない
  定数と、それを参照している箇所の規約を検証する。
  実際の claim / 承認の挙動は scripts/verify-minimum-payout.sql が担当。
*/
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const root = process.cwd();
const jiti = createJiti(root, { alias: { "@": root }, interopDefault: true, fsCache: false });

const min = await jiti.import(path.join(root, "lib/payments/minimum-payout.ts"));
const payable = await jiti.import(path.join(root, "lib/payments/payable.ts"));

const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const strip = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ").replace(/^\s*--.*$/gm, " ");

const QUERIES = strip(read("lib/db/payment-queries.ts"));
const ACTIONS = strip(read("app/actions/payments.ts"));
const APPROVE_MIGRATION = read("supabase/migrations/20260926150000_approve_minimum_payout.sql");

// =============================================================================
// 16. 定数の整合性
// =============================================================================
test("最低支払額の既定は 1,000円", () => {
  assert.equal(min.DEFAULT_MINIMUM_PAYOUT_YEN, 1000);
  assert.equal(min.AGENCY_PAYOUT_THRESHOLD_YEN, 1000);
});

test("承認RPCの最低支払額が TypeScript の定数と一致する", () => {
  // RPC は SQL なので定数を共有できない。値のズレをここで検出する
  const m = APPROVE_MIGRATION.match(/v_minimum_payout constant numeric := (\d+)/);
  assert.ok(m, "migration に v_minimum_payout が無い");
  assert.equal(Number(m[1]), min.DEFAULT_MINIMUM_PAYOUT_YEN);
});

test("1000 を各所へ直接書いていない", () => {
  // 画面の支払可否と claim は定数を参照する
  assert.match(QUERIES, /AGENCY_PAYOUT_THRESHOLD_YEN/);
  assert.match(ACTIONS, /AGENCY_PAYOUT_THRESHOLD_YEN/);
  assert.doesNotMatch(QUERIES, /sumAgencyAmounts,\s*0\s*\)/);
  assert.doesNotMatch(ACTIONS, /payeeKind === "referrer" \? REFERRAL_PAYOUT_THRESHOLD_YEN : 0/);
});

test("紹介者側の既存設定と互換（REFERRAL_MINIMUM_PAYOUT）", async () => {
  const ref = await jiti.import(path.join(root, "lib/referrals/referral-reward-engine.ts"));
  assert.equal(ref.REFERRAL_PAYOUT_THRESHOLD_YEN, 1000);
});

// =============================================================================
// 判定ロジック（累積での判定 / 境界）
// =============================================================================
const base = {
  isInHouse: false,
  bankState: "registered",
  hasUnconfirmedAssignment: false,
  hasUnconfirmedReward: false,
};
const judge = (unpaidAmount) =>
  payable.resolvePaymentHoldReasons({
    ...base,
    unpaidAmount,
    thresholdAmount: min.AGENCY_PAYOUT_THRESHOLD_YEN,
  });

test("4. ちょうど ¥1,000 は支払対象（境界）", () => {
  assert.deepEqual(judge(1000), []);
  assert.equal(
    payable.isPayable({ ...base, unpaidAmount: 1000, thresholdAmount: 1000 }),
    true,
  );
});

test("5. ¥999 は below_threshold（境界）", () => {
  assert.deepEqual(judge(999), ["below_threshold"]);
  assert.equal(
    payable.isPayable({ ...base, unpaidAmount: 999, thresholdAmount: 1000 }),
    false,
  );
});

test("3. 単月 ¥600 ×2ヶ月 = 累積 ¥1,200 は支払対象", () => {
  // 判定対象は締め月までの未払い累積。単月では判定しない
  const monthly = [600, 600];
  const cumulative = monthly.reduce((a, b) => a + b, 0);
  assert.equal(cumulative, 1200);
  assert.deepEqual(judge(cumulative), []);
  // 単月で判定してしまうと両方 below_threshold になる（そうしてはいけない）
  for (const m of monthly) assert.deepEqual(judge(m), ["below_threshold"]);
});

test("13. 7月末の実額（5件 ¥31,540 / 繰越 4件 ¥1,315）", () => {
  const payableAgencies = [8392, 7754, 7090, 5722, 2582];
  const carried = [621, 394, 152, 148];
  for (const amt of payableAgencies) assert.deepEqual(judge(amt), [], `${amt}`);
  for (const amt of carried) assert.deepEqual(judge(amt), ["below_threshold"], `${amt}`);
  assert.equal(payableAgencies.reduce((a, b) => a + b, 0), 31540);
  assert.equal(carried.reduce((a, b) => a + b, 0), 1315);
});

test("8. 翌月に累積が ¥1,000 を超えたら支払対象になる", () => {
  const july = 621;
  assert.deepEqual(judge(july), ["below_threshold"]);
  // 8月に 400 発生すれば累積 1,021 で支払対象
  assert.deepEqual(judge(july + 400), []);
});

// =============================================================================
// 12. bank_missing との区別 / 15. in_house
// =============================================================================
test("12. bank_missing と below_threshold は別理由", () => {
  // 進藤響希: 累積 2,896 で threshold はクリア、口座だけ未登録
  const shindo = payable.resolvePaymentHoldReasons({
    ...base,
    bankState: "missing",
    unpaidAmount: 2896,
    thresholdAmount: 1000,
  });
  assert.deepEqual(shindo, ["bank_missing"]);
  assert.equal(shindo.includes("below_threshold"), false);

  // 口座未登録かつ最低支払額未満なら両方立つ
  const both = payable.resolvePaymentHoldReasons({
    ...base,
    bankState: "missing",
    unpaidAmount: 500,
    thresholdAmount: 1000,
  });
  assert.deepEqual(both, ["bank_missing", "below_threshold"]);
});

test("15. in_house は最低支払額以前に除外される", () => {
  const reasons = payable.resolvePaymentHoldReasons({
    ...base,
    isInHouse: true,
    unpaidAmount: 50000,
    thresholdAmount: 1000,
  });
  assert.ok(reasons.includes("in_house"));
  assert.equal(
    payable.isPayable({ ...base, isInHouse: true, unpaidAmount: 50000, thresholdAmount: 1000 }),
    false,
  );
});

test("未払いが 0 円なら below_threshold を立てない", () => {
  assert.deepEqual(judge(0), []);
  assert.equal(payable.isPayable({ ...base, unpaidAmount: 0, thresholdAmount: 1000 }), false);
});

// =============================================================================
// 11. UI 表記
// =============================================================================
test("11. below_threshold の表記が「最低支払額未満（翌月へ繰越）」", () => {
  assert.equal(payable.PAYMENT_HOLD_REASON_LABEL.below_threshold, "最低支払額未満（翌月へ繰越）");
  assert.match(payable.PAYMENT_HOLD_REASON_HINT.below_threshold, /最低支払額/);
  assert.match(payable.PAYMENT_HOLD_REASON_HINT.below_threshold, /繰り越/);
  assert.match(payable.PAYMENT_HOLD_REASON_HINT.below_threshold, /消さず/);
});

test("表示用ラベルが作れる", () => {
  assert.equal(min.formatMinimumPayoutLabel(1000), "最低支払額未満（¥1,000）");
});

// =============================================================================
// 9/10. 承認側の検証
// =============================================================================
test("9. 承認RPCが最低支払額未満を拒否する", () => {
  assert.match(APPROVE_MIGRATION, /v_batch\.payment_amount < v_minimum_payout/);
  assert.match(APPROVE_MIGRATION, /最低支払額に達していないため承認できません/);
  assert.match(APPROVE_MIGRATION, /翌月以降へ繰り越してください/);
});

test("10. 単体承認・一括承認の共通処理に入っている", () => {
  // approve_one_payment_batch だけを差し替える（両方の入口がこれを呼ぶ）
  assert.match(APPROVE_MIGRATION, /create or replace function public\.approve_one_payment_batch/i);
  assert.doesNotMatch(APPROVE_MIGRATION, /function public\.approve_payment_batches_bulk/);
  assert.doesNotMatch(APPROVE_MIGRATION, /function public\.approve_payment_batch\(/);
});

test("承認RPCは支払先名が確定した後に判定する", () => {
  const payeeIdx = APPROVE_MIGRATION.indexOf("支払先が見つかりません");
  const minIdx = APPROVE_MIGRATION.indexOf("最低支払額に達していないため");
  const bankIdx = APPROVE_MIGRATION.indexOf("振込先が不足しているため");
  assert.ok(payeeIdx < minIdx, "支払先名の解決より前に判定している");
  assert.ok(minIdx < bankIdx, "振込先チェックより後に判定している");
});

test("migration はテーブル変更・データ操作をしない", () => {
  const topLevel = APPROVE_MIGRATION.replace(/\$function\$[\s\S]*?\$function\$/g, " BODY ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  const stmts = topLevel.split(";").map((x) => x.trim()).filter(Boolean);
  assert.equal(stmts.length, 1);
  assert.match(stmts[0], /^create or replace function/i);
  for (const kw of [/delete\s+from/i, /truncate/i, /alter table/i, /drop\s+table/i]) {
    assert.doesNotMatch(APPROVE_MIGRATION, kw);
  }
});

// =============================================================================
// 14. 紹介制度報酬が支払額に入らない
// =============================================================================
test("14. 代理店の判定額に紹介制度報酬が入らない", () => {
  // 代理店行の referralRewardAmount は常に 0
  assert.match(QUERIES, /referralRewardAmount: 0,/);
  // 判定は acc.claimable（agency_reward_items のみ）
  assert.match(QUERIES, /const unpaidAmount = sum\(acc\.claimable\)/);
});
