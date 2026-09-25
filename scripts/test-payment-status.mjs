/*
  支払明細の状態遷移テスト（DB非依存の純ロジック）。

  遷移表は lib/payments/payment-status.ts が単一ソース。
  同じ条件を RPC 側（supabase/migrations/20260925103000_payment_batch_rpc.sql）
  でも検証しているので、UI を迂回しても破れない。

  実行: node --test scripts/test-payment-status.mjs
*/
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const root = process.cwd();
const jiti = createJiti(root, { alias: { "@": root }, interopDefault: true, fsCache: false });

const s = await jiti.import(path.join(root, "lib/payments/payment-status.ts"));

test("状態は6種類", () => {
  assert.deepEqual([...s.PAYMENT_BATCH_STATUSES], [
    "draft",
    "approved",
    "processing",
    "paid",
    "failed",
    "cancelled",
  ]);
});

test("draft から進める先は approved / cancelled だけ", () => {
  assert.equal(s.canTransitionPaymentBatch("draft", "approved"), true);
  assert.equal(s.canTransitionPaymentBatch("draft", "cancelled"), true);
  // 承認せずに支払済みにはできない
  assert.equal(s.canTransitionPaymentBatch("draft", "paid"), false);
  assert.equal(s.canTransitionPaymentBatch("draft", "processing"), false);
  assert.equal(s.canTransitionPaymentBatch("draft", "failed"), false);
});

test("approved からは振込中 / 支払済み / 失敗 / 取消へ進める", () => {
  for (const to of ["processing", "paid", "failed", "cancelled"]) {
    assert.equal(s.canTransitionPaymentBatch("approved", to), true, to);
  }
  assert.equal(s.canTransitionPaymentBatch("approved", "draft"), false);
});

test("processing からも支払済み / 失敗 / 取消へ進める", () => {
  assert.equal(s.canTransitionPaymentBatch("processing", "paid"), true);
  assert.equal(s.canTransitionPaymentBatch("processing", "failed"), true);
  assert.equal(s.canTransitionPaymentBatch("processing", "cancelled"), true);
  assert.equal(s.canTransitionPaymentBatch("processing", "approved"), false);
});

test("paid からはどこへも進めない（取消も失敗も不可）", () => {
  for (const to of s.PAYMENT_BATCH_STATUSES) {
    assert.equal(s.canTransitionPaymentBatch("paid", to), false, to);
  }
});

test("failed / cancelled は終端", () => {
  for (const from of ["failed", "cancelled"]) {
    assert.equal(s.allowedPaymentBatchTransitions(from).length, 0, from);
    assert.equal(s.isTerminalPaymentBatchStatus(from), true, from);
  }
});

test("占有中とみなすのは draft / approved / processing", () => {
  assert.equal(s.isOpenPaymentBatchStatus("draft"), true);
  assert.equal(s.isOpenPaymentBatchStatus("approved"), true);
  assert.equal(s.isOpenPaymentBatchStatus("processing"), true);
  assert.equal(s.isOpenPaymentBatchStatus("paid"), false);
  assert.equal(s.isOpenPaymentBatchStatus("failed"), false);
  assert.equal(s.isOpenPaymentBatchStatus("cancelled"), false);
});

test("占有を解放できるのは占有中の状態だけ", () => {
  assert.equal(s.canReleasePaymentBatch("approved"), true);
  assert.equal(s.canReleasePaymentBatch("paid"), false);
});

test("監査ログの操作は7種類すべてラベルを持つ", () => {
  for (const action of s.PAYMENT_BATCH_ACTIONS) {
    assert.ok(s.PAYMENT_BATCH_ACTION_LABEL[action], action);
  }
  assert.deepEqual([...s.PAYMENT_BATCH_ACTIONS], [
    "created",
    "approved",
    "csv_exported",
    "processing",
    "paid",
    "failed",
    "cancelled",
  ]);
});

test("未知の状態はステータスとして受け付けない", () => {
  assert.equal(s.isPaymentBatchStatus("unknown"), false);
  assert.equal(s.isPaymentBatchStatus("paid"), true);
  assert.equal(s.paymentBatchStatusLabel("paid"), "支払済み");
  assert.equal(s.paymentBatchStatusLabel("unknown"), "unknown");
});
