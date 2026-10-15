import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";
import { test } from "node:test";

/*
  端末貸し出し（アカウント貸出）報酬を「代理店報酬として作らない」ことのテスト。

  ■ 最終確定ルール（2026-10-10）
    対象     所属が自社（THREE.inc）／AK 100%／区分が account_lending
    受取人   クリエイター本人（代理店ではない）
    本人     AP × 分配率（既定 80%）
    自社     AP − 本人報酬
    紹介料5% 対象外

  受取人が本人に確定したため、以前の「貸し出し先の代理店へ AP × 80%」は
  取りやめた。agency_reward_items.agency_id は支払先なので、
  本人への支払いを表現できない（本人を代理店マスタへ架空登録しない）。

  ■ このファイルで検証すること
    ・通常の代理店報酬が一切変わっていない（完全な非回帰）
    ・区分が account_lending では代理店報酬の明細を作らない（fail-closed）
    ・紹介者報酬5%と完全に分離されている
    ・列 migration（20261009120000）と旧ガード（20261009130000）の内容
    ・新ガード（20261010110000）が agency_reward_items への誤投入を止める

  本人ぶんの金額計算（AP × 80% の正確性・丸め・冪等性）は
  scripts/test-creator-lending-reward.mjs が検証する。
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

test("1-6. 通常報酬の金額は AP そのまま（AK を掛けない）", () => {
  for (const ak of [100, 80, 20, 0]) {
    const computed = engine.computeAgencyReward(
      line({ agency_split_rate: ak, agency_revenue: 1000 }),
      EXTERNAL,
    );
    assert.equal(computed.rewardAmount, 1000, `AK=${ak}`);
    assert.equal(computed.agencySplitRate, ak, "AK は記録だけ");
  }
});

// ---------------------------------------------------------------------------
// 2. account_lending では代理店報酬を作らない（受取人は本人）
// ---------------------------------------------------------------------------

test("2-1. 区分が account_lending なら代理店報酬の明細を作らない", () => {
  assert.equal(engine.computeAgencyReward(line(), LENDING, lending()), null);
});

test("2-2. 所属・分配率・AK・AP がどうであっても作らない（fail-closed）", () => {
  const assignments = [
    ["外部代理店（月別確定）", LENDING],
    ["外部代理店（暫定）", CURRENT_ONLY],
    ["自社所属", IN_HOUSE],
    ["所属未設定", UNASSIGNED],
  ];
  for (const [name, assignment] of assignments) {
    for (const rate of [null, 0.8, 0.6, 1]) {
      for (const ak of [100, 80, 0]) {
        assert.equal(
          engine.computeAgencyReward(
            line({ agency_split_rate: ak, agency_revenue: 26028 }),
            assignment,
            lending({ lendingSplitRate: rate }),
          ),
          null,
          `${name} / rate=${String(rate)} / AK=${ak}`,
        );
      }
    }
  }
});

test("2-3. 本番実データの月別 AP でも代理店報酬は1件も作られない", () => {
  const monthlyAp = [
    ["2026-04", 5325],
    ["2026-05", 11168],
    ["2026-06", 26028],
    ["2026-07", 22258],
    ["2026-08", 195],
  ];
  for (const [month, ap] of monthlyAp) {
    assert.equal(
      engine.computeAgencyReward(
        line({ target_month: month, source_row_key: `k-${month}`, agency_revenue: ap }),
        LENDING,
        lending(),
      ),
      null,
      month,
    );
  }
  /* 合計 AP は本番 READ ONLY で確認した基準値 */
  assert.equal(engine.sumAgencyAmounts(monthlyAp.map((row) => row[1])), 64974);
});

test("2-4. 同じ注文行でも、区分が standard のときだけ代理店報酬ができる", () => {
  const l = line({ agency_revenue: 1000 });
  const asAgency = engine.computeAgencyReward(l, EXTERNAL, {
    accountManagementType: "standard",
  });
  const asLending = engine.computeAgencyReward(l, LENDING, lending());
  assert.equal(asAgency.rewardAmount, 1000);
  assert.equal(asLending, null, "同じ注文行から2種類の報酬は作れない");
  assert.match(SYNC_SRC, /onConflict:\s*"source_row_key"/);
});

