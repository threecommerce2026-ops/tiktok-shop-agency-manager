import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";
import { test } from "node:test";

/*
  端末貸し出し（アカウント貸出）報酬のテスト。

  ■ 確定ルール（2026-10-09）
    対象区分   account_management_type = 'account_lending'
    計算基準   AP（affiliate_order_lines.agency_revenue）
    分配       貸し出し先 80% / 自社 20%（初期設定）
    分配率     クリエイターごと・月ごとに上書き可能。未設定は既定 80%
    分配先     既存の agencies マスタ（is_in_house = false）

  ■ ここで必ず守ることを検証する
    ・通常の代理店報酬の計算結果を変えない
    ・紹介者報酬5%とは完全に分離する
    ・未確定の貸し出し先へ自動で支払予定を作らない
    ・対象注文判定・丸め・集計・支払済保護は既存のものを再利用する
*/

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });

const engine = await jiti.import("@/lib/agency/agency-reward-engine.ts");
const types = await jiti.import("@/lib/creators/account-management-type.ts");
const status = await jiti.import("@/lib/revenue/order-line-status.ts");
const assignmentModule = await jiti.import("@/lib/agency/agency-assignment.ts");
const splitRate = await jiti.import("@/lib/agency/lending-split-rate.ts");
const referralEngine = await jiti.import("@/lib/referrals/referral-reward-engine.ts");

const SYNC_SRC = fs.readFileSync(
  path.join(process.cwd(), "lib/agency/sync-agency-rewards.ts"),
  "utf8",
);
const MIGRATION_SRC = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase/migrations/20261009120000_account_lending_reward_kind.sql",
  ),
  "utf8",
);

/* 月別確定済みの外部代理店所属 */
function monthly(agencyId, extra = {}) {
  return {
    creatorId: "c1",
    agencyId,
    agencyName: agencyId,
    agencyIsInHouse: false,
    source: "monthly",
    ...extra,
  };
}

const EXTERNAL = monthly("ag-external");
const LENDING = monthly("ag-lending");
const IN_HOUSE = monthly("ag-three", { agencyIsInHouse: true });
const CURRENT_ONLY = monthly("ag-lending", { source: "current" });
const UNASSIGNED = {
  creatorId: "c1",
  agencyId: null,
  agencyName: null,
  agencyIsInHouse: false,
  source: "none",
};

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

const lending = (over = {}) => ({
  accountManagementType: "account_lending",
  ...over,
});

// ---------------------------------------------------------------------------
// 1. 通常代理店報酬の完全な非回帰
// ---------------------------------------------------------------------------

test("1-1. options を渡さない呼び出しは従来どおり AP を100%", () => {
  const computed = engine.computeAgencyReward(line(), EXTERNAL);
  assert.equal(computed.rewardAmount, 5000);
  assert.equal(computed.rewardKind, "agency");
  assert.equal(computed.lendingSplitRate, null);
});

test("1-2. standard を明示しても結果が変わらない", () => {
  const without = engine.computeAgencyReward(line(), EXTERNAL);
  const withType = engine.computeAgencyReward(line(), EXTERNAL, {
    accountManagementType: "standard",
  });
  assert.deepEqual(withType, without);
});

test("1-3. 区分が未知・空・null でも通常報酬として扱う（既定 standard）", () => {
  for (const value of [null, undefined, "", "   ", "unknown_type"]) {
    const computed = engine.computeAgencyReward(line(), EXTERNAL, {
      accountManagementType: value,
    });
    assert.equal(computed.rewardAmount, 5000, `区分=${String(value)}`);
    assert.equal(computed.rewardKind, "agency");
  }
});

test("1-4. 通常報酬では分配率を渡しても無視される", () => {
  const computed = engine.computeAgencyReward(line(), EXTERNAL, {
    accountManagementType: "standard",
    lendingSplitRate: 0.2,
  });
  assert.equal(computed.rewardAmount, 5000);
  assert.equal(computed.lendingSplitRate, null);
});

test("1-5. 通常報酬は暫定の現在所属（current）でも従来どおり計算する", () => {
  const computed = engine.computeAgencyReward(line(), {
    ...EXTERNAL,
    source: "current",
  });
  assert.equal(computed.rewardAmount, 5000);
  assert.equal(computed.rewardKind, "agency");
});

