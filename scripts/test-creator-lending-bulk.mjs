/*
  端末貸し出し報酬「一括有効化」と「範囲再集計」のテスト。

  ■ 何を守りたいか
  この画面は人月をまとめて書き込む。対象の決定が1本から外れると、
  ・対象期間外（2026-08 以降）の人月
  ・支払済み・支払明細に占有済みの人月
  ・すでに有効化されている人月（＝監査ログの重複）
  へ一度に書き込みが入る。

  ■ 既定分配率をここで数えない
  既定 80% は lib/creators/lending-reward-engine.ts の
  CREATOR_LENDING_SPLIT_RATE が単一ソース。
  draft は null を運ぶだけで、テストもその前提を固定する。

  ■ 初期精算の範囲
  2026-02〜2026-07 の 5 名・17 人月は一度きりの過去分精算
  （2026-10-16 承認）。初期精算モードでは範囲外を選択も処理も
  できないことを固定する。通常運用の期間指定は別経路。

  実行: node --test scripts/test-creator-lending-bulk.mjs
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

const draft = await jiti.import(path.join(root, "lib/creators/lending-term-bulk-draft.ts"));
const engine = await jiti.import(path.join(root, "lib/creators/lending-reward-engine.ts"));

const ACTION_SRC = readFileSync(
  path.join(root, "app/actions/creator-lending-rewards.ts"),
  "utf8",
);
const PANEL_SRC = readFileSync(
  path.join(root, "app/(app)/revenue/LendingRewardTabClient.tsx"),
  "utf8",
);
const BOARD_SRC = readFileSync(
  path.join(root, "app/(app)/admin/monthly-account-management-types/MonthlyAccountTypeBoardClient.tsx"),
  "utf8",
);
const RPC_SQL = readFileSync(
  path.join(root, "supabase/migrations/20261019100000_creator_lending_terms_rpc.sql"),
  "utf8",
);
const LENDING_TERMS_RPC_NAME = "set_creator_lending_terms";

const CURRENT_MONTH = "2026-10";

/* --- テスト用の行を組む（本番の型と同じ形） -------------------------------- */

function monthRow(overrides = {}) {
  return {
    targetMonth: "2026-06",
    itemCount: 0,
    agencyRevenue: 0,
    rewardAmount: 0,
    selfShareAmount: 0,
    splitRate: null,
    effectiveSplitRate: 0.8,
    isActivated: false,
    paidAmount: 0,
    unpaidAmount: 0,
    paymentState: "none",
    hasOpenBatch: false,
    exclusionReason: "inactive_terms",
    exclusionLabel: "この月は端末貸し出しの対象として有効化されていません",
    pendingLineCount: 10,
    pendingAgencyRevenue: 1000,
    ...overrides,
  };
}

function creatorRow(creatorId, tiktokId, monthlyRows) {
  return {
    creatorId,
    creatorName: tiktokId,
    tiktokId,
    inHouseAgencyName: "THREE.inc",
    itemCount: 0,
    agencyRevenue: 0,
    rewardAmount: 0,
    selfShareAmount: 0,
    paidAmount: 0,
    unpaidAmount: 0,
    monthCount: 0,
    pendingMonthCount: monthlyRows.length,
    pendingAgencyRevenue: 0,
    isActivated: false,
    bankState: "missing",
    hasBankAccount: false,
    monthlyRows,
  };
}

/* 本番と同じ 5 名・17 人月（2026-02〜07）＋ 対象外の 2026-08 */
const C = {
  yoccyan: "f4c78dcb-ea64-4f9a-a81e-b7271063721d",
  afro: "dc06c0f3-eb7e-4b67-83d8-82672f50f067",
  nikkoro: "995670f6-5950-4c97-80d9-57591cba363e",
  kobayashi: "ce33b380-3938-45a6-a3ae-b3e8039fcb65",
  threeShop: "8fc7beb4-b275-490b-a7f6-7a8f68217fff",
};