test("2-5. 報酬の種類は agency のみを返す（account_lending を返さない）", () => {
  for (const assignment of [EXTERNAL, LENDING, IN_HOUSE]) {
    const computed = engine.computeAgencyReward(line(), assignment, {
      accountManagementType: "standard",
    });
    if (computed == null) continue;
    assert.equal(computed.rewardKind, "agency");
    assert.equal(computed.lendingSplitRate, null);
  }
});

test("2-6. self_operated も従来どおり報酬を作らない", () => {
  assert.equal(
    engine.computeAgencyReward(line(), EXTERNAL, {
      accountManagementType: "self_operated",
    }),
    null,
  );
});

test("2-7. 本人受取のエンジンが別に存在する（代理店エンジンは本人を扱わない）", () => {
  const lendingEnginePath = path.join(
    process.cwd(),
    "lib/creators/lending-reward-engine.ts",
  );
  assert.equal(fs.existsSync(lendingEnginePath), true);

  const AGENCY_SRC = fs
    .readFileSync(path.join(process.cwd(), "lib/agency/agency-reward-engine.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  /* 代理店エンジンは本人受取のテーブルに触らない */
  assert.doesNotMatch(AGENCY_SRC, /creator_lending_reward_items/);
  /* AP × 分配率の掛け算も残っていない */
  assert.doesNotMatch(AGENCY_SRC, /apAmount \* rate/);
});

// ---------------------------------------------------------------------------
// 3. 分配率の部品は残すが、代理店報酬には影響しない
// ---------------------------------------------------------------------------

test("3-1. 既定の分配率の定義は 80% のまま（本人受取でも同じ値）", () => {
  assert.equal(engine.ACCOUNT_LENDING_SPLIT_RATE, 0.8);
});

test("3-2. 不正な分配率は既定値へ丸めない（既定値を2か所に持たない）", () => {
  assert.equal(engine.resolveLendingSplitRate(null), 0.8);
  assert.equal(engine.resolveLendingSplitRate(undefined), 0.8);
  assert.equal(engine.resolveLendingSplitRate(""), 0.8);
  for (const bad of [0, -0.2, 1.2, 80, 100, "abc", NaN, Infinity]) {
    assert.equal(engine.resolveLendingSplitRate(bad), null, `rate=${String(bad)}`);
  }
});

test("3-3. 分配率の索引は creator_id|target_month で引く", () => {
  assert.equal(splitRate.lendingSplitRateKey("c1", "2026-06"), "c1|2026-06");
  assert.notEqual(
    splitRate.lendingSplitRateKey("c1", "2026-06"),
    splitRate.lendingSplitRateKey("c1", "2026-07"),
  );
});

test("3-4. 月別確定の判定は従来どおり（通常報酬の挙動を変えない）", () => {
  assert.equal(assignmentModule.isConfirmedAssignment("current"), false);
  assert.equal(assignmentModule.isConfirmedAssignment("monthly"), true);
});

// ---------------------------------------------------------------------------
// 4. 紹介者報酬5%との分離
// ---------------------------------------------------------------------------

test("4-1. account_lending は従来どおり紹介料5%の対象外", () => {
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

test("4-2. 代理店報酬は AP が元で、紹介料の算定基礎（TAP の W+X）と混ざらない", () => {
  const computed = engine.computeAgencyReward(line({ agency_revenue: 1000 }), EXTERNAL);
  assert.equal(computed.rewardAmount, 1000);
  assert.doesNotMatch(
    fs
      .readFileSync(path.join(process.cwd(), "lib/agency/agency-reward-engine.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, ""),
    /partner_estimated_commission|tap_revenue/,
  );
});

// ---------------------------------------------------------------------------
// 5. 返品・キャンセル・未払い除外（通常報酬の非回帰）
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
    assert.equal(
      engine.computeAgencyReward(l, EXTERNAL, { accountManagementType: "standard" }),
      null,
      `${name}（通常）`,
    );
    assert.equal(
      engine.computeAgencyReward(l, LENDING, lending()),
      null,
      `${name}（貸出）`,
    );
  }
});

test("5-2. 支払い済みかつ返金なしなら通常報酬の対象（order_status 未設定でも同じ）", () => {
  const l = line({ order_status: null });
  assert.equal(status.isAgencyPayoutEligibleOrderLine(l), true);
  assert.equal(engine.computeAgencyReward(l, EXTERNAL).rewardAmount, 5000);
});

// ---------------------------------------------------------------------------
// 6. 支払済・承認済バッチの保護（既存の保護を維持）
// ---------------------------------------------------------------------------

test("6-1. 支払済・支払予定中の明細は再集計で触らない", () => {
  assert.match(
    SYNC_SRC,
    /item\.is_paid \|\| item\.payout_id != null \|\| item\.payment_batch_id != null/,
  );
  assert.match(SYNC_SRC, /if \(paidSourceKeys\.has\(sourceRowKey\)\) continue;/);
});

test("6-2. 削除でも支払済・バッチ占有を除外する", () => {
  assert.match(SYNC_SRC, /is_paid/);
  assert.match(SYNC_SRC, /payment_batch_id/);
  assert.doesNotMatch(SYNC_SRC, /delete\(\)[\s\S]{0,200}eq\("is_paid", true\)/);
});

test("6-3. 支払判定は既存の resolveAgencyAnnualState（下限なし）", () => {
  const state = engine.resolveAgencyAnnualState({
    annualRewardAmount: 51979.2,
    paidAmount: 0,
  });
  assert.equal(state.thresholdAmount, 0);
  assert.equal(state.unpaidAmount, 51979.2);
  assert.equal(state.isPayable, true);

  const partial = engine.resolveAgencyAnnualState({
    annualRewardAmount: 51979.2,
    paidAmount: 20000,
  });
  assert.equal(partial.unpaidAmount, 31979.2, "支払済を差し引く（二重払い防止）");
});

test("6-4. 列 migration は支払経路（payment_batches / payee_kind）に触らない", () => {
  const body = MIGRATION_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
  assert.doesNotMatch(body, /payee_kind/);
  assert.doesNotMatch(body, /payment_batches/);
});

// ---------------------------------------------------------------------------
// 7. 区分の解決（単一ソース）
// ---------------------------------------------------------------------------

test("7-1. 区分の判定は月別確定を優先する単一ソースに委ねている", () => {
  assert.match(SYNC_SRC, /resolveMonthlyAccountManagementType\(\{/);
  assert.match(SYNC_SRC, /monthlyType: monthlyTypesResult\.index\.get\(/);
  assert.doesNotMatch(SYNC_SRC, /account_management_type === "account_lending"/);
});

test("7-2. 新しい代理店報酬エンジンを作っていない", () => {
  assert.ok(typeof engine.computeAgencyReward === "function");
  assert.equal(
    fs.existsSync(path.join(process.cwd(), "lib/agency/account-lending-reward-engine.ts")),
    false,
    "別エンジンのファイルを作らない",
  );
  assert.match(SYNC_SRC, /computeAgencyReward\(line, assignment, \{/);
});

// ---------------------------------------------------------------------------
// 8. 列 migration（20261009120000）の内容
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

test("8-3. 列が無い環境でも通常の同期は続く（列を落として保存する）", () => {
  const block = SYNC_SRC.slice(SYNC_SRC.indexOf("if (!schema.hasRewardKind)"));
  assert.match(block, /delete row\.reward_kind;/);
  assert.match(block, /delete row\.lending_split_rate;/);
});

test("8-4. 列の有無が判定できない場合は先へ進めない", () => {
  assert.match(SYNC_SRC, /if \(schema\.error\)/);
  assert.match(SYNC_SRC, /return \{ hasRewardKind: false, error: error\.message \};/);
});

test("8-5. 分配率の列が無い環境は「個別設定なし」として扱う", () => {
  assert.equal(
    splitRate.isLendingSplitRateColumnMissing("column lending_split_rate does not exist"),
    true,
  );
  assert.equal(splitRate.isLendingSplitRateColumnMissing("42703"), true);
  assert.equal(splitRate.isLendingSplitRateColumnMissing("could not find the column"), true);
  assert.equal(splitRate.isLendingSplitRateColumnMissing("permission denied"), false);
});

test("8-6. 範囲外の分配率は DB 側でも保存できない", () => {
  assert.match(MIGRATION_SRC, /lending_split_rate > 0 and lending_split_rate <= 1/);
});

test("8-7. 種類と分配率の整合を DB 側でも守る", () => {
  assert.match(MIGRATION_SRC, /reward_kind = 'account_lending' and lending_split_rate is not null/);
  assert.match(MIGRATION_SRC, /reward_kind <> 'account_lending' and lending_split_rate is null/);
});

// ---------------------------------------------------------------------------
// 9. 旧ガード（20261009130000・適用済み）の内容
// ---------------------------------------------------------------------------
/*
  このファイルは改変していない。本番に適用済みで、
  「account_lending の明細は AP × 分配率でなければ保存させない」
  という検査を持つ。

  受取人が本人に確定したため、20261010110000 で同じ関数名のまま
  「agency_reward_items に account_lending を入れさせない」検知へ
  差し替える（トリガ名は維持）。差し替え後の内容は section 10 で検証する。
*/

const GUARD_SRC = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase/migrations/20261009130000_account_lending_reward_guard.sql",
  ),
  "utf8",
);

const GUARD_BODY = GUARD_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

test("9-1. 旧ガードは DML を含まない（既存データを書き換えない）", () => {
  assert.doesNotMatch(GUARD_BODY, /\binsert\s+into\b/i);
  assert.doesNotMatch(GUARD_BODY, /\bupdate\s+public\./i);
  assert.doesNotMatch(GUARD_BODY, /\bdelete\s+from\b/i);
  assert.doesNotMatch(GUARD_BODY, /\btruncate\b/i);
  assert.doesNotMatch(GUARD_BODY, /\balter\s+table\b/i);
});

test("9-2. SECURITY DEFINER かつ search_path を固定している", () => {
  assert.match(GUARD_BODY, /security definer/i);
  assert.match(GUARD_BODY, /set search_path to 'public'/i);
});

test("9-3. BEFORE INSERT OR UPDATE の行トリガ（DELETE は対象外）", () => {
  assert.match(GUARD_BODY, /before insert or update on public\.agency_reward_items/i);
  assert.match(GUARD_BODY, /for each row/i);
  assert.doesNotMatch(GUARD_BODY, /before\s+delete|or\s+delete\s+on/i);
});

test("9-4. 金額・種類・分配率・分配先が動かない更新は検査しない（支払処理を壊さない）", () => {
  const early = GUARD_BODY.slice(
    GUARD_BODY.indexOf("if tg_op = 'UPDATE'"),
    GUARD_BODY.indexOf("select m.account_management_type"),
  );
  for (const col of ["reward_amount", "reward_kind", "lending_split_rate", "agency_id"]) {
    assert.match(early, new RegExp(`old\\.${col}\\s+is not distinct from new\\.${col}`), col);
  }
  assert.match(early, /return new;/);
});

test("9-5. 旧ガードは金額が AP × 分配率と一致することを検査していた", () => {
  assert.match(GUARD_BODY, /from public\.affiliate_order_lines/);
  assert.match(GUARD_BODY, /round\(v_ap \* new\.lending_split_rate, 2\)/);
  assert.match(GUARD_BODY, /abs\(new\.reward_amount - v_expected\) > 0\.01/);
});

test("9-6. 元の注文明細が引けない場合も拒否する（金額の根拠なしで保存させない）", () => {
  assert.match(GUARD_BODY, /if v_ap is null then/);
  assert.match(GUARD_SRC, /元の注文明細が見つからないため/);
  assert.doesNotMatch(GUARD_BODY, /if v_ap is not null then/);
});

test("9-7. エラーコードは 22023（不正な引数）で統一している", () => {
  const raises = GUARD_BODY.match(/raise exception[\s\S]*?using errcode = '[0-9A-Z]+'/g) ?? [];
  assert.ok(raises.length >= 5, `raise が ${raises.length} 件`);
  for (const raise of raises) {
    assert.match(raise, /using errcode = '22023'/);
  }
});

test("9-8. 旧ガードは支払経路・紹介報酬に触らない", () => {
  assert.doesNotMatch(GUARD_BODY, /payment_batches/);
  assert.doesNotMatch(GUARD_BODY, /payee_kind/);
  assert.doesNotMatch(
    GUARD_BODY,
    /claim_payment_batch_items|complete_payment_batch|approve_one_payment_batch/,
  );
  assert.doesNotMatch(GUARD_BODY, /referral_reward_items|referral_payouts|referrers/);
});

test("9-9. account_lending の migration は3本（列 → 旧ガード → ガード強化）", () => {
  const dir = path.join(process.cwd(), "supabase/migrations");
  const files = fs.readdirSync(dir).filter((name) => name.includes("account_lending"));
  assert.deepEqual(files.sort(), [
    "20261009120000_account_lending_reward_kind.sql",
    "20261009130000_account_lending_reward_guard.sql",
    "20261010150000_account_lending_guard_strengthen.sql",
  ]);
});

// ---------------------------------------------------------------------------
// 10. 新ガード（20261010110000）＝ 誤投入の検知へ差し替える
// ---------------------------------------------------------------------------

const NEW_GUARD_SRC = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase/migrations/20261010110000_creator_lending_reward_guard.sql",
  ),
  "utf8",
);

const NEW_GUARD_BODY = NEW_GUARD_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(
  /--[^\n]*/g,
  "",
);

test("10-1. 新ガードも DML を含まない", () => {
  assert.doesNotMatch(NEW_GUARD_BODY, /\binsert\s+into\b/i);
  assert.doesNotMatch(NEW_GUARD_BODY, /\bupdate\s+public\./i);
  assert.doesNotMatch(NEW_GUARD_BODY, /\bdelete\s+from\b/i);
  assert.doesNotMatch(NEW_GUARD_BODY, /\btruncate\b/i);
  assert.doesNotMatch(NEW_GUARD_BODY, /\balter\s+table\b/i);
});

test("10-2. 既存 migration ファイルを改変せず、同じ関数名を置き換える", () => {
  /* 旧ガードのファイルは関数定義を保持したまま（改変していない） */
  assert.match(GUARD_SRC, /create or replace function public\.guard_account_lending_reward_kind/);
  /* 新ガードが同じ関数を差し替える */
  assert.match(
    NEW_GUARD_BODY,
    /create or replace function public\.guard_account_lending_reward_kind/,
  );
  /* トリガ名は変えない（既存の付け替えを避ける） */
  assert.match(NEW_GUARD_BODY, /create trigger agency_reward_items_account_lending_guard/);
});

test("10-3. agency_reward_items への account_lending 投入を拒否する", () => {
  assert.match(NEW_GUARD_BODY, /coalesce\(new\.reward_kind, 'agency'\) = 'account_lending'/);
  assert.match(NEW_GUARD_SRC, /端末貸し出し報酬は代理店報酬の明細に保存できません/);
});

test("10-4. 分配率だけを入れることも拒否する", () => {
  assert.match(NEW_GUARD_BODY, /new\.lending_split_rate is not null/);
  assert.match(NEW_GUARD_SRC, /代理店報酬の明細に端末貸し出しの分配率は保存できません/);
});

test("10-5. 金額・種類・分配率・分配先が動かない更新は検査しない", () => {
  const section = NEW_GUARD_BODY.slice(
    NEW_GUARD_BODY.indexOf("guard_account_lending_reward_kind"),
  );
  const early = section.slice(
    section.indexOf("if tg_op = 'UPDATE'"),
    section.indexOf("if coalesce(new.reward_kind"),
  );
  for (const col of ["reward_amount", "reward_kind", "lending_split_rate", "agency_id"]) {
    assert.match(early, new RegExp(`old\\.${col}\\s+is not distinct from new\\.${col}`), col);
  }
  assert.match(early, /return new;/);
});

test("10-6. 新ガードは支払経路・紹介報酬に触らない", () => {
  assert.doesNotMatch(NEW_GUARD_BODY, /payment_batches/);
  assert.doesNotMatch(NEW_GUARD_BODY, /payee_kind/);
  assert.doesNotMatch(
    NEW_GUARD_BODY,
    /claim_payment_batch_items|complete_payment_batch|approve_one_payment_batch/,
  );
  assert.doesNotMatch(NEW_GUARD_BODY, /referral_reward_items|referral_payouts|referrers/);
});
