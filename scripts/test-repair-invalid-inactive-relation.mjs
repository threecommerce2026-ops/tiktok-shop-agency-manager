/*
  有効期間を持たない無効 relation の修復のテスト。

  ■ 何を守りたいか
  この経路は creator_referrals を直接 UPDATE する。対象判定を少しでも
  広げると、実在した過去の紹介関係の終了月を消して報酬の帰属を
  変えてしまう。だから「is_active=false かつ end_month < start_month」
  以外は絶対に触れないことを固定する。

  ■ 背景（2026-10-03）
  odebu888 の「-」関係が start=2026-05 / end=2026-04 / inactive という
  自己矛盾した状態になり、本来正しい（株）3 の関係まで
  superseded として潰していた（紹介報酬 62.20円が未発生）。

  実行: node --test scripts/test-repair-invalid-inactive-relation.mjs
*/
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const root = process.cwd();
const jiti = createJiti(root, { alias: { "@": root }, interopDefault: true, fsCache: false });

const repair = await jiti.import(
  path.join(root, "lib/referrals/repair-invalid-inactive-relation.ts"),
);
const period = await jiti.import(path.join(root, "lib/referrals/referral-period.ts"));

const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const codeOnly = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const LIB = read("lib/referrals/repair-invalid-inactive-relation.ts");
const ACTIONS = read("app/actions/repair-referral-relation.ts");
const MIGRATION = read(
  "supabase/migrations/20261003030000_repair_invalid_inactive_referral_relation.sql",
);
const UI = read("components/referrer/RelationRepairPanel.tsx");
const PAGE = read("app/(app)/admin/creator-referrals/page.tsx");
const CREATORS_PAGE = read("app/(app)/creators/page.tsx");
const NAV = read("lib/nav/app-nav.ts");
const EDITOR_PAGE = read("app/(app)/admin/creator-master-editor/page.tsx");

const KABU3 = "r-kabu3";
const DASH = "r-dash";
const MAEHARA = "r-maehara";
const CREATOR = "c-odebu";

function rel(overrides) {
  return {
    id: "rel-1",
    creator_id: CREATOR,
    referrer_id: DASH,
    start_month: "2026-05",
    end_month: "2026-04",
    is_active: false,
    referral_rate: 0.05,
    lifetime_payout_cap: 3000000,
    lifetime_paid_amount: 0,
    created_at: "2026-09-27T06:01:40Z",
    ...overrides,
  };
}

// --- 1〜4: 対象条件 -------------------------------------------------------------

test("1. inactive / start=2026-05 / end=2026-04 は repair 可能", () => {
  assert.equal(repair.canRepairRelation(rel({})), true);
  assert.deepEqual(repair.repairBlocksOf(rel({})), []);
});

test("2. active=true は repair 不可", () => {
  const row = rel({ is_active: true });
  assert.equal(repair.canRepairRelation(row), false);
  assert.ok(repair.repairBlocksOf(row).includes("not_inactive"));
});

test("3. inactive で end >= start は repair 不可", () => {
  for (const end of ["2026-05", "2026-06", "2026-12"]) {
    const row = rel({ end_month: end });
    assert.equal(repair.canRepairRelation(row), false, `end=${end} が対象になっている`);
    assert.ok(
      repair.repairBlocksOf(row).includes("end_month_not_before_start"),
      `end=${end}`,
    );
  }
});

test("4. inactive で end=null は repair 不要（対象外）", () => {
  for (const end of [null, undefined, ""]) {
    const row = rel({ end_month: end });
    assert.equal(repair.canRepairRelation(row), false);
    assert.ok(repair.repairBlocksOf(row).includes("end_month_missing"));
  }
});

test("月形式が壊れている行は触らない", () => {
  for (const row of [
    rel({ start_month: "2026-5" }),
    rel({ end_month: "2026-4" }),
    rel({ start_month: "abc" }),
  ]) {
    assert.equal(repair.canRepairRelation(row), false);
  }
});

// --- 5〜7: 支払・確定のガード -----------------------------------------------------

