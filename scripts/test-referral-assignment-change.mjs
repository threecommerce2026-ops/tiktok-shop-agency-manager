/*
  紹介者・適用開始月の変更まわりのテスト。

  DBへは接続せず、実装の規約と純関数の挙動を確かめる。
  実行: node --test scripts/test-referral-assignment-change.mjs

  ■ このテストが守っているもの
  ① 適用開始月を省略できないこと（登録月が勝手に入らない）
  ② 確定済み・支払処理へ進んだ月へ遡る変更を止めること
  ③ 変更で同じ月に紹介者が2人にならないこと
  ④ 保存の副作用で紹介報酬を作り直さないこと
  ⑤ 履歴に「何月分からどう変えたか」が残ること
  ⑥ 紹介報酬の計算式 (W+X)×5% を変えていないこと
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

const engine = await jiti.import(path.join(root, "lib/referrals/referral-reward-engine.ts"));
const period = await jiti.import(path.join(root, "lib/referrals/referral-period.ts"));

const read = (file) => readFileSync(path.join(root, file), "utf8");
const MIGRATION_RAW = read("supabase/migrations/20260929120000_creator_referral_logs.sql");
const LINK_RAW = read("lib/referrals/link-creator-referrer.ts");
const PLAN_RAW = read("lib/referrals/referral-assignment-change.ts");
const UPDATE_RAW = read("app/actions/update-creator-master.ts");
const BULK_RAW = read("app/actions/creator-master-bulk-edit.ts");
const PORTAL_RAW = read("app/actions/referrer-portal.ts");
const CREATOR_UI_RAW = read("app/(app)/creators/CreatorMasterClient.tsx");
const EDITOR_UI_RAW = read(
  "app/(app)/admin/creator-master-editor/CreatorMasterEditorClient.tsx",
);

/** コメントを除いたコード本体 */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*--.*$/gm, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

const MIGRATION = codeOnly(MIGRATION_RAW);
const LINK = codeOnly(LINK_RAW);
const PLAN = codeOnly(PLAN_RAW);
const UPDATE = codeOnly(UPDATE_RAW);
const BULK = codeOnly(BULK_RAW);
const PORTAL = codeOnly(PORTAL_RAW);
const CREATOR_UI = codeOnly(CREATOR_UI_RAW);
const EDITOR_UI = codeOnly(EDITOR_UI_RAW);

// =============================================================================
// 1 / 2. startMonth 必須化
// =============================================================================
test("1. startMonth は型として必須（省略できない）", () => {
  assert.match(
    LINK,
    /startMonth: string;/,
    "startMonth が任意のままになっている",
  );
  assert.equal(
    /startMonth\?: string/.test(LINK),
    false,
    "startMonth が省略可能な型になっている",
  );
});

test("2. YYYY-MM 以外は拒否する", () => {
  assert.match(
    LINK,
    /if \(!isValidTargetMonth\(params\.startMonth\)\)/,
    "開始月の形式チェックが無い",
  );
});

test("6. 暗黙の既定（currentMonthKey フォールバック）が残っていない", () => {
  assert.equal(
    /startMonth \?\? currentMonthKey\(\)/.test(LINK),
    false,
    "暗黙のフォールバックが残っている",
  );
  assert.equal(
    /currentMonthKey/.test(LINK),
    false,
    "link 側が currentMonthKey を参照している",
  );
});

// =============================================================================
// 3 / 4 / 5. 全 call site
// =============================================================================
test("3. creator編集は開始月を渡す", () => {
  assert.match(UPDATE, /readText\(formData, "referrer_start_month"\)/);
  assert.match(UPDATE, /startMonth: referrerStartMonth,/);
});

test("4. 一括編集は creator ごとの開始月を渡す", () => {
  assert.match(BULK, /referrerStartMonth/);
  assert.match(BULK, /startMonth: change\.referrerStartMonth,/);
  // 5項目のペイロードになっている
  assert.match(BULK, /\.filter\(\(parts\) => parts\.length === 5\)/);
});

