/*
  代理店への支払は「代理店分配報酬のみ」であることのテスト。

  ■ DBへ触らない
  migration SQL とソースの規約を検証する。

  ■ 何を守っているか
  ・agency の claim は agency_reward_items だけ
  ・agency の振込額に紹介制度報酬を加算しない
  ・referral_reward_items を変更しない
  ・release / complete は両テーブル対応を維持（旧明細の解放に必要）
  ・cutoff と二重支払い防止の4条件は維持
*/
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ").replace(/^\s*--.*$/gm, " ");

const MIGRATION = read("supabase/migrations/20260926130000_claim_agency_reward_only.sql");
const CLAIM = stripComments(MIGRATION);
const QUERIES = stripComments(read("lib/db/payment-queries.ts"));
const PAYMENTS_UI = stripComments(read("app/(app)/payments/PaymentsClient.tsx"));
const BULK_UI = stripComments(read("app/(app)/payments/bulk/BulkSettlementClient.tsx"));
const DETAIL_UI = stripComments(read("app/(app)/payments/[batchId]/PaymentBatchClient.tsx"));

/** agency 分岐（if p_payee_kind = 'agency' ... else）を切り出す */
function agencyBranch(sql) {
  const claimStart = sql.lastIndexOf("if p_payee_kind = 'agency' then");
  const elseIdx = sql.indexOf("\n  else", claimStart);
  return sql.slice(claimStart, elseIdx);
}

// =============================================================================
// 1〜3. claim は agency_reward_items のみ
// =============================================================================
test("1. agency claim は agency_reward_items だけを占有する", () => {
  const branch = agencyBranch(CLAIM);
  assert.match(branch, /update public\.agency_reward_items/);
  assert.equal(
    (branch.match(/update public\.agency_reward_items/g) ?? []).length,
    1,
    "agency_reward_items の update は1つ",
  );
});

test("2. agency claim で referral_reward_items を占有しない", () => {
  const branch = agencyBranch(CLAIM);
  assert.doesNotMatch(branch, /referral_reward_items/);
  assert.doesNotMatch(branch, /referrers r where r\.agency_id/);
});

test("3. agency の振込額に紹介制度報酬を加算しない", () => {
  assert.doesNotMatch(CLAIM, /v_ref_count/);
  assert.doesNotMatch(CLAIM, /v_ref_amount/);
  assert.doesNotMatch(CLAIM, /v_amount := v_amount \+/);
  assert.doesNotMatch(CLAIM, /v_count := v_count \+/);
});

test("legacy referrer 分岐は残っている", () => {
  // agency 分岐の後ろ（else 側）に referral の占有が残る
  const elseIdx = CLAIM.indexOf("\n  else", CLAIM.lastIndexOf("if p_payee_kind = 'agency' then"));
  const elseBranch = CLAIM.slice(elseIdx);
  assert.match(elseBranch, /update public\.referral_reward_items/);
  assert.match(elseBranch, /where referrer_id = p_payee_id/);
});