// ---------------------------------------------------------------------------
// 2. 端末貸し出し AP×80% の正確性
// ---------------------------------------------------------------------------

test("2-1. 既定の分配率は 80%", () => {
  assert.equal(engine.ACCOUNT_LENDING_SPLIT_RATE, 0.8);
});

test("2-2. AP × 80% を貸し出し先へ、残り 20% が自社", () => {
  const computed = engine.computeAgencyReward(line({ agency_revenue: 26028 }), LENDING, lending());
  assert.equal(computed.rewardAmount, 20822.4);
  assert.equal(computed.rewardKind, "account_lending");
  assert.equal(computed.lendingSplitRate, 0.8);
  assert.equal(engine.roundAgencyAmount(26028 - computed.rewardAmount), 5205.6);
});

test("2-3. 本番実データの月別 AP で検算（2026-04〜08）", () => {
  const monthlyAp = [
    ["2026-04", 5325, 4260],
    ["2026-05", 11168, 8934.4],
    ["2026-06", 26028, 20822.4],
    ["2026-07", 22258, 17806.4],
    ["2026-08", 195, 156],
  ];
  const paid = [];
  for (const [month, ap, expected] of monthlyAp) {
    const computed = engine.computeAgencyReward(
      line({ target_month: month, source_row_key: `k-${month}`, agency_revenue: ap }),
      LENDING,
      lending(),
    );
    assert.equal(computed.rewardAmount, expected, month);
    paid.push(computed.rewardAmount);
  }
  assert.equal(engine.sumAgencyAmounts(paid), 51979.2);
  assert.equal(engine.sumAgencyAmounts(monthlyAp.map((row) => row[1])), 64974);
});

test("2-4. 計算基準は AP のみ（AD・AJ を混ぜない）", () => {
  const computed = engine.computeAgencyReward(
    line({ commission_base: 999999, creator_revenue_before_split: 888888, agency_revenue: 1000 }),
    LENDING,
    lending(),
  );
  assert.equal(computed.rewardAmount, 800);
  assert.equal(computed.commissionBase, 999999, "AD は記録だけ");
  assert.equal(computed.creatorRevenueBeforeSplit, 888888, "AJ は記録だけ");
});

test("2-5. TikTok 側の AK は計算に使わない", () => {
  for (const ak of [100, 80, 20, 0]) {
    const computed = engine.computeAgencyReward(
      line({ agency_split_rate: ak, agency_revenue: 1000 }),
      LENDING,
      lending(),
    );
    assert.equal(computed.rewardAmount, 800, `AK=${ak}`);
    assert.equal(computed.agencySplitRate, ak, "AK は記録だけ");
  }
});

test("2-6. 端数は既存の roundAgencyAmount（銭単位）に従う", () => {
  const cases = [
    [1, 0.8],
    [3, 2.4],
    [7, 5.6],
    [0.13, 0.1],
    [0.19, 0.15],
    [195, 156],
  ];
  for (const [ap, expected] of cases) {
    const computed = engine.computeAgencyReward(line({ agency_revenue: ap }), LENDING, lending());
    assert.equal(computed.rewardAmount, expected, `AP=${ap}`);
    assert.equal(computed.rewardAmount, engine.roundAgencyAmount(ap * 0.8));
  }
});

test("2-7. AP が 0・負・null なら報酬を作らない", () => {
  for (const ap of [0, -100, null]) {
    assert.equal(
      engine.computeAgencyReward(line({ agency_revenue: ap }), LENDING, lending()),
      null,
      `AP=${ap}`,
    );
  }
});

test("2-8. 丸めて 0 円になる AP では報酬を作らない", () => {
  const computed = engine.computeAgencyReward(line({ agency_revenue: 0.004 }), LENDING, lending());
  assert.equal(computed, null);
});

// ---------------------------------------------------------------------------
// 3. クリエイターごとの分配先と月別適用期間
// ---------------------------------------------------------------------------

test("3-1. 分配先は対象月の所属代理店（agencies）", () => {
  const computed = engine.computeAgencyReward(line(), LENDING, lending());
  assert.equal(computed.agencyId, "ag-lending");
});