test("5. 紹介リンク登録は currentMonthKey を明示して使う", () => {
  assert.match(
    PORTAL,
    /const startMonth = currentMonthKey\(\);/,
    "登録月を明示していない",
  );
  assert.match(PORTAL, /start_month: startMonth,/);
});

test("linkCreatorToReferrer の呼び出しはすべて startMonth を渡す", () => {
  for (const [label, source] of [["creator編集", UPDATE], ["一括編集", BULK]]) {
    const calls = source.match(/linkCreatorToReferrer\(supabase, \{[\s\S]*?\}\)/g) ?? [];
    assert.ok(calls.length > 0, `${label} に呼び出しが無い`);
    for (const call of calls) {
      assert.match(call, /startMonth:/, `${label} の呼び出しに startMonth が無い`);
    }
  }
});

// =============================================================================
// 7 / 8 / 9. 期間の扱い
// =============================================================================
test("8. 紹介者を変えると旧関係の end_month が新開始月の前月になる", () => {
  assert.match(
    LINK,
    /end_month: previousMonthOf\(startMonth\)/,
    "旧関係の終了月を書いていない",
  );
});

test("9. 同じ紹介者のまま開始月だけ直せる", () => {
  assert.match(
    UPDATE,
    /referrerStartMonthChanged/,
    "開始月だけの変更を検知していない",
  );
  assert.match(
    UPDATE,
    /if \(referrerChanged \|\| referrerStartMonthChanged\)/,
    "開始月だけの変更で保存処理へ入らない",
  );
  // action の語彙に change_start_month がある
  assert.match(PLAN, /"change_start_month"/);
});

test("変更の種類を4つに分ける", () => {
  assert.match(PLAN, /action = "unlink"/);
  assert.match(PLAN, /action = "create"/);
  assert.match(PLAN, /action = "reassign"/);
  assert.match(PLAN, /action = "change_start_month"/);
});

// =============================================================================
// 10 / 11. 履歴
// =============================================================================
test("10 / 11. 履歴に前後の期間と影響範囲を構造化して残す", () => {
  for (const column of [
    "previous_referrer_id",
    "previous_start_month",
    "previous_end_month",
    "referrer_id",
    "start_month",
    "end_month",
    "affected_start_month",
    "affected_end_month",
    "action",
    "changed_by",
    "changed_by_email",
  ]) {
    assert.ok(MIGRATION.includes(column), `${column} が無い`);
  }
  // JSON へ押し込んでいない
  assert.equal(/jsonb|json /.test(MIGRATION), false, "JSON で保存している");
});

test("履歴は insert と select だけ（監査ログを書き換えさせない）", () => {
  assert.match(MIGRATION, /for select/);
  assert.match(MIGRATION, /for insert/);
  assert.match(MIGRATION, /grant select, insert/);
  assert.equal(
    /for update|for delete/.test(MIGRATION),
    false,
    "更新・削除を許可している",
  );
});

test("履歴は管理者のみ。本人以外の changed_by を書けない", () => {
  assert.match(MIGRATION, /using \(public\.is_app_admin\(\)\)/);
  assert.match(
    MIGRATION,
    /public\.is_app_admin\(\)\s*\n\s*and changed_by = auth\.uid\(\)/,
    "changed_by の詐称を防いでいない",
  );
});

test("action は4種類に限る", () => {
  assert.match(
    MIGRATION,
    /check \(action in \('create', 'reassign', 'change_start_month', 'unlink'\)\)/,
  );
});