function settlementRows({ extraAugust = true } = {}) {
  const months = (list) => list.map((m) => monthRow({ targetMonth: m }));

  return [
    creatorRow(C.yoccyan, "yoccyan_", months(
      extraAugust
        ? ["2026-02", "2026-03", "2026-06", "2026-07", "2026-08"]
        : ["2026-02", "2026-03", "2026-06", "2026-07"],
    )),
    creatorRow(C.afro, "afro...time", months(["2026-03", "2026-04", "2026-05", "2026-06", "2026-07"])),
    creatorRow(C.nikkoro, "nikkoro.gashi", months(["2026-04", "2026-05", "2026-06", "2026-07"])),
    creatorRow(C.kobayashi, "kobayashi.commerce", months(["2026-06", "2026-07"])),
    creatorRow(C.threeShop, "three.shop.japan", months(["2026-06", "2026-07"])),
  ];
}

const selectAll = (candidates) => draft.selectLendingTermCandidates(candidates);

/* --- 1. 候補の抽出 --------------------------------------------------------- */

test("1-1. 初期精算モードは 2026-02〜2026-07 の 17 人月だけを選択候補にする", () => {
  const candidates = draft.collectLendingTermCandidates(
    settlementRows(),
    draft.INITIAL_LENDING_SETTLEMENT,
  );
  const selectable = candidates.filter((c) => c.selectable);

  assert.equal(selectable.length, 17);
  assert.equal(new Set(selectable.map((c) => c.creatorId)).size, 5);
  assert.deepEqual(
    [...new Set(selectable.map((c) => c.targetMonth))].sort(),
    ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"],
  );
});

test("1-2. 2026-08 は候補に出るが選択できない（理由つき）", () => {
  const candidates = draft.collectLendingTermCandidates(
    settlementRows(),
    draft.INITIAL_LENDING_SETTLEMENT,
  );
  const august = candidates.filter((c) => c.targetMonth === "2026-08");

  assert.equal(august.length, 1);
  assert.equal(august[0].selectable, false);
  assert.equal(august[0].blockReason, "out_of_scope");
  assert.match(draft.LENDING_TERM_BLOCK_LABEL.out_of_scope, /対象期間外/);
});

test("1-3. 通常運用（範囲なし）では 2026-08 も選択できる", () => {
  const candidates = draft.collectLendingTermCandidates(settlementRows(), null);
  const august = candidates.find((c) => c.targetMonth === "2026-08");

  assert.equal(august.selectable, true);
  assert.equal(candidates.filter((c) => c.selectable).length, 18);
});

test("1-4. すでに有効化されている人月は選択できない（二重実行の no-op）", () => {
  const rows = [creatorRow(C.yoccyan, "yoccyan_", [monthRow({ isActivated: true })])];
  const candidates = draft.collectLendingTermCandidates(rows, draft.INITIAL_LENDING_SETTLEMENT);

  assert.equal(candidates[0].selectable, false);
  assert.equal(candidates[0].blockReason, "already_active");
});

test("1-5. 支払済みの人月は選択できない", () => {
  const rows = [creatorRow(C.yoccyan, "yoccyan_", [monthRow({ paymentState: "paid" })])];
  const candidates = draft.collectLendingTermCandidates(rows, draft.INITIAL_LENDING_SETTLEMENT);

  assert.equal(candidates[0].selectable, false);
  assert.equal(candidates[0].blockReason, "paid");
});

test("1-6. 支払明細に占有されている人月は選択できない", () => {
  const rows = [creatorRow(C.yoccyan, "yoccyan_", [monthRow({ hasOpenBatch: true })])];
  const candidates = draft.collectLendingTermCandidates(rows, draft.INITIAL_LENDING_SETTLEMENT);

  assert.equal(candidates[0].selectable, false);
  assert.equal(candidates[0].blockReason, "in_batch");
});

test("1-7. 計上できる明細が無い人月は選択できない（無駄な書き込みを作らない）", () => {
  const rows = [
    creatorRow(C.yoccyan, "yoccyan_", [
      monthRow({ pendingLineCount: 0, itemCount: 0 }),
    ]),
  ];
  const candidates = draft.collectLendingTermCandidates(rows, draft.INITIAL_LENDING_SETTLEMENT);

  assert.equal(candidates[0].selectable, false);
  assert.equal(candidates[0].blockReason, "no_pending_lines");
});