function plan(overrides) {
  return {
    candidate: {
      relationId: "rel-1",
      creatorId: CREATOR,
      tiktokId: "odebu888",
      creatorName: "ISSEI",
      referrerId: DASH,
      referrerName: "-",
      startMonth: "2026-05",
      endMonth: "2026-04",
      isActive: false,
      createdAt: null,
      updatedAt: null,
    },
    affectedMonths: ["2026-05", "2026-06"],
    resolutionBefore: [],
    resolutionAfter: [],
    finalizedMonths: [],
    claimedItemCount: 0,
    paidItemCount: 0,
    blocks: [],
    error: null,
    ...overrides,
  };
}

test("5. finalized settlement があれば repair 不可", () => {
  const p = plan({ finalizedMonths: ["2026-05"], blocks: ["settlement_finalized"] });
  assert.equal(repair.canApplyRelationRepair(p), false);
  assert.match(repair.describeRelationRepairBlocks(p), /確定済み/);
});

test("6. paid reward に影響すれば repair 不可", () => {
  const p = plan({ paidItemCount: 3, blocks: ["reward_paid"] });
  assert.equal(repair.canApplyRelationRepair(p), false);
  assert.match(repair.describeRelationRepairBlocks(p), /支払済み/);
});

test("7. payment batch / payout に影響すれば repair 不可", () => {
  const p = plan({ claimedItemCount: 2, blocks: ["reward_claimed"] });
  assert.equal(repair.canApplyRelationRepair(p), false);
  assert.match(repair.describeRelationRepairBlocks(p), /支払明細/);
});

test("plan 側のガード条件がコードに揃っている", () => {
  const code = codeOnly(LIB);
  assert.match(code, /blocks\.push\("settlement_finalized"\)/);
  assert.match(code, /blocks\.push\("reward_claimed"\)/);
  assert.match(code, /blocks\.push\("reward_paid"\)/);
  assert.match(code, /item\.payout_id != null \|\| item\.payment_batch_id != null/);
  assert.match(code, /fetchFinalizedReferralMonths\(supabase\)/);
});

test("ブロックが無いときだけ適用できる", () => {
  assert.equal(repair.canApplyRelationRepair(plan({})), true);
  assert.equal(repair.canApplyRelationRepair(plan({ candidate: null })), false);
  assert.equal(repair.canApplyRelationRepair(plan({ error: "boom" })), false);
});

// --- 8: 監査ログ -----------------------------------------------------------------

