/*
  クリエイター区分を月別管理に変えた変更のテスト。

  ■ 何を守りたいか
  紹介報酬は「その月に発生した THREE の取り分（W+X）の 5%」で、
  発生月ごとに帰属が決まる。ところが以前は
  creators.account_management_type の現在値を全対象月へ適用していた。

  実例（2026-10-02 監査）: kanya_land は 2026-03〜08 に
  W+X 759,181円・紹介者（株）3 の実績があるのに、
  2026-09-30 に standard → self_operated へ変えただけで
  6 か月すべてが対象外になっていた（紹介報酬 37,959.05円相当）。

  正式ルール（2026-10-02 確定）: 区分の変更は過去月へ遡及しない。

  実行: node --test scripts/test-monthly-account-management-type.mjs
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

const resolver = await jiti.import(
  path.join(root, "lib/creators/monthly-account-management-type.ts"),
);
const draft = await jiti.import(
  path.join(root, "lib/creators/monthly-account-type-draft.ts"),
);
const guard = await jiti.import(
  path.join(root, "lib/referrals/settlement-sync-guard.ts"),
);

const read = (rel) => readFileSync(path.join(root, rel), "utf8");
/** コメントを落として「実際のコード」だけを見る */
const codeOnly = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const MIGRATION = read(
  "supabase/migrations/20261002060000_creator_monthly_account_management_types.sql",
);
const SYNC = read("lib/referrals/sync-referral-rewards.ts");
const PREVIEW = read("lib/referrals/referral-reward-preview.ts");
const TAP = read("lib/db/tap-creator-queries.ts");
const UI = read("app/(app)/payments/PaymentsClient.tsx");
const PANEL = read("components/creators/MonthlyAccountTypePanel.tsx");
const ACTIONS = read("app/actions/creator-monthly-account-type.ts");
const CONFIRM = read("lib/creators/confirm-monthly-account-types.ts");
const SYNC_ACTION = read("app/actions/referral-rewards.ts");

// --- fallback 仕様 ------------------------------------------------------------

test("月別確定がある月はその区分を使う", () => {
  const resolved = resolver.resolveMonthlyAccountManagementType({
    creatorId: "c1",
    targetMonth: "2026-05",
    monthlyType: "standard",
    currentType: "self_operated",
  });

  assert.equal(resolved.accountManagementType, "standard");
  assert.equal(resolved.source, "monthly");
});

test("月別確定が無い月は現在区分へ落ちる（fallback 仕様）", () => {
  /*
    他の案を実データで比較した結果（月別確定 0 件の時点）:
      現在値へ fallback  8,448 件 / 40,292.00 円（＝現状と同じ判定）
      未確定を standard 20,397 件 / 121,845.50 円（区分を無視する）
      未確定は対象外          0 件 / 0.00 円（既存 47,902.90 が全消滅）
    現在値へ落とす案だけが、移行中に金額を動かさない。
  */
  const resolved = resolver.resolveMonthlyAccountManagementType({
    creatorId: "c1",
    targetMonth: "2026-05",
    monthlyType: null,
    currentType: "self_operated",
  });

  assert.equal(resolved.accountManagementType, "self_operated");
  assert.equal(resolved.source, "current");
});

test("月別確定が空文字でも未確定として扱う", () => {
  const resolved = resolver.resolveMonthlyAccountManagementType({
    creatorId: "c1",
    targetMonth: "2026-05",
    monthlyType: "   ",
    currentType: "standard",
  });
  assert.equal(resolved.source, "current");
});

test("不正な値は既定（standard）へ正規化する", () => {
  const resolved = resolver.resolveMonthlyAccountManagementType({
    creatorId: "c1",
    targetMonth: "2026-05",
    monthlyType: null,
    currentType: "なにか不正な値",
  });
  assert.equal(resolved.accountManagementType, "standard");
});

test("確定済かどうかを判定できる", () => {
  assert.equal(resolver.isConfirmedAccountManagementType("monthly"), true);
  assert.equal(resolver.isConfirmedAccountManagementType("current"), false);
});

// --- 遡及しないこと（今回の本題）---------------------------------------------