test("1-8. 支払済みの判定が有効化済みより先に出る（理由の優先順位）", () => {
  const rows = [
    creatorRow(C.yoccyan, "yoccyan_", [
      monthRow({ isActivated: true, paymentState: "paid" }),
    ]),
  ];
  const candidates = draft.collectLendingTermCandidates(rows, draft.INITIAL_LENDING_SETTLEMENT);

  assert.equal(candidates[0].blockReason, "paid");
});

/* --- 2. 書き込む行の決定 --------------------------------------------------- */

test("2-1. 選択していない人月は書き込まない", () => {
  const rows = settlementRows();
  const plan = draft.buildLendingTermChanges(rows, new Set(), {
    scope: draft.INITIAL_LENDING_SETTLEMENT,
  });

  assert.equal(plan.changes.length, 0);
});

test("2-2. 17 人月を選択すると 17 行を書き込む", () => {
  const rows = settlementRows();
  const candidates = draft.collectLendingTermCandidates(rows, draft.INITIAL_LENDING_SETTLEMENT);
  const plan = draft.buildLendingTermChanges(rows, selectAll(candidates), {
    scope: draft.INITIAL_LENDING_SETTLEMENT,
  });

  assert.equal(plan.changes.length, 17);
  assert.equal(plan.skipped.length, 0);
  assert.ok(plan.changes.every((change) => change.isActive === true));
});

test("2-3. 範囲外の人月を選択キーに混ぜても書き込まない（out_of_scope で落ちる）", () => {
  const rows = settlementRows();
  const selection = new Set([
    draft.lendingTermRowKey({ creatorId: C.yoccyan, targetMonth: "2026-08" }),
  ]);
  const plan = draft.buildLendingTermChanges(rows, selection, {
    scope: draft.INITIAL_LENDING_SETTLEMENT,
  });

  assert.equal(plan.changes.length, 0);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].reason, "out_of_scope");
});

test("2-4. 分配率が空欄なら split_rate は null（既定値を埋めない）", () => {
  const rows = settlementRows();
  const candidates = draft.collectLendingTermCandidates(rows, draft.INITIAL_LENDING_SETTLEMENT);
  const plan = draft.buildLendingTermChanges(rows, selectAll(candidates), {
    splitRate: null,
    scope: draft.INITIAL_LENDING_SETTLEMENT,
  });

  assert.ok(plan.changes.every((change) => change.splitRate === null));
  /* 既定 80% の解決はエンジン側が持つ */
  assert.equal(engine.resolveCreatorLendingSplitRate(null), engine.CREATOR_LENDING_SPLIT_RATE);
});

test("2-5. 分配率を指定すると全行に同じ率が入る", () => {
  const rows = settlementRows();
  const candidates = draft.collectLendingTermCandidates(rows, draft.INITIAL_LENDING_SETTLEMENT);
  const plan = draft.buildLendingTermChanges(rows, selectAll(candidates), {
    splitRate: 0.75,
    scope: draft.INITIAL_LENDING_SETTLEMENT,
  });

  assert.ok(plan.changes.every((change) => change.splitRate === 0.75));
});

test("2-6. 二重実行すると書き込む行が 0 になる（有効化済みは落ちる）", () => {
  const rows = settlementRows();
  const candidates = draft.collectLendingTermCandidates(rows, draft.INITIAL_LENDING_SETTLEMENT);
  const selection = selectAll(candidates);

  /* 1回目で全部有効化された状態を作る */
  const after = rows.map((row) => ({
    ...row,
    monthlyRows: row.monthlyRows.map((month) =>
      month.targetMonth <= "2026-07" ? { ...month, isActivated: true } : month,
    ),
  }));

  const plan = draft.buildLendingTermChanges(after, selection, {
    scope: draft.INITIAL_LENDING_SETTLEMENT,
  });

  assert.equal(plan.changes.length, 0);
  assert.equal(plan.skipped.length, 17);
  assert.ok(plan.skipped.every((item) => item.reason === "already_active"));
});

