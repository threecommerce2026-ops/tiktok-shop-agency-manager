/*
  月別クリエイター区分 一括確認・確定ボードのテスト。

  ■ 何を守りたいか
  この画面は 329 行をまとめて書き込む。保存経路が 1 本から外れると、
  ・支払済みのブロック
  ・creator_monthly_account_management_type_logs への履歴
  ・auth.uid() の記録
  ・現在区分を変えない扱い
  が抜けた書き込みが一度に大量に入る。

  また、埋める値は必ず「現在区分」であること。
  creator_master_change_logs の日時から過去区分を推測してはいけない
  （2026-10-03 確定: 9月末の区分変更はマスタ訂正であって
   実運用の変更日ではない）。

  実行: node --test scripts/test-monthly-account-type-board.mjs
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

const draft = await jiti.import(
  path.join(root, "lib/creators/monthly-account-type-board-draft.ts"),
);
const board = await jiti.import(
  path.join(root, "lib/db/monthly-account-type-board-queries.ts"),
);

const read = (rel) => readFileSync(path.join(root, rel), "utf8");
/** コメントを落として「実際のコード」だけを見る */
const codeOnly = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const PAGE = read("app/(app)/admin/monthly-account-management-types/page.tsx");
const UI = read(
  "app/(app)/admin/monthly-account-management-types/MonthlyAccountTypeBoardClient.tsx",
);
const QUERIES = read("lib/db/monthly-account-type-board-queries.ts");
const ACTIONS = read("app/actions/creator-monthly-account-type.ts");
const CONFIRM = read("lib/creators/confirm-monthly-account-types.ts");
const SETTINGS = read("app/(app)/settings/page.tsx");
const NAV = read("lib/nav/app-nav.ts");

function row(overrides) {
  return {
    creatorId: "c1",
    creatorName: "クリエイター1",
    tiktokId: "creator_one",
    targetMonth: "2026-05",
    currentType: "self_operated",
    monthlyType: null,
    effectiveType: "self_operated",
    source: "current",
    referralEligible: false,
    referralBase: 1000,
    lineCount: 3,
    rewardAmount: 0,
    rewardItemCount: 0,
    hasPaidReward: false,
    settlementFinalized: false,
    hasReferrer: true,
    referralRate: 0.05,
    ...overrides,
  };
}

// --- 権限 ----------------------------------------------------------------------

test("agency ユーザーはアクセスできない", () => {
  const code = codeOnly(PAGE);
  assert.match(code, /isAdminRole\(appUser\.data\.role\)/, "admin 判定が無い");
  assert.match(code, /redirect\("\/dashboard"\)/, "admin 以外を弾いていない");
  assert.match(
    code,
    /redirect\("\/login\?next=\/admin\/monthly-account-management-types"\)/,
    "未ログインを弾いていない",
  );
});