test("kanya_land の形: 過去を standard で確定すれば現在区分を変えても動かない", () => {
  /*
    2026-03〜08 を standard で確定し、現在区分が self_operated。
    確定済の 6 か月は standard のまま＝紹介報酬の対象。
  */
  const months = ["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"];
  const confirmed = new Map(months.map((m) => [m, "standard"]));

  for (const month of months) {
    const resolved = resolver.resolveMonthlyAccountManagementType({
      creatorId: "kanya",
      targetMonth: month,
      monthlyType: confirmed.get(month),
      currentType: "self_operated",
    });
    assert.equal(resolved.accountManagementType, "standard", `${month} が遡及している`);
    assert.equal(resolved.source, "monthly");
  }

  // 変更後の月は現在区分が効く
  const after = resolver.resolveMonthlyAccountManagementType({
    creatorId: "kanya",
    targetMonth: "2026-09",
    monthlyType: null,
    currentType: "self_operated",
  });
  assert.equal(after.accountManagementType, "self_operated");
});

test("索引は creator と月の組で引く", () => {
  const index = resolver.buildMonthlyAccountTypeIndex([
    { creator_id: "c1", target_month: "2026-05", account_management_type: "standard" },
    { creator_id: "c2", target_month: "2026-05", account_management_type: "self_operated" },
    { creator_id: "c1", target_month: "2026-06", account_management_type: "account_lending" },
  ]);

  assert.equal(index.get(resolver.monthlyAccountTypeKey("c1", "2026-05")), "standard");
  assert.equal(index.get(resolver.monthlyAccountTypeKey("c2", "2026-05")), "self_operated");
  assert.equal(index.get(resolver.monthlyAccountTypeKey("c1", "2026-06")), "account_lending");
  assert.equal(index.get(resolver.monthlyAccountTypeKey("c1", "2026-07")), undefined);
});

test("空の区分は索引に入れない（未確定として扱わせる）", () => {
  const index = resolver.buildMonthlyAccountTypeIndex([
    { creator_id: "c1", target_month: "2026-05", account_management_type: null },
    { creator_id: "c1", target_month: "2026-06", account_management_type: "" },
  ]);
  assert.equal(index.size, 0);
});

// --- 紹介報酬の計算が月別区分を参照すること ----------------------------------

