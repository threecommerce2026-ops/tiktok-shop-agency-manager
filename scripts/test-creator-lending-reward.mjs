import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";
import { test } from "node:test";

/*
  端末貸し出し報酬（受取人はクリエイター本人）のテスト。

  ■ 最終確定ルール（2026-10-10）
    対象     THREE.inc（自社）所属 ／ AK 100% ／ 管理区分 account_lending
    原資     AP（affiliate_order_lines.agency_revenue）
    本人     AP × 分配率（基本 80%。クリエイター別・対象月別に変更可）
    自社     AP − 本人報酬
    所属     THREE.inc のまま変更しない
    AK       100% のまま変更しない
    紹介料5% 対象外
    支払先   クリエイター本人。代理店マスタへの架空登録は禁止
    支払管理 既存 /payments に第3の受取種別 creator として統合

  ■ 検証値（本番 READ ONLY で確認）
    対象 5 名 ／ 364 明細 ／ AP 64,974.00 円
      本人 80%  51,979.20 円
      自社 20%  12,994.80 円
*/

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });

const lendingEngine = await jiti.import("@/lib/creators/lending-reward-engine.ts");
const terms = await jiti.import("@/lib/creators/lending-terms.ts");
const agencyEngine = await jiti.import("@/lib/agency/agency-reward-engine.ts");
const types = await jiti.import("@/lib/creators/account-management-type.ts");
const status = await jiti.import("@/lib/revenue/order-line-status.ts");
const payable = await jiti.import("@/lib/payments/payable.ts");
const minimum = await jiti.import("@/lib/payments/minimum-payout.ts");
const referralEngine = await jiti.import("@/lib/referrals/referral-reward-engine.ts");

const read = (relative) =>
  fs.readFileSync(path.join(process.cwd(), relative), "utf8");

const SYNC_SRC = read("lib/creators/sync-lending-rewards.ts");
const QUERIES_SRC = read("lib/db/creator-lending-queries.ts");
const ACTION_SRC = read("app/actions/creator-lending-rewards.ts");
const CLIENT_SRC = read("app/(app)/revenue/LendingRewardTabClient.tsx");
const TAB_SRC = read("app/(app)/revenue/LendingRewardTab.tsx");
const REVENUE_PAGE_SRC = read("app/(app)/revenue/page.tsx");
const PAYMENT_QUERIES_SRC = read("lib/db/payment-queries.ts");
const PAYMENTS_CLIENT_SRC = read("app/(app)/payments/PaymentsClient.tsx");
const PAYEE_BANK_ACTION_SRC = read("app/actions/payee-bank.ts");

const TABLES_SQL = read(
  "supabase/migrations/20261010100000_creator_lending_reward_tables.sql",
);
const GUARD_SQL = read(
  "supabase/migrations/20261010110000_creator_lending_reward_guard.sql",
);
const BATCH_SQL = read(
  "supabase/migrations/20261010120000_payment_batches_creator_payee.sql",
);
const RPC_SQL = read("supabase/migrations/20261010130000_payment_rpcs_creator_payee.sql");
const PRIVILEGE_SQL = read(
  "supabase/migrations/20261010140000_creator_lending_privilege_lock.sql",
);
const GUARD2_SQL = read(
  "supabase/migrations/20261010150000_account_lending_guard_strengthen.sql",
);
const CARRYOVER_SQL = read(
  "supabase/migrations/20261010160000_creator_lending_carryover.sql",
);
const CARRYOVER_RPC_SQL = read(
  "supabase/migrations/20261010170000_payment_rpcs_creator_carryover.sql",
);
const ROUNDING_SRC = read("lib/payments/creator-lending-rounding.ts");
const PAYEE_SOURCE_SRC = read("lib/payments/creator-lending-payee.ts");

const stripSql = (sql) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

/* コメントを除いた実行コード。説明文に出てくる語を誤検知しないため */
const stripTs = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*/gm, "");

/* 対象条件をすべて満たすクリエイターの状態 */
function context(over = {}) {
  return {
    creatorId: "c1",
    targetMonth: "2026-06",
    accountManagementType: "account_lending",
    agencyId: "ag-three",
    agencyIsInHouse: true,
    assignmentConfirmed: true,
    isActive: true,
    splitRateOverride: null,
    ...over,
  };
}