test("3-2. 未確定（暫定の現在所属）の貸し出し先へは支払予定を作らない", () => {
  assert.equal(engine.computeAgencyReward(line(), CURRENT_ONLY, lending()), null);
  assert.equal(assignmentModule.isConfirmedAssignment("current"), false);
  assert.equal(assignmentModule.isConfirmedAssignment("monthly"), true);
});

test("3-3. 所属未設定・自社所属へは支払予定を作らない", () => {
  assert.equal(engine.computeAgencyReward(line(), UNASSIGNED, lending()), null, "未設定");
  assert.equal(engine.computeAgencyReward(line(), IN_HOUSE, lending()), null, "自社");
});

test("3-4. 分配率はクリエイターごと・月ごとに上書きできる", () => {
  for (const [rate, expected] of [[0.7, 700], [0.5, 500], [0.2, 200], [1, 1000]]) {
    const computed = engine.computeAgencyReward(
      line({ agency_revenue: 1000 }),
      LENDING,
      lending({ lendingSplitRate: rate }),
    );
    assert.equal(computed.rewardAmount, expected, `rate=${rate}`);
    assert.equal(computed.lendingSplitRate, rate);
  }
});

test("3-5. 月ごとに異なる分配率を適用できる（適用月が混ざらない）", () => {
  const may = engine.computeAgencyReward(
    line({ target_month: "2026-05", source_row_key: "k5", agency_revenue: 1000 }),
    LENDING,
    lending({ lendingSplitRate: 0.8 }),
  );
  const june = engine.computeAgencyReward(
    line({ target_month: "2026-06", source_row_key: "k6", agency_revenue: 1000 }),
    LENDING,
    lending({ lendingSplitRate: 0.6 }),
  );
  assert.equal(may.rewardAmount, 800);
  assert.equal(june.rewardAmount, 600);
  assert.equal(may.lendingSplitRate, 0.8);
  assert.equal(june.lendingSplitRate, 0.6);
});

test("3-6. 区分が月ごとに変われば、その月の区分で計算する（過去月へ遡及しない）", () => {
  const may = engine.computeAgencyReward(
    line({ target_month: "2026-05", source_row_key: "k5", agency_revenue: 1000 }),
    LENDING,
    { accountManagementType: "standard" },
  );
  const june = engine.computeAgencyReward(
    line({ target_month: "2026-06", source_row_key: "k6", agency_revenue: 1000 }),
    LENDING,
    lending(),
  );
  assert.equal(may.rewardAmount, 1000, "2026-05 は通常なので100%");
  assert.equal(june.rewardAmount, 800, "2026-06 は貸出なので80%");
});

test("3-7. 未設定の分配率は既定 80%（既定値を2か所に持たない）", () => {
  assert.equal(engine.resolveLendingSplitRate(null), 0.8);
  assert.equal(engine.resolveLendingSplitRate(undefined), 0.8);
  assert.equal(engine.resolveLendingSplitRate(""), 0.8);
  const computed = engine.computeAgencyReward(
    line({ agency_revenue: 1000 }),
    LENDING,
    lending({ lendingSplitRate: null }),
  );
  assert.equal(computed.rewardAmount, 800);
});

test("3-8. 不正な分配率は既定値へ丸めず報酬を作らない（fail-closed）", () => {
  for (const bad of [0, -0.2, 1.2, 80, 100, "abc", NaN, Infinity]) {
    assert.equal(engine.resolveLendingSplitRate(bad), null, `rate=${String(bad)}`);
    assert.equal(
      engine.computeAgencyReward(line(), LENDING, lending({ lendingSplitRate: bad })),
      null,
      `rate=${String(bad)} で報酬を作らない`,
    );
  }
});

test("3-9. 分配率の索引は creator_id|target_month で引く", () => {
  assert.equal(splitRate.lendingSplitRateKey("c1", "2026-06"), "c1|2026-06");
  assert.notEqual(
    splitRate.lendingSplitRateKey("c1", "2026-06"),
    splitRate.lendingSplitRateKey("c1", "2026-07"),
  );
});

// ---------------------------------------------------------------------------
// 4. 二重計上・二重sync防止
// ---------------------------------------------------------------------------