test("サイドバー / 設定の導線は管理者側だけ", () => {
  assert.ok(
    SETTINGS.includes('{ href: "/admin/monthly-account-management-types", label: "月別クリエイター区分" }'),
    "管理者メニューに追加されていない",
  );
  /* ADMIN_INTERNAL_LINKS は isAdmin でガードされている */
  assert.match(
    codeOnly(SETTINGS),
    /isAdmin \? \([\s\S]{0,400}ADMIN_INTERNAL_LINKS/,
    "管理者リンクが admin 限定になっていない",
  );
  assert.ok(
    NAV.includes('"/admin/monthly-account-management-types"'),
    "ナビの別名に入っていない",
  );
});

// --- 埋める（WRITE しない）------------------------------------------------------

test("未確定月を埋めても DB へは書き込まない（選択を作るだけ）", () => {
  const rows = [
    row({ targetMonth: "2026-05" }),
    row({ targetMonth: "2026-06", monthlyType: "self_operated", source: "monthly" }),
    row({ targetMonth: "2026-07", hasPaidReward: true }),
  ];

  const selection = draft.selectUnconfirmedRows(rows);

  /* 未確定だけ。確定済みと支払済みは外す */
  assert.deepEqual([...selection], ["c1|2026-05"]);

  /* 画面側も「保存しない」と伝えている */
  assert.ok(
    UI.includes("この操作は選択するだけで、まだ保存しません"),
    "保存しない旨の表示が無い",
  );
});

test("埋める値は現在区分。変更ログから推測しない", () => {
  const changes = draft.buildBoardChanges(
    [row({ currentType: "self_operated" })],
    new Set(["c1|2026-05"]),
  );

  assert.equal(changes.length, 1);
  assert.equal(changes[0].accountManagementType, "self_operated");

  /* 画面・クエリ・draft のどこも変更ログを読まない */
  for (const [name, source] of [
    ["board UI", UI],
    ["board queries", QUERIES],
    ["board draft", read("lib/creators/monthly-account-type-board-draft.ts")],
  ]) {
    assert.ok(
      !codeOnly(source).includes("creator_master_change_logs"),
      `${name} が変更ログを読んでいる`,
    );
  }
});

test("選択していない行は保存対象に入らない", () => {
  const changes = draft.buildBoardChanges(
    [row({ targetMonth: "2026-05" }), row({ targetMonth: "2026-06" })],
    new Set(["c1|2026-05"]),
  );
  assert.deepEqual(changes.map((c) => c.targetMonth), ["2026-05"]);
});

test("すでに同じ区分で確定済みの行は保存対象に入らない", () => {
  const changes = draft.buildBoardChanges(
    [row({ monthlyType: "self_operated", source: "monthly" })],
    new Set(["c1|2026-05"]),
  );
  assert.equal(changes.length, 0, "同じ値を書き込もうとしている");
});

test("支払済みの行は選択されていても保存対象に入らない", () => {
  const changes = draft.buildBoardChanges(
    [row({ hasPaidReward: true })],
    new Set(["c1|2026-05"]),
  );
  assert.equal(changes.length, 0, "支払済みの行を変更しようとしている");
});

// --- 確認画面の集計 --------------------------------------------------------------

test("確認画面の件数は区分ごとに数える", () => {
  const rows = [
    row({ creatorId: "a", tiktokId: "a", targetMonth: "2026-05", currentType: "standard" }),
    row({ creatorId: "a", tiktokId: "a", targetMonth: "2026-06", currentType: "standard" }),
    row({ creatorId: "b", tiktokId: "b", targetMonth: "2026-05", currentType: "self_operated" }),
    row({ creatorId: "c", tiktokId: "c", targetMonth: "2026-05", currentType: "account_lending" }),
  ];
  const selection = new Set(rows.map((r) => draft.boardRowKey(r)));
  const summary = draft.summarizeBoardChanges(draft.buildBoardChanges(rows, selection));

  assert.equal(summary.creatorCount, 3);
  assert.equal(summary.rowCount, 4);
  assert.equal(summary.standardCount, 2);
  assert.equal(summary.selfOperatedCount, 1);
  assert.equal(summary.accountLendingCount, 1);
  assert.equal(summary.reconfirmCount, 0);
});

test("確定済みを付け替える件数を別に数える", () => {
  const rows = [
    row({ targetMonth: "2026-05" }),
    row({
      targetMonth: "2026-06",
      monthlyType: "standard",
      source: "monthly",
      currentType: "self_operated",
    }),
  ];
  const summary = draft.summarizeBoardChanges(
    draft.buildBoardChanges(rows, new Set(["c1|2026-05", "c1|2026-06"])),
  );
  assert.equal(summary.reconfirmCount, 1);
});

test("件数はハードコードせず集計から出す", () => {
  const code = codeOnly(UI);
  for (const hardcoded of ["145", "329", "250", "65", "14"]) {
    assert.ok(
      !new RegExp(`[^\\w]${hardcoded}[^\\w]`).test(code.replace(/w-\d+|min-w-\[\d+px\]|text-\[\d+px\]|py-\d+|px-\d+|gap-\d+|grid-cols-\d+|colSpan=\{\d+\}|slice\(0, ?\d+\)/g, "")),
      `件数 ${hardcoded} がハードコードされている`,
    );
  }
  assert.match(code, /summary\.rowCount/, "集計値を使っていない");
  assert.match(code, /data\.totals\.creatorCount/, "集計値を使っていない");
});

// --- 報酬影響確認 ----------------------------------------------------------------

test("報酬が発生している creator を確認画面で名指しする", () => {
  const rows = [
    row({ creatorId: "g", tiktokId: "golden", rewardAmount: 15224.15, rewardItemCount: 100 }),
    row({ creatorId: "t", tiktokId: "truth", rewardAmount: 1147.55, rewardItemCount: 50 }),
    row({ creatorId: "k", tiktokId: "kanya", rewardAmount: 0, referralBase: 759181 }),
    row({ creatorId: "z", tiktokId: "zero", rewardAmount: 0, referralBase: 0 }),
  ];
  const selection = new Set(rows.map((r) => draft.boardRowKey(r)));
  const picked = draft.pickRewardImpactRows(rows, draft.buildBoardChanges(rows, selection));

  const ids = picked.map((r) => r.tiktokId);
  assert.ok(ids.includes("golden"), "報酬ありの creator が出ていない");
  assert.ok(ids.includes("truth"), "報酬ありの creator が出ていない");
  assert.ok(ids.includes("kanya"), "算定元が大きい creator が出ていない");
  assert.ok(!ids.includes("zero"), "影響の無い creator まで出している");
});

test("対象 creator は固定値で書かない", () => {
  const source = read("lib/creators/monthly-account-type-board-draft.ts");
  for (const hardcoded of ["kanya_land", "golden_shark", "truth.inc0804"]) {
    assert.ok(
      !codeOnly(source).includes(hardcoded),
      `${hardcoded} が固定で書かれている`,
    );
    assert.ok(
      !codeOnly(UI).includes(hardcoded),
      `${hardcoded} が画面に固定で書かれている`,
    );
  }
});

test("紹介報酬が自動再計算されないと画面で伝える", () => {
  assert.ok(
    UI.includes("月別区分を確定しても紹介報酬は自動再計算されません"),
    "報酬影響確認の注意書きが無い",
  );
  assert.ok(
    UI.includes("この操作では紹介報酬・支払データは変更されません"),
    "最終確認の注意書きが無い",
  );
  assert.ok(
    UI.includes("この画面からは再集計を実行しません"),
    "再計算プレビューの注意書きが無い",
  );
});

// --- 二段階確認 ------------------------------------------------------------------

test("確認してから確定する二段階になっている", () => {
  const code = codeOnly(UI);
  assert.match(code, /変更内容を確認/, "確認ステップが無い");
  assert.match(code, /この内容で月別区分を確定/, "確定ステップが無い");
  assert.match(code, /stage === "edit"/, "編集中と確認中を分けていない");
  /* 確認を経ないと submit が描画されない */
  assert.ok(
    code.indexOf('setStage("confirm")') < code.indexOf("onClick={submit}"),
    "確認を飛ばして確定できる",
  );
});

test("変更が無ければ確認へ進めない", () => {
  assert.match(
    codeOnly(UI),
    /disabled=\{changes\.length === 0\}/,
    "変更ゼロでも確認ボタンが押せる",
  );
});

// --- 保存経路 ----------------------------------------------------------------------

test("保存は既存の正式アクションだけを通る", () => {
  const code = codeOnly(UI);
  assert.match(code, /bulkConfirmMonthlyAccountTypesAction/, "一括確定アクションを使っていない");
  assert.ok(!/\.from\(/.test(code), "画面が直接テーブルを触っている");
  assert.ok(!/\.rpc\(/.test(code), "画面が RPC を直接呼んでいる");
  /*
    Set.delete のような JS のメソッドまで拾わないよう、
    DB への書き込みに見える形だけを見る。
  */
  for (const write of [
    /\.(insert|upsert)\(/,
    /\.update\(\s*\{/,
    /\.delete\(\)/,
    /supabase/i,
  ]) {
    assert.ok(!write.test(code), `画面に書き込み処理がある: ${write}`);
  }
});

test("一括アクションは共通の確定処理と RPC を使う", () => {
  const code = codeOnly(ACTIONS);
  assert.match(code, /confirmMonthlyAccountTypes\(/, "共通の確定処理を経由していない");
  assert.ok(
    !/\.from\(\s*["']creator_monthly_account_management_types["']\s*\)[\s\S]{0,120}\.(insert|upsert|update|delete)\(/.test(code),
    "アクションが直接テーブルを書き換えている",
  );
});

test("WRITE はユーザーのクライアントで行い auth.uid を残す", () => {
  const code = codeOnly(CONFIRM);
  assert.match(
    code,
    /userClient\.rpc\(\s*"set_creator_monthly_account_management_type"/,
    "RPC をユーザーのクライアントで呼んでいない",
  );
  /* service role は支払済みチェックだけ */
  assert.ok(
    !/adminClient\.rpc\(/.test(code),
    "service role で RPC を呼んでいる（auth.uid が残らない）",
  );
  const actions = codeOnly(ACTIONS);
  assert.match(
    actions,
    /confirmMonthlyAccountTypes\(\s*auth\.supabase,\s*getSupabaseAdmin\(\)/,
    "ユーザーのクライアントを渡していない",
  );
});

// --- 既存ガード ----------------------------------------------------------------------

test("支払済みの行を画面でも名指しする（黙ってスキップしない）", () => {
  const code = codeOnly(UI);
  assert.match(code, /row\.hasPaidReward/, "支払済みを見ていない");
  assert.ok(
    UI.includes("支払済みのため確定できない行があります"),
    "ブロック対象の表示が無い",
  );
  /* サーバー側もスキップした件数と月を返す */
  assert.match(
    codeOnly(ACTIONS),
    /支払済みのため \$\{result\.blocked\.length\} 件をスキップ/,
    "スキップした行を伝えていない",
  );
});

test("月次確定済みの月を画面が把握している", () => {
  assert.match(codeOnly(QUERIES), /settlementFinalized/, "finalized を持っていない");
  assert.match(
    codeOnly(QUERIES),
    /list_referral_month_settlements/,
    "確定状況を RPC 経由で読んでいない",
  );
  assert.match(codeOnly(UI), /settlementFinalized/, "画面で使っていない");
});

// --- 触ってはいけないもの ------------------------------------------------------------

test("画面もクエリも報酬・payout・紹介者・所属を書き換えない", () => {
  for (const [name, source] of [["board UI", UI], ["board queries", QUERIES]]) {
    const code = codeOnly(source);
    for (const forbidden of [
      /syncReferralRewards/,
      /finalize_referral_month/,
      /linkCreatorToReferrer/,
      /updateCreatorMaster/,
      /confirmMonthlyAssignments/,
      /\.from\(\s*["']creator_referrals["']\s*\)[\s\S]{0,120}\.(insert|update|upsert|delete)\(/,
      /\.from\(\s*["']creator_monthly_agency_assignments["']\s*\)[\s\S]{0,120}\.(insert|update|upsert|delete)\(/,
      /\.from\(\s*["']referral_reward_items["']\s*\)[\s\S]{0,120}\.(insert|update|upsert|delete)\(/,
      /\.from\(\s*["']referral_payouts["']\s*\)/,
      /\.from\(\s*["']payment_batches["']\s*\)/,
      /\.from\(\s*["']creators["']\s*\)[\s\S]{0,120}\.(insert|update|upsert|delete)\(/,
    ]) {
      assert.ok(!forbidden.test(code), `${name} が ${forbidden} に該当する`);
    }
  }
});

// --- 再計算プレビュー ----------------------------------------------------------------

test("再計算プレビューは読み取りのみで、実行ボタンを持たない", () => {
  const code = codeOnly(UI);
  assert.match(code, /rewardPreview/, "プレビューを出していない");
  /*
    「再集計を実行しません」という注意書きが出るので、
    文言ではなく実行経路そのものを見る。
  */
  for (const run of [
    /syncReferralRewardsAction/,
    /syncReferralRewardsForMonth/,
    /onClick=\{[^}]*[sS]ync/,
  ]) {
    assert.ok(!run.test(code), `この画面から再集計を実行できてしまう: ${run}`);
  }
});

test("プレビューは標準 = 紹介者あり の行だけを数える", () => {
  const rows = [
    /* 対象: standard + 紹介者あり */
    row({ creatorId: "a", tiktokId: "a", currentType: "standard", effectiveType: "standard",
          referralBase: 1000, lineCount: 2, hasReferrer: true, rewardAmount: 0 }),
    /* 対象外: self_operated */
    row({ creatorId: "b", tiktokId: "b", effectiveType: "self_operated",
          referralBase: 2000, lineCount: 3, hasReferrer: true, rewardAmount: 100 }),
    /* 対象外: 紹介者なし */
    row({ creatorId: "c", tiktokId: "c", currentType: "standard", effectiveType: "standard",
          referralBase: 3000, lineCount: 4, hasReferrer: false, rewardAmount: 0 }),
  ];

  const preview = board.buildRewardPreview(rows, [
    { creator_id: "b", is_reward_target: true },
  ]);

  assert.equal(preview.beforeItemCount, 1);
  assert.equal(preview.afterItemCount, 2, "対象行の明細数が合わない");
  assert.equal(preview.afterAmount, 50, "1000 × 5% になっていない");
  assert.equal(preview.beforeAmount, 100);

  /* 減る creator（b）が差額一覧に出る */
  const b = preview.changes.find((change) => change.tiktokId === "b");
  assert.ok(b, "減る creator が出ていない");
  assert.equal(b.diff, -100);
});
