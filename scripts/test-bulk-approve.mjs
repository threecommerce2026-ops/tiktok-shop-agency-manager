/*
  支払明細の一括承認（ソース規約）のテスト。

  ■ DBへ触らない
  migration SQL と UI/サーバーアクションの規約を検証する。
  実際の RPC 挙動は scripts/verify-bulk-approve.sql が担当。
*/
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const strip = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ").replace(/^\s*--.*$/gm, " ");

const MIGRATION = read("supabase/migrations/20260926140000_approve_payment_batches_bulk.sql");
const SQL = strip(MIGRATION);
const ACTIONS = strip(read("app/actions/payments.ts"));
const UI = strip(read("app/(app)/payments/PaymentsClient.tsx"));

// =============================================================================
// 承認ロジックを二重に持たない
// =============================================================================
test("単体承認と一括承認が同じ共通処理を呼ぶ", () => {
  assert.match(SQL, /create or replace function public\.approve_one_payment_batch/);
  // 単体承認の本体は共通処理へ委譲する
  const single = SQL.slice(
    SQL.indexOf("create or replace function public.approve_payment_batch(p_batch_id uuid)"),
    SQL.indexOf("create or replace function public.approve_payment_batches_bulk"),
  );
  assert.match(single, /perform public\.approve_one_payment_batch\(p_batch_id\)/);
  // 単体側に承認ロジックを再実装していない
  assert.doesNotMatch(single, /update public\.payment_batches/);
  assert.doesNotMatch(single, /bank_account_holder/);

  // 一括承認も共通処理を呼ぶ
  const bulk = SQL.slice(SQL.indexOf("create or replace function public.approve_payment_batches_bulk"));
  assert.match(bulk, /perform public\.approve_one_payment_batch\(v_id\)/);
  assert.doesNotMatch(bulk, /update public\.payment_batches\s+set status = 'approved'/);
});

test("status 遷移と振込先の固定は共通処理にだけある", () => {
  const shared = SQL.slice(
    SQL.indexOf("create or replace function public.approve_one_payment_batch"),
    SQL.indexOf("create or replace function public.approve_payment_batch(p_batch_id uuid)"),
  );
  assert.match(shared, /status = 'approved'/);
  assert.match(shared, /approved_at = now\(\)/);
  assert.match(shared, /approved_by = auth\.uid\(\)/);
  for (const col of [
    "bank_name", "bank_code", "bank_branch_name", "bank_branch_code",
    "bank_account_type", "bank_account_number", "bank_account_holder",
  ]) {
    assert.match(shared, new RegExp(`${col} = v_`), `${col} を固定していない`);
  }
  assert.match(shared, /log_payment_batch_action/);
});

// =============================================================================
// validation
// =============================================================================
test("承認できるのは draft だけ", () => {
  assert.match(SQL, /v_batch\.status <> 'draft'/);
  assert.match(SQL, /承認できるのは下書きの支払明細だけです/);
});

test("振込先の必須項目は単体承認と同じ7項目", () => {
  const shared = SQL.slice(
    SQL.indexOf("create or replace function public.approve_one_payment_batch"),
    SQL.indexOf("create or replace function public.approve_payment_batch(p_batch_id uuid)"),
  );
  for (const v of [
    "v_bank_name", "v_bank_code", "v_branch_name", "v_branch_code",
    "v_account_type", "v_account_number", "v_account_holder",
  ]) {
    assert.match(shared, new RegExp(`btrim\\(${v}\\), ''\\) = ''`), `${v} を検証していない`);
  }
});

test("紹介制度報酬が占有されていたら承認しない", () => {
  assert.match(SQL, /referral_reward_items where payment_batch_id = p_batch_id/);
  assert.match(SQL, /紹介制度報酬が % 件含まれています/);
});

test("件数と金額のスナップショット整合を確認する", () => {
  assert.match(SQL, /明細件数が支払明細と一致しません/);
  assert.match(SQL, /金額が支払明細と一致しません/);
  assert.match(SQL, /対象明細がありません/);
});

test("空・NULL・重複・上限を検証する", () => {
  assert.match(SQL, /支払明細を1件以上選択してください/);
  assert.match(SQL, /array_agg\(distinct x\)/);
  assert.match(SQL, /where x is not null/);
  assert.match(SQL, /v_max_batches constant integer := 100/);
  assert.match(SQL, /一度に承認できる支払明細は % 件までです/);
  assert.match(SQL, /存在しない支払明細が含まれています/);
});

test("締め対象月の混在を拒否する", () => {
  assert.match(SQL, /count\(distinct cutoff_month\)/);
  assert.match(SQL, /締め対象月が異なる支払明細は同時に承認できません/);
});

