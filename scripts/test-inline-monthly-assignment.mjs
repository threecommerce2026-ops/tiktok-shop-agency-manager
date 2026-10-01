/*
  TAP実績画面の中で月別所属を確定できるようにした変更のテスト。

  ■ 何を守りたいか
  月別所属は creator_monthly_agency_assignments が唯一のソースで、
  保存経路も既存の1本（confirmMonthlyAssignments → RPC）しかない。
  画面を増やしたときに、そこへ独自の UPDATE が生えると
  ・支払済のブロック
  ・creator_monthly_agency_assignment_logs への履歴
  ・現在所属を変えない扱い
  が抜けた保存経路ができてしまう。

  このテストは「画面は増えたが保存経路は増えていない」ことを確かめる。

  実行: node --test scripts/test-inline-monthly-assignment.mjs
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

const panelPath = path.join(root, "components/agency/MonthlyAssignmentPanel.tsx");
const paymentsPath = path.join(root, "app/(app)/payments/PaymentsClient.tsx");
const actionsPath = path.join(root, "app/actions/creator-monthly-assignment.ts");

const panelSource = readFileSync(panelPath, "utf8");
const paymentsSource = readFileSync(paymentsPath, "utf8");
const actionsSource = readFileSync(actionsPath, "utf8");

/** コメントを落として「実際のコード」だけを見る */
function codeOf(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const panelCode = codeOf(panelSource);
const paymentsCode = codeOf(paymentsSource);

/*
  判定ロジックは TSX から切り出してある（UI を読み込まずに検証するため）。
*/
const draft = await jiti.import(
  path.join(root, "lib/agency/monthly-assignment-draft.ts"),
);

const AGENCIES = [
  { id: "a-three", name: "THREE.inc", isActive: true },
  { id: "a-ext", name: "外部代理店A", isActive: true },
  { id: "a-old", name: "旧代理店", isActive: false },
];

function row(overrides) {
  return {
    targetMonth: "2026-05",
    effectiveAgencyId: null,
    effectiveAgencyName: null,
    state: "none",
    monthlyAgencyId: null,
    monthlyAgencyName: null,
    agencyRevenue: 0,
    lineCount: 0,
    isExternalPayable: false,
    hasPaidReward: false,
    paidRewardAmount: 0,
    ...overrides,
  };
}

// --- PHASE 2: 別ページへ遷移しない -------------------------------------------

test("TAP実績から月別所属へ別ページ遷移しない", () => {
  assert.ok(
    !/href=\{`\/admin\/creator-assignment\?creator=/.test(paymentsCode),
    "まだ /admin/creator-assignment への遷移リンクが残っている",
  );
  assert.ok(
    /<MonthlyAssignmentLauncher/.test(paymentsCode),
    "TAP実績に月別所属パネルが埋め込まれていない",
  );
});

// --- PHASE 3: 月ごとに代理店を選べる -----------------------------------------

test("月ごとに別の代理店を選んで確定できる", () => {
  const rows = [
    row({ targetMonth: "2026-05" }),
    row({ targetMonth: "2026-06" }),
  ];
  const changes = draft.buildPlannedChanges(
    rows,
    { "2026-05": "a-three", "2026-06": "a-ext" },
    AGENCIES,
  );

  assert.deepEqual(
    changes.map((c) => [c.targetMonth, c.agencyName]),
    [
      ["2026-05", "THREE.inc"],
      ["2026-06", "外部代理店A"],
    ],
  );
});

test("「変更しない」を選んだ月は保存対象に入らない", () => {
  const changes = draft.buildPlannedChanges(
    [row({ targetMonth: "2026-05" }), row({ targetMonth: "2026-06" })],
    { "2026-05": "a-three", "2026-06": "" },
    AGENCIES,
  );
  assert.deepEqual(changes.map((c) => c.targetMonth), ["2026-05"]);
});

test("いまと同じ代理店を選び直しても保存対象に入らない", () => {
  const changes = draft.buildPlannedChanges(
    [row({ monthlyAgencyId: "a-three", monthlyAgencyName: "THREE.inc", state: "monthly" })],
    { "2026-05": "a-three" },
    AGENCIES,
  );
  assert.equal(changes.length, 0, "同じ値を書き込もうとしている");
});

test("支払済の月は選択されていても保存対象に入らない", () => {
  const changes = draft.buildPlannedChanges(
    [row({ hasPaidReward: true, paidRewardAmount: 1000 })],
    { "2026-05": "a-ext" },
    AGENCIES,
  );
  assert.equal(changes.length, 0, "支払済の月を変更しようとしている");
});

test("確定内容は対象月の昇順で並ぶ", () => {
  const changes = draft.buildPlannedChanges(
    [row({ targetMonth: "2026-07" }), row({ targetMonth: "2026-03" })],
    { "2026-07": "a-ext", "2026-03": "a-ext" },
    AGENCIES,
  );
  assert.deepEqual(changes.map((c) => c.targetMonth), ["2026-03", "2026-07"]);
});

test("「所属なし」を確定する選択肢は置いていない", () => {
  /*
    RPC set_creator_monthly_agency_assignment が p_agency_id is null を
    拒否するため、所属なしで確定する正式経路が存在しない。
    選択肢を出すと保存できない操作を誘発するので置かない。
    所属を外す操作は「確定を解除」が担当する。
  */
  assert.ok(
    !/所属なし/.test(panelCode),
    "保存できない「所属なし」の選択肢が生えている",
  );
  assert.ok(
    /「所属なし」で確定できない理由/.test(panelSource),
    "置いていない理由が書かれていない",
  );
  assert.ok(
    /確定を解除/.test(panelCode),
    "所属を外す正式経路（確定を解除）が消えている",
  );
});

// --- PHASE 4: まとめ選択は入力欄を埋めるだけ ---------------------------------

test("まとめ選択はDBへ書かず、入力欄を埋めるだけだと明記されている", () => {
  assert.ok(
    /入力欄を埋めるだけで、まだ保存しません/.test(panelSource),
    "まとめ選択が保存しないことを画面で伝えていない",
  );
  assert.ok(
    /未確定月の選択欄を埋める/.test(panelCode),
    "未確定月をまとめて選ぶ操作が無い",
  );
});

// --- PHASE 5: 2段階の確認 -----------------------------------------------------

test("確認してから確定する2段階になっている", () => {
  assert.ok(/変更内容を確認/.test(panelCode), "確認ステップが無い");
  assert.ok(
    /この内容で月別所属を確定/.test(panelCode),
    "確定ステップが無い",
  );
  assert.ok(
    /stage === "edit"/.test(panelCode),
    "編集中と確認中を分けていない",
  );
});

test("変更が1件も無ければ確認へ進めない", () => {
  const changes = draft.buildPlannedChanges([row({})], {}, AGENCIES);
  assert.equal(changes.length, 0);
  assert.ok(
    /disabled=\{changes\.length === 0\}/.test(panelCode),
    "変更ゼロでも確認ボタンが押せる",
  );
});

// --- PHASE 6: 確定済を変える場合の警告 ---------------------------------------

test("確定済の月を変える場合だけ強い警告の対象になる", () => {
  const changes = draft.buildPlannedChanges(
    [
      row({ targetMonth: "2026-05" }),
      row({
        targetMonth: "2026-06",
        monthlyAgencyId: "a-three",
        monthlyAgencyName: "THREE.inc",
        state: "monthly",
      }),
    ],
    { "2026-05": "a-ext", "2026-06": "a-ext" },
    AGENCIES,
  );

  const reconfirmed = draft.reconfirmedChanges(changes);
  assert.deepEqual(reconfirmed.map((c) => c.targetMonth), ["2026-06"]);
  assert.equal(reconfirmed[0].previousAgencyName, "THREE.inc");
});

test("新規確定だけなら強い警告は出ない", () => {
  const changes = draft.buildPlannedChanges(
    [row({ targetMonth: "2026-05" })],
    { "2026-05": "a-ext" },
    AGENCIES,
  );
  assert.equal(draft.reconfirmedChanges(changes).length, 0);
});

test("確定済を変える警告に再集計の案内がある", () => {
  assert.ok(
    /確定済を変更/.test(panelCode),
    "確定済の付け替えだと分かる表示が無い",
  );
  assert.ok(
    /再集計/.test(panelSource),
    "再集計の案内が消えている",
  );
});

// --- PHASE 8 / 9 / 10: 触ってはいけないもの ----------------------------------

test("パネルは現在所属（creators.agency_id）を変更しない", () => {
  assert.ok(
    !/creators["']?\s*\)/.test(panelCode.replace(/creatorId|creatorName/g, "")),
    "creators テーブルへ触れている",
  );
  assert.ok(
    !/agency_assignment_state/.test(panelCode),
    "現在所属の確認状態を書き換えている",
  );
  assert.ok(
    /現在所属は変更しません/.test(panelSource),
    "現在所属を変えない旨の表示が消えている",
  );
});

test("パネルは紹介者・紹介報酬を触らない", () => {
  for (const forbidden of [
    "creator_referrals",
    "referred_by_referrer_id",
    "referrer_assignment_state",
    "referral_reward_items",
    "linkCreatorToReferrer",
  ]) {
    assert.ok(
      !panelCode.includes(forbidden),
      `月別所属パネルが ${forbidden} を触っている`,
    );
  }
});

test("パネルは報酬・payout・settlement を再計算しない", () => {
  for (const forbidden of [
    "agency_reward_items",
    "referral_payouts",
    "payment_batches",
    "syncReferralRewards",
    "recalculate",
  ]) {
    assert.ok(
      !panelCode.includes(forbidden),
      `月別所属パネルが ${forbidden} を触っている`,
    );
  }
});

// --- 保存経路を増やしていない ------------------------------------------------

test("パネルは既存の正式アクションだけを呼ぶ", () => {
  assert.ok(
    /bulkConfirmMonthlyAssignmentsAction/.test(panelCode),
    "既存の確定アクションを使っていない",
  );
  assert.ok(
    /resetCreatorMonthlyAssignmentAction/.test(panelCode),
    "既存の解除アクションを使っていない",
  );
  assert.ok(
    !/\.from\(\s*["']creator_monthly_agency_assignments["']/.test(panelCode),
    "パネルが直接テーブルを書き換えている",
  );
  assert.ok(
    !/\.rpc\(/.test(panelCode),
    "パネルが RPC を直接呼んでいる",
  );
});

test("TAP実績側も独自の所属保存処理を持たない", () => {
  assert.ok(
    !/\.from\(\s*["']creator_monthly_agency_assignments["']/.test(paymentsCode),
    "TAP実績が月別所属テーブルを直接書き換えている",
  );
  assert.ok(
    !/set_creator_monthly_agency_assignment/.test(paymentsCode),
    "TAP実績が RPC を直接呼んでいる",
  );
});

test("確定アクションは支払済チェックつきの共通処理を経由する", () => {
  assert.ok(
    /confirmMonthlyAssignments\(/.test(codeOf(actionsSource)),
    "共通の確定処理を経由していない",
  );
});

// --- PHASE 11: 保存後は DB から読み直す --------------------------------------

test("保存後はDBから読み直し、画面側で数え直さない", () => {
  assert.ok(
    /loadCreatorMonthlyAssignmentAction\(data\.creatorId\)/.test(panelCode),
    "保存後にパネルの内容を読み直していない",
  );
  assert.ok(
    /onSaved\?\.\(\)/.test(panelCode),
    "呼び出し側へ読み直しを伝えていない",
  );
  assert.ok(
    /onSaved=\{load\}/.test(paymentsCode),
    "TAP実績が保存後に一覧を読み直していない",
  );
});

test("TAP実績の件数はサーバーから取得した集計を使う", () => {
  /*
    「115→114」のような引き算を画面側でしない。
    件数は fetchTapCreatorOverviewAction の戻り値をそのまま出す。
  */
  assert.ok(
    /fetchTapCreatorOverviewAction\(\)/.test(paymentsCode),
    "一覧の再取得経路が無い",
  );
  assert.ok(
    !/unconfirmedAgencyCreatorCount\s*-\s*1/.test(paymentsCode),
    "画面側で件数を手計算している",
  );
});

// --- 画面間で同じ実装を使う ---------------------------------------------------

test("TAP実績・クリエイター一覧・代理店報酬が同じパネルを使う", () => {
  for (const file of [
    "app/(app)/payments/PaymentsClient.tsx",
    "app/(app)/creators/CreatorMasterClient.tsx",
    "app/(app)/revenue/AgencyRewardTabClient.tsx",
  ]) {
    const source = readFileSync(path.join(root, file), "utf8");
    assert.ok(
      /MonthlyAssignmentLauncher/.test(source),
      `${file} が共通パネルを使っていない`,
    );
  }
});
