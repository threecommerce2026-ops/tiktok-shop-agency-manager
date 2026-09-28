/*
  紹介者一覧の「紹介元アカウント」内訳のテスト。

  DBへは接続せず、集計コードの規約と整合条件を確かめる。
  実行: node --test scripts/test-referral-creator-breakdown.mjs

  ■ このテストが守っているもの
  ① creator 別の合計が紹介者の発生額と必ず一致すること
  ② 紹介者の発生額が支払対象期間（inReferralClaimRange）で揃うこと
     ＝ 2026-08 の旧 affiliate 明細を発生額へ混ぜない
  ③ 2026-08 のデータ自体は消さない・変えない
  ④ 代理店行の発生額は従来どおり全期間であること
  ⑤ 明細を追加取得して一覧を重くしないこと
*/
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = process.cwd();
const read = (file) => readFileSync(path.join(root, file), "utf8");

const QUERIES_RAW = read("lib/db/payment-queries.ts");
const UI_RAW = read("app/(app)/payments/PaymentsClient.tsx");

/** コメントを除いたコード本体（説明文で誤検知させない） */
function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

const QUERIES = codeOnly(QUERIES_RAW);
const UI = codeOnly(UI_RAW);

/** 紹介明細のループ本体を切り出す */
function referralLoop() {
  const start = QUERIES.indexOf("for (const item of referralItems.data) {");
  assert.ok(start >= 0, "紹介明細のループが見つからない");
  const end = QUERIES.indexOf("referrerAcc.set(item.referrer_id, acc);", start);
  assert.ok(end > start, "ループの終わりが見つからない");
  return QUERIES.slice(start, end);
}

// =============================================================================
// 1. creator 別合計 = 紹介者の発生額
// =============================================================================
test("1. 発生額と creator 別内訳を同じ分岐で積む（合計が必ず一致する）", () => {
  const loop = referralLoop();
  /*
    acc.gross.push と trackCreatorAmount が同じ if の中にあること。
    別々の条件で積むと合計がずれる。
  */
  const grossBranch = loop.slice(
    loop.indexOf("if (item.is_reward_target && inReferralClaimRange"),
  );
  const branchBody = grossBranch.slice(0, grossBranch.indexOf("\n    }"));

  assert.match(branchBody, /acc\.gross\.push\(value\)/, "発生額を積んでいない");
  assert.match(
    branchBody,
    /trackCreatorAmount\(acc, item\.creator_id, value\)/,
    "creator 別内訳を同じ分岐で積んでいない",
  );
});