test("管理者以外は実行できない", () => {
  const bulk = SQL.slice(SQL.indexOf("create or replace function public.approve_payment_batches_bulk"));
  assert.match(bulk, /is_app_admin\(\)/);
  assert.match(bulk, /親管理者のみ実行できます/);
});

test("承認件数が指定件数と一致しなければ失敗する", () => {
  assert.match(SQL, /承認件数が指定件数と一致しません/);
});

// =============================================================================
// migration の安全性
// =============================================================================
test("migration は関数定義と権限だけ", () => {
  const topLevel = MIGRATION.replace(/\$fn\$[\s\S]*?\$fn\$/g, " BODY ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*--.*$/gm, " ");
  const stmts = topLevel.split(";").map((x) => x.trim()).filter(Boolean);
  for (const st of stmts) {
    assert.match(
      st,
      /^(create or replace function|revoke|grant)/i,
      `想定外のトップレベル文: ${st.slice(0, 60)}`,
    );
  }
  assert.doesNotMatch(MIGRATION, /delete\s+from/i);
  assert.doesNotMatch(MIGRATION, /truncate/i);
  assert.doesNotMatch(MIGRATION, /alter table/i);
  // reward / batch のデータ操作をトップレベルでしない
  assert.doesNotMatch(topLevel, /insert\s+into/i);
  assert.doesNotMatch(topLevel, /update\s+public\./i);
});

test("共通処理は直接実行させない", () => {
  assert.match(MIGRATION, /revoke all on function public\.approve_one_payment_batch\(uuid\) from public, anon, authenticated/);
  assert.match(MIGRATION, /grant execute on function public\.approve_payment_batches_bulk\(uuid\[\]\) to authenticated, service_role/);
});

// =============================================================================
// サーバーアクション
// =============================================================================
test("サーバー側で選択内容を再検証する", () => {
  const fn = ACTIONS.slice(ACTIONS.indexOf("export async function approvePaymentBatchesBulkAction"));
  assert.match(fn, /requireAdminAction/);
  assert.match(fn, /new Set\(readList\(formData, "batch_id"\)\)/);
  assert.match(fn, /fetchPaymentOverview/);
  assert.match(fn, /batch\.status !== "draft"/);
  assert.match(fn, /締め対象月が異なる支払明細は同時に承認できません/);
  assert.match(fn, /approve_payment_batches_bulk/);
});

test("失敗時は部分成功させず、原因を返す", () => {
  const fn = ACTIONS.slice(ACTIONS.indexOf("export async function approvePaymentBatchesBulkAction"));
  assert.match(fn, /承認された支払明細はありません/);
  // 1件ずつ RPC を呼ぶループにしていない（atomic RPC を1回だけ呼ぶ）
  assert.doesNotMatch(fn, /for \(const .* of batchIds\)[\s\S]*?rpc\(/);
});

// =============================================================================
// UI
// =============================================================================
test("選択できるのは draft の代理店明細だけ", () => {
  assert.match(UI, /function isBulkApprovable/);
  assert.match(UI, /batch\.status === "draft" && batch\.payeeKind === "agency"/);
  assert.match(UI, /disabled=\{!isBulkApprovable\(batch\)\}/);
});

test("すべて選択・選択解除・選択中の件数と金額を出す", () => {
  assert.match(UI, /下書きをすべて選択/);
  assert.match(UI, /選択を解除/);
  assert.match(UI, /\{approveTargets\.length\} 件 \/ \{yen\(approveAmount\)\}/);
});

test("押した瞬間には承認せず確認を挟む", () => {
  assert.match(UI, /setConfirmingApprove\(true\)/);
  assert.match(UI, /支払明細を一括承認します/);
  assert.match(UI, /件を承認して振込先を固定/);
  assert.match(UI, /戻る/);
});

test("確認画面に振込先が固定される旨を出す", () => {
  assert.match(UI, /現在登録されている振込先情報が固定されます/);
  assert.match(UI, /振込先は変更されません/);
  assert.match(UI, /承認しても支払済みにはなりません/);
});

test("送信中はボタンを無効化する（二重押下防止）", () => {
  assert.match(UI, /disabled=\{bulkApprovePending \|\| approveCutoffs\.length > 1\}/);
  assert.match(UI, /承認中…/);
});

test("締め月混在は画面でも止める", () => {
  assert.match(UI, /approveCutoffs\.length > 1/);
  assert.match(UI, /締め対象月が異なる支払明細は同時に承認できません/);
});
