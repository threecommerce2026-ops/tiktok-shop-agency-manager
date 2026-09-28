/*
  TAP実績（クリエイター単位の成果と報酬構造）のテスト。

  DBへは接続せず、集計ロジックと実装の規約を確かめる。
  実行: node --test scripts/test-tap-creator-overview.mjs

  ■ このテストが守っているもの
  ① 対象行の判定を書き写さず、既存の正式条件を呼ぶこと
  ② 4つの金額を合算しないこと
  ③ 紹介者がいない creator へ紹介報酬を作らないこと
  ④ 紹介報酬は referral_reward_items が唯一の正であること
  ⑤ 支払操作を置かないこと（読み取り専用）
  ⑥ ブラウザへ TAP の生データを渡さないこと
*/
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const root = process.cwd();
const jiti = createJiti(root, {
  alias: { "@": root },
  interopDefault: true,
  fsCache: false,
});

const tapSrc = await jiti.import(path.join(root, "lib/referrals/tap-referral-source.ts"));
const cutoff = await jiti.import(path.join(root, "lib/payments/cutoff-month.ts"));

const read = (file) => readFileSync(path.join(root, file), "utf8");
const QUERIES_RAW = read("lib/db/tap-creator-queries.ts");
const UI_RAW = read("app/(app)/payments/PaymentsClient.tsx");
const ACTIONS_RAW = read("app/actions/payments.ts");
const PAYMENT_QUERIES_RAW = read("lib/db/payment-queries.ts");

/** コメントを除いたコード本体（説明文で誤検知させない） */
function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

const QUERIES = codeOnly(QUERIES_RAW);
const UI = codeOnly(UI_RAW);
const ACTIONS = codeOnly(ACTIONS_RAW);

