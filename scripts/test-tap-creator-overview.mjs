/*
  TAP実績（クリエイター単位の成果と報酬構造）のテスト。

  DBへは接続せず、集計ロジックと実装の規約を確かめる。
  実行: node --test scripts/test-tap-creator-overview.mjs

  ■ このテストが守っているもの
  ① 対象行の判定を書き写さず、既存の正式条件を呼ぶこと
  ② 4つの金額を合算しないこと
  ③ 紹介者がいない creator へ紹介報酬を作らないこと
  ④ 紹介報酬は referral_reward_items が唯一の正であること
  ⑤ 支払操作を置かないこと（読み取り専用）
  ⑥ ブラウザへ TAP の生データを渡さないこと
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

const tapSrc = await jiti.import(path.join(root, "lib/referrals/tap-referral-source.ts"));
const cutoff = await jiti.import(path.join(root, "lib/payments/cutoff-month.ts"));

const read = (file) => readFileSync(path.join(root, file), "utf8");
const QUERIES_RAW = read("lib/db/tap-creator-queries.ts");
const UI_RAW = read("app/(app)/payments/PaymentsClient.tsx");
const ACTIONS_RAW = read("app/actions/payments.ts");
const PAYMENT_QUERIES_RAW = read("lib/db/payment-queries.ts");

/** コメントを除いたコード本体（説明文で誤検知させない） */
function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

const QUERIES = codeOnly(QUERIES_RAW);
const UI = codeOnly(UI_RAW);
const ACTIONS = codeOnly(ACTIONS_RAW);

