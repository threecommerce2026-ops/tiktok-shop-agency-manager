/*
  紹介者帰属状況（支払管理 → 紹介者）のテスト。

  DBへは接続せず、buildReferrerCoverage の分類と実装の規約を確かめる。
  実行: node --test scripts/test-payment-referrer-coverage.mjs

  ■ このテストが守っているもの
  ① 母集団は「紹介報酬の算定元がある」クリエイターだけ
     isTapReferralSourceLine を通り、かつ W + X > 0。
     算定元 0 のクリエイターは帰属を考える対象にならない
     （TAP実績の一覧からは消さない。あちらは別の画面）。

  ② 次の3つを絶対に混同しない
       「-」設定済み … 管理者が正式に設定した有効な紹介者
       紹介者なし     … いないと確認済み（state = none）
       未設定・要確認 … まだ確認していない
     DB 上の区別は creators.referrer_assignment_state だけが持つ。

  ③ 関係があっても帰属先を解決できなければ「要確認」へ
     odebu888 のように active relation があり assignment_state も
     assigned なのに、期間解決の結果が none になることがある。
     active relation の有無で assigned 判定してはいけない。

  ④ 支払とは完全に別
     coverage は PaymentUnpaidRow に混ぜない。支払候補・claim・
     支払明細・振込CSV へ流さない。

  ⑤ 現在DB実績を隠さない
     区分を変えたあと reward を再集計していないと、現在の区分では
     対象外なのに実績が残る。画面ロジックで 0 へ置き換えない。
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

const tap = await jiti.import(path.join(root, "lib/db/tap-creator-queries.ts"));

const read = (file) => readFileSync(path.join(root, file), "utf8");
const codeOnly = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
const QUERIES_RAW = read("lib/db/tap-creator-queries.ts");
const QUERIES = codeOnly(QUERIES_RAW);
const UI_RAW = read("app/(app)/payments/PaymentsClient.tsx");
const UI = codeOnly(UI_RAW);
const ACTIONS = codeOnly(read("app/actions/payments.ts"));
const PAYMENT_QUERIES = codeOnly(read("lib/db/payment-queries.ts"));

/** TapCreatorRow の最小形 */
function row(overrides = {}) {
  return {
    creatorId: `c-${Math.random().toString(36).slice(2, 8)}`,
    tiktokId: "tester",
    creatorName: "tester",
    firstTargetMonth: "2026-05",
    lastTargetMonth: "2026-08",
    firstEligibleMonth: "2026-05",
    eligibleItemCount: 10,
    commissionBase: 10000,
    tapRevenue: 1000,
    creatorEstimatedCommission: 0,
    creatorCommissionMissingCount: 0,
    referralRewardAmount: 0,
    referralRewardItemCount: 0,
    accountManagementType: "standard",
    referralBaseAmount: 1000,
    estimatedReferralReward: 50,
    referralEligibleType: true,
    referrerAssignmentState: "assigned",
    referrerState: "assigned",
    referrerName: "岸幸星",
    referralPeriodLabel: "2026-05〜",
    agencyState: "external",
    agencyLabel: "THREE.inc",
    ...overrides,
  };
}

const kindsOf = (rows) => {
  const cov = tap.buildReferrerCoverage(rows);
  const out = new Map();
  for (const g of cov.groups) for (const c of g.creators) out.set(c.tiktokId, g.kind);
  return { cov, kinds: out };
};

// =============================================================================
// 1-2. 母集団
// =============================================================================
test("1. 母集団は算定元（W+X）> 0 のクリエイターだけ", () => {
  const cov = tap.buildReferrerCoverage([
    row({ tiktokId: "has-base", referralBaseAmount: 1000 }),
    row({ tiktokId: "zero-base", referralBaseAmount: 0 }),
  ]);
  assert.equal(cov.totals.creatorCount, 1, "算定元0を数えている");
  const ids = cov.groups.flatMap((g) => g.creators.map((c) => c.tiktokId));
  assert.deepEqual(ids, ["has-base"]);

  // 実装でも絞っている
  assert.match(QUERIES, /rows\.filter\(\(row\) => row\.referralBaseAmount > 0\)/);
});