test("保存時に履歴を書く", () => {
  assert.match(LINK, /from\("creator_referral_logs"\)/);
  assert.match(LINK, /writeReferralLog\(supabase, params\)/);
  assert.match(UPDATE, /log: \{/);
  assert.match(BULK, /log: \{/);
});

// =============================================================================
// 12〜16. 保護
// =============================================================================
test("12. 確定済みの月に影響する変更をブロックする", () => {
  assert.match(PLAN, /"settlement_finalized"/);
  /*
    確定状況は list_referral_month_settlements() から取り、
    status が finalized の月だけを影響範囲と突き合わせる。
    （以前はテーブルを直接 .eq("status","finalized") で引いていたが、
     authenticated に SELECT が無く permission denied になった）
  */
  assert.match(PLAN, /supabase\.rpc\("list_referral_month_settlements"\)/);
  assert.match(PLAN, /row\.status === "finalized"/);
  assert.match(PLAN, /blocks\.push\("settlement_finalized"\)/);
});

test("13 / 14. 支払明細に組み入れ済み・payout 紐付きをブロックする", () => {
  assert.match(PLAN, /"reward_claimed"/);
  assert.match(
    PLAN,
    /item\.payment_batch_id != null \|\| item\.payout_id != null/,
    "claim / payout を見ていない",
  );
  assert.match(PLAN, /blocks\.push\("reward_claimed"\)/);
});

test("15. 支払済みをブロックする", () => {
  assert.match(PLAN, /"reward_paid"/);
  assert.match(PLAN, /if \(item\.is_paid\) paidItemCount \+= 1/);
  assert.match(PLAN, /blocks\.push\("reward_paid"\)/);
});

test("16. サーバー側でも保存前に必ず判定する（UIを迂回できない）", () => {
  for (const [label, source] of [["creator編集", UPDATE], ["一括編集", BULK]]) {
    assert.match(source, /buildReferralChangePlan\(/, `${label} が plan を作っていない`);
    assert.match(
      source,
      /if \(!canApplyReferralChange\(plan\)\)/,
      `${label} がブロック判定をしていない`,
    );
  }
});

// =============================================================================
// 17. 期間の重なり
// =============================================================================
test("17. 同じ月に紹介者が2人になる変更を拒否する", () => {
  assert.match(PLAN, /"referral_period_conflict"/);
  assert.match(PLAN, /resolveReferralForMonth\(/, "既存の期間ロジックを使っていない");
  assert.match(PLAN, /blocks\.push\("referral_period_conflict"\)/);
});

test("17-b. 重なりの検出は既存ロジックが正しく働く", () => {
  const rows = [
    {
      creator_id: "c1",
      referrer_id: "A",
      referral_rate: 0.05,
      start_month: "2026-03",
      end_month: "2026-10",
      is_active: false,
      lifetime_payout_cap: null,
      lifetime_paid_amount: 0,
      created_at: "2026-03-01T00:00:00Z",
    },
    {
      creator_id: "c1",
      referrer_id: "B",
      referral_rate: 0.05,
      start_month: "2026-06",
      end_month: null,
      is_active: true,
      lifetime_payout_cap: null,
      lifetime_paid_amount: 0,
      created_at: "2026-06-01T00:00:00Z",
    },
  ];
  const index = period.buildReferralPeriods(rows);
  const resolved = period.resolveReferralForMonth(index.byCreator.get("c1"), "2026-06");
  assert.equal(resolved.period, null, "重なりを見逃している");
  assert.equal(resolved.conflicts.length, 2);
});

// =============================================================================
// 18 / 19. 保存の副作用
// =============================================================================
test("18. 保存で紹介報酬を作り直さない", () => {
  for (const [label, source] of [
    ["plan", PLAN],
    ["link", LINK],
    ["creator編集", UPDATE],
    ["一括編集", BULK],
  ]) {
    assert.equal(
      /syncReferralRewardsForMonth/.test(source),
      false,
      `${label} が報酬を再集計している`,
    );
    assert.equal(
      /from\("referral_reward_items"\)[\s\S]{0,120}\.(update|insert|upsert|delete)\(/.test(
        source,
      ),
      false,
      `${label} が報酬明細を書き換えている`,
    );
  }
});

test("18-b. plan は読むだけ", () => {
  for (const forbidden of [/\.update\(/, /\.insert\(/, /\.upsert\(/, /\.delete\(/]) {
    assert.equal(forbidden.test(PLAN), false, `plan が書き込んでいる: ${forbidden}`);
  }

  /*
    RPC は読み取り専用のものだけ許す。
    list_referral_month_settlements は stable で、確定状況を返すだけ。
    finalize / unfinalize のような状態を変える RPC を呼ばないこと。
  */
  const rpcs = [...PLAN.matchAll(/\.rpc\("([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    rpcs,
    ["list_referral_month_settlements"],
    `読み取り専用でない RPC を呼んでいる: ${rpcs.join(", ")}`,
  );
});

test("19. 無関係なテーブルへ触らない", () => {
  for (const table of [
    "agency_reward_items",
    "payment_batches",
    "referral_month_settlements",
    "creator_monthly_agency_assignments",
  ]) {
    assert.equal(
      new RegExp(`from\\("${table}"\\)[\\s\\S]{0,120}\\.(update|insert|upsert|delete)\\(`).test(
        PLAN + LINK,
      ),
      false,
      `${table} を書き換えている`,
    );
  }
});

// =============================================================================
// 20. 紹介報酬の計算式
// =============================================================================
test("20. (W+X)×5% を変えていない", () => {
  assert.equal(engine.REFERRAL_REWARD_RATE, 0.05);
  assert.equal(
    engine.referralBaseAmount({
      partner_estimated_commission: 100,
      partner_shop_ads_estimated_commission: 50,
    }),
    150,
  );
  // ボーナスは入らない
  assert.equal(
    engine.referralBaseAmount({
      partner_estimated_commission: 100,
      partner_shop_ads_estimated_commission: 50,
      partner_bonus_estimated_commission: 500,
    }),
    150,
  );
});

test("20-b. プレビューの想定額も W+X から作る", () => {
  assert.match(PLAN, /referralBaseAmount\(line\)/);
  assert.match(PLAN, /REFERRAL_REWARD_RATE/);
  assert.equal(
    /commission_base[\s\S]{0,40}\* *0?\.05/.test(PLAN),
    false,
    "commission_base から計算している",
  );
});

// =============================================================================
// 21. 所属側
// =============================================================================
test("21. 所属の月別ロジックを変更していない", () => {
  const assignment = codeOnly(read("lib/agency/agency-assignment.ts"));
  assert.match(assignment, /creator_monthly_agency_assignments/);
  assert.match(assignment, /source: monthlyAgencyId \? "monthly"/);
  // 今回の変更で所属側の書き込み経路を増やしていない
  assert.equal(
    /creator_monthly_agency_assignments/.test(LINK),
    false,
    "紹介者の入口が所属を触っている",
  );
});

// =============================================================================
// 22. 既存データを書き換えない
// =============================================================================
test("22. migration は既存データを書き換えない", () => {
  for (const forbidden of [
    /update public\.creator_referrals/,
    /delete from public\.creator_referrals/,
    /insert into public\.creator_referrals/,
    /update public\.referral_reward_items/,
    /update public\.creators/,
  ]) {
    assert.equal(forbidden.test(MIGRATION), false, `既存データを触っている: ${forbidden}`);
  }
  // backfill していない
  assert.equal(
    /insert into public\.creator_referral_logs/.test(MIGRATION),
    false,
    "履歴を backfill している",
  );
});

// =============================================================================
// UI
// =============================================================================
test("UI: creator編集に適用開始月がある", () => {
  assert.match(CREATOR_UI, /name="referrer_start_month"/);
  assert.ok(CREATOR_UI_RAW.includes("適用開始月（必須）"));
  assert.ok(CREATOR_UI_RAW.includes("登録した月ではなく"));
});

test("UI: 保存前に影響を確認できる", () => {
  assert.match(CREATOR_UI, /previewReferralChangeAction\(/);
  assert.ok(CREATOR_UI_RAW.includes("変更内容を確認"));
  assert.ok(CREATOR_UI_RAW.includes("影響期間"));
  assert.ok(CREATOR_UI_RAW.includes("想定紹介報酬"));
  assert.ok(CREATOR_UI_RAW.includes("再計算されません"));
});

test("UI: 最初の実績月は参考表示にとどめる", () => {
  assert.ok(CREATOR_UI_RAW.includes("最初のTAP実績"));
  assert.ok(CREATOR_UI_RAW.includes("最初のaffiliate実績"));
  // 既定値に実績月を使っていない
  assert.match(
    CREATOR_UI,
    /useState\(\s*row\.referrerStartMonth \?\? currentMonthLabel\(\),\s*\)/,
    "実績月を既定値にしている",
  );
});

test("UI: 現在所属と月別確定を区別して期間を出す", () => {
  assert.ok(CREATOR_UI_RAW.includes("月別確定"));
  assert.match(CREATOR_UI, /row\.agencyAssignedStartMonth/);
  assert.match(CREATOR_UI, /row\.referrerStartMonth/);
  assert.match(CREATOR_UI, /formatPeriod\(/);
});

test("UI: 一括編集は creator ごとに開始月を持つ", () => {
  assert.match(EDITOR_UI, /referrerStartMonth/);
  assert.match(EDITOR_UI, /type="month"/);
  // 一括選択では開始月を設定しない
  const bulkApply = EDITOR_UI.slice(
    EDITOR_UI.indexOf("next[id] = { ...next[id], referrerId: value }"),
  ).slice(0, 200);
  assert.equal(
    /referrerStartMonth/.test(bulkApply),
    false,
    "一括選択で開始月をまとめて設定している",
  );
});

// =============================================================================
// 権限を持たないテーブルを直接読まない
// =============================================================================
/*
  referral_month_settlements は authenticated / service_role に SELECT が
  grant されていない（postgres のみ）。直接 .from() で引くと実行時に
  permission denied になり、画面の「変更内容を確認」が壊れる。

  実際にこの経路で発生したので、書き込みだけでなく「読み取り」も
  検査する。権限を緩めて直すのではなく、既存の security definer RPC を
  使う設計を固定する。
*/
test("settlement をテーブルから直接読まない（RPC を使う）", () => {
  assert.equal(
    /\.from\("referral_month_settlements"\)/.test(PLAN),
    false,
    "権限の無いテーブルを直接 SELECT している（permission denied になる）",
  );
  assert.match(
    PLAN,
    /supabase\.rpc\("list_referral_month_settlements"\)/,
    "既存の安全な RPC を使っていない",
  );
});

test("finalized の判定は RPC の status から行う", () => {
  assert.match(
    PLAN,
    /\.filter\(\(row\) => row\.status === "finalized"\)/,
    "RPC の結果から finalized を絞っていない",
  );
});

test("プレビューと保存が同じ判定を通る", () => {
  /*
    プレビューだけ直して保存側が permission denied、という状態を防ぐ。
    どちらも buildReferralChangePlan を呼び、その中の1か所だけが
    settlement を読む。
  */
  const rpcCalls = PLAN.match(/list_referral_month_settlements/g) ?? [];
  assert.equal(rpcCalls.length, 1, "settlement の読み取りが複数箇所にある");

  assert.match(UPDATE, /previewReferralChangeAction/, "プレビューの入口が無い");
  for (const [label, source] of [["プレビュー", UPDATE], ["一括編集", BULK]]) {
    assert.match(
      source,
      /buildReferralChangePlan\(/,
      `${label} が共通の判定を使っていない`,
    );
  }
  // プレビューも保存も同じ関数を呼ぶ
  const previewBlock = UPDATE.slice(
    UPDATE.indexOf("export async function previewReferralChangeAction"),
    UPDATE.indexOf("export async function updateCreatorMasterAction"),
  );
  assert.match(previewBlock, /buildReferralChangePlan\(auth\.supabase/);
});

test("settlement の権限を緩める変更を入れていない", () => {
  const { readdirSync } = require("node:fs");
  const dir = path.join(root, "supabase/migrations");
  for (const file of readdirSync(dir)) {
    const sql = readFileSync(path.join(dir, file), "utf8");
    if (!/referral_month_settlements/.test(sql)) continue;
    assert.equal(
      /grant\s+select[^;]*on\s+(table\s+)?public\.referral_month_settlements[^;]*to\s+(authenticated|anon)/i.test(
        sql,
      ),
      false,
      `${file} が settlement に SELECT を grant している`,
    );
  }
});
