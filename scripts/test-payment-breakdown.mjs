/*
  支払根拠の内訳（代理店分配報酬 / 紹介制度報酬）のテスト。

  ■ DBへ触らない
  fetchPaymentBatchDetail の集約規約をソース上で検証し、
  集約結果そのものは純粋な期待値で確認する。

  ■ 何を守っているか
  ・代理店分配額は reward_amount(AP実額) をそのまま合計する
  ・AJ × AK で作り直さない
  ・TAP を混ぜない
  ・紹介制度報酬は保存済み reward_amount を使う
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

const q = await jiti.import(path.join(root, "lib/db/payment-queries.ts"));

/** コメントを除いた本文（コメント中の語で誤検知しないため） */
function sourceWithoutComments(file) {
  return fs
    .readFileSync(path.join(root, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

const QUERIES = sourceWithoutComments("lib/db/payment-queries.ts");
const CLIENT = sourceWithoutComments("app/(app)/payments/[batchId]/PaymentBatchClient.tsx");

// =============================================================================
// 1. 表示元
// =============================================================================
test("代理店分配額は reward_amount を表示元にしている", () => {
  assert.match(QUERIES, /rewardAmount: toAmount\(row\.reward_amount\)/);
});

test("分配計算基準額は creator_revenue_before_split(AJ)", () => {
  assert.match(QUERIES, /baseAmount: toAmount\(row\.creator_revenue_before_split\)/);
});

test("分配率は agency_split_rate(AK)", () => {
  assert.match(QUERIES, /ratePct: toAmount\(row\.agency_split_rate\)/);
});

test("紹介制度報酬は保存済み reward_amount（resolveRewardItemAmount）を使う", () => {
  assert.match(QUERIES, /rewardAmount: resolveRewardItemAmount\(row\)/);
});

test("紹介計算基準額は base_amount(AD)", () => {
  assert.match(QUERIES, /baseAmount: toAmount\(row\.base_amount\)/);
});

// =============================================================================
// 2. AJ × AK で再計算していない
// =============================================================================
test("支払根拠の集約で基準額×率の再計算をしていない", () => {
  for (const src of [QUERIES, CLIENT]) {
    assert.doesNotMatch(src, /creator_revenue_before_split\s*\*/);
    assert.doesNotMatch(src, /agency_split_rate\s*\*/);
    assert.doesNotMatch(src, /baseAmount\s*\*\s*ratePct/);
    assert.doesNotMatch(src, /ratePct\s*\*\s*baseAmount/);
    assert.doesNotMatch(src, /baseAmount\s*\*\s*rate/);
  }
});

test("画面側でも金額を掛け算で作っていない", () => {
  // 表示は month.rewardAmount / creator.rewardAmount をそのまま出すだけ
  assert.match(CLIENT, /\{yen\(month\.rewardAmount\)\}/);
  assert.match(CLIENT, /\{yen\(creator\.rewardAmount\)\}/);
});

// =============================================================================
// 3. TAP を含めない
// =============================================================================
test("支払明細の取得で TAP データを読んでいない", () => {
  // TAP は別テーブル。支払根拠の取得・表示で参照しない
  assert.doesNotMatch(QUERIES, /tap_affiliate_order_lines/);
  assert.doesNotMatch(QUERIES, /tapRevenue|tap_rate/);
  assert.doesNotMatch(CLIENT, /tap_affiliate_order_lines/);
  assert.doesNotMatch(CLIENT, /tapRevenue|tap_rate/);
  // 画面には「TAPを含めない」旨の説明だけを置く
  assert.match(CLIENT, /TAP収益はどちらにも含まれません/);
});

test("明細の取得元は agency_reward_items と referral_reward_items だけ", () => {
  const detail = QUERIES.slice(QUERIES.indexOf("export async function fetchPaymentBatchDetail"));
  const tables = [...detail.matchAll(/"(\w+)",\s*\n\s*"id,/g)].map((m) => m[1]);
  for (const t of tables) {
    assert.ok(
      ["agency_reward_items", "referral_reward_items", "affiliate_order_lines"].includes(t),
      `想定外のテーブル: ${t}`,
    );
  }
});

test("source_row_key の .in() を使っていない（414対策）", () => {
  assert.doesNotMatch(QUERIES, /\.in\("source_row_key"/);
});

// =============================================================================
// 4. 表記
// =============================================================================
test("表記は代理店分配報酬 / 紹介制度報酬", () => {
  assert.equal(q.REWARD_KIND_LABEL.agency, "代理店分配報酬");
  assert.equal(q.REWARD_KIND_LABEL.referral, "紹介制度報酬");
});

test("GMVは参考値として表示される", () => {
  assert.match(CLIENT, /GMV（参考）/);
  assert.match(CLIENT, /報酬の直接の計算基準ではありません/);
});

test("ツールチップの説明が入っている", () => {
  assert.match(CLIENT, /収益分配前のクリエイター収益/);
  assert.match(CLIENT, /明細単位の丸めを反映した実額/);
  assert.match(CLIENT, /成果報酬ベース/);
});

// =============================================================================
// 5〜13. 集約規約（LUMN 実データ相当の期待値で検証）
// =============================================================================
const LUMN_AGENCY = [
  { month: "2026-05", gmv: 47448, base: 1634, rate: 10, reward: 162 },
  { month: "2026-06", gmv: 255677, base: 7802, rate: 10, reward: 786 },
  { month: "2026-07", gmv: 510375, base: 16383, rate: 10, reward: 1634 },
];
const LUMN_REFERRAL = [
  { month: "2026-05", base: 58843, rate: 5, reward: 2942.15 },
  { month: "2026-06", base: 328180, rate: 5, reward: 16409.0 },
  { month: "2026-07", base: 644804, rate: 5, reward: 32240.2 },
];
const round2 = (n) => Math.round(n * 100) / 100;

test("月別合計がクリエイター合計になる（代理店分配）", () => {
  const total = round2(LUMN_AGENCY.reduce((t, m) => t + m.reward, 0));
  assert.equal(total, 2582.0);
});

test("月別合計がクリエイター合計になる（紹介制度・小数あり）", () => {
  const total = round2(LUMN_REFERRAL.reduce((t, m) => t + m.reward, 0));
  assert.equal(total, 51591.35);
});

test("AJ×AK の理論値とAP実額は一致しない（だから再計算してはいけない）", () => {
  for (const m of LUMN_AGENCY) {
    const theoretical = round2((m.base * m.rate) / 100);
    if (m.month !== "2026-06") {
      assert.notEqual(theoretical, m.reward, `${m.month} で差が出るはず`);
    }
  }
  const theoreticalTotal = round2(
    LUMN_AGENCY.reduce((t, m) => t + (m.base * m.rate) / 100, 0),
  );
  assert.notEqual(theoreticalTotal, 2582.0);
  assert.equal(theoreticalTotal, 2581.9);
});

test("画面合計 = 代理店分配報酬 + 紹介制度報酬 = batch payment_amount", () => {
  const agency = round2(LUMN_AGENCY.reduce((t, m) => t + m.reward, 0));
  const referral = round2(LUMN_REFERRAL.reduce((t, m) => t + m.reward, 0));
  assert.equal(round2(agency + referral), 54173.35);
});

test("紹介制度報酬は紹介者×クリエイターでグループ化される", () => {
  // 同じクリエイターを別の紹介者が紹介していても混ざらない
  assert.match(QUERIES, /rewardKind === "referral"\s*\n?\s*\?\s*`\$\{row\.referrerName \?\? ""\}::\$\{row\.creatorId\}`/);
});

test("代理店分配はクリエイター単位でグループ化される", () => {
  assert.match(QUERIES, /:\s*row\.creatorId;/);
});

test("合計不一致なら内訳を表示しない", () => {
  assert.match(CLIENT, /breakdownMatches/);
  assert.match(CLIENT, /支払根拠の内訳が支払明細と一致しません/);
  assert.match(QUERIES, /totalsMatchBatch/);
});

test("締め対象月より後の明細は取得対象にならない（batch占有分だけを読む）", () => {
  const detail = QUERIES.slice(QUERIES.indexOf("export async function fetchPaymentBatchDetail"));
  // 明細は payment_batch_id でのみ絞る。target_month の条件で拾い直さない
  assert.match(detail, /query\.eq\("payment_batch_id", batchId\)/);
  assert.equal((detail.match(/query\.eq\("payment_batch_id", batchId\)/g) ?? []).length, 2);
});