test("2-7. 支払済み・占有中を選択しても書き込まず理由を返す", () => {
  const rows = [
    creatorRow(C.yoccyan, "yoccyan_", [
      monthRow({ targetMonth: "2026-06", paymentState: "paid" }),
      monthRow({ targetMonth: "2026-07", hasOpenBatch: true }),
    ]),
  ];
  const selection = new Set([
    draft.lendingTermRowKey({ creatorId: C.yoccyan, targetMonth: "2026-06" }),
    draft.lendingTermRowKey({ creatorId: C.yoccyan, targetMonth: "2026-07" }),
  ]);
  const plan = draft.buildLendingTermChanges(rows, selection, {
    scope: draft.INITIAL_LENDING_SETTLEMENT,
  });

  assert.equal(plan.changes.length, 0);
  assert.deepEqual(plan.skipped.map((item) => item.reason).sort(), ["in_batch", "paid"]);
});

/* --- 3. 実行前の確認に出す集計 --------------------------------------------- */

test("3-1. 集計が 5 名 / 17 人月 / 6 か月を返す", () => {
  const rows = settlementRows();
  const candidates = draft.collectLendingTermCandidates(rows, draft.INITIAL_LENDING_SETTLEMENT);
  const plan = draft.buildLendingTermChanges(rows, selectAll(candidates), {
    scope: draft.INITIAL_LENDING_SETTLEMENT,
  });
  const summary = draft.summarizeLendingTermPlan(plan);

  assert.equal(summary.creatorCount, draft.INITIAL_LENDING_SETTLEMENT_EXPECTED.creatorCount);
  assert.equal(
    summary.personMonthCount,
    draft.INITIAL_LENDING_SETTLEMENT_EXPECTED.personMonthCount,
  );
  assert.equal(summary.months.length, 6);
  assert.equal(summary.splitRate, null);
});

test("3-2. 未計上の明細数と AP を合算する", () => {
  const rows = [
    creatorRow(C.yoccyan, "yoccyan_", [
      monthRow({ targetMonth: "2026-06", pendingLineCount: 86, pendingAgencyRevenue: 12445 }),
      monthRow({ targetMonth: "2026-07", pendingLineCount: 130, pendingAgencyRevenue: 17115 }),
    ]),
  ];
  const candidates = draft.collectLendingTermCandidates(rows, draft.INITIAL_LENDING_SETTLEMENT);
  const summary = draft.summarizeLendingTermPlan(
    draft.buildLendingTermChanges(rows, selectAll(candidates), {
      scope: draft.INITIAL_LENDING_SETTLEMENT,
    }),
  );

  assert.equal(summary.pendingLineCount, 216);
  assert.equal(summary.pendingAgencyRevenue, 29560);
});

test("3-3. 対象外として落ちた件数を数える", () => {
  const rows = settlementRows();
  const selection = new Set([
    draft.lendingTermRowKey({ creatorId: C.yoccyan, targetMonth: "2026-08" }),
    draft.lendingTermRowKey({ creatorId: C.yoccyan, targetMonth: "2026-06" }),
  ]);
  const summary = draft.summarizeLendingTermPlan(
    draft.buildLendingTermChanges(rows, selection, {
      scope: draft.INITIAL_LENDING_SETTLEMENT,
    }),
  );

  assert.equal(summary.personMonthCount, 1);
  assert.equal(summary.skippedCount, 1);
});

/* --- 4. 再集計の対象月 ----------------------------------------------------- */