// =============================================================================
// 対象行の判定（独自実装を作らない）
// =============================================================================
test("対象行の判定は既存の正式条件を呼ぶ（条件を書き写さない）", () => {
  assert.match(
    QUERIES,
    /isTapReferralSourceLine\(/,
    "正式な eligible 判定を使っていない",
  );
  for (const copied of [
    /決済済み/,
    /支払い済み/,
    /fully_refunded/,
    /commission_base.*>\s*0/,
  ]) {
    assert.equal(
      copied.test(QUERIES),
      false,
      `eligible 条件を書き写している: ${copied}`,
    );
  }
});

test("正式条件の中身（退行検知）", () => {
  const line = (over = {}) => ({
    source_row_key: "k",
    order_id: null,
    product_id: null,
    creator_id: "c1",
    target_month: "2026-05",
    commission_base: 1000,
    payment_status: "支払い済み",
    order_status: "決済済み",
    refund_status: "いいえ",
    ...over,
  });

  assert.equal(tapSrc.isTapReferralSourceLine(line()), true);
  assert.equal(tapSrc.isTapReferralSourceLine(line({ creator_id: null })), false);
  assert.equal(tapSrc.isTapReferralSourceLine(line({ source_row_key: null })), false);
  assert.equal(tapSrc.isTapReferralSourceLine(line({ target_month: null })), false);
  assert.equal(tapSrc.isTapReferralSourceLine(line({ payment_status: "未払い" })), false);
  assert.equal(tapSrc.isTapReferralSourceLine(line({ refund_status: "はい" })), false);
  assert.equal(tapSrc.isTapReferralSourceLine(line({ commission_base: 0 })), false);
});

// =============================================================================
// 4つの金額を混ぜない
// =============================================================================
test("4つの金額を別々の項目として持つ", () => {
  for (const field of [
    "commissionBase",
    "tapRevenue",
    "creatorEstimatedCommission",
    "referralRewardAmount",
  ]) {
    assert.match(QUERIES, new RegExp(`${field}:`), `${field} を返していない`);
  }
});

test("合算した金額を作らない", () => {
  for (const forbidden of [/totalReward/i, /grandTotal/i, /combinedAmount/i]) {
    assert.equal(forbidden.test(QUERIES), false, `合算値を作っている: ${forbidden}`);
    assert.equal(forbidden.test(UI), false, `画面が合算値を出している: ${forbidden}`);
  }
  // 4指標を足し合わせる式が無いこと
  assert.equal(
    /commissionBase\s*\+\s*tapRevenue/.test(QUERIES),
    false,
    "基礎額と THREE 報酬を足している",
  );
  assert.equal(
    /tapRevenue\s*\+\s*creatorEstimatedCommission/.test(QUERIES),
    false,
    "THREE 報酬とクリエイター報酬を足している",
  );
});

test("画面は4つの金額を別の列で出す", () => {
  for (const label of [
    "成果報酬ベース",
    "THREE報酬",
    "クリエイター報酬",
    "紹介報酬",
  ]) {
    assert.ok(UI_RAW.includes(label), `列 ${label} が無い`);
  }
  assert.ok(UI_RAW.includes("合算した数字は出していません"), "注意書きが無い");
});

// =============================================================================
// 紹介報酬は referral_reward_items が唯一の正
// =============================================================================
test("紹介報酬を再計算しない（5% をここで掛けない）", () => {
  assert.equal(
    /0\.05/.test(QUERIES),
    false,
    "TAP実績側で 5% を計算している",
  );
  assert.equal(
    /REFERRAL_REWARD_RATE/.test(QUERIES),
    false,
    "紹介料率をここで使っている",
  );
  assert.match(
    QUERIES,
    /"referral_reward_items"/,
    "紹介報酬を実績テーブルから読んでいない",
  );
  assert.match(QUERIES, /resolveRewardItemAmount\(/);
});

test("紹介報酬は is_reward_target の明細だけ数える", () => {
  assert.match(
    QUERIES,
    /if \(!item\.is_reward_target\) continue;/,
    "対象外の明細まで紹介報酬に数えている",
  );
});

test("紹介者の状態を3つに分ける（あり / 期間外 / なし）", () => {
  assert.match(QUERIES, /"assigned" \| "out_of_period" \| "none"/);
  assert.match(QUERIES, /referrerState = covering \? "assigned" : "out_of_period"/);
  assert.ok(UI_RAW.includes("期間外"), "画面に期間外の表示が無い");
});

// =============================================================================
// 書き込みをしない
// =============================================================================
test("TAP実績の集計は参照のみ", () => {
  for (const forbidden of [/\.update\(/, /\.delete\(/, /\.upsert\(/, /\.insert\(/, /\.rpc\(/]) {
    assert.equal(forbidden.test(QUERIES), false, `書き込みを行っている: ${forbidden}`);
  }
});

test("TAP実績タブに支払操作を置かない", () => {
  const start = UI.indexOf("function TapPerformanceTab");
  assert.ok(start >= 0, "TapPerformanceTab が無い");
  const block = UI.slice(start, UI.indexOf("\nfunction ", start + 10));

  for (const forbidden of [
    /createPaymentBatchAction/,
    /setReferralPaymentHoldAction/,
    /clearReferralPaymentHoldAction/,
    /approvePaymentBatchesBulkAction/,
    /exportPaymentCsvAction/,
    /<form/,
  ]) {
    assert.equal(forbidden.test(block), false, `支払操作を置いている: ${forbidden}`);
  }
});

test("クリエイター報酬の欠損を 0 として黙って飲み込まない", () => {
  assert.match(QUERIES, /creatorCommissionMissingCount/);
  assert.match(QUERIES, /missing: true/);
  assert.ok(
    UI_RAW.includes("記録されていない明細"),
    "欠損件数を画面へ出していない",
  );
});

// =============================================================================
// ブラウザへ生データを渡さない
// =============================================================================
test("raw_row_json をまるごと取らない（1キーだけ取り出す）", () => {
  assert.match(
    QUERIES,
    /creator_commission_raw:raw_row_json->>/,
    "JSON の1キー取り出しを使っていない",
  );
  assert.equal(
    /"raw_row_json"/.test(QUERIES),
    false,
    "raw_row_json を列としてまるごと取得している",
  );
});

test("集計後の行だけを画面へ渡す（明細を渡さない）", () => {
  const start = QUERIES.indexOf("export type TapCreatorOverview");
  const block = QUERIES.slice(start, QUERIES.indexOf("};", start));
  assert.match(block, /rows: TapCreatorRow\[\]/);
  assert.equal(/lines:/.test(block), false, "明細行を画面へ渡している");
  assert.equal(/items:/.test(block), false, "明細行を画面へ渡している");
});

test("TAP実績はタブを開いたときに取り寄せる（初期表示を重くしない）", () => {
  assert.match(ACTIONS, /export async function fetchTapCreatorOverviewAction/);
  assert.match(ACTIONS, /requireAdminAction\(\)/);
  assert.match(UI, /await fetchTapCreatorOverviewAction\(\)/);
  // ページの初期ロードには載せない
  const page = codeOnly(read("app/(app)/payments/page.tsx"));
  assert.equal(
    /fetchTapCreatorOverview/.test(page),
    false,
    "/payments の初期表示で TAP を読み込んでいる（他タブまで遅くなる）",
  );
});

// =============================================================================
// 対象期間
// =============================================================================
test("既定の対象期間は 2026-01〜2026-07", () => {
  assert.match(QUERIES, /options\.startMonth \?\? EARLIEST_CUTOFF_MONTH/);
  assert.match(QUERIES, /options\.endMonth \?\? MAX_REFERRAL_PAYMENT_CUTOFF_MONTH/);
  assert.equal(cutoff.EARLIEST_CUTOFF_MONTH, "2026-01");
  assert.equal(cutoff.MAX_REFERRAL_PAYMENT_CUTOFF_MONTH, "2026-07");
});

// =============================================================================
// 既存 Payment を壊さない
// =============================================================================
test("タブを増やしただけで既存タブを消していない", () => {
  for (const label of ["代理店", "紹介者", "振込保留", "支払履歴", "セラー請求"]) {
    assert.ok(UI_RAW.includes(`label: "${label}"`), `既存タブ ${label} が消えている`);
  }
  assert.ok(UI_RAW.includes('label: "TAP実績"'), "TAP実績タブが無い");
});

test("既存の紹介者支払ロジックに触れていない", () => {
  // claim / manual_hold / threshold / 銀行 / settlement の判定は payment-queries 側のまま
  assert.match(PAYMENT_QUERIES_RAW, /isFullyManualHeld/);
  assert.match(PAYMENT_QUERIES_RAW, /REFERRAL_PAYOUT_THRESHOLD_YEN/);
  assert.match(PAYMENT_QUERIES_RAW, /resolvePaymentHoldReasons/);
  assert.match(PAYMENT_QUERIES_RAW, /inReferralClaimRange/);
  // TAP実績は payment-queries を書き換えていない
  assert.equal(
    /tap-creator-queries/.test(PAYMENT_QUERIES_RAW),
    false,
    "支払側から TAP実績へ依存している",
  );
});

test("TAP実績は PaymentUnpaidRow へ混ぜない", () => {
  assert.equal(
    /PaymentUnpaidRow/.test(QUERIES),
    false,
    "支払先の型へ TAP のクリエイターを混ぜている",
  );
  assert.equal(
    /isPayable|holdReasons|payment_batch_id/.test(QUERIES),
    false,
    "支払判定を TAP実績へ持ち込んでいる",
  );
});

// =============================================================================
// フィルター
// =============================================================================
test("フィルターと並び替えがある", () => {
  assert.match(UI, /TAP_AGENCY_FILTERS/);
  assert.match(UI, /TAP_REFERRER_FILTERS/);
  assert.match(UI, /TAP_SORTS/);
  for (const key of [
    "commissionBase",
    "tapRevenue",
    "creatorEstimatedCommission",
    "referralRewardAmount",
  ]) {
    assert.ok(UI.includes(`key: "${key}"`), `${key} で並び替えできない`);
  }
});

test("所属は既存の月別確定と is_in_house から決める（推測しない）", () => {
  assert.match(QUERIES, /"creator_monthly_agency_assignments"/);
  assert.match(QUERIES, /isInHouse: row\.is_in_house === true/);
  assert.match(QUERIES, /agencyState = "unconfirmed"/);
  assert.match(QUERIES, /partially_unconfirmed/);
  // 名前で自社判定しない
  assert.equal(
    /THREE\.inc/.test(QUERIES),
    false,
    "代理店名の文字列で自社を判定している",
  );
});