test("2. 母集団は正式な対象行の条件を通っている（一覧と同じ）", () => {
  // buildReferrerCoverage は fetchTapCreatorOverview の行を受け取る。
  // その行は isTapReferralSourceLine を通ったものだけ。
  assert.match(QUERIES, /if \(\s*!isTapReferralSourceLine\(/);
  assert.match(ACTIONS, /fetchTapCreatorOverview\(getSupabaseAdmin\(\), \{ endMonth \}\)/);
  assert.match(ACTIONS, /buildReferrerCoverage\(overview\.rows\)/);
});

// =============================================================================
// 3-7. 4分類と合計
// =============================================================================
test("3-7. 4分類に分かれ、合計が母集団と一致する", () => {
  const rows = [
    row({ tiktokId: "a1", referrerState: "assigned", referrerName: "岸幸星" }),
    row({ tiktokId: "a2", referrerState: "assigned", referrerName: "新川美希" }),
    row({ tiktokId: "d1", referrerState: "dash_referrer", referrerName: "-" }),
    row({ tiktokId: "n1", referrerState: "none", referrerName: null, referrerAssignmentState: "none" }),
    row({ tiktokId: "u1", referrerState: "none", referrerName: null, referrerAssignmentState: "unconfirmed" }),
  ];
  const { cov, kinds } = kindsOf(rows);

  assert.equal(kinds.get("a1"), "assigned");
  assert.equal(kinds.get("a2"), "assigned");
  assert.equal(kinds.get("d1"), "dash_referrer");
  assert.equal(kinds.get("n1"), "no_referrer");
  assert.equal(kinds.get("u1"), "unconfirmed");

  const t = cov.totals;
  assert.equal(t.assignedCount, 2);
  assert.equal(t.dashReferrerCount, 1);
  assert.equal(t.noReferrerCount, 1);
  assert.equal(t.unconfirmedCount, 1);
  assert.equal(
    t.assignedCount + t.dashReferrerCount + t.noReferrerCount + t.unconfirmedCount,
    t.creatorCount,
    "4分類の合計が母集団と一致しない",
  );

  // 紹介者ありは紹介者ごとに別グループ
  const assigned = cov.groups.filter((g) => g.kind === "assigned");
  assert.equal(assigned.length, 2, "紹介者ごとに分かれていない");
});

test("8. 算定元0のクリエイターは coverage に出ないが TAP実績からは消さない", () => {
  const cov = tap.buildReferrerCoverage([row({ tiktokId: "zero", referralBaseAmount: 0 })]);
  assert.equal(cov.totals.creatorCount, 0);
  // 一覧側（fetchTapCreatorOverview）は算定元で絞っていない
  const overview = QUERIES.slice(
    QUERIES.indexOf("export async function fetchTapCreatorOverview"),
    QUERIES.indexOf("export async function resolveReferralReviewEndMonth"),
  );
  assert.equal(
    /referralBaseAmount > 0/.test(overview),
    false,
    "一覧側まで算定元で絞っている（TAP実績から消える）",
  );
});

// =============================================================================
// 10-12. 混同しない
// =============================================================================
test("10. none と unconfirmed を混同しない", () => {
  const { kinds } = kindsOf([
    row({ tiktokId: "x", referrerState: "none", referrerName: null, referrerAssignmentState: "none" }),
    row({ tiktokId: "y", referrerState: "none", referrerName: null, referrerAssignmentState: "unconfirmed" }),
    row({ tiktokId: "z", referrerState: "none", referrerName: null, referrerAssignmentState: null }),
  ]);
  assert.equal(kinds.get("x"), "no_referrer");
  assert.equal(kinds.get("y"), "unconfirmed");
  assert.equal(kinds.get("z"), "unconfirmed", "state 未設定を確認済み扱いにしている");

  // 判定は単一ソースの関数を通す
  assert.match(QUERIES, /resolveAssignmentState\(null, row\.referrerAssignmentState\)/);
});

test("11-12. 「-」と none、「-」と assigned を分離する", () => {
  const { kinds } = kindsOf([
    row({ tiktokId: "dash", referrerState: "dash_referrer", referrerName: "-" }),
    row({ tiktokId: "none", referrerState: "none", referrerName: null, referrerAssignmentState: "none" }),
    row({ tiktokId: "norm", referrerState: "assigned", referrerName: "岸幸星" }),
  ]);
  assert.equal(kinds.get("dash"), "dash_referrer");
  assert.equal(kinds.get("none"), "no_referrer");
  assert.equal(kinds.get("norm"), "assigned");
  assert.notEqual(kinds.get("dash"), kinds.get("none"));
  assert.notEqual(kinds.get("dash"), kinds.get("norm"));

  // ラベルも別
  assert.notEqual(
    tap.REFERRER_COVERAGE_LABEL.dash_referrer,
    tap.REFERRER_COVERAGE_LABEL.no_referrer,
  );
  assert.notEqual(
    tap.REFERRER_COVERAGE_LABEL.no_referrer,
    tap.REFERRER_COVERAGE_LABEL.unconfirmed,
  );
});

// =============================================================================
// odebu888 のケース（関係はあるが帰属先を解決できない）
// =============================================================================
test("active relation あり / assigned でも期間解決不能なら要確認へ", () => {
  /*
    odebu888 の実データ。
    （株）3 の active relation があり assignment_state も assigned だが、
    同月開始の relation が3件並び、期間を解決できず referrerState = none。
    active relation の有無で assigned にしてはいけない。
  */
  const { cov, kinds } = kindsOf([
    row({
      tiktokId: "odebu888",
      referrerState: "none",
      referrerName: "（株）3",
      referrerAssignmentState: "assigned",
      referralRewardAmount: 62.2,
    }),
  ]);
  assert.equal(kinds.get("odebu888"), "unconfirmed", "assigned に分類している");

  const creator = cov.groups[0].creators[0];
  assert.equal(creator.relationInconsistent, true, "relation不整合として立っていない");
  assert.ok(creator.relationNote, "不整合の説明が無い");
  assert.equal(cov.totals.relationInconsistentCount, 1);
  assert.equal(cov.groups[0].relationInconsistentCount, 1);
});

test("通常の未設定と relation不整合を区別する", () => {
  const { cov } = kindsOf([
    row({ tiktokId: "plain", referrerState: "none", referrerName: null, referrerAssignmentState: "unconfirmed" }),
    row({ tiktokId: "broken", referrerState: "none", referrerName: "（株）3", referrerAssignmentState: "assigned" }),
  ]);
  const group = cov.groups.find((g) => g.kind === "unconfirmed");
  const plain = group.creators.find((c) => c.tiktokId === "plain");
  const broken = group.creators.find((c) => c.tiktokId === "broken");

  assert.equal(plain.relationInconsistent, false);
  assert.equal(broken.relationInconsistent, true);
  assert.equal(group.creatorCount, 2);
  assert.equal(group.relationInconsistentCount, 1);

  // 画面でもバッジを分ける
  assert.ok(UI_RAW.includes("relation要確認"));
  assert.ok(UI_RAW.includes("未設定"));
  assert.ok(UI_RAW.includes("relationを個別に確認する"), "不整合の導線が無い");
});

// =============================================================================
// 現在DB実績を隠さない
// =============================================================================
test("現在の区分で対象外でも DB 実績を隠さない", () => {
  /*
    __golden_shark__ / truth.inc0804 の実データ。
    区分を self_operated に変えたが reward を再集計していないため
    実績が残っている。画面ロジックで 0 へ置き換えない。
  */
  const cov = tap.buildReferrerCoverage([
    row({
      tiktokId: "__golden_shark__",
      accountManagementType: "self_operated",
      referralEligibleType: false,
      referralRewardAmount: 15224.15,
      referrerName: "（株）3",
    }),
    row({
      tiktokId: "truth.inc0804",
      accountManagementType: "self_operated",
      referralEligibleType: false,
      referralRewardAmount: 1147.55,
      referrerName: "（株）3",
    }),
  ]);

  const creators = cov.groups.flatMap((g) => g.creators);
  assert.equal(creators.find((c) => c.tiktokId === "__golden_shark__").referralRewardAmount, 15224.15);
  assert.equal(creators.find((c) => c.tiktokId === "truth.inc0804").referralRewardAmount, 1147.55);
  assert.equal(cov.totals.ineligibleRewardAmount, 16371.7, "対象外の実績を集計していない");
  assert.equal(cov.totals.ineligibleRewardCreatorCount, 2);

  // 実装が区分で金額を 0 へ潰していない
  assert.equal(
    /referralEligibleType \? [^\n]*referralRewardAmount[^\n]*: 0/.test(QUERIES),
    false,
    "区分で実績を 0 へ置き換えている",
  );
  assert.equal(
    /referralEligibleType \? [^\n]*referralRewardAmount[^\n]*: 0/.test(UI),
    false,
    "画面で実績を 0 へ置き換えている",
  );
  // 「現在は紹介報酬対象外」を併記する
  assert.ok(UI_RAW.includes("現在は紹介報酬対象外"));
});

test("現在DB実績と参考額を別に持つ", () => {
  const cov = tap.buildReferrerCoverage([
    row({
      tiktokId: "u",
      referrerState: "none",
      referrerName: null,
      referrerAssignmentState: "unconfirmed",
      referralRewardAmount: 0,
      referralBaseAmount: 1000,
      estimatedReferralReward: 50,
    }),
  ]);
  const g = cov.groups[0];
  assert.equal(g.referralRewardAmount, 0, "想定額を実績へ足している");
  assert.equal(g.estimatedReferralReward, 50);

  // 画面でも列とラベルを分ける
  assert.ok(UI_RAW.includes("紹介報酬（現在DB実績）"));
  assert.ok(UI_RAW.includes("設定時の参考額"));
  assert.ok(
    UI_RAW.includes("両者を足し合わせないでください"),
    "混同しない旨の注記が無い",
  );
});

test("self_operated / account_lending も一覧から消さない", () => {
  const cov = tap.buildReferrerCoverage([
    row({ tiktokId: "s", accountManagementType: "self_operated", referralEligibleType: false }),
    row({ tiktokId: "a", accountManagementType: "account_lending", referralEligibleType: false }),
    row({ tiktokId: "n", accountManagementType: "standard", referralEligibleType: true }),
  ]);
  const ids = cov.groups.flatMap((g) => g.creators.map((c) => c.tiktokId)).sort();
  assert.deepEqual(ids, ["a", "n", "s"], "対象外区分を一覧から消している");
  assert.equal(cov.totals.creatorCount, 3);
});

// =============================================================================
// 支払との分離
// =============================================================================
test("coverage が PaymentUnpaidRow へ混入しない", () => {
  // PaymentOverview には載せない（別経路で返す）
  assert.equal(
    /referrerCoverage/.test(PAYMENT_QUERIES),
    false,
    "支払の集計へ coverage が入り込んでいる",
  );
  assert.equal(
    /buildReferrerCoverage/.test(PAYMENT_QUERIES),
    false,
    "支払の集計が coverage を呼んでいる",
  );
  // 支払候補は従来どおり referral_reward_items 起点
  assert.match(PAYMENT_QUERIES, /const referrerAcc = new Map<string, PayeeAccumulator>\(\)/);
  assert.match(PAYMENT_QUERIES, /for \(const item of referralItems\.data\)/);
});

test("payment candidate / claim / CSV の判定を変えていない", () => {
  assert.match(PAYMENT_QUERIES, /targetMonth <= MAX_REFERRAL_PAYMENT_CUTOFF_MONTH/);
  assert.match(PAYMENT_QUERIES, /isPayable: isPayable\(payableInput\)/);
  assert.match(PAYMENT_QUERIES, /REFERRAL_PAYOUT_THRESHOLD_YEN/);
  // coverage 側は PaymentUnpaidRow を作らない
  const coverage = QUERIES.slice(QUERIES.indexOf("export function buildReferrerCoverage"));
  assert.equal(/PaymentUnpaidRow/.test(coverage), false);
  assert.equal(/isPayable/.test(coverage), false);
});

test("coverage は reward / payout を動かさない", () => {
  const coverage = QUERIES.slice(QUERIES.indexOf("export function buildReferrerCoverage"));
  for (const forbidden of [/\.insert\(/, /\.update\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/]) {
    assert.equal(forbidden.test(coverage), false, `coverage が書き込んでいる: ${forbidden}`);
  }
  // Server Action も読むだけ
  const action = ACTIONS.slice(
    ACTIONS.indexOf("export async function fetchReferrerCoverageAction"),
    ACTIONS.indexOf("export type ReferrerGapActionResult"),
  );
  for (const forbidden of [
    /\.insert\(/, /\.update\(/, /\.upsert\(/, /\.delete\(/,
    /syncReferralRewardsForMonth/, /refreshReferralPayouts/,
  ]) {
    assert.equal(forbidden.test(action), false, `Server Action が ${forbidden} を呼んでいる`);
  }
});

test("人数をハードコードしていない", () => {
  for (const hardcoded of [/144\s*名/, /\b94\s*名/, /\b36\s*名/, /\b12\s*名/]) {
    assert.equal(
      hardcoded.test(UI_RAW),
      false,
      `人数をベタ書きしている: ${hardcoded}`,
    );
  }
  assert.match(UI, /int\(t\.creatorCount\)/);
  assert.match(UI, /int\(t\.assignedCount\)/);
  assert.match(UI, /int\(t\.dashReferrerCount\)/);
  assert.match(UI, /int\(t\.noReferrerCount\)/);
  assert.match(UI, /int\(t\.unconfirmedCount\)/);
});