test("1-b. creator 別内訳を積むのは1箇所だけ（二重計上しない）", () => {
  const matches = QUERIES.match(/trackCreatorAmount\(/g) ?? [];
  // 定義1 + 呼び出し1
  assert.equal(matches.length, 2, "trackCreatorAmount の呼び出しが1箇所でない");
});

test("1-c. 内訳の金額は発生額と同じ丸め関数で合計する", () => {
  const start = QUERIES.indexOf("const creators: PayeeCreatorBreakdown[]");
  const block = QUERIES.slice(start, QUERIES.indexOf(".sort(", start));
  assert.match(
    block,
    /rewardAmount: sum\(entry\.amount\)/,
    "行の合計と別の丸め方をしている（銭単位でずれる）",
  );
});

// =============================================================================
// 2 / 3. 発生額の対象期間を支払対象範囲へ揃える
// =============================================================================
test("2. 紹介者の発生額は inReferralClaimRange で絞る", () => {
  const loop = referralLoop();
  assert.match(
    loop,
    /if \(item\.is_reward_target && inReferralClaimRange\(item\.target_month\)\)/,
    "発生額が全期間のままで 2026-08 が混ざる",
  );
  assert.equal(
    /if \(item\.is_reward_target\) \{\s*acc\.gross\.push/.test(loop),
    false,
    "期間で絞らない発生額の集計が残っている",
  );
});

test("3. 支払対象範囲は 2026-07 が上限（2026-08 を混ぜない）", () => {
  assert.match(
    QUERIES,
    /targetMonth <= MAX_REFERRAL_PAYMENT_CUTOFF_MONTH/,
    "紹介報酬の範囲に上限が無い",
  );
  assert.match(QUERIES, /inReferralClaimRange/);
});

test("3-b. 支払可能・保留・発生額・creator内訳がすべて同じ範囲判定を使う", () => {
  const loop = referralLoop();
  const occurrences = loop.match(/inReferralClaimRange\(item\.target_month\)/g) ?? [];
  assert.ok(
    occurrences.length >= 2,
    "発生額と支払対象で別々の範囲判定を使っている",
  );
  assert.equal(
    /inClaimRange\(item\.target_month\)/.test(loop),
    false,
    "紹介明細で上限なしの範囲判定を使っている",
  );
});

// =============================================================================
// 4. 2026-08 のデータ自体は変更しない
// =============================================================================
test("4. 一覧の集計は読むだけで、明細を書き換えない", () => {
  const loop = referralLoop();
  for (const forbidden of [/\.update\(/, /\.delete\(/, /\.upsert\(/, /\.insert\(/]) {
    assert.equal(
      forbidden.test(loop),
      false,
      `一覧の集計が書き込みを行っている: ${forbidden}`,
    );
  }
});

test("4-b. fetchPaymentOverview は参照のみ", () => {
  const start = QUERIES.indexOf("export async function fetchPaymentOverview");
  const block = QUERIES.slice(start, QUERIES.indexOf("\nexport ", start + 10));
  for (const forbidden of [/\.update\(/, /\.delete\(/, /\.upsert\(/, /\.insert\(/]) {
    assert.equal(forbidden.test(block), false, `overview が書き込んでいる: ${forbidden}`);
  }
});

// =============================================================================
// 5. 代理店行は従来どおり
// =============================================================================
test("5. 代理店の発生額は全期間のまま（範囲で絞らない）", () => {
  const start = QUERIES.indexOf("for (const item of agencyItems.data) {");
  assert.ok(start >= 0, "代理店明細のループが見つからない");
  const loop = QUERIES.slice(start, QUERIES.indexOf("agencyAcc.set(", start));

  assert.match(
    loop,
    /if \(item\.is_reward_target\) \{/,
    "代理店の発生額の条件が変わっている",
  );
  assert.equal(
    /inReferralClaimRange/.test(loop),
    false,
    "代理店に紹介報酬用の範囲上限が掛かっている",
  );
  assert.equal(
    /trackCreatorAmount/.test(loop),
    false,
    "代理店行にも creator 内訳を積んでいる",
  );
});

test("5-b. 代理店の claim 範囲は従来の inClaimRange のまま", () => {
  const start = QUERIES.indexOf("for (const item of agencyItems.data) {");
  const loop = QUERIES.slice(start, QUERIES.indexOf("agencyAcc.set(", start));
  assert.match(loop, /inClaimRange\(item\.target_month\)/);
});

// =============================================================================
// 6 / 7 / 8. 既存ロジックの維持
// =============================================================================
test("6. manual_hold の判定が残っている", () => {
  assert.match(QUERIES, /isManualHeld\(item\)/);
  assert.match(QUERIES, /item\.payment_hold_reason == null/);
  assert.match(QUERIES, /isFullyManualHeld: unpaidAmount <= 0 && manualHoldAmount > 0/);
});

test("7. payable の判定が残っている", () => {
  assert.match(QUERIES, /holdReasons: resolvePaymentHoldReasons\(payableInput\)/);
  assert.match(QUERIES, /isPayable: isPayable\(payableInput\)/);
  assert.match(
    QUERIES,
    /isInHouse: payeeKind === "agency" && meta\?\.isInHouse === true/,
    "紹介者が自社だけを理由に支払不可になっている",
  );
});

test("8. 最低支払額（¥1,000）の適用先が変わっていない", () => {
  assert.match(QUERIES, /REFERRAL_PAYOUT_THRESHOLD_YEN,/);
  assert.match(QUERIES, /AGENCY_PAYOUT_THRESHOLD_YEN,/);
});

// =============================================================================
// 9 / 10 / 11. 紹介者行・creator 行・孤児
// =============================================================================
test("9. 紹介者の行を作る（一覧から消さない）", () => {
  assert.match(QUERIES, /buildRow\(\s*"referrer"/);
  assert.equal(/紹介者の行は作らない/.test(QUERIES_RAW), false);
});

test("10. creator 内訳は creator マスタから TikTok ID を引く", () => {
  assert.match(QUERIES, /creatorMetaById/);
  assert.match(
    QUERIES,
    /tiktokId: creatorMeta\?\.tiktokId \?\? ""/,
    "TikTok ID を引いていない",
  );
});

test("11. 内訳が空でも紹介者行を落とさない（孤児を隠さない）", () => {
  const start = QUERIES.indexOf("for (const [referrerId, acc] of referrerAcc)");
  const block = QUERIES.slice(start, QUERIES.indexOf("rows.push(", start));
  assert.match(
    block,
    /acc\.gross\.length === 0 &&/,
    "発生額が無い紹介者だけを外す条件になっていない",
  );
  assert.equal(
    /creatorAmounts\.size === 0/.test(block),
    false,
    "creator 内訳の有無で紹介者行を落としている",
  );
});

// =============================================================================
// 12. 一覧を重くしない / UI
// =============================================================================
test("12. 明細の取得を増やしていない（既に全件読んでいるものを使う）", () => {
  const start = QUERIES.indexOf("export async function fetchPaymentOverview");
  const block = QUERIES.slice(start, QUERIES.indexOf("const error =", start));
  const referralFetches =
    block.match(/"referral_reward_items"/g) ?? [];
  assert.equal(
    referralFetches.length,
    1,
    "紹介明細を複数回取得している（一覧が重くなる）",
  );
});

test("12-b. creator マスタは .in() で ID を並べない（URL が伸びない）", () => {
  const start = QUERIES.indexOf("export async function fetchPaymentOverview");
  const block = QUERIES.slice(start, QUERIES.indexOf("const error =", start));
  assert.match(
    block,
    /fetchAllFrom<\{ id: string; tiktok_id: string \| null; creator_name: string \| null \}>\(/,
    "creator をページングで取得していない",
  );
  assert.equal(
    /\.in\("id"/.test(block),
    false,
    "creator を .in() で取得している（件数が増えると URL が伸びる）",
  );
});

test("12-c. UI は TikTok ID と金額を必ず出す", () => {
  assert.match(UI, /function ReferralCreators/);
  assert.match(UI, /creator\.tiktokId \|\| creator\.creatorName/);
  assert.match(UI, /yen\(creator\.rewardAmount\)/);
  assert.match(UI_RAW, /紹介元アカウント/);
});

test("12-d. 紹介者行だけに内訳を出す（代理店行には出さない）", () => {
  const start = UI.indexOf('row.payeeKind === "referrer" ? (');
  const block = UI.slice(start, UI.indexOf(") : null}", start));
  assert.match(block, /<ReferralCreators creators=\{row\.creators\} \/>/);
});

test("12-e. 「内訳を見る」は残っている（月別・率はそちらで見る）", () => {
  assert.match(UI, /fetchReferrerRewardDetailAction/);
  assert.match(UI_RAW, /内訳を見る/);
});