// =============================================================================
// 対象行の判定（独自実装を作らない）
// =============================================================================
test("対象行の判定は既存の正式条件を呼ぶ（条件を書き写さない）", () => {
  assert.match(
    QUERIES,
    /isTapReferralSourceLine\(/,
    "正式な eligible 判定を使っていない",
  );
  for (const copied of [
    /決済済み/,
    /支払い済み/,
    /fully_refunded/,
    /commission_base.*>\s*0/,
  ]) {
    assert.equal(
      copied.test(QUERIES),
      false,
      `eligible 条件を書き写している: ${copied}`,
    );
  }
});

test("正式条件の中身（退行検知）", () => {
  const line = (over = {}) => ({
    source_row_key: "k",
    order_id: null,
    product_id: null,
    creator_id: "c1",
    target_month: "2026-05",
    commission_base: 1000,
    payment_status: "支払い済み",
    order_status: "決済済み",
    refund_status: "いいえ",
    ...over,
  });

  assert.equal(tapSrc.isTapReferralSourceLine(line()), true);
  assert.equal(tapSrc.isTapReferralSourceLine(line({ creator_id: null })), false);
  assert.equal(tapSrc.isTapReferralSourceLine(line({ source_row_key: null })), false);
  assert.equal(tapSrc.isTapReferralSourceLine(line({ target_month: null })), false);
  assert.equal(tapSrc.isTapReferralSourceLine(line({ payment_status: "未払い" })), false);
  assert.equal(tapSrc.isTapReferralSourceLine(line({ refund_status: "はい" })), false);
  assert.equal(tapSrc.isTapReferralSourceLine(line({ commission_base: 0 })), false);
});

// =============================================================================
// 4つの金額を混ぜない
// =============================================================================
test("4つの金額を別々の項目として持つ", () => {
  for (const field of [
    "commissionBase",
    "tapRevenue",
    "creatorEstimatedCommission",
    "referralRewardAmount",
  ]) {
    assert.match(QUERIES, new RegExp(`${field}:`), `${field} を返していない`);
  }
});

test("合算した金額を作らない", () => {
  for (const forbidden of [/totalReward/i, /grandTotal/i, /combinedAmount/i]) {
    assert.equal(forbidden.test(QUERIES), false, `合算値を作っている: ${forbidden}`);
    assert.equal(forbidden.test(UI), false, `画面が合算値を出している: ${forbidden}`);
  }
  // 4指標を足し合わせる式が無いこと
  assert.equal(
    /commissionBase\s*\+\s*tapRevenue/.test(QUERIES),
    false,
    "基礎額と THREE 報酬を足している",
  );
  assert.equal(
    /tapRevenue\s*\+\s*creatorEstimatedCommission/.test(QUERIES),
    false,
    "THREE 報酬とクリエイター報酬を足している",
  );
});

test("画面は4つの金額を別の列で出す", () => {
  for (const label of [
    "成果報酬ベース",
    "THREE報酬",
    "クリエイター報酬",
    "紹介報酬",
  ]) {
    assert.ok(UI_RAW.includes(label), `列 ${label} が無い`);
  }
  assert.ok(UI_RAW.includes("合算した数字は出していません"), "注意書きが無い");
});

// =============================================================================
// 紹介報酬は referral_reward_items が唯一の正
// =============================================================================
test("実績としての紹介報酬を再計算しない（実績テーブルが唯一の正）", () => {
  /*
    2026-09-30 改定。

    「発生した紹介報酬」は従来どおり referral_reward_items が唯一の正で、
    ここで作り直さない（computeReferralReward を呼ばない）。

    一方で「紹介者が未設定のため、まだ報酬が作られていない」場合に
    どれだけの規模かを画面へ出す必要が出たので、想定額
    （算定元 × 料率）だけは計算する。実績と想定は列を分けて出す。

    料率は REFERRAL_REWARD_RATE を通す。5% をベタ書きすると
    料率が変わったときにここだけ取り残される。
  */
  assert.equal(
    /computeReferralReward\(/.test(QUERIES),
    false,
    "TAP実績側で報酬を計算し直している",
  );
  assert.equal(
    /0\.05/.test(QUERIES),
    false,
    "料率をベタ書きしている（REFERRAL_REWARD_RATE を使う）",
  );
  assert.match(
    QUERIES,
    /referralBase \* REFERRAL_REWARD_RATE/,
    "想定額を正式な料率定数から作っていない",
  );
  assert.match(
    QUERIES,
    /"referral_reward_items"/,
    "紹介報酬の実績を実績テーブルから読んでいない",
  );
  assert.match(QUERIES, /resolveRewardItemAmount\(/);

  // 実績と想定を別の項目として持つ
  assert.match(QUERIES, /referralRewardAmount: number;/);
  assert.match(QUERIES, /estimatedReferralReward: number;/);
});

test("紹介報酬は is_reward_target の明細だけ数える", () => {
  assert.match(
    QUERIES,
    /if \(!item\.is_reward_target\) continue;/,
    "対象外の明細まで紹介報酬に数えている",
  );
});

test("紹介者の状態を5つに分ける（あり /「-」/ 期間外 / なし / 異常）", () => {
  /*
    2026-09-30 改定。3つ（あり / 期間外 / なし）では足りなくなった。

    ①「紹介者が -」と「紹介者が未設定」を分ける必要がある。
      「-」は管理者が正式に設定した有効な紹介者で報酬もそこへ帰属する。
      未設定（relation そのものが無い）と同じ扱いにすると、
      紹介者の入力漏れを見つけられない。
    ② 有効な関係が重なっている異常を黙って1件選ばずに出す。

    「期間外」を出すという元の意図はそのまま残している。
  */
  for (const state of [
    '"assigned"',
    '"dash_referrer"',
    '"out_of_period"',
    '"none"',
    '"conflict"',
  ]) {
    assert.ok(QUERIES.includes(state), `${state} が型に無い`);
  }
  assert.equal(
    /"placeholder"/.test(QUERIES),
    false,
    "「-」を placeholder 扱いしている（正式な紹介者なので使わない）",
  );
  assert.match(QUERIES, /referrerState = "dash_referrer"/);
  assert.match(QUERIES, /referrerState = "out_of_period"/);
  assert.match(QUERIES, /referrerState = "conflict"/);
  assert.ok(UI_RAW.includes("期間外"), "画面に期間外の表示が無い");
  assert.ok(UI_RAW.includes("未設定"), "画面に未設定の表示が無い");
});

// =============================================================================
// 書き込みをしない
// =============================================================================
test("TAP実績の集計は参照のみ", () => {
  for (const forbidden of [/\.update\(/, /\.delete\(/, /\.upsert\(/, /\.insert\(/]) {
    assert.equal(forbidden.test(QUERIES), false, `書き込みを行っている: ${forbidden}`);
  }

  /*
    2026-09-30 改定。RPC は読み取り専用のものだけ許す。

    確認範囲を月次確定の対象月から決めるために
    list_referral_month_settlements（security definer / stable）を呼ぶ。
    referral_month_settlements は authenticated / service_role に
    SELECT が grant されていないため、テーブルを直接引くのではなく
    既存の安全な RPC を通す。

    finalize / unfinalize のような状態を変える RPC は呼ばない。
  */
  const rpcs = [...QUERIES.matchAll(/\.rpc\("([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    rpcs,
    ["list_referral_month_settlements"],
    `読み取り専用でない RPC を呼んでいる: ${rpcs.join(", ")}`,
  );
});

test("TAP実績タブに支払操作を置かない", () => {
  const start = UI.indexOf("function TapPerformanceTab");
  assert.ok(start >= 0, "TapPerformanceTab が無い");
  const block = UI.slice(start, UI.indexOf("\nfunction ", start + 10));

  for (const forbidden of [
    /createPaymentBatchAction/,
    /setReferralPaymentHoldAction/,
    /clearReferralPaymentHoldAction/,
    /approvePaymentBatchesBulkAction/,
    /exportPaymentCsvAction/,
    /<form/,
  ]) {
    assert.equal(forbidden.test(block), false, `支払操作を置いている: ${forbidden}`);
  }
});

test("クリエイター報酬の欠損を 0 として黙って飲み込まない", () => {
  assert.match(QUERIES, /creatorCommissionMissingCount/);
  assert.match(QUERIES, /missing: true/);
  assert.ok(
    UI_RAW.includes("記録されていない明細"),
    "欠損件数を画面へ出していない",
  );
});

// =============================================================================
// ブラウザへ生データを渡さない
// =============================================================================
test("raw_row_json をまるごと取らない（1キーだけ取り出す）", () => {
  assert.match(
    QUERIES,
    /creator_commission_raw:raw_row_json->>/,
    "JSON の1キー取り出しを使っていない",
  );
  assert.equal(
    /"raw_row_json"/.test(QUERIES),
    false,
    "raw_row_json を列としてまるごと取得している",
  );
});

test("集計後の行だけを画面へ渡す（明細を渡さない）", () => {
  const start = QUERIES.indexOf("export type TapCreatorOverview");
  const block = QUERIES.slice(start, QUERIES.indexOf("};", start));
  assert.match(block, /rows: TapCreatorRow\[\]/);
  assert.equal(/lines:/.test(block), false, "明細行を画面へ渡している");
  assert.equal(/items:/.test(block), false, "明細行を画面へ渡している");
});

test("TAP実績はタブを開いたときに取り寄せる（初期表示を重くしない）", () => {
  assert.match(ACTIONS, /export async function fetchTapCreatorOverviewAction/);
  assert.match(ACTIONS, /requireAdminAction\(\)/);
  assert.match(UI, /await fetchTapCreatorOverviewAction\(\)/);
  // ページの初期ロードには載せない
  const page = codeOnly(read("app/(app)/payments/page.tsx"));
  assert.equal(
    /fetchTapCreatorOverview/.test(page),
    false,
    "/payments の初期表示で TAP を読み込んでいる（他タブまで遅くなる）",
  );
});

// =============================================================================
// 対象期間
// =============================================================================
test("既定の対象期間は 2026-01〜2026-07", () => {
  assert.match(QUERIES, /options\.startMonth \?\? EARLIEST_CUTOFF_MONTH/);
  assert.match(QUERIES, /options\.endMonth \?\? MAX_REFERRAL_PAYMENT_CUTOFF_MONTH/);
  assert.equal(cutoff.EARLIEST_CUTOFF_MONTH, "2026-01");
  assert.equal(cutoff.MAX_REFERRAL_PAYMENT_CUTOFF_MONTH, "2026-07");
});

// =============================================================================
// 既存 Payment を壊さない
// =============================================================================
test("タブを増やしただけで既存タブを消していない", () => {
  for (const label of ["代理店", "紹介者", "振込保留", "支払履歴", "セラー請求"]) {
    assert.ok(UI_RAW.includes(`label: "${label}"`), `既存タブ ${label} が消えている`);
  }
  assert.ok(UI_RAW.includes('label: "TAP実績"'), "TAP実績タブが無い");
});

test("既存の紹介者支払ロジックに触れていない", () => {
  // claim / manual_hold / threshold / 銀行 / settlement の判定は payment-queries 側のまま
  assert.match(PAYMENT_QUERIES_RAW, /isFullyManualHeld/);
  assert.match(PAYMENT_QUERIES_RAW, /REFERRAL_PAYOUT_THRESHOLD_YEN/);
  assert.match(PAYMENT_QUERIES_RAW, /resolvePaymentHoldReasons/);
  assert.match(PAYMENT_QUERIES_RAW, /inReferralClaimRange/);
  // TAP実績は payment-queries を書き換えていない
  assert.equal(
    /tap-creator-queries/.test(PAYMENT_QUERIES_RAW),
    false,
    "支払側から TAP実績へ依存している",
  );
});

test("TAP実績は PaymentUnpaidRow へ混ぜない", () => {
  assert.equal(
    /PaymentUnpaidRow/.test(QUERIES),
    false,
    "支払先の型へ TAP のクリエイターを混ぜている",
  );
  assert.equal(
    /isPayable|holdReasons|payment_batch_id/.test(QUERIES),
    false,
    "支払判定を TAP実績へ持ち込んでいる",
  );
});

// =============================================================================
// フィルター
// =============================================================================
test("フィルターと並び替えがある", () => {
  assert.match(UI, /TAP_AGENCY_FILTERS/);
  assert.match(UI, /TAP_REFERRER_FILTERS/);
  assert.match(UI, /TAP_SORTS/);
  for (const key of [
    "commissionBase",
    "tapRevenue",
    "creatorEstimatedCommission",
    "referralRewardAmount",
  ]) {
    assert.ok(UI.includes(`key: "${key}"`), `${key} で並び替えできない`);
  }
});

test("所属は既存の月別確定と is_in_house から決める（推測しない）", () => {
  assert.match(QUERIES, /"creator_monthly_agency_assignments"/);
  assert.match(QUERIES, /isInHouse: row\.is_in_house === true/);
  assert.match(QUERIES, /agencyState = "unconfirmed"/);
  assert.match(QUERIES, /partially_unconfirmed/);
  // 名前で自社判定しない
  assert.equal(
    /THREE\.inc/.test(QUERIES),
    false,
    "代理店名の文字列で自社を判定している",
  );
});

// =============================================================================
// 紹介者ステータス（2026-09-30 追加）
//
// 「紹介者が -」と「紹介者が未設定」を絶対に混同しないこと。
// 「-」は取込時に作られた名前だが、管理者が正式に設定した有効な紹介者で
// あり、報酬もそこへ帰属する。未設定（relation そのものが無い）と
// 同じ扱いにすると、紹介者の入力漏れを見つけられなくなる。
//
// 母集団は TAP 側の成果データ。creator_referrals や
// referral_reward_items を起点にすると、紹介者が未設定の
// クリエイターは一覧にすら現れない（紹介者が無ければ報酬も作られない）。
// =============================================================================
const tap = await jiti.import(path.join(root, "lib/db/tap-creator-queries.ts"));
const period = await jiti.import(path.join(root, "lib/referrals/referral-period.ts"));
const engine = await jiti.import(path.join(root, "lib/referrals/referral-reward-engine.ts"));
const accountTypes = await jiti.import(
  path.join(root, "lib/creators/account-management-type.ts"),
);

// =============================================================================
// 1. 母集団は TAP 側の成果データ
// =============================================================================
test("1. 母集団は tap_affiliate_order_lines（relation や reward を起点にしない）", () => {
  /*
    紹介者が未設定のクリエイターは紹介報酬が作られないので、
    reward_items を起点にすると一覧に出てこない。
    creator_referrals を起点にしても同じ理由で漏れる。
  */
  assert.match(
    QUERIES,
    /fetchAllFrom<TapLineRow>\(\s*supabase,\s*"tap_affiliate_order_lines"/,
    "TAP の明細を母集団にしていない",
  );

  // 行の組み立ては TAP 明細から作った buckets を回す
  assert.match(QUERIES, /for \(const \[creatorId, bucket\] of buckets\)/);
  assert.equal(
    /for \(const .* of referralsResult\.data\) \{\s*rows\.push/.test(QUERIES),
    false,
    "紹介関係を起点に行を作っている",
  );
});

// =============================================================================
// 2〜7. 紹介者ステータスの判定
// =============================================================================
const CREATOR = "creator-1";
const relation = (overrides = {}) => ({
  creator_id: CREATOR,
  referrer_id: "referrer-A",
  referral_rate: 0.05,
  start_month: "2026-05",
  end_month: null,
  is_active: true,
  lifetime_payout_cap: null,
  lifetime_paid_amount: 0,
  created_at: "2026-05-01T00:00:00Z",
  ...overrides,
});

/** 実装と同じ手順で状態を決める（判定の流れを固定する） */
function resolveState(rows, months, nameById) {
  const index = period.buildReferralPeriods(rows);
  const periods = index.byCreator.get(CREATOR);
  if (!periods || periods.length === 0) return { state: "none", name: null };

  const conflicted = months.some(
    (m) => period.resolveReferralForMonth(periods, m).conflicts.length > 0,
  );
  const covering = months
    .map((m) => period.resolveReferralForMonth(periods, m).period)
    .find((p) => p != null);
  const shown = covering ?? periods[periods.length - 1];
  const name = nameById[shown.referrerId] ?? "（不明な紹介者）";

  if (conflicted) return { state: "conflict", name };
  if (!covering) return { state: "out_of_period", name };
  if (tap.isDashReferrerName(name)) return { state: "dash_referrer", name };
  return { state: "assigned", name };
}

test("2. assigned: 通常の紹介者が対象月を覆う", () => {
  const got = resolveState(
    [relation({ referrer_id: "r-1" })],
    ["2026-05", "2026-06"],
    { "r-1": "岸幸星" },
  );
  assert.equal(got.state, "assigned");
  assert.equal(got.name, "岸幸星");
});

test("3. dash_referrer: 紹介者「-」が正式に設定されている", () => {
  const got = resolveState(
    [relation({ referrer_id: "r-dash" })],
    ["2026-05"],
    { "r-dash": "-" },
  );
  assert.equal(got.state, "dash_referrer", "「-」を assigned に混ぜてはいけない");
  assert.equal(got.name, "-");
});

test("4. none: 有効な紹介関係が無い＝未設定", () => {
  const got = resolveState([], ["2026-05"], {});
  assert.equal(got.state, "none");
  assert.equal(got.name, null);
});

test("5. out_of_period: 関係はあるが対象月を覆わない", () => {
  const got = resolveState(
    [relation({ referrer_id: "r-1", start_month: "2026-09" })],
    ["2026-05", "2026-06"],
    { "r-1": "岸幸星" },
  );
  assert.equal(got.state, "out_of_period");
});

test("6. conflict: 期間が重なる関係が2件ある", () => {
  const got = resolveState(
    [
      relation({ referrer_id: "r-1", start_month: "2026-05", end_month: "2026-10" }),
      relation({
        referrer_id: "r-2",
        start_month: "2026-09",
        created_at: "2026-09-27T00:00:00Z",
      }),
    ],
    ["2026-09"],
    { "r-1": "A", "r-2": "B" },
  );
  assert.equal(got.state, "conflict");
});

test("7. 「-」と未設定を混同しない", () => {
  const dash = resolveState([relation({ referrer_id: "r-dash" })], ["2026-05"], {
    "r-dash": "-",
  });
  const none = resolveState([], ["2026-05"], {});

  assert.notEqual(dash.state, none.state, "同じ状態にしてはいけない");
  assert.equal(dash.state, "dash_referrer");
  assert.equal(none.state, "none");

  // 型に placeholder という名前を使わない（「-」は正式な紹介者）
  assert.equal(
    /"placeholder"/.test(QUERIES),
    false,
    "「-」を placeholder 扱いしている",
  );
  assert.match(QUERIES, /"dash_referrer"/);

  // 表記ゆれも拾う
  for (const name of ["-", " - ", "−", "ー", "—"]) {
    assert.equal(tap.isDashReferrerName(name), true, `${name} を「-」と認識しない`);
  }
  for (const name of ["岸幸星", "", null, undefined, "--"]) {
    assert.equal(tap.isDashReferrerName(name), false, `${name} を「-」と誤認`);
  }
});

// =============================================================================
// 8〜9. 入力漏れ警告の対象
// =============================================================================
test("8. self_operated / account_lending は入力漏れ警告に含めない", () => {
  /*
    区分により紹介報酬の対象外なので、紹介者が無くても入力漏れではない。
    混ぜると警告の人数と金額が過大になる。
  */
  for (const t of ["self_operated", "account_lending"]) {
    assert.equal(accountTypes.isReferralRewardEligibleType(t), false, `${t} が対象になっている`);
  }
  assert.match(
    QUERIES,
    /row\.referrerState === "none" && row\.referralEligibleType/,
    "警告対象を区分で絞っていない",
  );
});

test("9. standard かつ未設定を警告対象にする", () => {
  assert.equal(accountTypes.isReferralRewardEligibleType("standard"), true);
  assert.match(QUERIES, /missingReferrerCreatorCount: missingReferrer\.length/);
  assert.match(QUERIES, /missingReferrerBaseAmount/);
  assert.match(QUERIES, /missingReferrerEstimatedReward/);
});

// =============================================================================
// 10〜11. 金額
// =============================================================================
test("10. 算定元は referralBaseAmount（W + X）を通す", () => {
  assert.equal(engine.referralBaseAmount({ partner_estimated_commission: 1680 }), 1680);
  assert.equal(
    engine.referralBaseAmount({ partner_shop_ads_estimated_commission: 265 }),
    265,
  );
  assert.equal(
    engine.referralBaseAmount({
      partner_estimated_commission: 100,
      partner_shop_ads_estimated_commission: 50,
    }),
    150,
  );
  // ボーナスは入れない
  assert.equal(
    engine.referralBaseAmount({
      partner_estimated_commission: 100,
      partner_bonus_estimated_commission: 900,
    }),
    100,
  );

  assert.match(
    QUERIES,
    /bucket\.referralBase\.push\(referralBaseAmount\(line\)\)/,
    "算定元を自前で足し直している",
  );
  assert.equal(
    /partner_estimated_commission\s*\)\s*\+\s*toAmount/.test(QUERIES),
    false,
    "W と X を直接足している箇所がある",
  );
});

test("11. 想定紹介報酬は REFERRAL_REWARD_RATE を使う（5% をベタ書きしない）", () => {
  assert.equal(engine.REFERRAL_REWARD_RATE, 0.05);
  assert.match(QUERIES, /referralBase \* REFERRAL_REWARD_RATE/);
  assert.equal(
    /estimatedReferralReward[^\n]*0\.05/.test(QUERIES),
    false,
    "料率をベタ書きしている",
  );
});

// =============================================================================
// 12〜13. フィルター
// =============================================================================
test("12. 紹介者未設定だけを絞り込める", () => {
  assert.match(UI_RAW, /\{ key: "none", label: "紹介者: 未設定" \}/);
  assert.match(UI_RAW, /\{ key: "dash_referrer", label: "紹介者: 「-」設定済み" \}/);
  // 「-」と未設定が同じ選択肢になっていない
  assert.equal(
    /key: "none"[^\n]*「-」/.test(UI_RAW),
    false,
    "未設定の選択肢に「-」を混ぜている",
  );
});

test("13. 要確認は未設定・期間外・異常をまとめる", () => {
  assert.match(UI_RAW, /\{ key: "review", label: "紹介者: 要確認" \}/);
  assert.match(
    UI_RAW,
    /state === "none" \|\| state === "out_of_period" \|\| state === "conflict"/,
  );
  assert.match(QUERIES, /export function needsReferrerReview/);
  for (const [state, expected] of [
    ["none", true],
    ["out_of_period", true],
    ["conflict", true],
    ["assigned", false],
    ["dash_referrer", false],
  ]) {
    assert.equal(
      tap.needsReferrerReview(state),
      expected,
      `${state} の要確認判定が違う`,
    );
  }
});

// =============================================================================
// 14. 月別の警告判定
// =============================================================================
test("14. 警告は月ごとに判定する（後の月のTAPで過去月を警告しない）", () => {
  /*
    2026-09 開始の紹介関係しか無いクリエイターに 2026-05 の TAP がある場合、
    2026-05 は未設定として警告するが、2026-09 は警告しない。
  */
  const rows = [relation({ referrer_id: "r-1", start_month: "2026-09" })];
  const index = period.buildReferralPeriods(rows);
  const periods = index.byCreator.get(CREATOR);

  assert.equal(
    period.resolveReferralForMonth(periods, "2026-05").period,
    null,
    "2026-05 は覆われていない",
  );
  assert.ok(
    period.resolveReferralForMonth(periods, "2026-09").period,
    "2026-09 は覆われている",
  );

  // 実装が月ごとに解決していること
  assert.match(
    QUERIES,
    /resolveReferralForMonth\(\s*index\.byCreator\.get\(creatorId\),\s*targetMonth,\s*\)/,
    "月ごとに解決していない",
  );
  assert.match(QUERIES, /export type ReferrerGapMonth/);
  assert.match(QUERIES, /targetMonth: string;/);
});

// =============================================================================
// 15〜16. 副作用が無いこと
// =============================================================================
test("15. 紹介者を自動登録しない（この経路は読むだけ）", () => {
  for (const forbidden of [/\.insert\(/, /\.update\(/, /\.upsert\(/, /\.delete\(/]) {
    assert.equal(
      forbidden.test(QUERIES),
      false,
      `TAP実績の集計が書き込んでいる: ${forbidden}`,
    );
  }
  // 「-」を既定値として埋めていない
  assert.equal(
    /referrerName = "-"/.test(QUERIES),
    false,
    "紹介者名に「-」を勝手に埋めている",
  );
});

test("16. 既存の reward / payout ロジックへ影響しない", () => {
  /*
    紹介報酬の金額は referral_reward_items の実績をそのまま出す。
    この画面で作り直さない（生成側と食い違う元になる）。
  */
  assert.match(QUERIES, /referralRewardAmount: sumReferralAmounts\(reward\?\.amounts \?\? \[\]\)/);
  assert.equal(
    /computeReferralReward\(/.test(QUERIES),
    false,
    "TAP実績側で報酬を計算し直している",
  );

  // 生成側は従来どおり
  const sync = readFileSync(
    path.join(root, "lib/referrals/sync-referral-rewards.ts"),
    "utf8",
  );
  assert.match(sync, /buildReferralPeriods\(/);
  assert.match(sync, /computeReferralReward\(/);
  assert.equal(
    /tap-creator-queries/.test(sync),
    false,
    "生成側が表示用の集計に依存している",
  );
});

// =============================================================================
// 確認範囲と支払上限の分離（2026-09-30 追加）
//
// MAX_REFERRAL_PAYMENT_CUTOFF_MONTH（2026-07）は「紹介報酬を支払って
// よい最後の締め月」で、TAP が全量確定していない月を支払わないための
// 歯止め。2026-08 は 1,343 行中 871 行が未払い（支払済 35.1%）なので、
// 支払上限は動かさない。
//
// 一方、月次確定の対象には 2026-08 が含まれている。確定できる月の
// 紹介者の入力漏れを確認できないと見逃すので、確認範囲だけを
// 月次確定の対象月に合わせる。確認は読むだけで支払を発生させない。
// =============================================================================

test("支払上限は 2026-07 のまま動かさない", () => {
  assert.equal(cutoff.MAX_REFERRAL_PAYMENT_CUTOFF_MONTH, "2026-07");

  // 支払候補の判定は支払上限で絞り続ける
  assert.match(
    codeOnly(PAYMENT_QUERIES_RAW),
    /targetMonth <= MAX_REFERRAL_PAYMENT_CUTOFF_MONTH/,
    "支払候補の上限が外れている",
  );
  assert.match(
    codeOnly(PAYMENT_QUERIES_RAW),
    /params\.cutoffMonth > MAX_REFERRAL_PAYMENT_CUTOFF_MONTH/,
    "内訳表示のクランプが外れている",
  );
});

test("claim RPC の 2026-07 上限を維持する", () => {
  const migration = read(
    "supabase/migrations/20260927200000_referral_payment_hold.sql",
  );
  assert.match(
    migration,
    /if p_cutoff_month > '2026-07' then/,
    "claim RPC の上限が外れている",
  );
});

test("確認範囲は月次確定の対象月から決める（固定値にしない）", () => {
  assert.match(QUERIES, /export async function resolveReferralReviewEndMonth/);
  assert.match(
    QUERIES,
    /supabase\.rpc\("list_referral_month_settlements"\)/,
    "settlement を既存の安全な RPC から読んでいない",
  );
  // 権限を緩めていない
  assert.equal(
    /\.from\("referral_month_settlements"\)/.test(QUERIES),
    false,
    "settlement をテーブルから直接読んでいる",
  );
  // 取得できなければ支払上限まで狭める（広げる方向へ倒さない）
  assert.match(QUERIES, /if \(error\) return MAX_REFERRAL_PAYMENT_CUTOFF_MONTH;/);
  assert.match(
    QUERIES,
    /latest < MAX_REFERRAL_PAYMENT_CUTOFF_MONTH\s*\?\s*MAX_REFERRAL_PAYMENT_CUTOFF_MONTH\s*:\s*latest/,
    "確定対象が支払上限より手前のとき狭い方に合わせていない",
  );
});

test("確認範囲は呼び出し側から渡せる（集計側で固定しない）", () => {
  assert.match(QUERIES, /options\.endMonth \?\? MAX_REFERRAL_PAYMENT_CUTOFF_MONTH/);
  assert.match(
    QUERIES,
    /export async function fetchReferrerGapSummary\(\s*supabase: SupabaseClient,\s*options: \{ endMonth\?: string \} = \{\},/,
    "gap 集計が範囲を受け取れない",
  );
  // Server Action が確認範囲を解決して渡している
  assert.match(ACTIONS, /resolveReferralReviewEndMonth\(auth\.supabase\)/);
  assert.match(ACTIONS, /fetchTapCreatorOverview\(getSupabaseAdmin\(\), \{ endMonth \}\)/);
  assert.match(ACTIONS, /fetchReferrerGapSummary\(getSupabaseAdmin\(\), \{ endMonth \}\)/);
});

test("確認範囲を広げても支払候補へ混入しない", () => {
  /*
    確認範囲（endMonth）は TAP実績と gap 集計にしか渡していない。
    支払候補を作る fetchPaymentOverview には渡らない。
  */
  assert.equal(
    /fetchPaymentOverview\([^)]*endMonth/.test(ACTIONS),
    false,
    "確認範囲が支払候補の集計へ渡っている",
  );
  // 支払側は MAX_REFERRAL_PAYMENT_CUTOFF_MONTH だけを見る
  const payment = codeOnly(PAYMENT_QUERIES_RAW);
  assert.equal(
    /resolveReferralReviewEndMonth/.test(payment),
    false,
    "支払側が確認範囲を参照している",
  );
  assert.equal(
    /referral_month_settlements/.test(payment),
    false,
    "支払側が確定状況で範囲を決めている",
  );
});

test("画面で支払上限と確認範囲を取り違えさせない", () => {
  // gap は両方を返す
  assert.match(QUERIES, /endMonth: string;/);
  assert.match(QUERIES, /paymentCutoffMonth: string;/);
  assert.match(QUERIES, /paymentCutoffMonth: MAX_REFERRAL_PAYMENT_CUTOFF_MONTH/);

  // 画面が両方を出す
  assert.ok(UI_RAW.includes("確認対象："), "確認範囲を表示していない");
  assert.ok(UI_RAW.includes("支払可能な締め月："), "支払上限を表示していない");
  // 支払上限より後の月に注記を出す
  assert.match(
    UI_RAW,
    /row\.targetMonth > MAX_REFERRAL_PAYMENT_CUTOFF_MONTH/,
    "支払上限より後の月の注記が無い",
  );
  assert.ok(UI_RAW.includes("TAP未確定・支払対象外"));
});

test("確認範囲は正式な対象行の条件で数える（監査の概算とは一致しない）", () => {
  /*
    母集団は isTapReferralSourceLine を通す。未払い・未決済・返金済みの
    行は「報酬が発生した」とは言えないので除く。

    W+X>0 だけで数えた概算（153名）より少なくなるのが正しい。
    2026-08 は 1,343 行中 871 行が未払いで、その分が落ちる。
  */
  assert.match(QUERIES, /isTapReferralSourceLine\(/);

  // gap 側は「その月を覆う関係が無い」で判定する。
  // 「active relation が無い」だけで数えると、関係はあるが対象月を
  // 覆わない creator（期間外）を取りこぼす。
  assert.match(
    QUERIES,
    /if \(resolution\.period\?\.referrerId\) continue;/,
    "その月を覆うかで判定していない",
  );
  assert.equal(
    /cr\.is_active[^\n]*gap/i.test(QUERIES),
    false,
    "gap 判定を is_active だけで行っている",
  );
});

// =============================================================================
// TAP実績からの紹介者設定（2026-09-30 追加）
//
// 保存は既存の updateCreatorMasterAction が唯一の入口。
// 期間競合・月次確定・claim / paid のガードも audit log もそちらが持つ。
// saveCreatorReferralAction は月次確定のガードを通らないので使わない。
//
// 紹介者を登録しただけでは紹介報酬を作り直さない。
// =============================================================================
const CREATORS_UI_RAW = read("app/(app)/creators/CreatorMasterClient.tsx");
const ADMIN_REFERRALS_RAW = read("app/actions/admin-creator-referrals.ts");

/** ReferrerAssignPanel の本体だけを切り出す */
function assignPanelSource() {
  const start = UI_RAW.indexOf("function ReferrerAssignPanel");
  assert.ok(start >= 0, "ReferrerAssignPanel が無い");
  const end = UI_RAW.indexOf("function TapPerformanceTab", start);
  assert.ok(end > start, "パネルの終端が見つからない");
  return UI_RAW.slice(start, end);
}

test("設定ボタンは紹介者未設定の creator にだけ出す", () => {
  // none のときだけボタンとパネルを出す
  assert.match(
    UI_RAW,
    /\{row\.referrerState === "none" \? \(\s*assigning === row\.creatorId \? null : \(/,
    "未設定以外にもボタンを出している",
  );
  assert.match(
    UI_RAW,
    /row\.referrerState === "none" && assigning === row\.creatorId \? \(\s*<ReferrerAssignPanel/,
    "パネルの表示条件が未設定に限定されていない",
  );

  // assigned / dash_referrer / out_of_period / conflict には出さない
  for (const state of ["assigned", "dash_referrer", "out_of_period", "conflict"]) {
    assert.equal(
      new RegExp(`referrerState === "${state}"[^\\n]*紹介者を設定`).test(UI_RAW),
      false,
      `${state} に新規設定ボタンを出している`,
    );
  }
});

test("期間外・relation異常は今回このUIから触らない", () => {
  const panel = assignPanelSource();
  // パネル自体が「現在の紹介者：未設定」を前提に書かれている
  assert.match(panel, /現在の紹介者：/);
  assert.match(panel, /未設定/);
  // 既存関係を解除する操作を置かない
  assert.equal(/紹介者を外す|unlink/.test(panel), false, "解除操作を置いている");
});

test("「-」も正式な紹介者として選べる", () => {
  const panel = assignPanelSource();
  /*
    有効な紹介者はすべて選択肢に出す。名前で弾かない。
    「-」は取込時に作られた名前だが管理者が正式に設定した紹介者で、
    未設定のままにすることとは別。
  */
  assert.match(panel, /form\.referrers\s*\.filter\(\(referrer\) => referrer\.isActive\)/);
  assert.equal(
    /isDashReferrerName|!== "-"|name !== "-"/.test(panel),
    false,
    "「-」を選択肢から除いている",
  );
});

test("紹介開始月の初期値は firstEligibleMonth", () => {
  const panel = assignPanelSource();
  assert.match(
    panel,
    /useState\(row\.firstEligibleMonth\)/,
    "開始月の初期値が最初の対象月になっていない",
  );
  // firstEligibleMonth は正式条件を通った行から作る
  assert.match(QUERIES, /firstEligibleMonth: firstTargetMonth/);
  assert.match(QUERIES, /const months = \[\.\.\.bucket\.months\]\.sort\(\)/);
  // bucket は isTapReferralSourceLine を通った行だけを積む
  assert.match(QUERIES, /if \(\s*!isTapReferralSourceLine\(/);
});

test("/creators でも 既存startMonth > firstTapMonth > 今月 の順で決める", () => {
  // 既存関係があればその開始月を優先
  assert.match(
    CREATORS_UI_RAW,
    /useState\(\s*row\.referrerStartMonth \?\? currentMonthLabel\(\),\s*\)/,
    "既存の開始月を優先していない",
  );
  // 新規紐付けのときだけ firstTapMonth を採用
  assert.match(CREATORS_UI_RAW, /const adoptFirstTapMonth = async/);
  assert.match(
    CREATORS_UI_RAW,
    /nextReferrerId &&\s*!row\.referrerStartMonth &&\s*!startMonthTouched/,
    "既存関係の開始月まで書き換えている",
  );
  assert.match(CREATORS_UI_RAW, /result\.plan\.firstTapMonth/);
  // 管理者が触ったら自動補完しない
  assert.match(CREATORS_UI_RAW, /setStartMonthTouched\(true\)/);
});

test("プレビューは読むだけ", () => {
  const panel = assignPanelSource();
  assert.match(panel, /previewReferralChangeAction\(/);
  // プレビュー経路が書き込まない
  const plan = codeOnly(read("lib/referrals/referral-assignment-change.ts"));
  for (const forbidden of [/\.insert\(/, /\.update\(/, /\.upsert\(/, /\.delete\(/]) {
    assert.equal(forbidden.test(plan), false, `プレビューが書き込んでいる: ${forbidden}`);
  }
});

test("blocks があれば保存できない", () => {
  const panel = assignPanelSource();
  assert.match(panel, /const blocked = \(plan\?\.blocks\.length \?\? 0\) > 0;/);
  assert.match(panel, /disabled=\{busy \|\| blocked\}/, "ブロック時に保存できてしまう");
  assert.match(panel, /REFERRAL_CHANGE_BLOCK_LABEL\[reason\]/, "理由を表示していない");
});

test("保存は updateCreatorMasterAction だけを使う", () => {
  const panel = assignPanelSource();
  assert.match(panel, /await updateCreatorMasterAction\(null, body\)/);

  /*
    ガードの無い旧経路を使わない。
    コメントで名前に触れるのは構わないので、コードだけを見る。
  */
  assert.equal(
    /saveCreatorReferralAction/.test(UI),
    false,
    "saveCreatorReferralAction を使っている（月次確定のガードを通らない）",
  );
  // 旧経路がガードを持たないことを明示しておく
  assert.equal(
    /buildReferralChangePlan|canApplyReferralChange/.test(ADMIN_REFERRALS_RAW),
    false,
    "旧経路の前提が変わった。使ってよいか再検討する",
  );
  // 独自の更新処理を作らない
  assert.equal(
    /\.from\("creator_referrals"\)/.test(UI),
    false,
    "画面から creator_referrals を直接触っている",
  );
  assert.equal(
    /\.from\("creators"\)[\s\S]{0,40}\.update\(/.test(UI),
    false,
    "画面から creators を直接更新している",
  );
});

test("紹介者以外の現在値をそのまま送り返す（意図せず変えない）", () => {
  const panel = assignPanelSource();
  for (const field of ["agency_id", "commission_rate", "account_management_type"]) {
    assert.ok(panel.includes(`body.set("${field}"`), `${field} を送っていない`);
  }
  // 現在値は保存直前に読んだものを使う（画面の推測値を送らない）
  assert.match(panel, /form\.current\.agencyId/);
  assert.match(panel, /form\.current\.commissionRate/);
  assert.match(panel, /form\.current\.accountManagementType/);

  // 取得側が creators の現在値を読んでいる
  assert.match(
    ACTIONS,
    /\.select\("id, agency_id, commission_rate, account_management_type"\)/,
    "現在値の取得が足りない",
  );
  // 下ごしらえの action は書き込まない
  const prep = ACTIONS.slice(
    ACTIONS.indexOf("export async function fetchCreatorReferrerFormAction"),
    ACTIONS.indexOf("export type ReferrerGapActionResult"),
  );
  for (const forbidden of [/\.insert\(/, /\.update\(/, /\.upsert\(/, /\.delete\(/]) {
    assert.equal(forbidden.test(prep), false, `下ごしらえが書き込んでいる: ${forbidden}`);
  }
});

test("紹介者設定で reward / payout / settlement を自動で動かさない", () => {
  const panel = assignPanelSource();
  for (const forbidden of [
    /syncReferralRewardsForMonth/,
    /refreshReferralPayouts/,
    /finalizeReferralMonthAction/,
    /unfinalizeReferralMonthAction/,
    /claim/,
    /payment_batch/,
    /markReferralPayoutPaid/,
  ]) {
    assert.equal(forbidden.test(panel), false, `設定パネルが ${forbidden} を呼んでいる`);
  }

  // 保存経路も reward / payout を触らない
  const master = codeOnly(read("app/actions/update-creator-master.ts"));
  for (const table of ["referral_reward_items", "referral_payouts", "referral_month_settlements"]) {
    assert.equal(
      master.includes(`"${table}"`),
      false,
      `保存経路が ${table} を触っている`,
    );
  }
  const link = codeOnly(read("lib/referrals/link-creator-referrer.ts"));
  for (const table of ["referral_reward_items", "referral_payouts"]) {
    assert.equal(link.includes(`"${table}"`), false, `link が ${table} を触っている`);
  }
});

test("保存後は再計算されていないことを伝え、一覧を取り直す", () => {
  const panel = assignPanelSource();
  assert.match(panel, /紹介報酬はまだ再計算されていません/);
  assert.match(panel, /onDone/);
  // 一覧の再取得を親が行う
  assert.match(
    UI_RAW,
    /onDone=\{\(\) => \{\s*setAssigning\(null\);\s*void load\(\);\s*\}\}/,
    "保存後に一覧を取り直していない",
  );
});

test("紹介者未設定は成果報酬ベースの高い順に並ぶ", () => {
  // 既定の並びが成果報酬ベース
  assert.match(UI_RAW, /useState<TapSortKey>\("commissionBase"\)/);
  assert.match(
    UI_RAW,
    /\.sort\(\(a, b\) => b\[sortKey\] - a\[sortKey\]/,
    "降順になっていない",
  );
});

// =============================================================================
// 警告の母集団を揃える / 所属は月別管理画面へ渡す（2026-09-30 追加）
// =============================================================================
const ASSIGNMENT_UI_RAW = read(
  "app/(app)/admin/creator-assignment/CreatorAssignmentClient.tsx",
);
const ASSIGNMENT_PAGE_RAW = read("app/(app)/admin/creator-assignment/page.tsx");

test("gap 警告も一覧と同じ正式条件で数える", () => {
  /*
    gap だけ isTapReferralSourceLine を通していなかったため、
    未払い・未決済・返金済みの行だけを理由に警告へ入る creator が
    5名いた（いずれも 2026-08。あの月は 1,343 行中 871 行が未払い）。

    報酬が発生していない行を根拠に「紹介者の入力漏れ」と言ってはいけない。
    条件を揃えた結果として、一覧の入力漏れ件数と一致する。
  */
  const gap = QUERIES.slice(
    QUERIES.indexOf("export async function fetchReferrerGapSummary"),
  );
  assert.match(
    gap,
    /if \(\s*!isTapReferralSourceLine\(/,
    "gap 集計が正式な対象行の条件を通していない",
  );
  // 条件を書き写していない（既存関数を呼ぶ）
  for (const copied of [/決済済み/, /支払い済み/, /fully_refunded/]) {
    assert.equal(copied.test(gap), false, `対象条件を書き写している: ${copied}`);
  }
});

test("gap と一覧の入力漏れは同じ絞り込みで作る", () => {
  const gap = QUERIES.slice(
    QUERIES.indexOf("export async function fetchReferrerGapSummary"),
  );
  // どちらも「紹介報酬が発生しうる区分」だけを数える
  assert.match(gap, /if \(!eligibleById\.get\(creatorId\)\) continue;/);
  assert.match(QUERIES, /row\.referrerState === "none" && row\.referralEligibleType/);
  // どちらも算定元は referralBaseAmount を通す
  assert.match(gap, /const base = referralBaseAmount\(line\);/);
  assert.match(QUERIES, /bucket\.referralBase\.push\(referralBaseAmount\(line\)\)/);
  // gap は月ごとに覆われているかで判定する（一覧は creator 単位）
  assert.match(gap, /if \(resolution\.period\?\.referrerId\) continue;/);
});

test("所属はこの画面で書き換えず、月別管理画面へ対象を渡す", () => {
  // TAP実績から creator を指定して遷移する
  assert.match(
    UI_RAW,
    /\/admin\/creator-assignment\?creator=\$\{encodeURIComponent\(row\.tiktokId\)\}/,
    "対象を引き継ぐ導線が無い",
  );
  assert.ok(UI_RAW.includes("所属を確認・変更"));

  // TAP実績側では所属を書き換えない
  for (const forbidden of [
    /confirmMonthlyAgencyAssignmentAction/,
    /atomic_monthly_agency_assignment/,
    /bulk_confirm_monthly_agency_assignments/,
    /creator_monthly_agency_assignments/,
  ]) {
    assert.equal(
      forbidden.test(UI),
      false,
      `TAP実績が所属を書き換えている: ${forbidden}`,
    );
  }
  // 紹介者の保存に agency_id を混ぜない（現在値をそのまま返すだけ）
  const panel = assignPanelSource();
  assert.match(panel, /body\.set\("agency_id", form\.current\.agencyId\)/);
  assert.equal(
    /setAgency|selectAgency|agencyId, set/.test(panel),
    false,
    "紹介者パネルで所属を選ばせている",
  );
});

test("月別管理画面は creator 指定を受け取って絞り込む", () => {
  // page 側で受け取る
  assert.match(ASSIGNMENT_PAGE_RAW, /searchParams: Promise<\{ creator\?: string \}>/);
  assert.match(ASSIGNMENT_PAGE_RAW, /initialSearch={initialSearch}/);
  // 長すぎる値をそのまま使わない
  assert.match(ASSIGNMENT_PAGE_RAW, /\.trim\(\)\.slice\(0, 100\)/);

  // client 側で初期の検索語にする
  assert.match(ASSIGNMENT_UI_RAW, /initialSearch = ""/);
  assert.match(ASSIGNMENT_UI_RAW, /useState\(initialSearch\)/);
  // 指定されて開いたことが分かる
  assert.ok(ASSIGNMENT_UI_RAW.includes("TAP実績から"));
});