// =============================================================================
// 4. referral_reward_items を変更しない
// =============================================================================
test("4. migration が referral_reward_items を DELETE / 書き換えしない", () => {
  assert.doesNotMatch(MIGRATION, /delete\s+from/i);
  assert.doesNotMatch(MIGRATION, /is_reward_target\s*=\s*false/i);
  assert.doesNotMatch(MIGRATION, /drop\s+table/i);
  assert.doesNotMatch(MIGRATION, /truncate/i);
  // トップレベルは create or replace function だけ
  const topLevel = MIGRATION.replace(/\$function\$[\s\S]*?\$function\$/g, " BODY ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  const stmts = topLevel.split(";").map((x) => x.trim()).filter(Boolean);
  assert.equal(stmts.length, 1, `トップレベル文は1つ: ${stmts.length}`);
  assert.match(stmts[0], /^create or replace function/i);
});

// =============================================================================
// 5. release / complete は両テーブル対応を維持（旧明細の解放に必要）
// =============================================================================
test("5. migration は release / complete を変更していない", () => {
  assert.doesNotMatch(MIGRATION, /release_payment_batch_items\s*\(/);
  assert.doesNotMatch(MIGRATION, /function public\.release_payment_batch_items/);
  assert.doesNotMatch(MIGRATION, /function public\.complete_payment_batch/);
});

// =============================================================================
// 6〜7. cutoff と二重支払い防止を維持
// =============================================================================
test("6. cutoff 検証と claim 上限が維持されている", () => {
  assert.match(CLAIM, /target_month <= p_cutoff_month/);
  assert.match(CLAIM, /未来月/.test(MIGRATION) ? /p_cutoff_month/ : /p_cutoff_month/);
  assert.match(MIGRATION, /未来月は指定できません/);
  assert.match(CLAIM, /Asia\/Tokyo/);
  assert.doesNotMatch(CLAIM, /p_period_end_month/);
});

test("7. 二重支払い防止の4条件が維持されている", () => {
  const branch = agencyBranch(CLAIM);
  assert.match(branch, /is_reward_target = true/);
  assert.match(branch, /is_paid = false/);
  assert.match(branch, /payout_id is null/);
  assert.match(branch, /payment_batch_id is null/);
});

// =============================================================================
// 8. in_house / 振込先 guard を維持
// =============================================================================
test("8. in_house guard と振込先チェックが維持されている", () => {
  assert.match(MIGRATION, /自社です。外部への支払対象ではありません/);
  assert.match(MIGRATION, /振込先が未登録です/);
  assert.match(MIGRATION, /金融機関コード \/ 支店コードが未登録です/);
  assert.match(MIGRATION, /代理店に帰属しています/);
});

// =============================================================================
// Overview / KPI
// =============================================================================
test("代理店行の紹介制度報酬は常に 0", () => {
  assert.match(QUERIES, /referralRewardAmount: 0,/);
  assert.match(QUERIES, /referrerCount: 0,/);
});

test("紹介報酬を代理店の accumulator へ寄せる処理が無い", () => {
  assert.doesNotMatch(QUERIES, /agencyAcc\.get\(mergeAgencyId\)/);
  assert.doesNotMatch(QUERIES, /mergeAgencyId/);
});

test("紹介者の行を支払候補として作らない", () => {
  assert.doesNotMatch(QUERIES, /for \(const \[referrerId, acc\] of referralAcc\)/);
  assert.doesNotMatch(QUERIES, /referralAcc/);
});

test("KPI の紹介制度報酬は参考値で、支払予定額に入らない", () => {
  assert.match(QUERIES, /referrerUnpaidAmount: referralReferenceAmount,/);
  assert.match(PAYMENTS_UI, /紹介制度報酬（支払対象外）/);
  assert.match(PAYMENTS_UI, /支払予定額・支払可能額には含まれません/);
  // 締め対象KPIは代理店分配報酬のみ
  assert.doesNotMatch(
    PAYMENTS_UI,
    /agencyUnpaidAmount \+ overview\.totals\.referrerUnpaidAmount/,
  );
});

// =============================================================================
// UI
// =============================================================================
test("一括精算の表から紹介報酬列が消えている", () => {
  assert.doesNotMatch(BULK_UI, /<th[^>]*>紹介報酬<\/th>/);
  assert.doesNotMatch(BULK_UI, /row\.referralRewardAmount/);
  assert.match(BULK_UI, /代理店分配報酬/);
});

test("17. 旧batchの紹介制度報酬は履歴として確認できる", () => {
  assert.match(DETAIL_UI, /hasLegacyReferral/);
  assert.match(DETAIL_UI, /旧仕様：紹介制度報酬/);
  assert.match(DETAIL_UI, /detail\.referralBreakdown\.creators\.length > 0/);
});

test("18. 新agency batchには紹介制度報酬セクションが出ない", () => {
  const agencySection = DETAIL_UI.indexOf("breakdown={detail.agencyBreakdown}");
  const referralSection = DETAIL_UI.indexOf("breakdown={detail.referralBreakdown}");
  assert.ok(agencySection >= 0, "代理店分配報酬セクションが無い");
  assert.ok(referralSection > agencySection, "紹介セクションが代理店セクションより前にある");

  // 代理店セクションと紹介セクションの間に hasLegacyReferral のゲートがある
  // = 代理店は無条件、紹介は旧明細があるときだけ、という構造
  const between = DETAIL_UI.slice(agencySection, referralSection);
  assert.match(between, /\{hasLegacyReferral \?/);

  // 紹介セクションの参照は1箇所だけ
  assert.equal(
    (DETAIL_UI.match(/breakdown=\{detail\.referralBreakdown\}/g) ?? []).length,
    1,
  );
});