test("8. repair 後に監査ログを残す", () => {
  const code = codeOnly(LIB);
  assert.match(
    code,
    /from\("creator_referral_logs"\)\s*\.insert\(\{/,
    "監査ログを書いていない",
  );
  assert.match(code, /action: REPAIR_ACTION/);
  assert.match(code, /previous_end_month: candidate\.endMonth/, "変更前が残らない");
  assert.match(code, /end_month: null/, "変更後が残らない");
  assert.match(code, /changed_by: actorId/);
  assert.match(code, /changed_by_email: actorEmail/);
  assert.match(code, /note: params\.note \?\? REPAIR_REASON/);

  assert.equal(repair.REPAIR_ACTION, "repair_invalid_inactive_relation");
  assert.equal(
    repair.REPAIR_REASON,
    "invalid inactive referral relation created by prior reassignment",
  );

  /* migration が action を許可している */
  assert.match(MIGRATION, /'repair_invalid_inactive_relation'/);
  for (const keep of ["'create'", "'reassign'", "'change_start_month'", "'unlink'"]) {
    assert.ok(MIGRATION.includes(keep), `既存 action ${keep} が消えている`);
  }
});

test("操作者が無ければ実行しない", async () => {
  const result = await repair.repairInvalidInactiveReferralRelation(
    { from: () => { throw new Error("呼ばれてはいけない"); } },
    { plan: plan({}), actorId: "", actorEmail: null },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /操作者/);
});

test("ブロックがある plan では書き込みを試みない", async () => {
  const result = await repair.repairInvalidInactiveReferralRelation(
    { from: () => { throw new Error("呼ばれてはいけない"); } },
    { plan: plan({ blocks: ["reward_paid"] }), actorId: "u1", actorEmail: null },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /修復できません/);
});

// --- 9: 他 relation を変更しない -------------------------------------------------

test("9. 他の relation を変更しない（1行だけを条件付きで更新）", () => {
  const code = codeOnly(LIB);

  /* 更新は end_month を null にするだけ。start_month も referrer も変えない */
  assert.match(code, /\.update\(\{ end_month: null, updated_at:/);
  assert.ok(
    !/\.update\([^)]*start_month/.test(code),
    "start_month を書き換えている（履歴の捏造）",
  );
  assert.ok(
    !/\.update\([^)]*referrer_id/.test(code),
    "紹介者を書き換えている",
  );
  assert.ok(
    !/\.update\([^)]*is_active/.test(code),
    "is_active を書き換えている",
  );

  /* 物理削除しない */
  assert.ok(!/\.delete\(/.test(code), "物理削除している");

  /* WHERE で対象を二重に絞る */
  for (const guard of [
    /\.eq\("id", candidate\.relationId\)/,
    /\.eq\("is_active", false\)/,
    /\.eq\("start_month", candidate\.startMonth\)/,
    /\.eq\("end_month", candidate\.endMonth as string\)/,
  ]) {
    assert.match(code, guard, `WHERE の絞り込みが足りない: ${guard}`);
  }

  /* 0 行更新なら失敗として返す */
  assert.match(code, /\(updated \?\? \[\]\)\.length === 0/);
});

test("一括修復の経路が無い", () => {
  const code = codeOnly(LIB) + codeOnly(ACTIONS);
  for (const forbidden of [/\.in\("id"/, /bulkRepair/, /repairAll/, /forEach[\s\S]{0,80}repairInvalid/]) {
    assert.ok(!forbidden.test(code), `一括修復に見える経路がある: ${forbidden}`);
  }
});

test("紹介報酬・payout・batch・settlement を触らない", () => {
  const code = codeOnly(LIB) + codeOnly(ACTIONS);
  for (const forbidden of [
    /syncReferralRewards/,
    /finalize_referral_month/,
    /\.from\("referral_payouts"\)/,
    /\.from\("payment_batches"\)/,
    /\.from\("referral_reward_items"\)[\s\S]{0,120}\.(insert|update|upsert|delete)\(/,
    /\.from\("referral_month_settlements"\)/,
    /\.from\("creators"\)[\s\S]{0,120}\.(insert|update|upsert|delete)\(/,
    /linkCreatorToReferrer/,
  ]) {
    assert.ok(!forbidden.test(code), `${forbidden} に該当する`);
  }
});

test("確定は必ずサーバー側で plan を作り直す", () => {
  const code = codeOnly(ACTIONS);
  assert.match(code, /requireAdminAction\(\)/, "admin 判定が無い");
  assert.match(
    code,
    /const plan = await buildRelationRepairPlan\(auth\.supabase, relationId\)/,
    "plan を作り直していない",
  );
  assert.match(code, /if \(!canApplyRelationRepair\(plan\)\)/, "ガードを通っていない");
  /* プレビューも admin 限定 */
  const previews = [...code.matchAll(/export async function (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(previews.sort(), [
    "listRelationRepairCandidatesAction",
    "previewRelationRepairAction",
    "repairRelationAction",
  ]);
});

test("紹介報酬は自動で再計算しないと伝える", () => {
  assert.match(ACTIONS, /紹介報酬は再計算していません/);
});

// --- 10: odebu888 相当データが正しく解決される ------------------------------------

test("10. odebu888 相当データ: 修復後 2026-05 / 2026-06 → （株）3", () => {
  /*
    実データと同じ形:
      前原一誠 inactive / end=null        → 誤登録として期間計算から除外
      （株）3  active   / end=null        → 本来これが正しい
      「-」    inactive / end=2026-04     → start より前（修復対象）
  */
  const rows = [
    rel({ id: "r-m", referrer_id: MAEHARA, end_month: null, is_active: false,
          created_at: "2026-09-16T01:54:25Z" }),
    rel({ id: "r-k", referrer_id: KABU3, end_month: null, is_active: true,
          created_at: "2026-09-17T04:18:23Z" }),
    rel({ id: "r-d", referrer_id: DASH, end_month: "2026-04", is_active: false,
          created_at: "2026-09-27T06:01:40Z" }),
  ];

  // --- 修復前: 誰にも解決されない ---
  const before = period.buildReferralPeriods(rows);
  const pBefore = before.byCreator.get(CREATOR) ?? [];
  assert.equal(pBefore.length, 0, "修復前に期間が解決されている");
  for (const m of ["2026-05", "2026-06"]) {
    assert.equal(
      period.resolveReferralForMonth(pBefore, m).period,
      null,
      `修復前の ${m} が解決されている`,
    );
  }
  assert.equal(before.unresolved.length, 2);

  // --- 修復後: end_month を null へ戻す ---
  const repaired = rows.map((r) =>
    r.id === "r-d" ? { ...r, end_month: null } : r,
  );
  const after = period.buildReferralPeriods(repaired);
  const pAfter = after.byCreator.get(CREATOR) ?? [];

  assert.equal(pAfter.length, 1, "修復後の期間が1件でない");
  assert.equal(pAfter[0].referrerId, KABU3);
  assert.equal(pAfter[0].startMonth, "2026-05");
  assert.equal(pAfter[0].endMonth, null);
  assert.equal(pAfter[0].isActive, true);

  for (const m of ["2026-05", "2026-06"]) {
    const res = period.resolveReferralForMonth(pAfter, m);
    assert.equal(res.period?.referrerId, KABU3, `${m} が（株）3 に解決されない`);
    assert.equal(res.conflicts.length, 0, `${m} に期間競合がある`);
  }

  /* 修復対象だった「-」は誤登録として除外され、解決不能にも出ない */
  assert.equal(after.unresolved.length, 0, "修復後も解決不能が残っている");
});

test("修復後の形が既存の「誤登録」判定と同じ扱いになる", () => {
  /*
    is_active=false かつ end_month=null は referral-period.ts の
    isUsableForPeriod が既に期間計算から外す形。新しい状態を増やさない。
  */
  const source = codeOnly(read("lib/referrals/referral-period.ts"));
  assert.match(source, /if \(row\.is_active === true\) return true;/);
  assert.match(source, /return row\.end_month != null;/);

  /* 前原一誠（inactive / end=null）と同じ扱いになることを実挙動で確認 */
  const rows = [
    rel({ id: "r-a", referrer_id: MAEHARA, end_month: null, is_active: false }),
    rel({ id: "r-b", referrer_id: DASH, end_month: null, is_active: false }),
  ];
  const index = period.buildReferralPeriods(rows);
  assert.equal(index.byCreator.get(CREATOR), undefined, "期間が作られている");
  assert.equal(index.unresolved.length, 0, "解決不能として報告されている");
});

// --- UI ------------------------------------------------------------------------

test("画面は admin 限定で、プレビューを経ないと確定できない", () => {
  const page = codeOnly(PAGE);
  assert.match(page, /isAdminRole\(appUser\.data\.role\)/, "admin 判定が無い");
  assert.match(page, /<RelationRepairPanel \/>/, "パネルが置かれていない");

  const ui = codeOnly(UI);
  /* 確定ボタンは plan があるときだけ描画され、ブロックがあれば押せない */
  assert.match(ui, /plan\?\.candidate \? \(/, "plan 無しでも確定できる");
  assert.match(
    ui,
    /const canApply =\s*plan != null && plan\.candidate != null && plan\.blocks\.length === 0;/,
    "ブロックがあっても押せる",
  );
  assert.match(ui, /disabled=\{isPending \|\| !canApply\}/);
});

test("画面は直接テーブルを触らない", () => {
  const ui = codeOnly(UI);
  assert.ok(!/\.from\(/.test(ui), "画面が直接テーブルを触っている");
  assert.ok(!/\.rpc\(/.test(ui), "画面が RPC を直接呼んでいる");

  const actions = [...ui.matchAll(/\b(\w+Action)\(/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(actions)].sort(),
    [
      "listRelationRepairCandidatesAction",
      "previewRelationRepairAction",
      "repairRelationAction",
    ],
    "想定外のアクションを呼んでいる",
  );
});

test("画面は保存後に DB から読み直す（数え直さない）", () => {
  const ui = codeOnly(UI);
  assert.match(
    ui,
    /const reloaded = await listRelationRepairCandidatesAction\(\)/,
    "修復後に一覧を読み直していない",
  );
});

test("画面は一括修復のボタンを持たない", () => {
  const ui = codeOnly(UI);
  for (const forbidden of [/すべて修復/, /一括/, /repairAll/, /rows\.map[\s\S]{0,200}apply\(/]) {
    assert.ok(!forbidden.test(ui), `一括修復の経路がある: ${forbidden}`);
  }
});

// --- 到達できること -------------------------------------------------------------

test("サイドバーの遷移先（/creators）からパネルへ到達できる", () => {
  /*
    サイドバー「クリエイター」の href は /creators。
    /admin/creator-referrals は highlight 用の alias にすぎず、
    クリックしても開かれない。パネルをそこだけに置くと
    気づけないまま異常が残る（2026-10-03）。
  */
  const nav = codeOnly(NAV);
  assert.match(nav, /href: "\/creators"/, "サイドバーの遷移先が変わっている");

  const page = codeOnly(CREATORS_PAGE);
  assert.match(page, /<RelationRepairPanel \/>/, "/creators にパネルが無い");
  assert.match(
    page,
    /isAdmin \? <RelationRepairPanel \/> : null/,
    "代理店ユーザーにも出てしまう",
  );
});

test("パネルを置いた画面はすべて admin 限定", () => {
  for (const [name, source] of [
    ["/admin/creator-referrals", PAGE],
    ["/creators", CREATORS_PAGE],
  ]) {
    const code = codeOnly(source);
    assert.match(code, /isAdminRole\(/, `${name} に admin 判定が無い`);
    assert.match(code, /<RelationRepairPanel/, `${name} にパネルが無い`);
  }

  /* /creators は代理店も開ける画面なので isAdmin で囲む必要がある */
  assert.match(
    codeOnly(CREATORS_PAGE),
    /isAdmin \? <RelationRepairPanel/,
    "/creators で admin 限定になっていない",
  );
});

// --- 到達できる画面を取り違えないための固定 ------------------------------------

test("クリエイター系の管理画面すべてからパネルへ到達できる", () => {
  /*
    2026-10-03: /admin/creator-referrals → /creators と順に置いたが、
    実際に見られていたのは /admin/creator-master-editor だった。
    「どの画面を見ているか」の取り違えで二度手間になったので、
    クリエイターマスタ系の3画面すべてに置いて固定する。
  */
  for (const [name, source] of [
    ["/admin/creator-referrals", PAGE],
    ["/creators", CREATORS_PAGE],
    ["/admin/creator-master-editor", EDITOR_PAGE],
  ]) {
    assert.match(
      codeOnly(source),
      /<RelationRepairPanel/,
      `${name} にパネルが無い`,
    );
  }
});

test("見ている画面とビルドを管理者が判別できる", () => {
  /*
    「push した / デプロイ success」と「実ブラウザがその版を見ている」は別。
    ページ名と commit を画面へ出して、取り違えを一目で分かるようにする。
  */
  for (const [name, source] of [
    ["/admin/creator-referrals", PAGE],
    ["/creators", CREATORS_PAGE],
    ["/admin/creator-master-editor", EDITOR_PAGE],
  ]) {
    assert.match(codeOnly(source), /<BuildMarker page="/, `${name} にビルド表示が無い`);
  }

  /* 表示だけ。DB も外部も触らない */
  const marker = codeOnly(read("components/app/BuildMarker.tsx"));
  const ref = codeOnly(read("lib/app/build-ref.ts"));
  for (const forbidden of [/\.from\(/, /\.rpc\(/, /fetch\(/, /supabase/i]) {
    assert.ok(!forbidden.test(marker + ref), `ビルド表示が ${forbidden} に触っている`);
  }
  assert.match(ref, /VERCEL_GIT_COMMIT_SHA/, "commit を読んでいない");
});

test("パネルを置いた画面はいずれも非管理者に見えない", () => {
  /* ページ全体が admin ガードされているもの */
  for (const [name, source] of [
    ["/admin/creator-referrals", PAGE],
    ["/admin/creator-master-editor", EDITOR_PAGE],
  ]) {
    const code = codeOnly(source);
    assert.match(code, /isAdminRole\(appUser\.data\.role\)/, `${name} に admin 判定が無い`);
    assert.match(code, /redirect\("\/dashboard"\)/, `${name} が非 admin を弾いていない`);
  }

  /* /creators は代理店も開けるので条件付き描画 */
  assert.match(
    codeOnly(CREATORS_PAGE),
    /isAdmin \? <RelationRepairPanel \/> : null/,
    "/creators で admin 限定になっていない",
  );
});