test("4-1. 初期精算は 2026-02〜2026-07 の 6 か月だけを返す", () => {
  const result = draft.resolveLendingSyncMonths({
    scope: "initial_settlement",
    currentMonth: CURRENT_MONTH,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.months, [
    "2026-02",
    "2026-03",
    "2026-04",
    "2026-05",
    "2026-06",
    "2026-07",
  ]);
  assert.equal(result.scope, "initial_settlement");
});

test("4-2. 初期精算では 2026-08 以降が入らない", () => {
  const result = draft.resolveLendingSyncMonths({
    scope: "initial_settlement",
    /* 範囲外の月を指定しても無視される */
    month: "2026-08",
    fromMonth: "2026-01",
    toMonth: "2026-12",
    currentMonth: CURRENT_MONTH,
  });

  assert.ok(result.months.every((month) => month <= "2026-07"));
  assert.equal(result.months.includes("2026-08"), false);
});

test("4-3. 範囲指定は開始〜終了を展開する（通常運用）", () => {
  const result = draft.resolveLendingSyncMonths({
    scope: "range",
    fromMonth: "2026-02",
    toMonth: "2026-07",
    currentMonth: CURRENT_MONTH,
  });

  assert.equal(result.ok, true);
  assert.equal(result.months.length, 6);
  assert.equal(result.scope, "range");
});

test("4-4. 範囲指定で開始 > 終了は拒否する", () => {
  const result = draft.resolveLendingSyncMonths({
    scope: "range",
    fromMonth: "2026-07",
    toMonth: "2026-02",
    currentMonth: CURRENT_MONTH,
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /開始月が終了月より後/);
});

test("4-5. 範囲指定は当月より後を落とす", () => {
  const result = draft.resolveLendingSyncMonths({
    scope: "range",
    fromMonth: "2026-09",
    toMonth: "2026-12",
    currentMonth: CURRENT_MONTH,
  });

  assert.deepEqual(result.months, ["2026-09", "2026-10"]);
});

test("4-6. 範囲指定の上限を超えたら拒否する", () => {
  const result = draft.resolveLendingSyncMonths({
    scope: "range",
    fromMonth: "2024-01",
    toMonth: "2026-10",
    currentMonth: CURRENT_MONTH,
  });

  assert.equal(result.ok, false);
  assert.match(result.error, new RegExp(`${draft.LENDING_SYNC_MAX_MONTHS} か月`));
});

test("4-7. 形式が不正な範囲は拒否する", () => {
  for (const input of [
    { fromMonth: "2026-13", toMonth: "2026-07" },
    { fromMonth: "2026-2", toMonth: "2026-07" },
    { fromMonth: "", toMonth: "2026-07" },
  ]) {
    const result = draft.resolveLendingSyncMonths({
      scope: "range",
      ...input,
      currentMonth: CURRENT_MONTH,
    });
    assert.equal(result.ok, false, JSON.stringify(input));
  }
});

test("4-8. 単月指定は従来どおり動く（非回帰）", () => {
  const result = draft.resolveLendingSyncMonths({
    scope: "month",
    month: "2026-06",
    currentMonth: CURRENT_MONTH,
  });

  assert.deepEqual(result.months, ["2026-06"]);
  assert.equal(result.scope, "month");
});

test("4-9. 単月指定で当月より後は拒否する", () => {
  const result = draft.resolveLendingSyncMonths({
    scope: "month",
    month: "2026-12",
    currentMonth: CURRENT_MONTH,
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /当月より後/);
});

test("4-10. 年指定は当月までに制限される（従来どおり）", () => {
  const result = draft.resolveLendingSyncMonths({
    scope: "year",
    year: "2026",
    currentMonth: CURRENT_MONTH,
  });

  assert.equal(result.months.length, 10);
  assert.equal(result.months.at(-1), "2026-10");
  assert.equal(result.scope, "year");
});

test("4-11. 月キーの検証が 2026-13 / 2026-0 を弾く", () => {
  assert.equal(draft.isValidMonthKey("2026-07"), true);
  assert.equal(draft.isValidMonthKey("2026-13"), false);
  assert.equal(draft.isValidMonthKey("2026-00"), false);
  assert.equal(draft.isValidMonthKey("2026-7"), false);
  assert.equal(draft.isValidMonthKey(null), false);
});

test("4-12. 範囲判定が両端を含む", () => {
  const scope = draft.INITIAL_LENDING_SETTLEMENT;
  assert.equal(draft.isWithinMonthScope("2026-02", scope), true);
  assert.equal(draft.isWithinMonthScope("2026-07", scope), true);
  assert.equal(draft.isWithinMonthScope("2026-01", scope), false);
  assert.equal(draft.isWithinMonthScope("2026-08", scope), false);
});

/* --- 5. 経路の固定（実装が1本から外れていないか） ------------------------- */

test("5-1. 一括アクションは applyLendingTerms を通る（独自 upsert を持たない）", () => {
  const bulk = ACTION_SRC.slice(
    ACTION_SRC.indexOf("export async function bulkSetCreatorLendingTermsAction"),
    ACTION_SRC.indexOf("export type BulkLendingTermResult"),
  );

  assert.ok(bulk.length > 0);
  assert.match(bulk, /await applyLendingTerms\(/);
  /* terms / logs への直接の書き込みを持たない */
  assert.equal(/\.from\("creator_lending_terms"\)/.test(bulk), false);
  assert.equal(/\.from\("creator_lending_term_logs"\)/.test(bulk), false);
  assert.equal(/\.upsert\(/.test(bulk), false);
});

test("5-2. 書き込み経路は RPC 1本（terms と logs をアプリ層で分けて書かない）", () => {
  /*
    2026-10-19: terms の upsert と監査ログは
    set_creator_lending_terms（RPC）の中で同一トランザクションで行う。
    アプリ層が2回に分けて書くと、ログだけ失敗して履歴が欠落する。
  */
  assert.match(ACTION_SRC, /async function applyLendingTerms\(/);
  assert.match(ACTION_SRC, /userClient\.rpc\(LENDING_TERMS_RPC/);
  assert.equal(LENDING_TERMS_RPC_NAME, "set_creator_lending_terms");

  /* アプリ層のどこにも terms / logs への直接書き込みが無い */
  assert.equal(/\.from\("creator_lending_terms"\)/.test(ACTION_SRC), false);
  assert.equal(/\.from\("creator_lending_term_logs"\)/.test(ACTION_SRC), false);

  /* 実行者はアプリが入れた値ではなく DB 側が auth.uid() から記録する */
  assert.match(RPC_SQL, /v_user_id := auth\.uid\(\);/);
  assert.match(RPC_SQL, /changed_by, changed_by_email/);
  assert.match(RPC_SQL, /created_by, created_by_email/);
});

test("5-3. 監査ログは差分があるときだけ追記する（二重実行で増えない）", () => {
  assert.match(RPC_SQL, /if v_from_rate is distinct from v_rate then/);
  assert.match(RPC_SQL, /if \(not v_found\) or \(v_from_active is distinct from v_is_active\) then/);
  /* 同じ設定なら upsert もログもせず unchanged として数える */
  assert.match(RPC_SQL, /v_unchanged := v_unchanged \+ 1;\s*\n\s*continue;/);
  assert.match(
    RPC_SQL,
    /v_from_rate is not distinct from v_rate[\s\S]{0,120}v_from_active is not distinct from v_is_active/,
  );
});

test("5-3b. RPC は管理者を DB 側で検証し、権限は authenticated だけに渡す", () => {
  assert.match(RPC_SQL, /security definer/);
  assert.match(RPC_SQL, /set search_path to 'public'/);
  assert.match(RPC_SQL, /if v_user_id is null then\s*\n\s*raise exception 'ログインが必要です。'/);
  assert.match(RPC_SQL, /if not public\.is_app_admin\(\) then/);
  assert.match(RPC_SQL, /revoke all on function public\.set_creator_lending_terms\(jsonb, text, text\) from public;/);
  assert.match(RPC_SQL, /revoke all on function public\.set_creator_lending_terms\(jsonb, text, text\) from anon;/);
  assert.match(RPC_SQL, /revoke all on function public\.set_creator_lending_terms\(jsonb, text, text\) from service_role;/);
  assert.match(RPC_SQL, /grant execute on function public\.set_creator_lending_terms\(jsonb, text, text\) to authenticated;/);
});

test("5-3c. RPC は DB 側でも対象を再検証する（fail-closed）", () => {
  assert.match(RPC_SQL, /クリエイターが見つかりません/);
  assert.match(RPC_SQL, /対象月が不正/);
  assert.match(RPC_SQL, /対象期間外の月が含まれています/);
  assert.match(RPC_SQL, /計上できる注文明細がありません/);
  assert.match(RPC_SQL, /支払済み（または支払明細に占有済み）/);
  /* 分配率は % 表記を読み替えない */
  assert.match(RPC_SQL, /if v_rate <= 0 or v_rate > 1 then/);
  /* 対象期間は引数で受け、関数に焼き込まない */
  assert.match(RPC_SQL, /p_from_month text default null/);
  assert.equal(/2026-02/.test(RPC_SQL.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, "")), false);
});

test("5-3d. RPC は人月ごとに勧告ロックを取る（同時実行でログを二重に積まない）", () => {
  assert.match(RPC_SQL, /pg_advisory_xact_lock\(/);
  assert.match(RPC_SQL, /hashtextextended\('creator_lending_terms:'/);
  /* ロックは変更前の読み取りより先 */
  assert.ok(
    RPC_SQL.indexOf("pg_advisory_xact_lock(") <
      RPC_SQL.indexOf("select t.split_rate, t.is_active"),
  );
});

test("5-3e. 実際に保存できた件数を返す（書こうとした件数ではない）", () => {
  assert.match(RPC_SQL, /'log_count',\s*v_log_count/);
  assert.match(RPC_SQL, /v_log_count := v_log_count \+ 1;/);
  assert.match(ACTION_SRC, /logCount: Number\(result\.log_count \?\? 0\)/);
  /* 失敗時は全件ロールバックなので 0 件として扱う */
  assert.match(ACTION_SRC, /全件を取り消しました/);
  assert.match(ACTION_SRC, /failedCount: 0/);
});

test("5-4. 一括アクションは管理者判定を通る", () => {
  const bulk = ACTION_SRC.slice(
    ACTION_SRC.indexOf("export async function bulkSetCreatorLendingTermsAction"),
    ACTION_SRC.indexOf("export type BulkLendingTermResult"),
  );

  assert.match(bulk, /const auth = await requireAdminAction\(\);/);
  assert.match(bulk, /if \(!auth\.ok\) return \{ ok: false, error: auth\.error \}/);
});

test("5-5. 一括アクションはサーバー側で候補を組み直して突き合わせる", () => {
  const bulk = ACTION_SRC.slice(
    ACTION_SRC.indexOf("export async function bulkSetCreatorLendingTermsAction"),
    ACTION_SRC.indexOf("export type BulkLendingTermResult"),
  );

  assert.match(bulk, /await fetchCreatorLendingSummary\(writeClient, year\)/);
  assert.match(bulk, /buildLendingTermChanges\(summary\.rows, selection/);
  assert.match(bulk, /collectLendingTermCandidates\(summary\.rows, scope\)/);
  /* 候補に無い人月を unknown として別に数える */
  assert.match(bulk, /const unknown = requested\.filter\(/);
});

test("5-6. 初期精算モードが既定で、通常運用だけ範囲を外す", () => {
  const bulk = ACTION_SRC.slice(
    ACTION_SRC.indexOf("export async function bulkSetCreatorLendingTermsAction"),
    ACTION_SRC.indexOf("export type BulkLendingTermResult"),
  );

  assert.match(bulk, /scopeInput === "all"\s*\?\s*null\s*:\s*INITIAL_LENDING_SETTLEMENT/);
});

test("5-7. 一括アクションが既定率をハードコードしていない", () => {
  const bulk = ACTION_SRC.slice(
    ACTION_SRC.indexOf("export async function bulkSetCreatorLendingTermsAction"),
    ACTION_SRC.indexOf("export type BulkLendingTermResult"),
  );

  /*
    画面に出す入力例（「80% なら 0.8」）は文字列なので除いて判定する。
    見たいのは「計算に 0.8 を直接書いていないか」。
  */
  const code = bulk
    .replace(/`(?:[^`\\]|\\.)*`/g, '""')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, '""');

  assert.equal(/0\.8\b/.test(code), false);

  /* 既定率の参照と検証はコード本体（文字列を含む）で確認する */
  assert.match(bulk, /CREATOR_LENDING_SPLIT_RATE/);
  assert.match(bulk, /resolveCreatorLendingSplitRate\(parsed\)/);
});

test("5-8. 成功・未変更・対象外・失敗を分けて返す", () => {
  assert.match(ACTION_SRC, /succeededCount: number;/);
  assert.match(ACTION_SRC, /unchangedCount: number;/);
  assert.match(ACTION_SRC, /rejectedCount: number;/);
  assert.match(ACTION_SRC, /failedCount: number;/);
  assert.match(ACTION_SRC, /logCount: number;/);
});

test("5-9. 再集計の対象月の決定は resolveLendingSyncMonths だけに任せる", () => {
  const sync = ACTION_SRC.slice(
    ACTION_SRC.indexOf("export async function syncCreatorLendingRewardsAction"),
    ACTION_SRC.indexOf("type LendingTermEntry"),
  );

  assert.match(sync, /resolveLendingSyncMonths\(\{/);
  /* 画面の値から月を組み立て直していない */
  assert.equal(/expandMonthRange\(/.test(sync), false);
  assert.equal(/currentMonthKey\(\)\]/.test(sync), false);
});

test("5-10. 再集計は支払済みを据え置く同期処理をそのまま使う", () => {
  const sync = ACTION_SRC.slice(
    ACTION_SRC.indexOf("export async function syncCreatorLendingRewardsAction"),
    ACTION_SRC.indexOf("type LendingTermEntry"),
  );

  assert.match(sync, /syncCreatorLendingRewardsForMonth\(writeClient, targetMonth\)/);
  assert.match(sync, /skippedPaid/);
});

test("5-11. 画面は対象の決定を draft に委ね、件数を数え直さない", () => {
  const panel = PANEL_SRC.slice(
    PANEL_SRC.indexOf("function BulkActivatePanel"),
    PANEL_SRC.indexOf("export function LendingRewardTabClient"),
  );

  assert.ok(panel.length > 0);
  assert.match(panel, /collectLendingTermCandidates\(rows, scope\)/);
  assert.match(panel, /buildLendingTermChanges\(rows, selection/);
  assert.match(panel, /summarizeLendingTermPlan\(plan\)/);
  assert.match(panel, /bulkSetCreatorLendingTermsAction/);
});

test("5-12. 画面の「すべて選択」は選択可能な候補だけを選ぶ", () => {
  const panel = PANEL_SRC.slice(
    PANEL_SRC.indexOf("function BulkActivatePanel"),
    PANEL_SRC.indexOf("export function LendingRewardTabClient"),
  );

  assert.match(panel, /selectLendingTermCandidates\(candidates\)/);
  /* 選択できない行はチェックボックスを無効にする */
  assert.match(panel, /disabled=\{!candidate\.selectable\}/);
});

test("5-13. 作業の種類を変えたら選択を作り直す（対象外が残らない）", () => {
  const panel = PANEL_SRC.slice(
    PANEL_SRC.indexOf("function BulkActivatePanel"),
    PANEL_SRC.indexOf("export function LendingRewardTabClient"),
  );

  assert.match(panel, /setScopeMode\(event\.target\.value/);
  assert.match(panel, /setSelection\(new Set\(\)\)/);
});

test("5-14. 再集計フォームの既定は初期精算（誤って全月を流さない）", () => {
  assert.match(PANEL_SRC, /useState<string>\("initial_settlement"\)/);
  assert.match(PANEL_SRC, /<option value="initial_settlement">/);
  assert.match(PANEL_SRC, /<option value="range">/);
});

test("5-15. 月別区分ボードの「すべて選択」は絞り込み結果だけを対象にする", () => {
  assert.match(BOARD_SRC, /setSelection\(selectUnconfirmedRows\(rows\)\)/);
  assert.equal(/selectUnconfirmedRows\(data\.rows\)/.test(BOARD_SRC), false);
});

test("5-16. 初期精算の範囲が業務で確定した値のまま（勝手に広げない）", () => {
  assert.equal(draft.INITIAL_LENDING_SETTLEMENT.fromMonth, "2026-02");
  assert.equal(draft.INITIAL_LENDING_SETTLEMENT.toMonth, "2026-07");
  assert.equal(draft.INITIAL_LENDING_SETTLEMENT_EXPECTED.creatorCount, 5);
  assert.equal(draft.INITIAL_LENDING_SETTLEMENT_EXPECTED.personMonthCount, 17);
});

test("5-17. 代理店報酬・紹介料のテーブルへ書き込まない", () => {
  const writes = ACTION_SRC.match(/\.from\("([a-z_]+)"\)/g) ?? [];
  const tables = new Set(writes.map((m) => m.replace(/\.from\("|"\)/g, "")));

  assert.equal(tables.has("agency_reward_items"), false);
  assert.equal(tables.has("referral_reward_items"), false);
  assert.equal(tables.has("payment_batches"), false);
  assert.equal(tables.has("creator_monthly_agency_assignments"), false);
  assert.equal(tables.has("affiliate_order_lines"), false);
});
