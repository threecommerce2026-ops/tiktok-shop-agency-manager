/*
  所属ラベルと紹介者変更ガードのテスト。

  DBへは接続せず、表示の文言と実装の規約を確かめる。
  実行: node --test scripts/test-agency-label-and-referral-guard.mjs

  ■ 所属と区分は別概念
  所属の「自社代理店所属」は agencies.is_in_house 由来で、
  対象月すべてが自社代理店（THREE.inc /（株）3）であることを指す。
  区分の「自社運用」は creators.account_management_type = self_operated で、
  収益が100%自社に入るアカウントのこと。

  以前は所属側を「自社運営」と表示していたため、区分の「自社運用」と
  1文字しか違わず取り違えた。nikkoro.gashi は
      所属 THREE.inc（自社代理店）／ 区分 account_lending（アカウント貸出）
  でどちらも正しいのに「自社運営なのにアカウント貸出？」と読めてしまった。

  ■ 紹介者変更は1つのガードに通す
  画面ごとに別のガードを持たせない。月次確定済みの月や支払処理へ
  進んだ月に影響する変更を素通しする経路を残さない。
*/
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = process.cwd();
const read = (file) => readFileSync(path.join(root, file), "utf8");
const codeOnly = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

const TAP_RAW = read("lib/db/tap-creator-queries.ts");
const TAP = codeOnly(TAP_RAW);
const PAYMENTS_RAW = read("app/(app)/payments/PaymentsClient.tsx");
const PAYMENTS = codeOnly(PAYMENTS_RAW);
const CREATORS_RAW = read("app/(app)/creators/CreatorMasterClient.tsx");
const TYPES_RAW = read("lib/creators/account-management-type.ts");
const ADMIN_REFERRALS = codeOnly(read("app/actions/admin-creator-referrals.ts"));
const MASTER = codeOnly(read("app/actions/update-creator-master.ts"));
const BULK = codeOnly(read("app/actions/creator-master-bulk-edit.ts"));

// =============================================================================
// 所属ラベル
// =============================================================================
test("所属の自社判定は「自社代理店所属」と表示する", () => {
  assert.match(
    TAP,
    /agencyLabel = allInHouse \? "自社代理店所属"/,
    "所属ラベルが自社代理店所属になっていない",
  );
  // 紛らわしい「自社運営」をコードから無くす
  assert.equal(
    /"自社運営"/.test(TAP),
    false,
    "所属側に「自社運営」が残っている",
  );
  assert.equal(
    /"所属: 自社運営"/.test(PAYMENTS),
    false,
    "フィルタに「自社運営」が残っている",
  );
  assert.ok(PAYMENTS_RAW.includes("所属: 自社代理店"));
});

test("所属の判定根拠は agencies.is_in_house と月別確定だけ", () => {
  assert.match(TAP, /agencyById\.get\(agencyId\)\?\.isInHouse === true/);
  assert.match(TAP, /monthlyByCreator\.get\(creatorId\)/);
  /*
    所属の判定に区分を混ぜない。THREE.inc 所属だからといって
    account_management_type を self_operated 扱いにしてはいけない。
  */
  const block = TAP.slice(
    TAP.indexOf("const assignments = monthlyByCreator"),
    TAP.indexOf("rows.push({"),
  );
  assert.equal(
    /self_operated|accountManagementType|referralEligibleType/.test(block),
    false,
    "所属の判定に区分を混ぜている",
  );
});

test("区分のラベルは 通常 / 自社運用 / アカウント貸出", () => {
  assert.match(TYPES_RAW, /standard: "通常"/);
  assert.match(TYPES_RAW, /self_operated: "自社運用"/);
  assert.match(TYPES_RAW, /account_lending: "アカウント貸出"/);
  // 区分に「自社代理店所属」を使わない
  assert.equal(/自社代理店/.test(TYPES_RAW), false, "区分側に所属の語が混ざっている");
});

test("画面は区分を日本語ラベルで出す（所属と取り違えない）", () => {
  assert.match(PAYMENTS, /accountManagementTypeLabel\(row\.accountManagementType\)/);
  assert.match(PAYMENTS, /accountManagementTypeLabel\(c\.accountManagementType\)/);
  assert.match(
    PAYMENTS,
    /from "@\/lib\/creators\/account-management-type"/,
    "区分ラベルを単一定義から取っていない",
  );
});