test("sync は現在区分を全月へ適用しない", () => {
  const code = codeOnly(SYNC);

  assert.ok(
    /resolveMonthlyAccountManagementType\(/.test(code),
    "sync が月別区分の解決を通っていない",
  );
  assert.ok(
    /fetchMonthlyAccountTypes\(supabase, \{ targetMonth \}\)/.test(code),
    "sync が対象月の月別区分を読んでいない",
  );
  assert.ok(
    !/accountManagementType: config\.accountManagementType/.test(code),
    "sync が現在区分をそのまま渡している（遡及が残っている）",
  );
  assert.ok(
    /accountManagementType: resolvedType\.accountManagementType/.test(code),
    "sync が解決後の区分を渡していない",
  );
});

test("dry-run も本番と同じ区分判定を使う", () => {
  const code = codeOnly(PREVIEW);
  assert.ok(
    /resolveMonthlyAccountManagementType\(/.test(code),
    "preview が月別区分の解決を通っていない",
  );
  assert.ok(
    !/accountManagementType: creator\.accountManagementType,\s*\},\s*rateByCreator/.test(code),
    "preview が現在区分をそのまま渡している",
  );
});

test("TAP実績の対象判定も月別区分で行う", () => {
  const code = codeOnly(TAP);
  assert.ok(/fetchMonthlyAccountTypes\(supabase\)/.test(code), "月別区分を読んでいない");
  assert.ok(/typeMonths/.test(code), "月ごとの区分を持っていない");
  assert.ok(
    !/const eligibleType = isReferralRewardEligibleType\(\s*creator\?\.accountManagementType/.test(code),
    "creator の現在区分だけで対象判定している",
  );
});

test("区分判定の入口は 1 つだけ", () => {
  /*
    isReferralRewardEligibleType を直接呼ぶ場所が増えると、
    月別を見る経路と現在値を見る経路が混在する。
    紹介報酬の計算経路では必ず解決を通す。
  */
  for (const [name, source] of [["sync", SYNC], ["preview", PREVIEW]]) {
    const code = codeOnly(source);
    assert.ok(
      !/isReferralRewardEligibleType\(/.test(code),
      `${name} が区分判定を自前で呼んでいる`,
    );
  }
});

// --- 画面の選択 → 保存する変更 -----------------------------------------------

function typeRow(overrides) {
  return {
    targetMonth: "2026-05",
    effectiveType: "self_operated",
    source: "current",
    monthlyType: null,
    referralEligible: false,
    referralBase: 1000,
    lineCount: 3,
    rewardAmount: 0,
    rewardItemCount: 0,
    hasPaidReward: false,
    paidRewardAmount: 0,
    ...overrides,
  };
}

test("月ごとに別の区分を選んで確定できる", () => {
  const changes = draft.buildPlannedTypeChanges(
    [typeRow({ targetMonth: "2026-05" }), typeRow({ targetMonth: "2026-06" })],
    { "2026-05": "standard", "2026-06": "account_lending" },
  );

  assert.deepEqual(
    changes.map((c) => [c.targetMonth, c.accountManagementType]),
    [
      ["2026-05", "standard"],
      ["2026-06", "account_lending"],
    ],
  );
});

test("「変更しない」を選んだ月は保存対象に入らない", () => {
  const changes = draft.buildPlannedTypeChanges(
    [typeRow({ targetMonth: "2026-05" }), typeRow({ targetMonth: "2026-06" })],
    { "2026-05": "standard", "2026-06": "" },
  );
  assert.deepEqual(changes.map((c) => c.targetMonth), ["2026-05"]);
});

test("いまと同じ確定区分を選び直しても保存対象に入らない", () => {
  const changes = draft.buildPlannedTypeChanges(
    [typeRow({ monthlyType: "standard", effectiveType: "standard", source: "monthly" })],
    { "2026-05": "standard" },
  );
  assert.equal(changes.length, 0, "同じ値を書き込もうとしている");
});

test("支払済みの月は選択されていても保存対象に入らない", () => {
  const changes = draft.buildPlannedTypeChanges(
    [typeRow({ hasPaidReward: true, paidRewardAmount: 500 })],
    { "2026-05": "standard" },
  );
  assert.equal(changes.length, 0, "支払済みの月を変更しようとしている");
});

test("不正な区分は保存対象に入らない", () => {
  const changes = draft.buildPlannedTypeChanges([typeRow({})], {
    "2026-05": "unknown_type",
  });
  assert.equal(changes.length, 0);
});

test("紹介報酬の対象が切り替わる月を区別できる", () => {
  const changes = draft.buildPlannedTypeChanges(
    [
      /* 対象外 → 対象（kanya_land の形） */
      typeRow({ targetMonth: "2026-05", effectiveType: "self_operated" }),
      /* 対象 → 対象（貸出ではないので可否は変わらない）*/
      typeRow({ targetMonth: "2026-06", effectiveType: "standard", referralEligible: true }),
    ],
    { "2026-05": "standard", "2026-06": "standard" },
  );

  const changing = draft.eligibilityChangingTypeChanges(changes);
  assert.deepEqual(changing.map((c) => c.targetMonth), ["2026-05"]);
});

test("確定済を付け替える月だけ強い警告の対象になる", () => {
  const changes = draft.buildPlannedTypeChanges(
    [
      typeRow({ targetMonth: "2026-05" }),
      typeRow({
        targetMonth: "2026-06",
        monthlyType: "standard",
        effectiveType: "standard",
        source: "monthly",
        referralEligible: true,
      }),
    ],
    { "2026-05": "standard", "2026-06": "account_lending" },
  );

  const reconfirmed = draft.reconfirmedTypeChanges(changes);
  assert.deepEqual(reconfirmed.map((c) => c.targetMonth), ["2026-06"]);
  assert.equal(reconfirmed[0].previousType, "standard");
});

test("確定内容は対象月の昇順で並ぶ", () => {
  const changes = draft.buildPlannedTypeChanges(
    [typeRow({ targetMonth: "2026-07" }), typeRow({ targetMonth: "2026-03" })],
    { "2026-07": "standard", "2026-03": "standard" },
  );
  assert.deepEqual(changes.map((c) => c.targetMonth), ["2026-03", "2026-07"]);
});

// --- migration -----------------------------------------------------------------

test("月別区分テーブルは所属とは別テーブルで、creator×月で一意", () => {
  assert.ok(
    /create table if not exists public\.creator_monthly_account_management_types/.test(MIGRATION),
  );
  assert.ok(
    /unique \(creator_id, target_month\)/.test(MIGRATION),
    "creator×月の一意制約が無い",
  );
  for (const column of [
    "creator_id",
    "target_month",
    "account_management_type",
    "updated_by",
    "updated_by_email",
    "created_at",
    "updated_at",
  ]) {
    assert.ok(
      new RegExp(`\\b${column}\\b`).test(MIGRATION),
      `${column} が無い`,
    );
  }
  /*
    所属テーブルとは結合しない。

    なぜ別にするかは migration の冒頭コメントで説明しているので、
    説明文は落としてから実際の DDL だけを見る。
  */
  const ddl = MIGRATION.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, "");
  assert.ok(
    !/creator_monthly_agency_assignments/.test(ddl),
    "月別所属と結合している（外部キーや参照がある）",
  );
});

test("監査ログで誰が何月を何から何へ変えたか追える", () => {
  assert.ok(
    /create table if not exists public\.creator_monthly_account_management_type_logs/.test(MIGRATION),
  );
  for (const column of ["from_type", "to_type", "changed_by", "changed_by_email", "action"]) {
    assert.ok(new RegExp(`\\b${column}\\b`).test(MIGRATION), `${column} が無い`);
  }
  // 監査ログは書き換えさせない
  assert.ok(
    !/for update[\s\S]{0,200}creator_monthly_account_management_type_logs/.test(MIGRATION),
    "監査ログに update を許可している",
  );
});

test("RPC はログインと管理者権限を必須にする", () => {
  for (const fn of [
    "set_creator_monthly_account_management_type",
    "reset_creator_monthly_account_management_type",
  ]) {
    assert.ok(
      new RegExp(`create or replace function public\\.${fn}`).test(MIGRATION),
      `${fn} が無い`,
    );
  }
  assert.ok(/v_user_id := auth\.uid\(\);/.test(MIGRATION));
  assert.ok(/raise exception 'ログインが必要です。'/.test(MIGRATION));
  assert.ok(/if not public\.is_app_admin\(\) then/.test(MIGRATION));
  assert.ok(/raise exception '区分が不正です。'/.test(MIGRATION), "区分の検証が無い");
});

test("RPC は現在区分（creators）を変更しない", () => {
  assert.ok(
    !/update public\.creators/.test(MIGRATION),
    "RPC が creators を書き換えている",
  );
});

// --- 保存経路と安全ガード ------------------------------------------------------

test("パネルは既存の正式アクションだけを呼ぶ", () => {
  const code = codeOnly(PANEL);
  assert.ok(/confirmCreatorMonthlyAccountTypesAction/.test(code));
  assert.ok(/resetCreatorMonthlyAccountTypeAction/.test(code));
  assert.ok(
    !/\.from\(/.test(code),
    "パネルが直接テーブルを触っている",
  );
  assert.ok(!/\.rpc\(/.test(code), "パネルが RPC を直接呼んでいる");
});

test("パネルは現在区分・紹介者・月別所属・報酬を触らない", () => {
  /*
    パネルは画面の説明文でテーブル名に触れる
    （「紹介報酬（referral_reward_items）も自動では再計算しません」）。
    文字列に出てくるかではなく、読み書きの呼び出しが無いことを見る。
  */
  const code = codeOnly(PANEL);

  assert.ok(!/\.from\(/.test(code), "パネルが直接テーブルを触っている");
  assert.ok(!/\.rpc\(/.test(code), "パネルが RPC を直接呼んでいる");

  for (const forbidden of [
    /linkCreatorToReferrer/,
    /updateCreatorMaster/,
    /syncReferralRewards/,
    /confirmMonthlyAssignments/,
    /confirmCreatorMonthlyAssignmentsAction/,
    /resetCreatorMonthlyAssignmentAction/,
  ]) {
    assert.ok(
      !forbidden.test(code),
      `パネルが ${forbidden} を呼んでいる`,
    );
  }

  /* 呼ぶアクションは月別区分の 3 つだけ */
  const actions = [...code.matchAll(/\b(\w+Action)\(/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(actions)].sort(),
    [
      "confirmCreatorMonthlyAccountTypesAction",
      "loadCreatorMonthlyAccountTypeAction",
      "resetCreatorMonthlyAccountTypeAction",
    ],
    "月別区分以外のアクションを呼んでいる",
  );

  assert.ok(
    /現在区分は変更しません/.test(PANEL),
    "現在区分を変えない旨の表示が無い",
  );
});

test("確定処理は支払済み・支払予定中の月をブロックする", () => {
  const code = codeOnly(CONFIRM);
  assert.ok(/is_paid/.test(code), "is_paid を見ていない");
  assert.ok(/payout_id/.test(code), "payout_id を見ていない");
  assert.ok(/payment_batch_id/.test(code), "payment_batch_id を見ていない");
  assert.ok(/blocked\.push/.test(code), "ブロックした月を返していない");
});

test("確定処理は紹介報酬を自動で再計算しない", () => {
  const code = codeOnly(CONFIRM) + codeOnly(ACTIONS);
  for (const forbidden of [
    "syncReferralRewardsForMonth",
    "referral_payouts",
    "payment_batches",
    "finalize_referral_month",
  ]) {
    assert.ok(!code.includes(forbidden), `確定処理が ${forbidden} を触っている`);
  }
  assert.ok(
    /自動では再計算しません|再集計を実行してください/.test(ACTIONS),
    "再集計が別操作である案内が無い",
  );
});

test("月次確定済みの月は再集計できない", () => {
  assert.deepEqual(
    [...guard.finalizedMonthsOf([
      { target_month: "2026-05", status: "finalized" },
      { target_month: "2026-06", status: "unfinalized" },
      { target_month: "2026-07", status: "finalized" },
    ])].sort(),
    ["2026-05", "2026-07"],
  );

  const split = guard.splitSyncableMonths(
    ["2026-05", "2026-06", "2026-07"],
    new Set(["2026-05", "2026-07"]),
  );
  assert.deepEqual(split.syncable, ["2026-06"]);
  assert.deepEqual(split.blocked, ["2026-05", "2026-07"]);
});

test("確定済みの月しか無ければ再集計を拒否する", () => {
  const code = codeOnly(SYNC_ACTION);
  assert.ok(
    /fetchFinalizedReferralMonths\(auth\.supabase\)/.test(code),
    "確定月を読んでいない",
  );
  assert.ok(
    /if \(syncable\.length === 0\)/.test(code),
    "全部が確定済みのときに拒否していない",
  );
  assert.ok(
    /月次確定済みのため再集計できません/.test(SYNC_ACTION),
    "拒否の理由を伝えていない",
  );
  assert.ok(
    /blockedNote/.test(code),
    "スキップした月を黙って飲み込んでいる",
  );
});

test("明細単位の既存ガードは残っている", () => {
  const code = codeOnly(SYNC);
  assert.ok(/paidSourceKeys/.test(code), "支払済明細の保護が消えている");
  assert.ok(
    /item\.is_paid \|\| item\.payout_id != null \|\| item\.payment_batch_id != null/.test(code),
    "支払済判定の条件が変わっている",
  );
});

// --- UI ------------------------------------------------------------------------

test("TAP実績から月別区分を画面内で確定できる", () => {
  const code = codeOnly(UI);
  assert.ok(/<MonthlyAccountTypeLauncher/.test(code), "月別区分パネルが無い");
  assert.ok(/creatorId=\{row\.creatorId\}/.test(code), "対象 creator を渡していない");
  assert.ok(UI.includes("月別区分を確認・確定"));
  // 別ページへ遷移させない
  assert.ok(
    !/href=[^\n]*monthly-account/.test(code),
    "月別区分で別ページへ遷移している",
  );
});

test("再集計が必要な月を名指しで出す", () => {
  const code = codeOnly(UI);
  assert.ok(/totals\.staleRewardCreatorCount > 0/.test(code), "警告の条件が無い");
  assert.ok(
    /totals\.staleRewardMonths\.join/.test(code),
    "対象月を並べていない",
  );
  assert.ok(
    /totals\.staleRewardEstimatedAmount/.test(code),
    "再集計で発生しうる額を出していない",
  );
  assert.ok(
    UI.includes("紹介報酬の再集計が必要です"),
    "再集計が必要である見出しが無い",
  );
  assert.ok(
    UI.includes("この画面では再集計しません"),
    "自動で再集計しないことを伝えていない",
  );
});

test("未確定の月は現在区分で暫定判定していると伝える", () => {
  const code = codeOnly(UI);
  assert.ok(/totals\.unconfirmedTypeCreatorCount > 0/.test(code));
  assert.ok(/row\.unconfirmedTypeMonths\.length > 0/.test(code));
  assert.ok(UI.includes("現在区分で暫定判定"));
});

test("TAP実績は区分も報酬も自前で書き換えない", () => {
  const code = codeOnly(UI);
  for (const forbidden of [
    "creator_monthly_account_management_types",
    "set_creator_monthly_account_management_type",
    "syncReferralRewardsForMonth",
  ]) {
    assert.ok(!code.includes(forbidden), `TAP実績が ${forbidden} を触っている`);
  }
});
