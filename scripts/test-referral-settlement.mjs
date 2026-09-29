/*
  紹介者報酬の月次確定（finalize / unfinalize）のテスト。

  DBへは接続せず、migration と実装の規約を検査する。
  実行: node --test scripts/test-referral-settlement.mjs

  ■ このテストが守っているもの
  ① 確定は管理者かつ本人が特定できるときだけ（監査証跡が必ず残る）
  ② 対象の1か月しか変えない
  ③ 二重確定で finalized_at / finalized_by を書き換えない
  ④ 支払処理へ進んだ月は解除できない（DB側の歯止め）
  ⑤ 報酬額・紹介関係・代理店側に触れない
  ⑥ 特定の年月をハードコードしない（将来の月も同じ経路で確定する）
  ⑦ 画面やサーバーアクションがテーブルを直接更新しない
*/
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = process.cwd();
const read = (file) => readFileSync(path.join(root, file), "utf8");

const MIGRATION_RAW = read(
  "supabase/migrations/20260929100000_referral_settlement_finalize.sql",
);
const ACTIONS_RAW = read("app/actions/payments.ts");
const UI_RAW = read("app/(app)/payments/PaymentsClient.tsx");

/** コメントを除いたコード本体（説明文で誤検知させない） */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*--.*$/gm, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

const MIGRATION = codeOnly(MIGRATION_RAW);
const ACTIONS = codeOnly(ACTIONS_RAW);
const UI = codeOnly(UI_RAW);

/** 関数本体を切り出す */
function fnBody(name) {
  const start = MIGRATION.indexOf(`function public.${name}(`);
  assert.ok(start >= 0, `${name} が見つからない`);
  const end = MIGRATION.indexOf("$fn$;", start);
  assert.ok(end > start, `${name} の終わりが見つからない`);
  return MIGRATION.slice(start, end);
}

// =============================================================================
// 1 / 2. 権限と監査証跡
// =============================================================================
test("1. 非管理者は finalize / unfinalize できない", () => {
  for (const name of ["finalize_referral_month", "unfinalize_referral_month"]) {
    assert.match(
      fnBody(name),
      /if not public\.is_app_admin\(\) then/,
      `${name} に管理者チェックが無い`,
    );
  }
});

test("1-b. public / anon から実行権限を剥がし authenticated にだけ渡す", () => {
  for (const name of [
    "finalize_referral_month\\(text\\)",
    "unfinalize_referral_month\\(text\\)",
    "list_referral_month_settlements\\(\\)",
  ]) {
    assert.match(
      MIGRATION,
      new RegExp(`revoke all on function public\\.${name} from public, anon`),
      `${name} の revoke が無い`,
    );
    assert.match(
      MIGRATION,
      new RegExp(`grant execute on function public\\.${name} to authenticated`),
      `${name} の grant が無い`,
    );
  }
});

test("2. auth.uid() が取れなければ拒否する（確定者不明の抜け道を作らない）", () => {
  for (const name of ["finalize_referral_month", "unfinalize_referral_month"]) {
    const body = fnBody(name);
    assert.match(body, /v_actor uuid := auth\.uid\(\);/, `${name} が auth.uid() を取っていない`);
    assert.match(
      body,
      /if v_actor is null then\s*\n\s*raise exception/,
      `${name} が actor NULL を拒否していない`,
    );
  }
});

test("security definer と search_path を固定している", () => {
  for (const name of [
    "finalize_referral_month",
    "unfinalize_referral_month",
    "list_referral_month_settlements",
  ]) {
    const start = MIGRATION.indexOf(`function public.${name}(`);
    const head = MIGRATION.slice(start, start + 600);
    assert.match(head, /security definer/, `${name} が security definer でない`);
    assert.match(head, /set search_path = public/, `${name} の search_path が固定されていない`);
  }
});

// =============================================================================
// 3. 存在しない月
// =============================================================================
test("3. 月の形式が不正なら拒否する", () => {
  for (const name of ["finalize_referral_month", "unfinalize_referral_month"]) {
    assert.match(
      fnBody(name),
      /p_target_month !~ '\^\\d\{4\}-\(0\[1-9\]\|1\[0-2\]\)\$'/,
      `${name} に月の形式チェックが無い`,
    );
  }
});

test("3-b. 行が無い月はエラー。勝手に INSERT しない", () => {
  for (const name of ["finalize_referral_month", "unfinalize_referral_month"]) {
    const body = fnBody(name);
    assert.match(body, /if not found then\s*\n\s*raise exception/, `${name} が not found を拒否していない`);
    assert.equal(
      /insert into public\.referral_month_settlements/.test(body),
      false,
      `${name} が勝手に行を作っている`,
    );
  }
});

// =============================================================================
// 4 / 5 / 6. 1か月だけ更新し、監査情報を残す
// =============================================================================
test("4. 更新は対象の1か月だけ（where で月を固定）", () => {
  for (const name of ["finalize_referral_month", "unfinalize_referral_month"]) {
    const body = fnBody(name);
    const update = body.slice(body.indexOf("update public.referral_month_settlements"));
    assert.match(
      update,
      /where s\.target_month = p_target_month/,
      `${name} の UPDATE が月で絞られていない`,
    );
  }
});