test("nikkoro.gashi の組み合わせが別々に表示される", () => {
  /*
    所属 THREE.inc（is_in_house=true、全月確定）→ 自社代理店所属
    区分 account_lending                        → アカウント貸出
    どちらも正しく、別の列に出る。
  */
  const labels = {
    standard: "通常",
    self_operated: "自社運用",
    account_lending: "アカウント貸出",
  };
  assert.equal(labels.account_lending, "アカウント貸出");
  assert.notEqual(labels.self_operated, "自社代理店所属");
  assert.notEqual("自社代理店所属", labels.account_lending);
  // 所属の語と区分の語が別物であること
  assert.notEqual("自社代理店所属", labels.self_operated);
});

test("所属が月別確定ベースであることを画面で示す", () => {
  assert.ok(
    PAYMENTS_RAW.includes("所属（月別確定ベース）"),
    "TAP実績の所属見出しに根拠が無い",
  );
  assert.ok(
    PAYMENTS_RAW.includes("月別に確定した所属"),
    "所属の説明が無い",
  );
  assert.ok(
    PAYMENTS_RAW.includes("とは別の項目です"),
    "区分と別である説明が無い",
  );
});

test("/creators の所属は現在所属だと分かる", () => {
  assert.ok(CREATORS_RAW.includes("現在の所属代理店"));
  assert.ok(CREATORS_RAW.includes("この編集フォームは「現在所属」を変更します"));
  assert.ok(
    CREATORS_RAW.includes("月別確定ベース"),
    "TAP実績との違いを説明していない",
  );
  // 月別所属への導線は残す
  assert.ok(CREATORS_RAW.includes("MonthlyAssignmentLauncher"));
});

// =============================================================================
// 紹介者変更のガード
// =============================================================================
const GUARDED = [
  ["app/actions/admin-creator-referrals.ts", ADMIN_REFERRALS],
  ["app/actions/update-creator-master.ts", MASTER],
  ["app/actions/creator-master-bulk-edit.ts", BULK],
];

test("紹介者を変える経路はすべて同じガードを通る", () => {
  for (const [name, source] of GUARDED) {
    assert.match(source, /buildReferralChangePlan\(/, `${name} が plan を作っていない`);
    assert.match(source, /canApplyReferralChange\(/, `${name} が保存可否を見ていない`);
    assert.match(source, /linkCreatorToReferrer\(/, `${name} が共通の書き込みを使っていない`);
  }
});

test("月次確定済みへの変更を素通しする経路が無い", () => {
  for (const [name, source] of GUARDED) {
    // plan を作ったあと必ず可否を見てから書く
    const planAt = source.indexOf("buildReferralChangePlan(");
    const canAt = source.indexOf("canApplyReferralChange(");
    const linkAt = source.indexOf("linkCreatorToReferrer(");
    assert.ok(planAt >= 0 && canAt > planAt, `${name} の順序が違う`);
    assert.ok(linkAt > canAt, `${name} が可否判定の前に書き込んでいる`);
  }
});

test("紹介者変更のロジックを画面ごとに複製していない", () => {
  for (const [name, source] of GUARDED) {
    // creator_referrals を直接触らない（linkCreatorToReferrer が唯一の入口）
    assert.equal(
      /\.from\("creator_referrals"\)[\s\S]{0,80}\.(update|insert|upsert|delete)\(/.test(source),
      false,
      `${name} が creator_referrals を直接書き換えている`,
    );
    // 期間の判定を書き直さない
    assert.equal(
      /buildReferralPeriods\(|resolveReferralForMonth\(/.test(source),
      false,
      `${name} が期間判定を自前で持っている`,
    );
  }
});

test("紹介者変更は監査ログを残す", () => {
  for (const [name, source] of GUARDED) {
    assert.match(source, /log: \{\s*plan,/, `${name} が履歴を残していない`);
  }
});

test("紹介者変更で reward / payout を動かさない", () => {
  for (const [name, source] of GUARDED) {
    for (const forbidden of [
      /syncReferralRewardsForMonth/,
      /refreshReferralPayouts/,
      /finalize_referral_month/,
      /claim_payment_batch_items/,
    ]) {
      assert.equal(forbidden.test(source), false, `${name} が ${forbidden} を呼んでいる`);
    }
    for (const table of ["referral_reward_items", "referral_payouts", "referral_month_settlements"]) {
      assert.equal(
        source.includes(`"${table}"`),
        false,
        `${name} が ${table} を触っている`,
      );
    }
  }
});