test("4-1. 一意キーは source_row_key（同じ注文行から2種類の報酬は作れない）", () => {
  const l = line({ agency_revenue: 1000 });
  const asAgency = engine.computeAgencyReward(l, EXTERNAL, { accountManagementType: "standard" });
  const asLending = engine.computeAgencyReward(l, LENDING, lending());
  assert.equal(asAgency.sourceRowKey, asLending.sourceRowKey);
  assert.match(SYNC_SRC, /onConflict:\s*"source_row_key"/);
});

test("4-2. 再実行しても同じ金額（冪等）", () => {
  const l = line({ agency_revenue: 26028 });
  const amounts = Array.from(
    { length: 20 },
    () => engine.computeAgencyReward(l, LENDING, lending()).rewardAmount,
  );
  assert.equal(new Set(amounts).size, 1);
  assert.equal(amounts[0], 20822.4);
});

test("4-3. 紹介者報酬5%とは完全に分離（account_lending は従来どおり5%対象外）", () => {
  assert.equal(types.isReferralRewardEligibleType("account_lending"), false);
  assert.equal(types.isReferralRewardEligibleType("self_operated"), false);
  assert.equal(types.isReferralRewardEligibleType("standard"), true);
  assert.equal(
    referralEngine.isReferralTargetCreator({
      creatorId: "c1",
      referrerId: "r1",
      accountManagementType: "account_lending",
    }),
    false,
  );
});