test("4-b. 行ロックを取ってから更新する", () => {
  for (const name of ["finalize_referral_month", "unfinalize_referral_month"]) {
    assert.match(fnBody(name), /for update;/, `${name} が for update を取っていない`);
  }
});

test("5 / 6. finalize は finalized_at と finalized_by を保存する", () => {
  const body = fnBody("finalize_referral_month");
  assert.match(body, /set status = 'finalized'/);
  assert.match(body, /finalized_at = now\(\)/);
  assert.match(body, /finalized_by = v_actor/);
});

// =============================================================================
// 7. 二重確定
// =============================================================================
test("7. 確定済みの月は監査情報を書き換えず返す", () => {
  const body = fnBody("finalize_referral_month");
  const guard = body.slice(body.indexOf("if v_current.status = 'finalized' then"));
  const beforeReturn = guard.slice(0, guard.indexOf("return;"));

  assert.ok(guard.length > 0, "確定済みの分岐が無い");
  assert.equal(
    /update public\.referral_month_settlements/.test(beforeReturn),
    false,
    "確定済みなのに UPDATE している",
  );
  assert.match(beforeReturn, /true/, "already_finalized を返していない");
});

// =============================================================================
// 8〜11. 解除の安全条件
// =============================================================================
test("8. 条件を満たせば解除できる（3列だけ戻す）", () => {
  const body = fnBody("unfinalize_referral_month");
  assert.match(body, /set status = 'unfinalized'/);
  assert.match(body, /finalized_at = null/);
  assert.match(body, /finalized_by = null/);
});

test("9 / 10. claim 済み・payout 紐付きがあれば解除を拒否", () => {
  const body = fnBody("unfinalize_referral_month");
  assert.match(
    body,
    /count\(\*\) filter \(where i\.payment_batch_id is not null or i\.payout_id is not null\)/,
    "claim 済みを数えていない",
  );
  assert.match(body, /if v_claimed > 0 then\s*\n\s*raise exception/, "claim 済みを拒否していない");
});

test("11. 支払済みがあれば解除を拒否", () => {
  const body = fnBody("unfinalize_referral_month");
  assert.match(body, /count\(\*\) filter \(where i\.is_paid\)/, "支払済みを数えていない");
  assert.match(body, /if v_paid > 0 then\s*\n\s*raise exception/, "支払済みを拒否していない");
});

test("11-b. 支払明細側からも確かめる（片側だけ見ない）", () => {
  const body = fnBody("unfinalize_referral_month");
  assert.match(body, /from public\.payment_batches b/, "支払明細を見ていない");
  assert.match(body, /b\.payee_kind = 'referrer'/);
  assert.match(body, /b\.status in \('draft', 'approved', 'processing', 'paid'\)/);
  assert.match(body, /if v_batches > 0 then\s*\n\s*raise exception/);
});

// =============================================================================
// 12〜16. 報酬・紹介関係・代理店に触れない
// =============================================================================
test("12 / 13. 報酬明細を書き換えない", () => {
  for (const forbidden of [
    /update public\.referral_reward_items/,
    /delete from public\.referral_reward_items/,
    /insert into public\.referral_reward_items/,
  ]) {
    assert.equal(
      forbidden.test(MIGRATION),
      false,
      `migration が報酬明細を書き換えている: ${forbidden}`,
    );
  }
  // reward の列を set していない
  for (const column of ["reward_amount", "adjusted_reward_amount", "base_amount", "is_reward_target"]) {
    assert.equal(
      new RegExp(`set[\\s\\S]{0,80}${column}\\s*=`).test(MIGRATION),
      false,
      `${column} を書き換えている`,
    );
  }
});

test("14 / 15. 代理店側のテーブルに触れない", () => {
  for (const table of ["agency_reward_items", "agencies", "agency_payouts"]) {
    assert.equal(
      new RegExp(table).test(MIGRATION),
      false,
      `migration が ${table} を参照している`,
    );
  }
  // payment_batches は読むだけ
  assert.equal(
    /update public\.payment_batches|insert into public\.payment_batches|delete from public\.payment_batches/.test(
      MIGRATION,
    ),
    false,
    "支払明細を書き換えている",
  );
});

test("16. 紹介関係に触れない", () => {
  assert.equal(
    /creator_referrals/.test(MIGRATION),
    false,
    "migration が creator_referrals を参照している",
  );
});

test("既存の claim RPC を作り直していない", () => {
  assert.equal(
    /claim_payment_batch_items/.test(MIGRATION),
    false,
    "claim RPC を書き換えている",
  );
  assert.equal(
    /assert_referral_months_finalized/.test(MIGRATION),
    false,
    "確定判定の関数を書き換えている",
  );
});