function line(over = {}) {
  return {
    source_row_key: "key-1",
    order_id: "order-1",
    product_id: "product-1",
    creator_id: "c1",
    target_month: "2026-06",
    commission_base: 100000,
    commission_gmv: 120000,
    creator_revenue_before_split: 5000,
    agency_split_rate: 100,
    agency_revenue: 5000,
    payment_status: "支払い済み",
    order_status: "決済済み",
    refund_status: "いいえ",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. 金額（AP × 80% / 本人 + 自社 = AP）
// ---------------------------------------------------------------------------

test("1-1. 基本分配率は 80%", () => {
  assert.equal(lendingEngine.CREATOR_LENDING_SPLIT_RATE, 0.8);
});

test("1-2. 本人 = AP × 80% / 自社 = AP − 本人", () => {
  const computed = lendingEngine.computeCreatorLendingReward(
    line({ agency_revenue: 26028 }),
    context(),
  );
  assert.equal(computed.rewardAmount, 20822.4);
  assert.equal(computed.selfShareAmount, 5205.6);
  assert.equal(computed.splitRate, 0.8);
  assert.equal(computed.creatorId, "c1", "受取人は本人");
  assert.equal(computed.inHouseAgencyId, "ag-three", "所属は記録のみ");
});

test("1-3. 本番基準値と一致する（5名 / 364明細 / AP 64,974円）", () => {
  const monthlyAp = [
    ["2026-04", 5325, 4260, 1065],
    ["2026-05", 11168, 8934.4, 2233.6],
    ["2026-06", 26028, 20822.4, 5205.6],
    ["2026-07", 22258, 17806.4, 4451.6],
    ["2026-08", 195, 156, 39],
  ];

  const rewards = [];
  const selfShares = [];
  const aps = [];

  for (const [month, ap, expectedReward, expectedSelf] of monthlyAp) {
    const computed = lendingEngine.computeCreatorLendingReward(
      line({ target_month: month, source_row_key: `k-${month}`, agency_revenue: ap }),
      context({ targetMonth: month }),
    );
    assert.equal(computed.rewardAmount, expectedReward, `${month} 本人`);
    assert.equal(computed.selfShareAmount, expectedSelf, `${month} 自社`);
    rewards.push(computed.rewardAmount);
    selfShares.push(computed.selfShareAmount);
    aps.push(ap);
  }

  assert.equal(lendingEngine.sumLendingAmounts(aps), 64974);
  assert.equal(lendingEngine.sumLendingAmounts(rewards), 51979.2);
  assert.equal(lendingEngine.sumLendingAmounts(selfShares), 12994.8);
});

test("1-4. どの AP でも 本人 + 自社 = AP（丸め差を残さない）", () => {
  const aps = [1, 3, 7, 0.13, 0.19, 195, 1234.56, 26028, 99999.99];
  for (const ap of aps) {
    const computed = lendingEngine.computeCreatorLendingReward(
      line({ agency_revenue: ap }),
      context(),
    );
    assert.equal(
      agencyEngine.roundAgencyAmount(computed.rewardAmount + computed.selfShareAmount),
      agencyEngine.roundAgencyAmount(ap),
      `AP=${ap}`,
    );
  }
});

test("1-5. 自社取り分は引き算で求める（掛け算で作らない）", () => {
  const src = SYNC_SRC + read("lib/creators/lending-reward-engine.ts");
  assert.match(src, /agencyRevenue - rewardAmount/);
  assert.doesNotMatch(
    src.replace(/\/\*[\s\S]*?\*\//g, ""),
    /agencyRevenue \* \(1 - /,
  );
});

test("1-6. 計算基準は AP のみ（AD・AJ を混ぜない）", () => {
  const computed = lendingEngine.computeCreatorLendingReward(
    line({
      commission_base: 999999,
      creator_revenue_before_split: 888888,
      agency_revenue: 1000,
    }),
    context(),
  );
  assert.equal(computed.rewardAmount, 800);
  assert.equal(computed.commissionBase, 999999, "AD は記録だけ");
  assert.equal(computed.creatorRevenueBeforeSplit, 888888, "AJ は記録だけ");
});

test("1-7. 丸めは既存の roundAgencyAmount（銭単位）に従う", () => {
  for (const [ap, expected] of [[1, 0.8], [3, 2.4], [7, 5.6], [0.13, 0.1], [195, 156]]) {
    const computed = lendingEngine.computeCreatorLendingReward(
      line({ agency_revenue: ap }),
      context(),
    );
    assert.equal(computed.rewardAmount, expected, `AP=${ap}`);
    assert.equal(computed.rewardAmount, agencyEngine.roundAgencyAmount(ap * 0.8));
  }
});

test("1-8. AP が 0・負・null、丸めて 0 円なら報酬を作らない", () => {
  for (const ap of [0, -100, null, 0.004]) {
    assert.equal(
      lendingEngine.computeCreatorLendingReward(line({ agency_revenue: ap }), context()),
      null,
      `AP=${String(ap)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. 対象条件（4条件すべて・fail-closed）
// ---------------------------------------------------------------------------

test("2-1. 4条件を満たすときだけ報酬ができる", () => {
  assert.equal(lendingEngine.resolveLendingExclusionReason(line(), context()), null);
  assert.ok(lendingEngine.computeCreatorLendingReward(line(), context()));
});

test("2-2. 区分がアカウント貸し出しでなければ作らない", () => {
  for (const type of ["standard", "self_operated", null, "", "unknown"]) {
    const ctx = context({ accountManagementType: type });
    assert.equal(
      lendingEngine.resolveLendingExclusionReason(line(), ctx),
      "not_account_lending",
      `区分=${String(type)}`,
    );
    assert.equal(lendingEngine.computeCreatorLendingReward(line(), ctx), null);
  }
});

test("2-3. 所属が月別確定されていなければ作らない", () => {
  for (const over of [
    { assignmentConfirmed: false },
    { agencyId: null },
    { agencyId: null, assignmentConfirmed: false },
  ]) {
    const ctx = context(over);
    assert.equal(
      lendingEngine.resolveLendingExclusionReason(line(), ctx),
      "assignment_unconfirmed",
    );
    assert.equal(lendingEngine.computeCreatorLendingReward(line(), ctx), null);
  }
});

test("2-4. 所属が自社でなければ作らない（外部代理店は対象外）", () => {
  const ctx = context({ agencyId: "ag-external", agencyIsInHouse: false });
  assert.equal(
    lendingEngine.resolveLendingExclusionReason(line(), ctx),
    "agency_not_in_house",
  );
  assert.equal(lendingEngine.computeCreatorLendingReward(line(), ctx), null);
});

test("2-5. AK が 100% でなければ作らない", () => {
  assert.equal(lendingEngine.REQUIRED_AGENCY_SPLIT_RATE, 100);
  for (const ak of [0, 20, 80, 99.99, 100.01, null]) {
    const l = line({ agency_split_rate: ak });
    assert.equal(
      lendingEngine.resolveLendingExclusionReason(l, context()),
      "agency_split_rate_not_100",
      `AK=${String(ak)}`,
    );
    assert.equal(lendingEngine.computeCreatorLendingReward(l, context()), null);
  }
});

test("2-6. その月が有効化されていなければ作らない", () => {
  const ctx = context({ isActive: false });
  assert.equal(lendingEngine.resolveLendingExclusionReason(line(), ctx), "inactive_terms");
  assert.equal(lendingEngine.computeCreatorLendingReward(line(), ctx), null);
});

test("2-7. 分配率が不正なら既定値へ丸めず作らない（% 表記の混入を拒否）", () => {
  for (const bad of [0, -0.2, 1.2, 80, 100, "abc", NaN, Infinity]) {
    assert.equal(
      lendingEngine.resolveCreatorLendingSplitRate(bad),
      null,
      `rate=${String(bad)}`,
    );
    const ctx = context({ splitRateOverride: bad });
    assert.equal(
      lendingEngine.resolveLendingExclusionReason(line(), ctx),
      "invalid_split_rate",
    );
    assert.equal(lendingEngine.computeCreatorLendingReward(line(), ctx), null);
  }
});

test("2-8. 未設定の分配率は既定 80%（既定値を2か所に持たない）", () => {
  for (const value of [null, undefined, ""]) {
    assert.equal(lendingEngine.resolveCreatorLendingSplitRate(value), 0.8);
  }
  /* 分配条件の読み取り側は既定値を埋めない */
  assert.doesNotMatch(read("lib/creators/lending-terms.ts"), /0\.8/);
});

test("2-9. 明細の識別情報が足りなければ作らない", () => {
  for (const over of [
    { creator_id: null },
    { source_row_key: null },
    { target_month: null },
  ]) {
    assert.equal(
      lendingEngine.resolveLendingExclusionReason(line(over), context()),
      "missing_key",
    );
  }
});

test("2-10. 対象外の理由はすべて日本語ラベルを持つ", () => {
  const reasons = [
    "missing_key",
    "not_account_lending",
    "assignment_unconfirmed",
    "agency_not_in_house",
    "agency_split_rate_not_100",
    "inactive_terms",
    "invalid_split_rate",
    "order_not_payable",
    "ap_not_positive",
    "reward_not_positive",
  ];
  for (const reason of reasons) {
    const label = lendingEngine.LENDING_EXCLUSION_LABEL[reason];
    assert.ok(label && label.length > 0, reason);
  }
});

// ---------------------------------------------------------------------------
// 3. 返品・キャンセル・未払いの除外（既存判定の再利用）
// ---------------------------------------------------------------------------

test("3-1. 既存の対象注文判定をそのまま使う", () => {
  const cases = [
    ["返金済み（はい）", { refund_status: "はい" }],
    ["返金済み（fully_refunded）", { refund_status: "fully_refunded" }],
    ["返金済み（大文字）", { refund_status: "REFUNDED" }],
    ["未払い", { payment_status: "未払い" }],
    ["支払状況が空", { payment_status: null }],
    ["キャンセル", { order_status: "キャンセル", payment_status: "未払い" }],
  ];
  for (const [name, over] of cases) {
    const l = line(over);
    assert.equal(status.isAgencyPayoutEligibleOrderLine(l), false, `${name}（判定関数）`);
    assert.equal(
      lendingEngine.resolveLendingExclusionReason(l, context()),
      "order_not_payable",
      name,
    );
    assert.equal(lendingEngine.computeCreatorLendingReward(l, context()), null, name);
  }
});

test("3-2. 支払い済みかつ返金なしなら対象（order_status 未設定でも同じ）", () => {
  const l = line({ order_status: null });
  assert.equal(status.isAgencyPayoutEligibleOrderLine(l), true);
  assert.equal(lendingEngine.computeCreatorLendingReward(l, context()).rewardAmount, 4000);
});

test("3-3. 計算部品を作り直していない（既存の丸め・合算を使う）", () => {
  const src = read("lib/creators/lending-reward-engine.ts");
  assert.match(src, /roundAgencyAmount/);
  assert.match(src, /sumAgencyAmounts/);
  assert.match(src, /isAgencyPayoutEligibleOrderLine/);
  assert.match(src, /resolveAgencyAnnualState/);
  /* 独自の丸めを書いていない */
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, ""), /Math\.round\(/);
});

// ---------------------------------------------------------------------------
// 4. 分配率の個別設定（クリエイター別・対象月別）
// ---------------------------------------------------------------------------

test("4-1. 分配率はクリエイター別・対象月別に変更できる", () => {
  for (const [rate, expectedReward, expectedSelf] of [
    [0.8, 800, 200],
    [0.7, 700, 300],
    [0.6, 600, 400],
    [0.5, 500, 500],
    [1, 1000, 0],
  ]) {
    const computed = lendingEngine.computeCreatorLendingReward(
      line({ agency_revenue: 1000 }),
      context({ splitRateOverride: rate }),
    );
    assert.equal(computed.rewardAmount, expectedReward, `rate=${rate}`);
    assert.equal(computed.selfShareAmount, expectedSelf, `rate=${rate}`);
    assert.equal(computed.splitRate, rate);
  }
});

test("4-2. 対象月ごとに違う率を適用でき、他の月に混ざらない", () => {
  const june = lendingEngine.computeCreatorLendingReward(
    line({ target_month: "2026-06", source_row_key: "k6", agency_revenue: 1000 }),
    context({ targetMonth: "2026-06", splitRateOverride: 0.6 }),
  );
  const july = lendingEngine.computeCreatorLendingReward(
    line({ target_month: "2026-07", source_row_key: "k7", agency_revenue: 1000 }),
    context({ targetMonth: "2026-07", splitRateOverride: null }),
  );
  assert.equal(june.rewardAmount, 600);
  assert.equal(july.rewardAmount, 800, "設定の無い月は既定 80%");
});

test("4-3. 分配条件の索引は creator_id|target_month で引く", () => {
  assert.equal(terms.lendingTermKey("c1", "2026-06"), "c1|2026-06");
  assert.notEqual(terms.lendingTermKey("c1", "2026-06"), terms.lendingTermKey("c1", "2026-07"));
});

test("4-4. 行が無い月は「有効化されていない」として扱う（報酬を作らない）", () => {
  const term = terms.getLendingTerm(new Map(), "c1", "2026-06");
  assert.equal(term.isActive, false);
  assert.equal(term.splitRate, null);
  assert.equal(
    lendingEngine.resolveLendingExclusionReason(line(), context({ isActive: false })),
    "inactive_terms",
  );
});

test("4-5. 分配条件テーブルが無い環境は空として扱う（fail-closed）", () => {
  assert.equal(terms.isMissingLendingTermsTable("relation does not exist"), true);
  assert.equal(terms.isMissingLendingTermsTable("42P01"), true);
  assert.equal(terms.isMissingLendingTermsTable("Could not find the table"), true);
  assert.equal(terms.isMissingLendingTermsTable("permission denied"), false);
  /* sync はテーブルが無いとき保存へ進まない */
  assert.match(SYNC_SRC, /if \(termsResult\.tableMissing\)/);
  assert.match(SYNC_SRC, /20261010100000_creator_lending_reward_tables\.sql/);
});

test("4-6. 分配率の入力は 0 < rate <= 1 のみ受け付ける（% 表記を読み替えない）", () => {
  assert.match(ACTION_SRC, /parsed <= 0 \|\| parsed > 1/);
  assert.match(ACTION_SRC, /80% なら 0\.8/);
  /* 入力値をそのままメッセージに出して、黙って丸めない */
  assert.match(ACTION_SRC, /入力値: \$\{rateInput\}/);
});

// ---------------------------------------------------------------------------
// 5. 二重計上防止・冪等性・支払済保護
// ---------------------------------------------------------------------------

test("5-1. 一意キーは source_row_key（upsert で二重計上しない）", () => {
  assert.match(SYNC_SRC, /onConflict:\s*"source_row_key"/);
  assert.match(TABLES_SQL, /source_row_key text not null unique/);
});

test("5-2. 再実行しても同じ金額（冪等）", () => {
  const l = line({ agency_revenue: 26028 });
  const amounts = Array.from(
    { length: 20 },
    () => lendingEngine.computeCreatorLendingReward(l, context()).rewardAmount,
  );
  assert.equal(new Set(amounts).size, 1);
  assert.equal(amounts[0], 20822.4);
});

test("5-3. 支払済・支払予定中の明細は再集計で触らない", () => {
  assert.match(
    SYNC_SRC,
    /item\.is_paid \|\| item\.payout_id != null \|\| item\.payment_batch_id != null/,
  );
  assert.match(SYNC_SRC, /if \(paidSourceKeys\.has\(sourceRowKey\)\) continue;/);
  /* 保護は計算より前にある */
  const skipIndex = SYNC_SRC.indexOf("if (paidSourceKeys.has(sourceRowKey)) continue;");
  const computeIndex = SYNC_SRC.indexOf("computeCreatorLendingReward(line, context)");
  assert.ok(skipIndex > 0 && computeIndex > skipIndex, "保護が計算より前にある");
});

test("5-4. 削除でも支払済・バッチ占有・payout 紐付けを除外する", () => {
  const block = SYNC_SRC.slice(SYNC_SRC.indexOf("async function deleteObsoleteLendingItems"));
  assert.match(block, /if \(item\.is_paid\) continue;/);
  assert.match(block, /if \(item\.payout_id != null\) continue;/);
  assert.match(block, /if \(item\.payment_batch_id != null\) continue;/);
  /* DB 側の条件でも二重に守る */
  assert.match(block, /\.eq\("is_paid", false\)/);
  assert.match(block, /\.is\("payout_id", null\)/);
  assert.match(block, /\.is\("payment_batch_id", null\)/);
});

test("5-5. 支払予定は本人×対象月で一意（再計算で二重に作らない）", () => {
  assert.match(TABLES_SQL, /unique \(target_month, creator_id\)/);
  assert.match(SYNC_SRC, /onConflict: "target_month,creator_id"/);
  /*
    M-3 以降は「その月の明細」から状態を決める。
    支払済みの月は allPaid が true になり status='paid' で上書きされるので、
    支払済みフラグを別に持つ必要がない。
  */
  assert.match(SYNC_SRC, /const allPaid = acc\.count > 0 && acc\.paidCount === acc\.count;/);
  assert.match(SYNC_SRC, /status: allPaid \? "paid" : "unpaid"/);
});

test("5-6. 所属・区分・AK は読むだけで書き換えない", () => {
  const body = SYNC_SRC.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const table of [
    "creator_monthly_agency_assignments",
    "creator_monthly_account_management_types",
    "affiliate_order_lines",
    "creators",
    "agencies",
  ]) {
    assert.doesNotMatch(
      body,
      new RegExp(`from\\("${table}"\\)[\\s\\S]{0,120}\\.(update|upsert|insert|delete)\\(`),
      table,
    );
  }
});

// ---------------------------------------------------------------------------
// 6. 既存制度への非干渉
// ---------------------------------------------------------------------------

test("6-1. 代理店報酬・紹介者報酬のテーブルに触らない", () => {
  /* 説明コメントでの言及は許す。実行コードから参照していないことを見る */
  for (const src of [SYNC_SRC, QUERIES_SRC, ACTION_SRC]) {
    const body = stripTs(src);
    assert.doesNotMatch(body, /agency_reward_items/);
    assert.doesNotMatch(body, /referral_reward_items/);
    assert.doesNotMatch(body, /agency_payouts|referral_payouts/);
  }
});

test("6-2. 紹介料5%の対象外であることは変わらない", () => {
  assert.equal(types.isReferralRewardEligibleType("account_lending"), false);
  assert.equal(
    referralEngine.isReferralTargetCreator({
      creatorId: "c1",
      referrerId: "r1",
      accountManagementType: "account_lending",
    }),
    false,
  );
});

test("6-3. 代理店報酬エンジンは account_lending で報酬を作らない", () => {
  const assignment = {
    creatorId: "c1",
    agencyId: "ag-three",
    agencyName: "THREE.inc",
    agencyIsInHouse: false,
    source: "monthly",
  };
  assert.equal(
    agencyEngine.computeAgencyReward(line(), assignment, {
      accountManagementType: "account_lending",
    }),
    null,
  );
});

test("6-4. 本人を代理店マスタへ登録しない", () => {
  for (const src of [SYNC_SRC, ACTION_SRC, QUERIES_SRC, CLIENT_SRC, TAB_SRC]) {
    assert.doesNotMatch(src, /from\("agencies"\)[\s\S]{0,120}\.(insert|upsert)\(/);
  }
  /* 受取人の列はクリエイター。自社所属は監査用の記録 */
  assert.match(TABLES_SQL, /creator_id uuid not null references public\.creators\(id\)/);
  assert.match(TABLES_SQL, /in_house_agency_id/);
});

test("6-5. 支払先に THREE.inc の代理店 ID を代用しない", () => {
  const body = stripSql(RPC_SQL);

  /*
    本人の口座は本人専用テーブルから引く。
    本番の pg_get_functiondef 出力をそのまま使っているため大文字が混ざる。
  */
  assert.match(body, /public\.creator_bank_accounts/i);

  /*
    creator の分岐（claim の振込先解決）で agencies を引いていない。
    次の elsif / else が来るまでを見る。
  */
  const start = body.indexOf("elsif p_payee_kind = 'creator'");
  assert.ok(start > 0);
  const rest = body.slice(start + 10);
  const end = rest.search(/\n\s*(elsif|else)\b/);
  const branch = rest.slice(0, end > 0 ? end : rest.length);
  assert.doesNotMatch(branch, /public\.agencies/);
  assert.doesNotMatch(branch, /agency_id/);
});

// ---------------------------------------------------------------------------
// 7. 口座情報の扱い
// ---------------------------------------------------------------------------

test("7-1. 口座は専用テーブルで 1 対 1（creators に口座列を作らない）", () => {
  assert.match(
    TABLES_SQL,
    /create table if not exists public\.creator_bank_accounts[\s\S]{0,200}creator_id uuid primary key references public\.creators\(id\)/,
  );
  const body = stripSql(TABLES_SQL);
  assert.doesNotMatch(body, /alter table public\.creators/);
});

test("7-2. authenticated / anon には権限を与えない", () => {
  const section = TABLES_SQL.slice(TABLES_SQL.indexOf("creator_bank_accounts"));
  assert.match(section, /revoke all on public\.creator_bank_accounts from authenticated, anon/);
  assert.match(section, /grant all on public\.creator_bank_accounts to service_role/);
  assert.match(section, /enable row level security/);
});

test("7-3. 一覧へ渡すのは下4桁だけ（全桁を画面に出さない）", () => {
  assert.match(QUERIES_SRC, /accountNumberTail/);
  assert.match(QUERIES_SRC, /number\.slice\(-4\)/);
  /*
    一覧の読み取りは口座番号の中身を返さない。
    口座から取るのは creator_id と bank_account_number（有無の判定用）だけで、
    名義・支店などは一覧用の関数では読まない。
  */
  const summary = QUERIES_SRC.slice(
    QUERIES_SRC.indexOf("export async function fetchCreatorLendingSummary"),
    QUERIES_SRC.indexOf("/** 口座の登録状況"),
  );
  assert.ok(summary.length > 0, "一覧の読み取り関数が見つかる");
  assert.match(summary, /hasBankAccount/);
  /*
    M-1 で判定を支払系と揃えたため、状態判定に必要な列をすべて読む。
    ただし画面へ渡すのは状態（bankState）だけで、口座番号そのものは返さない。
  */
  assert.match(summary, /resolveBankAccountState\(bankAccountFromRow\(row\)\)/);
  assert.match(summary, /bankStateByCreator/);
  assert.doesNotMatch(summary, /accountNumberTail/);
  /* 一覧の行型に口座番号を載せていない */
  assert.doesNotMatch(QUERIES_SRC, /bankAccountNumber: string/);
});

test("7-4. 編集フォームに既存の口座番号を初期値として出さない", () => {
  const form = CLIENT_SRC.slice(CLIENT_SRC.indexOf('name="bank_account_number"'));
  assert.doesNotMatch(form.slice(0, 400), /defaultValue=\{bank/);
  assert.match(CLIENT_SRC, /autoComplete="off"/);
});

test("7-5. 口座の中身を監査ログ・完了メッセージに書かない", () => {
  const save = ACTION_SRC.slice(
    ACTION_SRC.indexOf("export async function saveCreatorBankAccountAction"),
  );
  assert.doesNotMatch(save, /message: `.*\$\{accountNumber\}/);
  assert.doesNotMatch(save, /message: `.*\$\{accountHolder\}/);
  /* 変更履歴テーブルに口座列が無い */
  const logs = TABLES_SQL.slice(TABLES_SQL.indexOf("creator_lending_term_logs"));
  assert.doesNotMatch(logs.slice(0, 800), /bank_/);
});

test("7-6. 口座の入力検証が支払処理の必須条件と一致する（M-1）", () => {
  /* 7項目すべてを必須にしている */
  for (const label of [
    "銀行名",
    "銀行コード",
    "支店名",
    "支店コード",
    "口座種別",
    "口座番号",
    "口座名義",
  ]) {
    assert.ok(ACTION_SRC.includes(`"${label}"`), label);
  }
  /* 桁数の検証（任意ではなく必須） */
  assert.match(ACTION_SRC, /\/\^\\d\{1,10\}\$\//);
  assert.match(ACTION_SRC, /if \(!\/\^\\d\{4\}\$\/\.test\(bankCode\)\)/);
  assert.match(ACTION_SRC, /if \(!\/\^\\d\{3\}\$\/\.test\(branchCode\)\)/);
  assert.match(ACTION_SRC, /BANK_ACCOUNT_TYPES\.includes/);
  /* 保存前に支払系の判定で検算する */
  assert.match(ACTION_SRC, /resolveBankAccountState\(\{/);
  assert.match(ACTION_SRC, /resolvedState !== "registered"/);
});

test("7-7. 口座未登録では支払明細を作れない（RPC 側でも拒否）", () => {
  assert.match(RPC_SQL, /振込先が未登録です/);
});

// ---------------------------------------------------------------------------
// 8. 管理画面（/revenue の端末貸し出しタブ）
// ---------------------------------------------------------------------------

test("8-1. タブは管理者だけに出す", () => {
  assert.match(REVENUE_PAGE_SRC, /\{ key: "lending", label: "端末貸し出し" \}/);
  assert.match(REVENUE_PAGE_SRC, /ADMIN_ONLY_TABS = new Set<TabKey>\(\["referral", "lending"\]\)/);
  assert.match(REVENUE_PAGE_SRC, /tab === "lending" && isAdmin \? <LendingRewardTab/);
});

test("8-2. 画面に必要な項目がそろっている", () => {
  for (const label of [
    "対象クリエイター",
    "AP",
    "本人報酬",
    "自社取り分",
    "適用分配率",
    "分配率の設定",
    "振込先",
    "報酬が作られなかった理由",
  ]) {
    assert.ok(CLIENT_SRC.includes(label), label);
  }
});

test("8-3. 未計上・未払い・支払中・一部支払・支払済みを区別して出す", () => {
  for (const label of ["支払済", "一部支払", "支払中", "未払い", "未計上"]) {
    assert.ok(CLIENT_SRC.includes(label), label);
  }
  /* 状態は明細から導いた paymentState を使う（支払予定の累積値は見ない）*/
  assert.match(CLIENT_SRC, /MONTH_STATE_STYLE\[row\.paymentState\]/);
  assert.doesNotMatch(CLIENT_SRC, /payoutStatus/);
});

test("8-4. 画面では金額を計算しない（保存済みの値を出すだけ）", () => {
  const body = CLIENT_SRC.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(body, /agencyRevenue \* /);
  assert.doesNotMatch(body, /\* splitRate/);
  assert.doesNotMatch(body, /rewardAmount \* /);
});

test("8-4b. 一覧の母集合は明細だけでなく対象候補も含む（初回有効化ができる）", () => {
  /*
    報酬明細だけを母集合にすると、未有効化のクリエイターが一覧に出ず、
    行を展開した先にある分配率設定・口座登録に到達できない（鶏と卵）。
    区分が account_lending の注文明細から対象候補を作り、
    明細 0 件でも行を出す。
  */
  const summary = QUERIES_SRC.slice(
    QUERIES_SRC.indexOf("export async function fetchCreatorLendingSummary"),
  );
  /* 候補は注文明細から作る */
  assert.match(summary, /affiliate_order_lines/);
  assert.match(summary, /const candidates = new Map/);
  /* 明細の集合と候補の集合の和をとる */
  assert.match(summary, /new Set<string>\(\[\.\.\.itemsByCreator\.keys\(\), \.\.\.candidates\.keys\(\)\]\)/);
  /* 月行も和集合 */
  assert.match(summary, /\.\.\.\(itemAcc \? itemAcc\.byMonth\.keys\(\) : \[\]\)/);
  /* 未計上の情報を行に持たせる */
  for (const field of [
    "pendingMonthCount",
    "pendingAgencyRevenue",
    "isActivated",
    "exclusionReason",
    "exclusionLabel",
  ]) {
    assert.ok(QUERIES_SRC.includes(field), field);
  }
});

test("8-4c. 画面が未有効化を区別して出す", () => {
  /* 月行のバッジ */
  assert.match(CLIENT_SRC, /未有効化/);
  assert.match(CLIENT_SRC, /row\.exclusionReason === "inactive_terms"/);
  /* 計上0件の月は理由を先に出す */
  assert.match(CLIENT_SRC, /if \(row\.itemCount === 0\)/);
  /* 未計上 AP の列と、手順の案内 */
  assert.match(CLIENT_SRC, /未計上 AP/);
  assert.match(CLIENT_SRC, /summary\.totals\.pendingMonthCount > 0/);
  assert.match(CLIENT_SRC, /対象月の分配率を保存して有効化してから/);
  /* 一覧の行に有効化バッジ */
  assert.match(CLIENT_SRC, /row\.isActivated \? \(/);
});

test("8-4d. 未計上の月には「予定」として設定中の率を出す（実績と混ぜない）", () => {
  assert.match(CLIENT_SRC, /month\.itemCount > 0 \? \(/);
  assert.match(CLIENT_SRC, /effectiveSplitRate/);
  assert.match(CLIENT_SRC, /予定/);
  /* 明細がある月は保存済みの率をそのまま出す */
  assert.match(CLIENT_SRC, /formatRate\(month\.splitRate\)/);
});

test("8-5. 対象外の理由は計算と同じ関数で判定する（表示と計算が食い違わない）", () => {
  assert.match(QUERIES_SRC, /resolveLendingExclusionReason/);
  assert.match(QUERIES_SRC, /LENDING_EXCLUSION_LABEL/);
  /* 区分が貸出の月だけを対象にする */
  assert.match(QUERIES_SRC, /accountManagementType !== "account_lending"/);
});

test("8-6. 変更操作は管理者のみ・監査ログを残す", () => {
  const actions = [
    "syncCreatorLendingRewardsAction",
    "setCreatorLendingTermAction",
    "saveCreatorBankAccountAction",
  ];
  for (const name of actions) {
    const body = ACTION_SRC.slice(ACTION_SRC.indexOf(`export async function ${name}`));
    assert.match(body.slice(0, 400), /requireAdminAction\(\)/, name);
  }
  assert.match(ACTION_SRC, /creator_lending_term_logs/);
  assert.match(ACTION_SRC, /action: splitRate == null \? "reset_rate" : "set_rate"/);
  assert.match(ACTION_SRC, /action: isActive \? "activate" : "deactivate"/);
});

test("8-7. 監査ログの操作種別は DB の CHECK と一致する", () => {
  assert.match(
    TABLES_SQL,
    /check \(action in \('set_rate', 'reset_rate', 'activate', 'deactivate'\)\)/,
  );
});

test("8-8. 設定しただけでは金額が変わらないことを画面で伝える", () => {
  assert.match(CLIENT_SRC, /対象月を再集計すると反映されます/);
  assert.match(ACTION_SRC, /金額へ反映するには対象月を再集計してください/);
});

// ---------------------------------------------------------------------------
// 9. 支払管理への統合（第3の受取種別 creator）
// ---------------------------------------------------------------------------

test("9-1. 受取種別は agency / referrer / creator の3つ", () => {
  assert.deepEqual([...payable.PAYEE_KINDS], ["agency", "referrer", "creator"]);
  assert.equal(payable.PAYEE_KIND_LABEL.creator, "クリエイター");
  assert.equal(payable.isPayeeKind("creator"), true);
});

test("9-2. 既存の agency / referrer のラベルと判定を変えていない", () => {
  assert.equal(payable.PAYEE_KIND_LABEL.agency, "代理店");
  assert.equal(payable.PAYEE_KIND_LABEL.referrer, "紹介者");
  assert.equal(payable.isPayeeKind("agency"), true);
  assert.equal(payable.isPayeeKind("referrer"), true);
  assert.equal(payable.isPayeeKind("seller"), false);
});

test("9-3. DB の受取種別・排他制約も3択になる", () => {
  const body = stripSql(BATCH_SQL);
  assert.match(body, /payee_kind in \('agency', 'referrer', 'creator'\)/);
  assert.match(body, /payee_creator_id uuid/);
  assert.match(body, /references public\.creators\(id\)/);
  /* 受取人はどれか1つだけ */
  assert.match(body, /payee_exclusive_check/);
});

test("9-4. 端末貸し出しの最低振込額は 1,000円（2026-10-11 確定）", () => {
  assert.equal(minimum.CREATOR_LENDING_PAYOUT_THRESHOLD_YEN, 1000);
  assert.equal(minimum.DEFAULT_MINIMUM_PAYOUT_YEN, 1000, "既存の下限は変えない");
  const actions = read("app/actions/payments.ts");
  assert.match(actions, /if \(payeeKind === "creator"\) return CREATOR_LENDING_PAYOUT_THRESHOLD_YEN;/);
  /* 代理店・紹介者とは別の定数にしてある（片方だけ変えられるように） */
  assert.match(read("lib/payments/minimum-payout.ts"), /CREATOR_LENDING_MINIMUM_PAYOUT/);
});

test("9-5. 占有するのは端末貸し出しの明細だけ（二重支払い防止の4条件を維持）", () => {
  const body = stripSql(RPC_SQL);
  const start = body.indexOf("update public.creator_lending_reward_items");
  assert.ok(start > 0, "creator の占有が存在する");
  const branch = body.slice(start, body.indexOf("returning", start) + 60);
  assert.match(branch, /update public\.creator_lending_reward_items/);
  assert.match(branch, /is_reward_target = true/);
  assert.match(branch, /is_paid = false/);
  assert.match(branch, /payout_id is null/);
  assert.match(branch, /payment_batch_id is null/);
  /* 代理店・紹介者の明細は触らない */
  assert.doesNotMatch(branch, /agency_reward_items|referral_reward_items/);
});

test("9-6. 支払予定は本人×対象月（creator_lending_payouts）に紐付く", () => {
  assert.match(RPC_SQL, /from public\.creator_lending_payouts/);
  assert.match(TABLES_SQL, /status in \('hold', 'unpaid', 'paid'\)/);
});

test("9-7. 支払管理の金額は本人ぶんだけ（自社取り分を混ぜない）", () => {
  assert.match(PAYMENT_QUERIES_SRC, /lendingRewardAmount/);
  assert.match(PAYMENT_QUERIES_SRC, /lendingSelfShareAmount/);
  /* 自社取り分は支払額（claimable）に足さない */
  const acc = PAYMENT_QUERIES_SRC.slice(
    PAYMENT_QUERIES_SRC.indexOf("const creatorAcc = new Map"),
    PAYMENT_QUERIES_SRC.indexOf("// ---- 支払明細 ---"),
  );
  assert.match(acc, /acc\.claimable\.push\(value\)/);
  assert.doesNotMatch(acc, /acc\.claimable\.push\(selfShare\)/);
  assert.doesNotMatch(acc, /acc\.lendingClaimable\.push\(selfShare\)/);
});

test("9-8. 受取人が本人の行は自社扱いにしない（in_house で保留しない）", () => {
  const reasons = payable.resolvePaymentHoldReasons({
    isInHouse: false,
    bankState: "registered",
    unpaidAmount: 20822.4,
    thresholdAmount: 0,
    hasUnconfirmedAssignment: false,
    hasUnconfirmedReward: false,
  });
  assert.deepEqual(reasons, []);
  assert.match(PAYMENT_QUERIES_SRC, /isInHouse: payeeKind === "agency" && meta\?\.isInHouse === true/);
});

test("9-9. 口座未登録のクリエイターは bank_missing で保留される", () => {
  const reasons = payable.resolvePaymentHoldReasons({
    isInHouse: false,
    bankState: "missing",
    unpaidAmount: 20822.4,
    thresholdAmount: 0,
    hasUnconfirmedAssignment: false,
    hasUnconfirmedReward: false,
  });
  assert.deepEqual(reasons, ["bank_missing"]);
});

test("9-10. 本人の振込先は代理店・紹介者の口座編集から変更できない", () => {
  assert.match(PAYEE_BANK_ACTION_SRC, /if \(payeeKind === "creator"\)/);
  assert.match(PAYEE_BANK_ACTION_SRC, /端末貸し出し」タブから登録・変更してください/);
  /* agencies / referrers のどちらにも書かない */
  const branch = PAYEE_BANK_ACTION_SRC.slice(
    PAYEE_BANK_ACTION_SRC.indexOf('if (payeeKind === "creator")'),
  );
  assert.match(branch.slice(0, 400), /return \{/);
});

test("9-11. 支払管理にクリエイタータブがある", () => {
  assert.match(PAYMENTS_CLIENT_SRC, /\{ key: "creator", label: "クリエイター" \}/);
  assert.match(PAYMENTS_CLIENT_SRC, /tab === "creator" && row\.payeeKind !== "creator"/);
});

test("9-12. テーブル未作成の環境では支払候補を出さない（代理店・紹介者は止めない）", () => {
  const src = read("lib/payments/creator-lending-payee.ts");
  assert.match(src, /tableMissing/);
  assert.match(src, /isMissingLendingTable/);
  /* 権限エラーなどは握り潰さず error として返す */
  assert.match(src, /return \{ \.\.\.empty, error: itemsResult\.error \};/);
  assert.match(PAYMENT_QUERIES_SRC, /lendingTableMissing/);
});

// ---------------------------------------------------------------------------
// 10. migration（4本）の安全性
// ---------------------------------------------------------------------------

const ALL_SQL = [
  ["20261010100000 テーブル", TABLES_SQL],
  ["20261010110000 ガード", GUARD_SQL],
  ["20261010120000 支払先列", BATCH_SQL],
  ["20261010130000 支払RPC", RPC_SQL],
  ["20261010140000 権限", PRIVILEGE_SQL],
  ["20261010150000 ガード強化", GUARD2_SQL],
  ["20261010160000 繰越", CARRYOVER_SQL],
  ["20261010170000 繰越RPC", CARRYOVER_RPC_SQL],
];

/*
  DDL だけの migration（テーブル・ガード・支払先列）。
  支払RPC（20261010130000）は関数定義なので、本文に INSERT / UPDATE を含む。
  それは関数が呼ばれたときの動作であって、適用時に実行される DML ではない。
*/
const DDL_ONLY_SQL = ALL_SQL.filter(
  ([name]) => !name.includes("支払RPC") && !name.includes("繰越RPC"),
);

test("10-1. 適用時に実行される DML が無い（DDL のみ）", () => {
  /*
    文としての truncate を探す。
    comment on table の説明文に「TRUNCATE / DELETE は外してある」と
    書いてあるのは文ではないので、直後に対象名が続く形だけを見る。
  */
  const TRUNCATE_STATEMENT = /\btruncate\s+(table\s+)?(only\s+)?(public\.)?[a-z_][a-z0-9_]*/i;
  for (const [name, sql] of DDL_ONLY_SQL) {
    const body = stripSql(sql);
    assert.doesNotMatch(body, /\binsert\s+into\s+public\./i, name);
    assert.doesNotMatch(body, /\bdelete\s+from\s+public\./i, name);
    assert.doesNotMatch(body, TRUNCATE_STATEMENT, name);
    assert.doesNotMatch(body, /\bdrop\s+table\b/i, name);
  }
});

test("10-1b. 支払RPC は関数の作り直しだけで、適用時にデータを動かさない", () => {
  const body = stripSql(RPC_SQL);
  /* 作るのは create or replace function だけ（本番の定義出力は大文字） */
  assert.match(body, /create or replace function public\.claim_payment_batch_items/i);
  assert.match(body, /create or replace function public\.approve_one_payment_batch/i);
  assert.match(body, /create or replace function public\.complete_payment_batch/i);
  /* 関数の外（トップレベル）に DML・DDL が無い */
  const topLevel = body
    .split(/\$function\$/)
    .filter((_, index) => index % 2 === 0)
    .join("\n");
  assert.equal((body.match(/\$function\$/g) ?? []).length, 6, "関数3本ぶんの引用符");
  assert.doesNotMatch(topLevel, /\binsert\s+into\b/i);
  assert.doesNotMatch(topLevel, /\bupdate\s+public\./i);
  assert.doesNotMatch(topLevel, /\bdelete\s+from\b/i);
  assert.doesNotMatch(topLevel, /\btruncate\b/i);
  assert.doesNotMatch(topLevel, /\balter\s+table\b/i);
  assert.doesNotMatch(topLevel, /\bdrop\s+table\b/i);
});

test("10-2. 既存の報酬・支払テーブルの列を落とさない", () => {
  for (const [name, sql] of DDL_ONLY_SQL) {
    const body = stripSql(sql);
    assert.doesNotMatch(body, /drop\s+column/i, name);
    assert.doesNotMatch(body, /drop\s+constraint\s+(?!if exists payment_batches_payee)/i, name);
  }
});

test("10-3. 本人受取の明細はガードで検証される（4条件）", () => {
  const body = stripSql(GUARD_SQL);
  assert.match(body, /before insert or update on public\.creator_lending_reward_items/);
  assert.match(body, /security definer/);
  assert.match(body, /set search_path to 'public'/);
  /* 区分 / 所属 / AK / 金額 */
  assert.match(body, /v_effective_type <> 'account_lending'/);
  assert.match(body, /not coalesce\(v_is_in_house, false\)/);
  assert.match(body, /coalesce\(v_ak, 0\) <> 100/);
  assert.match(body, /round\(v_ap \* new\.split_rate, 2\)/);
  assert.match(body, /abs\(new\.self_share_amount - v_self_expected\) > 0\.01/);
});

test("10-4. 検証に使う列はすべて早期 return の比較に入っている", () => {
  const body = stripSql(GUARD_SQL);
  const early = body.slice(
    body.indexOf("if tg_op = 'UPDATE'"),
    body.indexOf("select m.account_management_type"),
  );
  for (const col of [
    "reward_amount",
    "self_share_amount",
    "split_rate",
    "creator_id",
    "agency_revenue",
    "agency_split_rate",
    "in_house_agency_id",
    "target_month",
    "source_row_key",
  ]) {
    assert.match(early, new RegExp(`old\\.${col}\\s+is not distinct from new\\.${col}`), col);
  }
});

test("10-5. 記録した AK・AP が注文明細と一致することも検査する", () => {
  const body = stripSql(GUARD_SQL);
  assert.match(body, /abs\(coalesce\(new\.agency_split_rate, 0\) - v_ak\) > 0\.0001/);
  assert.match(body, /abs\(new\.agency_revenue - v_ap\) > 0\.01/);
  /* 注文明細が引けない場合も拒否（fail-open にしない） */
  assert.match(body, /if v_ap is null then/);
  assert.doesNotMatch(body, /if v_ap is not null then/);
});

test("10-6. 本人 + 自社 = AP を DB 側でも守る", () => {
  assert.match(
    TABLES_SQL,
    /abs\(\(reward_amount \+ self_share_amount\) - agency_revenue\) <= 0\.01/,
  );
});

test("10-7. 分配率と対象月の形式を DB 側でも守る", () => {
  /* 分配条件（null = 既定）と明細（必須）の両方に範囲チェックがある */
  assert.match(TABLES_SQL, /split_rate is null or \(split_rate > 0 and split_rate <= 1\)/);
  assert.match(TABLES_SQL, /check \(split_rate > 0 and split_rate <= 1\)/);
  /* 対象月の形式チェックが3テーブルに入っている */
  const monthChecks = TABLES_SQL.match(/target_month ~ /g) ?? [];
  assert.equal(monthChecks.length, 3, `対象月チェックが ${monthChecks.length} 件`);
  assert.ok(TABLES_SQL.includes("(0[1-9]|1[0-2])"));
});

test("10-8. 既存の agency / referrer 分岐を書き換えていない", () => {
  const body = stripSql(RPC_SQL);
  /* 既存2種の分岐がそのまま残っている */
  assert.match(body, /if p_payee_kind = 'agency' then/);
  assert.match(body, /elsif p_payee_kind = 'creator' then/);
  assert.match(body, /update public\.agency_reward_items/);
  assert.match(body, /update public\.referral_reward_items/);
  /* 既存の下限 1,000 円の判定を消していない */
  assert.match(body, /p_min_amount/);
});

test("10-9. 適用順序（テーブル → ガード → 支払先列 → 支払RPC → 権限 → ガード強化 → 繰越 → 繰越RPC）", () => {
  const dir = path.join(process.cwd(), "supabase/migrations");
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith("202610101"))
    .sort();
  assert.deepEqual(files, [
    "20261010100000_creator_lending_reward_tables.sql",
    "20261010110000_creator_lending_reward_guard.sql",
    "20261010120000_payment_batches_creator_payee.sql",
    "20261010130000_payment_rpcs_creator_payee.sql",
    "20261010140000_creator_lending_privilege_lock.sql",
    "20261010150000_account_lending_guard_strengthen.sql",
    "20261010160000_creator_lending_carryover.sql",
    "20261010170000_payment_rpcs_creator_carryover.sql",
  ]);
});

test("10-10a. 既定権限で付く TRUNCATE を4テーブルから剥奪する", () => {
  /*
    本番の既定権限（postgres が public に作るテーブル → anon/authenticated に
    TRUNCATE / REFERENCES / TRIGGER）を剥がすのがこの migration の目的。
    RLS は TRUNCATE を止めないので、権限を外すことが唯一の防御になる。
  */
  const body = stripSql(PRIVILEGE_SQL);
  assert.match(body, /revoke all on public\.%I from authenticated, anon/);
  for (const table of [
    "creator_lending_terms",
    "creator_lending_reward_items",
    "creator_lending_payouts",
    "creator_lending_term_logs",
  ]) {
    assert.ok(body.includes(`'${table}'`), table);
  }
  /* 読み取りだけ戻す（書き込みは service_role のみ） */
  assert.match(body, /grant select on public\.%I to authenticated/);
  assert.match(body, /grant all on public\.%I to service_role/);
  /* 監査ログへの INSERT は戻さない */
  assert.doesNotMatch(body, /grant select, insert/);
});

test("10-10b. 口座テーブルは SELECT も渡さない", () => {
  const body = stripSql(PRIVILEGE_SQL);
  assert.match(body, /revoke all on public\.creator_bank_accounts from authenticated, anon/);
  assert.doesNotMatch(
    body,
    /grant [^;]*on public\.creator_bank_accounts to authenticated/,
  );
});

test("10-10c. 権限 migration は DML を含まず、既定権限そのものを変えない", () => {
  const body = stripSql(PRIVILEGE_SQL);
  assert.doesNotMatch(body, /\binsert\s+into\b/i);
  assert.doesNotMatch(body, /\bupdate\s+public\./i);
  assert.doesNotMatch(body, /\bdelete\s+from\b/i);
  assert.doesNotMatch(body, /\btruncate\s+(table\s+)?(only\s+)?(public\.)?[a-z_]/i);
  assert.doesNotMatch(body, /\bdrop\s+table\b/i);
  /*
    alter default privileges は書かない。
    書くと今後 public に作られる全テーブルの権限が変わる。
  */
  assert.doesNotMatch(body, /alter default privileges/i);
  /* テーブルが無い環境でも落ちないよう存在チェックで囲む */
  assert.match(body, /from pg_class c/);
  assert.match(body, /relkind = 'r'/);
});

test("10-11. 口座テーブルは authenticated / anon に一切の権限を与えない", () => {
  assert.match(
    TABLES_SQL,
    /revoke all on public\.creator_bank_accounts from authenticated, anon/,
  );
  assert.match(TABLES_SQL, /grant all on public\.creator_bank_accounts to service_role/);
  /* 口座テーブルには authenticated への grant が一切ない */
  assert.doesNotMatch(TABLES_SQL, /grant [^;]*on public\.creator_bank_accounts to authenticated/);
});

test("10-12. 他の本人受取テーブルは RLS 管理者限定＋読み取りだけ", () => {
  for (const table of [
    "creator_lending_terms",
    "creator_lending_term_logs",
    "creator_lending_reward_items",
    "creator_lending_payouts",
  ]) {
    assert.match(
      TABLES_SQL,
      new RegExp(`alter table public\\.${table} enable row level security`),
      table,
    );
    assert.match(
      TABLES_SQL,
      new RegExp(`create policy "${table}_admin_all"[\\s\\S]{0,200}public\\.is_app_admin\\(\\)`),
      table,
    );
    assert.match(
      TABLES_SQL,
      new RegExp(`grant all on public\\.${table} to service_role`),
      table,
    );
    /* authenticated へ UPDATE / DELETE は渡さない（書き込みは service role だけ） */
    assert.doesNotMatch(
      TABLES_SQL,
      new RegExp(`grant[^;]*\\b(update|delete)\\b[^;]*on public\\.${table} to authenticated`),
      table,
    );
  }
});

// ---------------------------------------------------------------------------
// 11. 支払可否の判定（年間累積・下限なし）
// ---------------------------------------------------------------------------

test("11-1. 支払判定は代理店報酬と同じ関数（下限なし）", () => {
  const state = lendingEngine.resolveCreatorLendingAnnualState({
    annualRewardAmount: 51979.2,
    paidAmount: 0,
  });
  assert.equal(state.thresholdAmount, 0);
  assert.equal(state.unpaidAmount, 51979.2);
  assert.equal(state.isPayable, true);
});

test("11-2. 支払済みを差し引く（二重払い防止）", () => {
  const partial = lendingEngine.resolveCreatorLendingAnnualState({
    annualRewardAmount: 51979.2,
    paidAmount: 22132,
  });
  assert.equal(partial.unpaidAmount, 29847.2);
});

test("11-3. 明細の金額は reward_amount を正式 source とする", () => {
  assert.equal(
    lendingEngine.resolveCreatorLendingRewardItemAmount({
      reward_amount: 20822.4,
      self_share_amount: 5205.6,
    }),
    20822.4,
  );
});

// ---------------------------------------------------------------------------
// 12. 監査で見つかった残存問題の修正（M-1〜M-6）
// ---------------------------------------------------------------------------

const rounding = await jiti.import("@/lib/payments/creator-lending-rounding.ts");
const referralEngineForMinimum = await jiti.import(
  "@/lib/referrals/referral-reward-engine.ts",
);

// ---- M-1 口座の登録済み判定の統一 ----------------------------------------

test("12-1. 一覧の『登録済』は支払系と同じ判定を使う", () => {
  /* 口座番号の有無だけで決めない */
  assert.doesNotMatch(
    QUERIES_SRC,
    /registered: number\.length > 0/,
  );
  assert.match(QUERIES_SRC, /registered: state === "registered"/);
  assert.match(QUERIES_SRC, /bankState: bankStateByCreator\.get\(creatorId\) \?\? "missing"/);
  /* 画面も3状態で出す */
  assert.match(CLIENT_SRC, /BANK_ACCOUNT_STATE_LABEL\[row\.bankState\]/);
  assert.match(CLIENT_SRC, /BANK_STATE_CLASS/);
});

test("12-2. 必須項目は claim RPC の条件と一致する", () => {
  /* claim が要求する7項目 */
  const claim = CARRYOVER_RPC_SQL.slice(
    CARRYOVER_RPC_SQL.indexOf("claim_payment_batch_items"),
  );
  assert.match(claim, /coalesce\(btrim\(v_bank_name\), ''\) = ''/);
  assert.match(claim, /coalesce\(btrim\(v_branch_name\), ''\) = ''/);
  assert.match(claim, /coalesce\(btrim\(v_account_type\), ''\) = ''/);
  assert.match(claim, /coalesce\(btrim\(v_account_number\), ''\) = ''/);
  assert.match(claim, /coalesce\(btrim\(v_account_holder\), ''\) = ''/);
  assert.match(claim, /coalesce\(btrim\(v_bank_code\), ''\) = ''/);
  assert.match(claim, /coalesce\(btrim\(v_branch_code\), ''\) = ''/);
  /* 入力画面もコードを必須にしている */
  assert.match(CLIENT_SRC, /銀行コード（4桁・必須）/);
  assert.match(CLIENT_SRC, /支店コード（3桁・必須）/);
});

// ---- M-2 ガードの防御維持 -------------------------------------------------

test("12-3. 区分が貸出の人月に通常の代理店報酬を作らせない", () => {
  const body = stripSql(GUARD2_SQL);
  /* 月別確定を優先して区分を解決する */
  assert.match(body, /from public\.creator_monthly_account_management_types/);
  assert.match(body, /v_effective_type := coalesce\(/);
  assert.match(body, /if v_effective_type = 'account_lending' then/);
  /* 自社所属かどうかでメッセージを分ける */
  assert.match(body, /coalesce\(a\.is_in_house, false\)/);
  assert.match(GUARD2_SQL, /所属が自社です。代理店報酬としては保存できません/);
  assert.match(GUARD2_SQL, /AP は本人への分配の原資なので/);
  /* 旧ルール（account_lending の種類・分配率）も残す */
  assert.match(body, /coalesce\(new\.reward_kind, 'agency'\) = 'account_lending'/);
  assert.match(body, /new\.lending_split_rate is not null/);
});

test("12-4. 支払処理の UPDATE は検査しない（既存の支払経路を壊さない）", () => {
  const body = stripSql(GUARD2_SQL);
  const early = body.slice(
    body.indexOf("if tg_op = 'UPDATE'"),
    body.indexOf("coalesce(new.reward_kind, 'agency') = 'account_lending'"),
  );
  for (const col of [
    "reward_amount",
    "reward_kind",
    "lending_split_rate",
    "agency_id",
    "creator_id",
    "target_month",
  ]) {
    assert.match(early, new RegExp(`old\\.${col}\\s+is not distinct from new\\.${col}`), col);
  }
  assert.match(early, /return new;/);
  /* トリガ名は変えない */
  assert.match(body, /create trigger agency_reward_items_account_lending_guard/);
});

// ---- M-3 支払済みステータスの整合性 --------------------------------------

test("12-5. 支払予定は月別の実額を入れる（年初来累積にしない）", () => {
  /* 対象月だけを読む */
  assert.match(SYNC_SRC, /\.eq\("target_month", targetMonth\)/);
  /* 累積のための範囲指定を使っていない */
  const refresh = SYNC_SRC.slice(SYNC_SRC.indexOf("async function refreshLendingPayoutsForMonth"));
  assert.doesNotMatch(refresh, /rewardYear/);
  assert.doesNotMatch(refresh, /gte\("target_month"/);
  /* 意味を migration のコメントにも書いている */
  assert.match(CARRYOVER_SQL, /年初来累積ではない/);
});

test("12-6. 画面と支払候補は明細を正とする（支払予定の status を見ない）", () => {
  /*
    一覧の読み取りは支払予定テーブルを読まない。
    （コメントでの言及は許す。実行コードから参照していないことを見る）
  */
  assert.doesNotMatch(stripTs(QUERIES_SRC), /creator_lending_payouts/);
  /* 月の状態は明細から導く */
  assert.match(QUERIES_SRC, /function resolveMonthPaymentState/);
  assert.match(QUERIES_SRC, /if \(params\.itemCount === 0\) return "none";/);
  /* 支払管理も明細から集計している */
  assert.doesNotMatch(stripTs(PAYMENT_QUERIES_SRC), /creator_lending_payouts/);
});

// ---- M-4 振込端数と繰越 ---------------------------------------------------

test("12-7. 1,000円以上は1円単位へ切り捨て、端数を繰越す", () => {
  /* [明細, 繰越, 期待する振込, 期待する次回繰越] */
  const cases = [
    [3016.8, 0, 3016, 0.8],
    [1433.6, 0.4, 1434, 0],
    [1328.8, 0, 1328, 0.8],
    [2183.2, 0, 2183, 0.2],
    [1000, 0, 1000, 0],
    [1500.8, 0, 1500, 0.8],
    /* 繰越を足して境界を越える */
    [999.8, 0.3, 1000, 0.1],
  ];
  for (const [items, carryIn, transfer, carryOut] of cases) {
    const result = rounding.resolveCarryoverSettlement({
      itemsAmount: items,
      carryoverIn: carryIn,
    });
    assert.equal(result.transferAmount, transfer, `${items} + ${carryIn}`);
    assert.equal(result.carryoverOut, carryOut, `${items} + ${carryIn} の端数`);
    assert.equal(result.payable, true, `${items} + ${carryIn} は支払可能`);
    assert.equal(result.belowMinimum, false);
    assert.equal(result.carryForwardAmount, carryOut, "次回へ回るのは端数だけ");
  }
});

test("12-7b. 1,000円未満は振り込まず、全額を次回へ繰り越す", () => {
  /* [明細, 繰越, 期待する次回繰越総額, 期待する不足額] */
  const cases = [
    [800, 0, 800, 200],
    [999.8, 0, 999.8, 0.2],
    [999.8, 0.1, 999.9, 0.1],
    [254.4, 0.4, 254.8, 745.2],
    [0.5, 0.3, 0.8, 999.2],
  ];
  for (const [items, carryIn, carryForward, shortfall] of cases) {
    const result = rounding.resolveCarryoverSettlement({
      itemsAmount: items,
      carryoverIn: carryIn,
    });
    assert.equal(result.payable, false, `${items} + ${carryIn}`);
    assert.equal(result.belowMinimum, true);
    assert.equal(result.transferAmount, 0, "振り込まない");
    /* 繰越残高は消費しない（持ち込んだ値のまま） */
    assert.equal(result.carryoverOut, carryIn, "繰越残高を消費しない");
    assert.equal(result.carryForwardAmount, carryForward, "未払い全額を次回へ");
    assert.equal(result.shortfallAmount, shortfall, "不足額");
  }
});

test("12-7c. 1,000円ちょうどは支払対象（境界を含む）", () => {
  const exact = rounding.resolveCarryoverSettlement({ itemsAmount: 1000, carryoverIn: 0 });
  assert.equal(exact.payable, true);
  assert.equal(exact.transferAmount, 1000);
  const just_below = rounding.resolveCarryoverSettlement({ itemsAmount: 999.99, carryoverIn: 0 });
  assert.equal(just_below.payable, false);
  assert.equal(just_below.carryForwardAmount, 999.99);
});

test("12-8. 支払った累計 + 未払い + 繰越 = 計上した累計（消えない・増えない）", () => {
  /*
    月ごとに計上し、そのたびに支払いを試す。
    1,000円未満の月は振り込まず、未払いが次の月へ積み上がる。
      254.40 → 未達（254.40 繰越）
      +1,433.60 = 1,688.00 → 1,688円支払い（端数 0）
      +1,328.80 → 1,328円支払い、0.80 繰越
  */
  const months = [254.4, 1433.6, 1328.8];
  let unpaid = 0;       /* 未払明細の合計 */
  let carry = 0;        /* 1円未満の繰越残高 */
  let transferred = 0;  /* 振込の累計 */

  for (const amount of months) {
    unpaid = Math.round((unpaid + amount) * 100) / 100;
    const result = rounding.resolveCarryoverSettlement({
      itemsAmount: unpaid,
      carryoverIn: carry,
    });
    if (result.payable) {
      transferred += result.transferAmount;
      carry = result.carryoverOut;
      unpaid = 0;
    } else {
      /* 振り込まない月は未払いも繰越もそのまま残る */
      assert.equal(result.carryoverOut, carry);
      assert.equal(result.carryForwardAmount, Math.round((unpaid + carry) * 100) / 100);
    }
  }

  assert.equal(transferred, 1688 + 1328);
  assert.equal(carry, 0.8);
  assert.equal(unpaid, 0);
  assert.equal(
    rounding.isCarryoverConsistent({
      rewardTotal: 3016.8,
      transferredTotal: transferred,
      carryoverBalance: Math.round((carry + unpaid) * 100) / 100,
    }),
    true,
  );
  /* まとめて1回でも総額は変わらない */
  const once = rounding.resolveCarryoverSettlement({ itemsAmount: 3016.8, carryoverIn: 0 });
  assert.equal(once.transferAmount + once.carryoverOut, 3016.8);
});

test("12-9. 下限を下げる指定は効かない（1,000円へ丸める）", () => {
  /* 0 を渡しても 1,000円として判定される */
  const result = rounding.resolveCarryoverSettlement({
    itemsAmount: 0.17,
    carryoverIn: 0,
    minimumAmount: 0,
  });
  assert.equal(result.minimumAmount, 1000, "下限へ丸める");
  assert.equal(result.transferAmount, 0);
  /*
    振り込まないときは何も動かさない。
    繰越残高は持ち込んだ値（0）のまま、0.17 は未払明細として残る。
  */
  assert.equal(result.carryoverOut, 0, "繰越残高を動かさない");
  assert.equal(result.carryForwardAmount, 0.17, "0.17 は未払いとして次回へ");
  assert.equal(result.payable, false);
  assert.equal(result.belowMinimum, true, "1,000円未満なので未達");
  /* claim RPC も両方の条件で拒否する */
  assert.match(CARRYOVER_RPC_SQL, /if v_carry_gross < v_min_amount then/);
  assert.match(CARRYOVER_RPC_SQL, /支払可能額が最低振込額に達していません/);
  assert.match(CARRYOVER_RPC_SQL, /if v_pay_amount < 1 then/);
  assert.match(CARRYOVER_RPC_SQL, /振込額が1円未満です/);
});

test("12-10. 繰越残高は 0 以上 1 未満", () => {
  assert.equal(rounding.isValidCarryoverBalance(0), true);
  assert.equal(rounding.isValidCarryoverBalance(0.99), true);
  assert.equal(rounding.isValidCarryoverBalance(1), false);
  assert.equal(rounding.isValidCarryoverBalance(-0.1), false);
  /* DB 側にも同じ制約がある */
  assert.match(CARRYOVER_SQL, /check \(balance >= 0 and balance < 1\)/);
});

test("12-11. 繰越の二重取り込み・二重復元を DB が弾く", () => {
  assert.match(CARRYOVER_SQL, /unique \(payment_batch_id, action\)/);
  assert.match(CARRYOVER_SQL, /check \(action in \('applied', 'reverted'\)\)/);
  /* 復元は balance_before へ戻す（引き算にしない） */
  const body = stripSql(CARRYOVER_RPC_SQL);
  assert.match(body, /on conflict \(payment_batch_id, action\) do nothing/);
  assert.match(body, /balance = r\.restore_to/);
  assert.doesNotMatch(body, /balance = balance - /);
});

test("12-12. 承認・振込完了も 明細 + 繰越 − 端数 で検証する", () => {
  const body = stripSql(CARRYOVER_RPC_SQL);
  const matches = body.match(/v_expected_amount := round\(v_\w+ \+ v_carry_in - v_carry_out, 2\)/g) ?? [];
  assert.equal(matches.length, 2, `approve と complete の2箇所: ${matches.length}`);
  /* 振込額が1円単位であることも確かめる */
  assert.match(body, /v_batch\.payment_amount <> floor\(v_batch\.payment_amount\)/);
});

test("12-13. 報酬明細の金額は銭のまま（丸めるのは振込額だけ）", () => {
  /* 明細の計算は小数2桁を保持する */
  assert.match(read("lib/creators/lending-reward-engine.ts"), /roundAgencyAmount\(agencyRevenue \* splitRate\)/);
  /* 繰越の計算は振込額の側にある */
  assert.match(ROUNDING_SRC, /Math\.floor\(grossAmount\)/);
  assert.doesNotMatch(SYNC_SRC, /Math\.floor/);
});

test("12-14. 承認でも最低振込額を確認し、画面は未達と繰越額を出す", () => {
  const body = stripSql(CARRYOVER_RPC_SQL);
  /* creator も共通の 1,000円判定を通る（claim 後に金額が下がった下書き対策） */
  assert.match(body, /if v_batch\.payment_amount < v_minimum_payout then/);
  /* creator は加えて1円未満も拒否 */
  assert.match(body, /if v_batch\.payee_kind = 'creator' and v_batch\.payment_amount < 1 then/);
  /* 画面の表示 */
  assert.match(PAYMENTS_CLIENT_SRC, /最低振込額未達/);
  assert.match(PAYMENTS_CLIENT_SRC, /次回繰越額/);
  assert.match(PAYMENTS_CLIENT_SRC, /row\.shortfallAmount/);
  assert.match(PAYMENTS_CLIENT_SRC, /row\.payableAmount/);
  /* 下限0円時代の「少額警告」は廃止した */
  assert.doesNotMatch(PAYMENTS_CLIENT_SRC, /SMALL_TRANSFER_WARNING_YEN/);
});

test("12-15. 最低振込額・端数繰越ともに確定仕様として明示する", () => {
  assert.match(ROUNDING_SRC, /業務ルールとして確定済み/);
  assert.match(ROUNDING_SRC, /1円未満の端数は本人別の繰越残高として次回へ繰り越す/);
  assert.match(CARRYOVER_SQL, /業務ルールとして確定済み（2026-10-12 承認）/);
  /* 「暫定・未承認」の記述が残っていない */
  assert.doesNotMatch(ROUNDING_SRC, /暫定|未承認/);
  assert.doesNotMatch(CARRYOVER_SQL, /暫定|未承認/);
  assert.match(PAYMENT_QUERIES_SRC, /CARRYOVER_PROVISIONAL_NOTE/);
  assert.match(PAYMENTS_CLIENT_SRC, /overview\.carryoverNote/);
  /* 注記に最低振込額が入る */
  assert.match(ROUNDING_SRC, /最低振込額 \$\{CREATOR_LENDING_PAYOUT_THRESHOLD_YEN/);
});

// ---- M-5 migration 未適用時の表示 -----------------------------------------

test("12-16. テーブル未作成は生の DB エラーを出さず案内にする", () => {
  assert.match(PAYEE_SOURCE_SRC, /LENDING_TABLE_MISSING_MESSAGE/);
  assert.match(PAYEE_SOURCE_SRC, /20261010100000_creator_lending_reward_tables\.sql/);
  /* 一覧の読み取りが未作成を error ではなく tableMissing で返す */
  assert.match(QUERIES_SRC, /isMissingLendingTable\(itemsResult\.error, itemsResult\.errorCode\)/);
  assert.match(QUERIES_SRC, /return \{ \.\.\.empty, tableMissing: true \};/);
  /* 画面が案内を出す */
  assert.match(CLIENT_SRC, /summary\.tableMissing \?/);
  assert.match(CLIENT_SRC, /端末貸し出し報酬のテーブルが未作成です/);
});

// ---- M-6 支払RPC未適用時の操作防止 ---------------------------------------

test("12-17. creator 対応かを DB に聞いてから操作させる", () => {
  /* 判定関数 */
  assert.match(CARRYOVER_RPC_SQL, /create or replace function public\.payment_batch_supports_creator/);
  assert.match(CARRYOVER_RPC_SQL, /payee_creator_id/);
  assert.match(CARRYOVER_RPC_SQL, /creator_lending_carryovers/);
  /* 読み取り側は関数が無ければ false（fail-closed） */
  assert.match(PAYEE_SOURCE_SRC, /let supportsCreatorPayee = false;/);
  assert.match(PAYEE_SOURCE_SRC, /payment_batch_supports_creator/);
  /* 画面はボタンを出さない */
  assert.match(PAYMENTS_CLIENT_SRC, /!overview\.supportsCreatorPayee/);
  assert.match(PAYMENTS_CLIENT_SRC, /支払経路が未対応/);
});

test("12-18. Server Action でも未対応環境の作成を拒否する", () => {
  const actions = read("app/actions/payments.ts");
  const createFn = actions.slice(actions.indexOf("export async function createPaymentBatchAction"));
  assert.match(createFn, /payment_batch_supports_creator/);
  assert.match(createFn, /支払経路がクリエイター本人に未対応です/);
  /* DB 側の fail-closed も残っている（受取種別の検証） */
  assert.match(CARRYOVER_RPC_SQL, /p_payee_kind not in \('agency', 'referrer', 'creator'\)/);
});

test("12-19. 代理店・紹介者の支払経路は変えていない", () => {
  const body = stripSql(CARRYOVER_RPC_SQL);
  /* 既定の振込額は明細の合計（従来の挙動） */
  assert.match(body, /v_pay_amount := v_amount;/);
  /* 繰越は creator の分岐の中だけ */
  const carryBlock = body.slice(
    body.indexOf("if p_payee_kind = 'creator' then"),
    body.indexOf("update public.payment_batches"),
  );
  assert.match(carryBlock, /creator_lending_carryovers/);
  /* 既存2種の占有 SQL は残っている */
  assert.match(body, /update public\.agency_reward_items/);
  assert.match(body, /update public\.referral_reward_items/);
  /* 代理店・紹介者の最低支払額の判定も残っている */
  assert.match(body, /v_minimum_payout/);
});

// ---------------------------------------------------------------------------
// 13. 複数月まとめ払いでも月別の支払予定が一致する（M-3 の続き）
// ---------------------------------------------------------------------------

test("13-1. 支払完了は対象月ごとに支払予定を作る", () => {
  const body = stripSql(CARRYOVER_RPC_SQL);
  const complete = body.slice(body.indexOf("complete_payment_batch"));
  /* creator の分岐だけを見る（代理店・紹介者は締め月の1行で正しい） */
  const start = complete.indexOf("elsif v_batch.payee_kind = 'creator' then");
  assert.ok(start > 0, "creator の分岐がある");
  /*
    紹介者の分岐も月ごとの loop を持つ（既存の実装）。
    creator の分岐より前に end loop が現れるので、start より後から探す。
  */
  const creatorBranch = complete.slice(start, complete.indexOf("end loop;", start) + 9);
  /* 締め月の1行に寄せない */
  assert.doesNotMatch(creatorBranch, /target_month = v_batch\.period_end_month/);
  /* 明細に含まれる対象月を1つずつ回す */
  assert.match(creatorBranch, /for v_month in\s+select distinct target_month/);
  assert.match(creatorBranch, /where payment_batch_id = p_batch_id/);
  /* その月の支払予定へ紐付ける */
  assert.match(creatorBranch, /payout_id = v_payout_id/);
  assert.match(creatorBranch, /and target_month = v_month/);
});

test("13-2. 金額と状態はその月の明細すべてから数え直す（再集計を待たない）", () => {
  const body = stripSql(CARRYOVER_RPC_SQL);
  const complete = body.slice(body.indexOf("complete_payment_batch"));
  assert.match(complete, /count\(\*\) filter \(where is_paid\)/);
  assert.match(complete, /and target_month = v_month/);
  assert.match(complete, /and is_reward_target = true/);
  /* 全部支払済みなら paid、残っていれば unpaid */
  assert.match(complete, /when v_month_count > 0 and v_month_paid_count = v_month_count then 'paid'/);
  assert.match(complete, /is_payable = v_month_unpaid > 0/);
});

test("13-3. 支払済みの履歴を書き換えない", () => {
  const body = stripSql(CARRYOVER_RPC_SQL);
  const complete = body.slice(body.indexOf("complete_payment_batch"));
  /* 支払済みの明細は対象にしない */
  assert.match(complete, /and is_paid = false/);
  /* 既に paid の月の paid_at は上書きしない */
  assert.match(complete, /then coalesce\(paid_at, v_paid_at\)/);
});

test("13-4. 代理店・紹介者の支払予定の作り方は変えていない", () => {
  const body = stripSql(CARRYOVER_RPC_SQL);
  /* 代理店・紹介者は従来どおり締め月の1行 */
  assert.match(body, /from public\.agency_payouts\s+where target_month = v_batch\.period_end_month/);
  assert.match(body, /from public\.referral_payouts\s+where target_month = v_batch\.period_end_month/);
});

// ---------------------------------------------------------------------------
// 14. 同時実行の安全装置（設計上の根拠）
// ---------------------------------------------------------------------------

test("14-1. 繰越残高は行ロックで直列化する", () => {
  const body = stripSql(CARRYOVER_RPC_SQL);
  const claim = body.slice(body.indexOf("claim_payment_batch_items"));
  assert.match(claim, /select balance into v_carry_in[\s\S]{0,200}for update/);
  /* 行が無ければ先に作る（同時実行でも1行に収まる） */
  assert.match(claim, /insert into public\.creator_lending_carryovers[\s\S]{0,200}on conflict \(creator_id\) do nothing/);
});

test("14-2. 明細の占有は4条件で守る（同時 claim で二重占有しない）", () => {
  const body = stripSql(CARRYOVER_RPC_SQL);
  /* claim の creator 分岐の中だけを見る */
  const claimFn = body.slice(
    body.indexOf("claim_payment_batch_items"),
    body.indexOf("approve_one_payment_batch"),
  );
  const start = claimFn.indexOf("update public.creator_lending_reward_items");
  assert.ok(start > 0, "creator の占有がある");
  const occupy = claimFn.slice(start, claimFn.indexOf("returning reward_amount as amount", start));
  assert.match(occupy, /is_reward_target = true/);
  assert.match(occupy, /is_paid = false/);
  assert.match(occupy, /payout_id is null/);
  assert.match(occupy, /payment_batch_id is null/);
});

test("14-3. 支払予定の行も更新前にロックする", () => {
  const body = stripSql(CARRYOVER_RPC_SQL);
  const complete = body.slice(body.indexOf("complete_payment_batch"));
  assert.match(complete, /from public\.creator_lending_payouts[\s\S]{0,200}for update/);
});

test("14-4. 支払明細そのものも行ロックで保護されている", () => {
  const body = stripSql(CARRYOVER_RPC_SQL);
  /* claim 以外の RPC は batch を for update で押さえる */
  const locks = body.match(/from public\.payment_batches where id = p_batch_id for update/g) ?? [];
  assert.ok(locks.length >= 2, `batch の行ロックが ${locks.length} 箇所`);
});

// ---------------------------------------------------------------------------
// 15. 最低振込額 1,000円（2026-10-11 確定）
// ---------------------------------------------------------------------------

test("15-1. claim は「明細 + 繰越」で下限を判定する", () => {
  const body = stripSql(CARRYOVER_RPC_SQL);
  /* 代理店・紹介者は従来どおり明細だけで判定 */
  assert.match(body, /if p_payee_kind <> 'creator' and v_amount < p_min_amount then/);
  /* creator は繰越を足した額で判定 */
  assert.match(body, /v_carry_gross := round\(v_amount \+ v_carry_in, 2\)/);
  assert.match(body, /if v_carry_gross < v_min_amount then/);
});

test("15-2. 未達のときは何も残さない（バッチ・占有・繰越）", () => {
  const body = stripSql(CARRYOVER_RPC_SQL);
  const claim = body.slice(
    body.indexOf("claim_payment_batch_items"),
    body.indexOf("approve_one_payment_batch"),
  );
  /* 判定は繰越残高を更新する前に行う */
  const checkAt = claim.indexOf("if v_carry_gross < v_min_amount then");
  const updateAt = claim.indexOf("update public.creator_lending_carryovers");
  const logAt = claim.indexOf("insert into public.creator_lending_carryover_logs");
  assert.ok(checkAt > 0 && updateAt > checkAt, "下限判定が残高更新より前");
  assert.ok(logAt > checkAt, "下限判定が履歴の記録より前");
  /* 例外で巻き戻ることを明記している */
  assert.match(CARRYOVER_RPC_SQL, /未払いは翌月以降へ繰り越します/);
});

test("15-3. 画面も同じ下限・同じ判定額を使う", () => {
  /* 判定額は未払残高 + 繰越残高 */
  assert.match(PAYMENT_QUERIES_SRC, /minimumAmount: thresholdAmount/);
  assert.match(PAYMENT_QUERIES_SRC, /unpaidAmount: settlement \? settlement\.grossAmount : unpaidAmount/);
  /* 下限は支払系の定数から取る */
  const actions = read("app/actions/payments.ts");
  assert.match(actions, /CREATOR_LENDING_PAYOUT_THRESHOLD_YEN/);
  /* 行には未達の情報を載せる */
  for (const field of ["payableAmount", "belowMinimumTransfer", "shortfallAmount", "carryForwardAmount"]) {
    assert.ok(PAYMENT_QUERIES_SRC.includes(field), field);
  }
});

test("15-4. 未達は below_threshold で保留される（明細は消さない）", () => {
  const reasons = payable.resolvePaymentHoldReasons({
    isInHouse: false,
    bankState: "registered",
    unpaidAmount: 800,
    thresholdAmount: 1000,
    hasUnconfirmedAssignment: false,
    hasUnconfirmedReward: false,
  });
  assert.deepEqual(reasons, ["below_threshold"]);
  /* 保留の説明は「明細を消さず翌月へ繰り越す」 */
  assert.match(payable.PAYMENT_HOLD_REASON_HINT.below_threshold, /明細は消さず/);
});

test("15-5. 1,000円以上なら保留されない", () => {
  const reasons = payable.resolvePaymentHoldReasons({
    isInHouse: false,
    bankState: "registered",
    unpaidAmount: 1000,
    thresholdAmount: 1000,
    hasUnconfirmedAssignment: false,
    hasUnconfirmedReward: false,
  });
  assert.deepEqual(reasons, []);
});

test("15-6. 代理店・紹介者の下限は変えていない", () => {
  assert.equal(minimum.AGENCY_PAYOUT_THRESHOLD_YEN, 1000);
  assert.equal(referralEngineForMinimum.REFERRAL_PAYOUT_THRESHOLD_YEN, 1000);
  /* claim の既存分岐は明細だけで判定する形を維持 */
  const body = stripSql(CARRYOVER_RPC_SQL);
  assert.match(body, /v_amount < p_min_amount/);
  assert.match(body, /未払い累積が支払基準額に達していません/);
});

// ---------------------------------------------------------------------------
// 16. 最低振込額 1,000円の下限保護（2026-10-12）
// ---------------------------------------------------------------------------

test("16-1. 環境変数で 1,000円未満へ下げられない", () => {
  assert.equal(minimum.CREATOR_LENDING_MINIMUM_PAYOUT_FLOOR, 1000);
  /* 下回る指定・不正な値はすべて 1,000円へ */
  for (const bad of ["500", "0", "-1", "999", "999.99", "abc", "", null, undefined, 0, -100, 999.4]) {
    assert.equal(
      minimum.resolveCreatorLendingMinimumPayout(bad),
      1000,
      `入力 ${JSON.stringify(bad)}`,
    );
  }
  /* 引き上げは尊重する */
  assert.equal(minimum.resolveCreatorLendingMinimumPayout("2000"), 2000);
  assert.equal(minimum.resolveCreatorLendingMinimumPayout(1500.4), 1500);
  /* 実際に使う定数も 1,000円以上 */
  assert.ok(minimum.CREATOR_LENDING_PAYOUT_THRESHOLD_YEN >= 1000);
});

test("16-2. 判定の単一ソースでも下限を丸める", () => {
  for (const bad of [0, 500, 999.99, -1]) {
    const s = rounding.resolveCarryoverSettlement({
      itemsAmount: 999.99,
      carryoverIn: 0,
      minimumAmount: bad,
    });
    assert.equal(s.minimumAmount, 1000, `minimumAmount=${bad}`);
    assert.equal(s.payable, false);
    assert.equal(s.belowMinimum, true);
    assert.equal(s.carryForwardAmount, 999.99, "全額を次回へ");
  }
  /* 引き上げはそのまま効く */
  const raised = rounding.resolveCarryoverSettlement({
    itemsAmount: 1500,
    carryoverIn: 0,
    minimumAmount: 2000,
  });
  assert.equal(raised.minimumAmount, 2000);
  assert.equal(raised.payable, false);
});

test("16-3. DB 側（claim RPC）も greatest で下限を守る", () => {
  const body = stripSql(CARRYOVER_RPC_SQL);
  assert.match(body, /v_min_amount := greatest\(coalesce\(p_min_amount, 0\), 1000\)/);
  /* 判定とメッセージは丸めた後の値を使う */
  assert.match(body, /if v_carry_gross < v_min_amount then/);
  assert.doesNotMatch(body, /v_carry_gross < p_min_amount/);
  /* 承認側の下限（1,000円）も維持 */
  assert.match(body, /v_minimum_payout constant numeric := 1000/);
  assert.match(body, /if v_batch\.payment_amount < v_minimum_payout then/);
});

test("16-4. 1,000円ちょうどは支払可能・999.99円は不可（単一ソース）", () => {
  const exact = rounding.resolveCarryoverSettlement({ itemsAmount: 1000, carryoverIn: 0 });
  assert.equal(exact.payable, true);
  assert.equal(exact.transferAmount, 1000);
  assert.equal(exact.carryForwardAmount, 0);

  const below = rounding.resolveCarryoverSettlement({ itemsAmount: 999.99, carryoverIn: 0 });
  assert.equal(below.payable, false);
  assert.equal(below.transferAmount, 0);
  assert.equal(below.carryForwardAmount, 999.99);
  assert.equal(below.shortfallAmount, 0.01);

  /* 1,500.80 → 1,500円振込・0.80円繰越 */
  const over = rounding.resolveCarryoverSettlement({ itemsAmount: 1500.8, carryoverIn: 0 });
  assert.equal(over.transferAmount, 1500);
  assert.equal(over.carryoverOut, 0.8);
  assert.equal(over.carryForwardAmount, 0.8);
});

test("16-5. 代理店・紹介者の下限は引き下げ可能なまま（巻き込んでいない）", () => {
  const src = read("lib/payments/minimum-payout.ts");
  /* 代理店は従来の resolveMinimumPayoutYen のまま */
  assert.match(src, /export const AGENCY_PAYOUT_THRESHOLD_YEN = resolveMinimumPayoutYen\(/);
  /* creator だけ下限付きの関数を使う */
  assert.match(
    src,
    /export const CREATOR_LENDING_PAYOUT_THRESHOLD_YEN = resolveCreatorLendingMinimumPayout\(/,
  );
  /* 代理店側の環境変数名は変えていない */
  assert.match(src, /AGENCY_MINIMUM_PAYOUT/);
});