test("4-4. 端末貸し出しは AP が元なので、紹介料の算定基礎（TAP の W+X）と混ざらない", () => {
  const computed = engine.computeAgencyReward(line({ agency_revenue: 1000 }), LENDING, lending());
  assert.equal(computed.rewardAmount, 800);
  // AP だけを見ており TAP 由来の列は参照しない
  assert.doesNotMatch(
    fs.readFileSync(path.join(process.cwd(), "lib/agency/agency-reward-engine.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""),
    /partner_estimated_commission|tap_revenue/,
  );
});

test("4-5. 報酬の種類は2つだけ（勝手な値を作らない）", () => {
  assert.deepEqual([...engine.AGENCY_REWARD_KINDS], ["agency", "account_lending"]);
  assert.match(MIGRATION_SRC, /check \(reward_kind in \('agency', 'account_lending'\)\)/);
});

// ---------------------------------------------------------------------------
// 5. 返品・キャンセル・未払い除外
// ---------------------------------------------------------------------------

test("5-1. 既存の対象判定をそのまま使う（返品・未払い・キャンセル）", () => {
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
    assert.equal(engine.computeAgencyReward(l, LENDING, lending()), null, `${name}（貸出）`);
    assert.equal(
      engine.computeAgencyReward(l, EXTERNAL, { accountManagementType: "standard" }),
      null,
      `${name}（通常）`,
    );
  }
});

test("5-2. 支払い済みかつ返金なしなら対象（order_status 未設定でも既存仕様どおり）", () => {
  const l = line({ order_status: null });
  assert.equal(status.isAgencyPayoutEligibleOrderLine(l), true);
  assert.equal(engine.computeAgencyReward(l, LENDING, lending()).rewardAmount, 4000);
});

test("5-3. self_operated は通常も貸出も報酬を作らない", () => {
  assert.equal(
    engine.computeAgencyReward(line(), EXTERNAL, { accountManagementType: "self_operated" }),
    null,
  );
  assert.equal(
    engine.computeAgencyReward(line(), LENDING, { accountManagementType: "self_operated" }),
    null,
  );
});

// ---------------------------------------------------------------------------
// 6. 支払済・承認済バッチの保護
// ---------------------------------------------------------------------------

test("6-1. 支払済・支払予定中の明細は再集計で触らない（既存の保護を維持）", () => {
  assert.match(SYNC_SRC, /item\.is_paid \|\| item\.payout_id != null \|\| item\.payment_batch_id != null/);
  assert.match(SYNC_SRC, /if \(paidSourceKeys\.has\(sourceRowKey\)\) continue;/);
});

test("6-2. 削除でも支払済・バッチ占有を除外する", () => {
  assert.match(SYNC_SRC, /is_paid/);
  assert.match(SYNC_SRC, /payment_batch_id/);
  assert.doesNotMatch(SYNC_SRC, /delete\(\)[\s\S]{0,200}eq\("is_paid", true\)/);
});

test("6-3. 支払判定は既存の resolveAgencyAnnualState（下限なし）", () => {
  const state = engine.resolveAgencyAnnualState({ annualRewardAmount: 51979.2, paidAmount: 0 });
  assert.equal(state.thresholdAmount, 0);
  assert.equal(state.unpaidAmount, 51979.2);
  assert.equal(state.isPayable, true);

  const partial = engine.resolveAgencyAnnualState({
    annualRewardAmount: 51979.2,
    paidAmount: 20000,
  });
  assert.equal(partial.unpaidAmount, 31979.2, "支払済を差し引く（二重払い防止）");
});

test("6-4. 支払経路は payee_kind='agency' を再利用し、新しい種類を作らない", () => {
  // コメントでは経路に触れてよいが、実行される SQL が支払系に触ってはいけない
  const body = MIGRATION_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
  assert.doesNotMatch(body, /payee_kind/);
  assert.doesNotMatch(body, /payment_batches/);
  assert.doesNotMatch(body, /payment_batches_payee_kind_check/);
});

// ---------------------------------------------------------------------------
// 7. 分配率変更時の過去月への影響
// ---------------------------------------------------------------------------

test("7-1. 明細に適用率を残すので、既定値を変えても過去の根拠が辿れる", () => {
  const computed = engine.computeAgencyReward(line({ agency_revenue: 1000 }), LENDING, lending({ lendingSplitRate: 0.8 }));
  assert.equal(computed.lendingSplitRate, 0.8);
  assert.match(MIGRATION_SRC, /lending_split_rate numeric/);
});

test("7-2. 支払済・バッチ占有済みの月は分配率を変えても再計算されない", () => {
  // paidSourceKeys に入った明細は computeAgencyReward に到達しない
  assert.match(SYNC_SRC, /if \(paidSourceKeys\.has\(sourceRowKey\)\) continue;/);
  const skipIndex = SYNC_SRC.indexOf("if (paidSourceKeys.has(sourceRowKey)) continue;");
  const computeIndex = SYNC_SRC.indexOf("computeAgencyReward(line, assignment, {");
  assert.ok(skipIndex > 0 && computeIndex > skipIndex, "保護が計算より前にある");
});

test("7-3. 未払の月は新しい分配率で再計算される", () => {
  const before = engine.computeAgencyReward(line({ agency_revenue: 1000 }), LENDING, lending({ lendingSplitRate: 0.8 }));
  const after = engine.computeAgencyReward(line({ agency_revenue: 1000 }), LENDING, lending({ lendingSplitRate: 0.6 }));
  assert.equal(before.rewardAmount, 800);
  assert.equal(after.rewardAmount, 600);
  assert.equal(before.sourceRowKey, after.sourceRowKey, "同じ明細が上書きされる");
});

// ---------------------------------------------------------------------------
// 8. migration 適用前後の互換性
// ---------------------------------------------------------------------------

test("8-1. migration は列の追加だけで DML を含まない", () => {
  const body = MIGRATION_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
  assert.doesNotMatch(body, /\binsert\s+into\b/i);
  assert.doesNotMatch(body, /\bupdate\s+public\./i);
  assert.doesNotMatch(body, /\bdelete\s+from\b/i);
  assert.doesNotMatch(body, /\btruncate\b/i);
  assert.doesNotMatch(body, /\bdrop\s+(table|column|constraint)\b/i);
});

test("8-2. 既存行は reward_kind='agency' / lending_split_rate=null になる", () => {
  assert.match(MIGRATION_SRC, /reward_kind text not null default 'agency'/);
  assert.match(MIGRATION_SRC, /add column if not exists lending_split_rate numeric/);
});

test("8-3. 列が無い環境では端末貸し出しの保存を中止する（fail-closed）", () => {
  assert.match(SYNC_SRC, /if \(!schema\.hasRewardKind\)/);
  assert.match(SYNC_SRC, /端末貸し出し報酬を保存できません/);
  assert.match(SYNC_SRC, /lendingLineCount > 0/);
});

test("8-4. 列が無くても端末貸し出しが0件なら通常の同期は続く", () => {
  const block = SYNC_SRC.slice(SYNC_SRC.indexOf("if (!schema.hasRewardKind)"));
  assert.match(block, /delete row\.reward_kind;/);
  assert.match(block, /delete row\.lending_split_rate;/);
});

test("8-5. 列の有無が判定できない場合は先へ進めない", () => {
  assert.match(SYNC_SRC, /if \(schema\.error\)/);
  assert.match(SYNC_SRC, /return \{ hasRewardKind: false, error: error\.message \};/);
});

test("8-6. 分配率の列が無い環境は「個別設定なし」として既定率で動く", () => {
  assert.equal(splitRate.isLendingSplitRateColumnMissing("column lending_split_rate does not exist"), true);
  assert.equal(splitRate.isLendingSplitRateColumnMissing("42703"), true);
  assert.equal(splitRate.isLendingSplitRateColumnMissing("could not find the column"), true);
  assert.equal(splitRate.isLendingSplitRateColumnMissing("permission denied"), false);
});

test("8-7. 範囲外の分配率は DB 側でも保存できない", () => {
  assert.match(MIGRATION_SRC, /lending_split_rate > 0 and lending_split_rate <= 1/);
});

test("8-8. 種類と分配率の整合を DB 側でも守る", () => {
  assert.match(MIGRATION_SRC, /reward_kind = 'account_lending' and lending_split_rate is not null/);
  assert.match(MIGRATION_SRC, /reward_kind <> 'account_lending' and lending_split_rate is null/);
});

// ---------------------------------------------------------------------------
// 9. 月次集計と内訳
// ---------------------------------------------------------------------------

test("9-1. 月次集計は既存の sumAgencyAmounts を使う", () => {
  const amounts = [4260, 8934.4, 20822.4, 17806.4, 156];
  assert.equal(engine.sumAgencyAmounts(amounts), 51979.2);
});

test("9-2. sync の結果に端末貸し出しの内訳が入る", () => {
  assert.match(SYNC_SRC, /lendingLineCount: number;/);
  assert.match(SYNC_SRC, /lendingRewardAmount: number;/);
  assert.match(SYNC_SRC, /lendingRewardAmount: sumAgencyAmounts\(lendingAmounts\)/);
});

test("9-3. 区分の判定は月別確定を優先する単一ソースに委ねている", () => {
  assert.match(SYNC_SRC, /resolveMonthlyAccountManagementType\(\{/);
  assert.match(SYNC_SRC, /monthlyType: monthlyTypesResult\.index\.get\(/);
  assert.doesNotMatch(SYNC_SRC, /account_management_type === "account_lending"/);
});

test("9-4. 新しい報酬エンジンを作っていない（既存エンジンを拡張しただけ）", () => {
  assert.ok(typeof engine.computeAgencyReward === "function");
  assert.equal(
    fs.existsSync(path.join(process.cwd(), "lib/agency/account-lending-reward-engine.ts")),
    false,
    "別エンジンのファイルを作らない",
  );
  assert.match(SYNC_SRC, /computeAgencyReward\(line, assignment, \{/);
});

// ---------------------------------------------------------------------------
// 10. DB側ガード（20261009130000）
// ---------------------------------------------------------------------------

const GUARD_SRC = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase/migrations/20261009130000_account_lending_reward_guard.sql",
  ),
  "utf8",
);

const GUARD_BODY = GUARD_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

test("10-1. ガードは DML を含まない（既存データを書き換えない）", () => {
  assert.doesNotMatch(GUARD_BODY, /\binsert\s+into\b/i);
  assert.doesNotMatch(GUARD_BODY, /\bupdate\s+public\./i);
  assert.doesNotMatch(GUARD_BODY, /\bdelete\s+from\b/i);
  assert.doesNotMatch(GUARD_BODY, /\btruncate\b/i);
  assert.doesNotMatch(GUARD_BODY, /\balter\s+table\b/i);
});

test("10-2. SECURITY DEFINER かつ search_path を固定している", () => {
  assert.match(GUARD_BODY, /security definer/i);
  assert.match(GUARD_BODY, /set search_path to 'public'/i);
});

test("10-3. BEFORE INSERT OR UPDATE の行トリガ（DELETE は対象外）", () => {
  assert.match(GUARD_BODY, /before insert or update on public\.agency_reward_items/i);
  assert.match(GUARD_BODY, /for each row/i);
  assert.doesNotMatch(GUARD_BODY, /before\s+delete|or\s+delete\s+on/i);
});

test("10-4. 金額・種類・分配率・分配先が動かない更新は検査しない（支払処理を壊さない）", () => {
  const early = GUARD_BODY.slice(
    GUARD_BODY.indexOf("if tg_op = 'UPDATE'"),
    GUARD_BODY.indexOf("select m.account_management_type"),
  );
  for (const col of ["reward_amount", "reward_kind", "lending_split_rate", "agency_id"]) {
    assert.match(early, new RegExp(`old\\.${col}\\s+is not distinct from new\\.${col}`), col);
  }
  assert.match(early, /return new;/);
});

test("10-5. 対象月の確定区分が account_lending のときだけ検査する", () => {
  assert.match(GUARD_BODY, /from public\.creator_monthly_account_management_types/);
  assert.match(GUARD_BODY, /v_monthly_type is distinct from 'account_lending'/);
});

test("10-6. 種類が account_lending でなければ拒否（AP100% を止める）", () => {
  assert.match(GUARD_BODY, /coalesce\(new\.reward_kind, 'agency'\) <> 'account_lending'/);
  assert.match(GUARD_SRC, /通常の代理店報酬として保存できません/);
});

test("10-7. 分配率の存在と範囲を検査する", () => {
  assert.match(GUARD_BODY, /new\.lending_split_rate is null/);
  assert.match(GUARD_BODY, /new\.lending_split_rate <= 0 or new\.lending_split_rate > 1/);
});

test("10-8. 分配先が対象月の確定所属と一致することを検査する", () => {
  assert.match(GUARD_BODY, /from public\.creator_monthly_agency_assignments/);
  assert.match(GUARD_BODY, /v_monthly_agency is null or v_monthly_agency <> new\.agency_id/);
  assert.match(GUARD_SRC, /所属が月別確定されていないため/);
});

test("10-9. 金額が AP × 分配率と一致することを検査する", () => {
  assert.match(GUARD_BODY, /from public\.affiliate_order_lines/);
  assert.match(GUARD_BODY, /round\(v_ap \* new\.lending_split_rate, 2\)/);
  assert.match(GUARD_BODY, /abs\(new\.reward_amount - v_expected\) > 0\.01/);
});

test("10-10. 元の注文明細が引けない場合も拒否する（金額の根拠なしで保存させない）", () => {
  assert.match(GUARD_BODY, /if v_ap is null then/);
  assert.match(GUARD_SRC, /元の注文明細が見つからないため/);
  // 「引けないときは検査を飛ばす」形になっていないこと
  assert.doesNotMatch(GUARD_BODY, /if v_ap is not null then/);
});

test("10-11. エラーコードは 22023（不正な引数）で統一している", () => {
  const raises = GUARD_BODY.match(/raise exception[\s\S]*?using errcode = '[0-9A-Z]+'/g) ?? [];
  assert.ok(raises.length >= 5, `raise が ${raises.length} 件`);
  for (const raise of raises) {
    assert.match(raise, /using errcode = '22023'/);
  }
});

test("10-12. 列 migration（20261009120000）より後の連番である", () => {
  const dir = path.join(process.cwd(), "supabase/migrations");
  const files = fs.readdirSync(dir).filter((name) => name.includes("account_lending"));
  assert.deepEqual(files.sort(), [
    "20261009120000_account_lending_reward_kind.sql",
    "20261009130000_account_lending_reward_guard.sql",
  ]);
});

test("10-13. 支払経路（payment_batches / payee_kind / 支払RPC）に触らない", () => {
  assert.doesNotMatch(GUARD_BODY, /payment_batches/);
  assert.doesNotMatch(GUARD_BODY, /payee_kind/);
  assert.doesNotMatch(GUARD_BODY, /claim_payment_batch_items|complete_payment_batch|approve_one_payment_batch/);
});

test("10-14. 紹介報酬のテーブルに触らない（完全に分離）", () => {
  assert.doesNotMatch(GUARD_BODY, /referral_reward_items|referral_payouts|referrers/);
});