// =============================================================================
// 17. 年月をハードコードしない
// =============================================================================
test("17. 特定の年月を埋め込まない（将来の月も同じ経路で確定できる）", () => {
  const months = MIGRATION.match(/'20\d{2}-\d{2}'/g) ?? [];
  assert.deepEqual(
    months,
    [],
    `migration に年月が埋め込まれている: ${months.join(", ")}`,
  );
});

test("17-b. サーバーアクションも月を固定しない", () => {
  const start = ACTIONS.indexOf("async function updateReferralSettlement");
  const body = ACTIONS.slice(start, ACTIONS.indexOf("\nexport async function finalizeReferralMonthAction", start));
  const months = body.match(/"20\d{2}-\d{2}"/g) ?? [];
  assert.deepEqual(months, [], `アクションに年月が埋め込まれている: ${months.join(", ")}`);
});

// =============================================================================
// 18. 0円の月
// =============================================================================
test("18. 報酬 0 件の月でも確定できる（件数を条件にしない）", () => {
  const body = fnBody("finalize_referral_month");
  assert.equal(
    /reward_item_count|item_count\s*=\s*0|count\(\*\)\s*=\s*0/.test(body),
    false,
    "件数で確定可否を決めている",
  );
  assert.equal(
    /referral_reward_items/.test(body),
    false,
    "finalize が報酬明細を条件にしている",
  );
});

// =============================================================================
// 19 / 20. 直接 UPDATE させない
// =============================================================================
test("19. 画面がテーブルを直接更新しない", () => {
  assert.equal(
    /referral_month_settlements/.test(UI),
    false,
    "画面がテーブル名を直接扱っている",
  );
  assert.equal(
    /\.from\("referral_month_settlements"\)/.test(UI),
    false,
    "画面がテーブルへ直接アクセスしている",
  );
});

test("20. サーバーアクションは RPC しか使わない", () => {
  const start = ACTIONS.indexOf("export async function fetchReferralMonthSettlementsAction");
  const end = ACTIONS.indexOf("export async function createPaymentBatchAction");
  const block = ACTIONS.slice(start, end);

  assert.equal(
    /\.from\("referral_month_settlements"\)/.test(block),
    false,
    "アクションがテーブルへ直接アクセスしている",
  );
  for (const rpc of [
    "list_referral_month_settlements",
    "finalize_referral_month",
    "unfinalize_referral_month",
  ]) {
    assert.ok(block.includes(rpc), `${rpc} を呼んでいない`);
  }
  assert.match(block, /requireAdminAction\(\)/, "管理者チェックが無い");
  assert.match(block, /auth\.supabase\.rpc\(/, "ログイン中のセッションで呼んでいない");
  assert.equal(
    /getSupabaseAdmin\(\)/.test(block),
    false,
    "サービスロールで呼んでいる（auth.uid() が取れず確定者が残らない）",
  );
});

// =============================================================================
// 21 / 22. claim 側の前提は変えない
// =============================================================================
test("21 / 22. 確定判定（assert）の定義を変更していない", () => {
  /*
    finalize は settlement の状態を変えるだけで、
    「全月が finalized か」を確かめる関数自体はそのまま。
    一部の月が未確定なら claim は引き続き失敗する。
  */
  const lock = read("supabase/migrations/20260927110000_claim_referral_finalized_lock.sql");
  assert.match(lock, /generate_series/, "全月検査の実装が変わっている");
  assert.match(lock, /<> 'finalized'/);
  assert.equal(
    /assert_referral_months_finalized/.test(MIGRATION),
    false,
    "今回の migration が確定判定を上書きしている",
  );
});

// =============================================================================
// UI
// =============================================================================
test("UI は確定前に月・件数・金額を確認させる", () => {
  const start = UI.indexOf("function ReferralSettlementSection");
  const block = UI.slice(start, UI.indexOf("\nfunction ", start + 10));

  assert.ok(UI_RAW.includes("よろしいですか？"), "確認ダイアログが無い");
  assert.ok(UI_RAW.includes("件数："), "件数を出していない");
  assert.ok(UI_RAW.includes("紹介報酬："), "金額を出していない");
  assert.match(block, /confirming === row\.targetMonth/, "確認の段階が無い");
});

test("UI は支払処理済みの月で解除ボタンを出さない", () => {
  const start = UI.indexOf("function ReferralSettlementSection");
  const block = UI.slice(start, UI.indexOf("\nfunction ", start + 10));

  assert.match(
    block,
    /const locked = row\.claimedItemCount > 0 \|\| row\.paidItemCount > 0;/,
    "支払処理済みの判定が無い",
  );
  assert.ok(UI_RAW.includes("解除不可（支払処理済み）"), "解除不可の表示が無い");
});

test("UI は確定日時と確定者を表示する", () => {
  assert.ok(UI_RAW.includes("確定日時"), "確定日時の列が無い");
  assert.ok(UI_RAW.includes("確定者"), "確定者の列が無い");
  assert.match(UI, /row\.finalizedAt/);
  assert.match(UI, /row\.finalizedByEmail/);
});
