/*
  紹介報酬の「発生」と「支払」を分ける仕組みのテスト。

  DBへは接続せず、判定ロジックと migration / 実装コードの内容を確かめる。
  実行: node --test scripts/test-referral-payment-hold.mjs

  ■ このテストが守っているもの
  ① 「今回は支払わない」にした明細が claim されないこと（DB側の歯止め）
  ② TAP 再集計で EMI の判断が消えないこと
  ③ 発生データ（reward_amount 等）に触らないこと
  ④ 2026-08 以降を紹介者の支払対象に混ぜないこと
  ⑤ 代理店所属・自社だけを理由に紹介者を一覧から消さないこと
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

const payable = await jiti.import(path.join(root, "lib/payments/payable.ts"));
const cutoff = await jiti.import(path.join(root, "lib/payments/cutoff-month.ts"));
const engine = await jiti.import(
  path.join(root, "lib/referrals/referral-reward-engine.ts"),
);
const minimum = await jiti.import(path.join(root, "lib/payments/minimum-payout.ts"));

const MIGRATION = readFileSync(
  path.join(root, "supabase/migrations/20260927200000_referral_payment_hold.sql"),
  "utf8",
);
const SYNC = readFileSync(
  path.join(root, "lib/referrals/sync-referral-rewards.ts"),
  "utf8",
);
const QUERIES = readFileSync(path.join(root, "lib/db/payment-queries.ts"), "utf8");
const ACTIONS = readFileSync(path.join(root, "app/actions/payments.ts"), "utf8");

/** コメントを除いたコード本体（コメント中の文字列で誤検知しないため） */
function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, "");
}

/** claim RPC の紹介報酬占有ブロックだけを取り出す */
function referralClaimBlock() {
  const code = codeOnly(MIGRATION);
  const start = code.indexOf("update public.referral_reward_items\n         set payment_batch_id");
  assert.ok(start >= 0, "紹介報酬の占有クエリが見つからない");
  return code.slice(start, code.indexOf("returning", start));
}

// =============================================================================
// 1 / 11. manual_hold は claim されない・二重claim防止は維持
// =============================================================================
test("1. claim の紹介報酬条件に payment_hold_reason is null がある", () => {
  assert.match(
    referralClaimBlock(),
    /and payment_hold_reason is null/,
    "手動保留した明細が claim されてしまう",
  );
});

test("11. 二重支払い防止の既存4条件が残っている", () => {
  const block = referralClaimBlock();
  for (const condition of [
    /and is_reward_target = true/,
    /and is_paid = false/,
    /and payout_id is null/,
    /and payment_batch_id is null/,
  ]) {
    assert.match(block, condition, `二重支払い防止条件が消えている: ${condition}`);
  }
});

test("11-b. 画面の支払可能額も claim と同じ条件で数える", () => {
  const code = codeOnly(QUERIES);
  const start = code.indexOf("function isClaimable");
  const block = code.slice(start, code.indexOf("}", code.indexOf("return", start)));
  assert.match(block, /item\.payment_hold_reason == null/);
  assert.match(block, /!item\.is_paid/);
  assert.match(block, /item\.payout_id == null/);
  assert.match(block, /item\.payment_batch_id == null/);
});

// =============================================================================
// 2. 解除すれば支払候補へ戻る
// =============================================================================
test("2. 解除RPCは payment_hold_reason を null に戻す", () => {
  const code = codeOnly(MIGRATION);
  const start = code.indexOf("function public.clear_referral_payment_hold");
  const block = code.slice(start, code.indexOf("$fn$;", start));
  assert.match(block, /set payment_hold_reason = null/);
  assert.match(block, /payment_hold_set_by = null/);
  assert.match(block, /payment_hold_set_at = null/);
});

test("2-b. 解除後は他条件を満たせば支払候補になる（保留理由が立たない）", () => {
  const reasons = payable.resolvePaymentHoldReasons({
    isInHouse: false,
    bankState: "complete",
    unpaidAmount: 5000,
    thresholdAmount: 1000,
    hasUnconfirmedAssignment: false,
    hasUnconfirmedReward: false,
    isFullyManualHeld: false,
  });
  assert.deepEqual(reasons, []);
  assert.equal(
    payable.isPayable({
      isInHouse: false,
      bankState: "complete",
      unpaidAmount: 5000,
      thresholdAmount: 1000,
      hasUnconfirmedAssignment: false,
      hasUnconfirmedReward: false,
      isFullyManualHeld: false,
    }),
    true,
  );
});

test("2-c. 全額が手動保留のときだけ保留理由に出す（一部保留は支払可能）", () => {
  // 全額保留 → 保留タブに理由付きで残す（黙って消さない）
  assert.ok(
    payable
      .resolvePaymentHoldReasons({
        isInHouse: false,
        bankState: "complete",
        unpaidAmount: 0,
        thresholdAmount: 1000,
        hasUnconfirmedAssignment: false,
        hasUnconfirmedReward: false,
        isFullyManualHeld: true,
      })
      .includes("manual_hold"),
  );
  // 一部だけ保留 → 残りは普通に支払える
  assert.deepEqual(
    payable.resolvePaymentHoldReasons({
      isInHouse: false,
      bankState: "complete",
      unpaidAmount: 3000,
      thresholdAmount: 1000,
      hasUnconfirmedAssignment: false,
      hasUnconfirmedReward: false,
      isFullyManualHeld: false,
    }),
    [],
  );
});

// =============================================================================
// 3 / 4. claim済み・支払済みには hold を付けられない
// =============================================================================
test("3/4. hold設定RPCは支払済み・payout紐付き・占有中を除外する", () => {
  const code = codeOnly(MIGRATION);
  const start = code.indexOf("function public.set_referral_payment_hold");
  const block = code.slice(start, code.indexOf("$fn$;", start));

  assert.match(block, /and is_paid = false/, "支払済みに付けられてしまう");
  assert.match(block, /and payout_id is null/, "payout紐付きに付けられてしまう");
  assert.match(block, /and payment_batch_id is null/, "占有中に付けられてしまう");
  assert.match(block, /and payment_hold_reason is null/, "二重に数えてしまう");
});

test("3/4-b. hold解除RPCも同じ安全条件を持つ", () => {
  const code = codeOnly(MIGRATION);
  const start = code.indexOf("function public.clear_referral_payment_hold");
  const block = code.slice(start, code.indexOf("$fn$;", start));

  assert.match(block, /and is_paid = false/);
  assert.match(block, /and payout_id is null/);
  assert.match(block, /and payment_batch_id is null/);
});

test("3/4-c. hold RPC は管理者のみ", () => {
  const code = codeOnly(MIGRATION);
  const setBlock = code.slice(
    code.indexOf("function public.set_referral_payment_hold"),
    code.indexOf("$fn$;", code.indexOf("function public.set_referral_payment_hold")),
  );
  const clearBlock = code.slice(
    code.indexOf("function public.clear_referral_payment_hold"),
    code.indexOf("$fn$;", code.indexOf("function public.clear_referral_payment_hold")),
  );
  assert.match(setBlock, /is_app_admin\(\)/);
  assert.match(clearBlock, /is_app_admin\(\)/);
  assert.match(MIGRATION, /revoke all on function public\.set_referral_payment_hold/);
  assert.match(MIGRATION, /revoke all on function public\.clear_referral_payment_hold/);
});

// =============================================================================
// 5. TAP sync で manual_hold が消えない
// =============================================================================
test("5. sync の upsert に payment_hold 列が含まれていない", () => {
  const code = codeOnly(SYNC);
  const start = code.indexOf("upserts.push({");
  const block = code.slice(start, code.indexOf("});", start));

  assert.ok(start >= 0, "upsert の組み立てが見つからない");
  assert.equal(
    /payment_hold_reason/.test(block),
    false,
    "再集計で EMI の判断が上書きされる",
  );
  assert.equal(/payment_hold_set_by/.test(block), false);
  assert.equal(/payment_hold_set_at/.test(block), false);
});

test("5-b. sync のどこでも payment_hold 列を書かない", () => {
  const code = codeOnly(SYNC);
  assert.equal(
    /payment_hold/.test(code),
    false,
    "sync が payment_hold 列に触れている",
  );
});

// =============================================================================
// 3'. 発生データに触らない
// =============================================================================
test("migration は発生データの列を変更しない", () => {
  const code = codeOnly(MIGRATION);
  for (const column of [
    "reward_amount",
    "adjusted_reward_amount",
    "base_amount",
    "reward_rate",
    "source_row_key",
    "source_table",
    "is_reward_target",
  ]) {
    assert.equal(
      new RegExp(`set\\s+${column}\\s*=`).test(code),
      false,
      `発生データ ${column} を書き換えている`,
    );
    assert.equal(
      new RegExp(`drop column[\\s\\S]{0,40}${column}`).test(code),
      false,
      `発生データ ${column} を削除している`,
    );
  }
  assert.equal(
    /delete from public\.referral_reward_items/.test(code),
    false,
    "migration が報酬明細を削除している",
  );
});

test("agency_excluded は作らない（自動で支払対象外にしないため）", () => {
  /*
    コメントには「agency_excluded は作らない」という説明が入っている。
    判定はコード本体だけを見る（説明文で誤検知させない）。
  */
  assert.equal(
    /agency_excluded/.test(codeOnly(MIGRATION)),
    false,
    "migration のコードに agency_excluded がある",
  );
  assert.equal(
    payable.PAYMENT_HOLD_REASONS.includes("agency_excluded"),
    false,
    "保留理由に agency_excluded がある",
  );
  assert.match(
    MIGRATION,
    /check \(payment_hold_reason is null or payment_hold_reason = 'manual_hold'\)/,
    "CHECK が manual_hold 限定になっていない",
  );
});

// =============================================================================
// 6. ¥1,000 未満は繰越
// =============================================================================
test("6. 閾値は締め月までの累積で判定し、未満は below_threshold で繰越", () => {
  assert.equal(engine.REFERRAL_PAYOUT_THRESHOLD_YEN, 1000);
  assert.equal(minimum.DEFAULT_MINIMUM_PAYOUT_YEN, 1000);

  const reasons = payable.resolvePaymentHoldReasons({
    isInHouse: false,
    bankState: "complete",
    unpaidAmount: 999,
    thresholdAmount: 1000,
    hasUnconfirmedAssignment: false,
    hasUnconfirmedReward: false,
    isFullyManualHeld: false,
  });
  assert.deepEqual(reasons, ["below_threshold"]);

  // 単月ではなく累積。6月600 + 7月600 = 1,200 は支払対象
  assert.equal(
    engine.resolveAnnualPayoutState({ annualRewardAmount: 1200, paidAmount: 0 })
      .isPayable,
    true,
  );
  assert.equal(
    engine.resolveAnnualPayoutState({ annualRewardAmount: 600, paidAmount: 0 })
      .isPayable,
    false,
  );
});

test("6-b. 繰越と手動保留は別の理由として区別される", () => {
  const reasons = payable.resolvePaymentHoldReasons({
    isInHouse: false,
    bankState: "complete",
    unpaidAmount: 0,
    thresholdAmount: 1000,
    hasUnconfirmedAssignment: false,
    hasUnconfirmedReward: false,
    isFullyManualHeld: true,
  });
  assert.deepEqual(reasons, ["manual_hold"], "繰越と混ざっている");
});

// =============================================================================
// 7. 口座不足では claim できない（保留の設定はできる）
// =============================================================================
test("7. 口座未登録・コード欠けは保留理由になり支払不可", () => {
  for (const [state, reason] of [
    ["missing", "bank_missing"],
    ["incomplete", "bank_incomplete"],
  ]) {
    const input = {
      isInHouse: false,
      bankState: state,
      unpaidAmount: 5000,
      thresholdAmount: 1000,
      hasUnconfirmedAssignment: false,
      hasUnconfirmedReward: false,
      isFullyManualHeld: false,
    };
    assert.ok(payable.resolvePaymentHoldReasons(input).includes(reason));
    assert.equal(payable.isPayable(input), false);
  }
});

test("7-b. claim RPC は振込先と金融機関コードを必須にしている", () => {
  const code = codeOnly(MIGRATION);
  assert.match(code, /の振込先が未登録です/);
  assert.match(code, /の金融機関コード \/ 支店コードが未登録です/);
});

// =============================================================================
// 8. 2026-08 は選べない
// =============================================================================
test("8. 紹介者の締め月上限は 2026-07", () => {
  assert.equal(cutoff.MAX_REFERRAL_PAYMENT_CUTOFF_MONTH, "2026-07");
  assert.equal(cutoff.isReferralPaymentCutoffMonth("2026-07"), true);
  assert.equal(cutoff.isReferralPaymentCutoffMonth("2026-08"), false);
  assert.equal(cutoff.referralPaymentCutoffError("2026-07"), null);
  assert.ok(cutoff.referralPaymentCutoffError("2026-08"));
  assert.ok(cutoff.referralPaymentCutoffError("2026-09"));
});

test("8-b. claim RPC 側にも同じ上限がある（UIだけに頼らない）", () => {
  const code = codeOnly(MIGRATION);
  const start = code.indexOf("if p_payee_kind = 'referrer' then");
  const block = code.slice(start, code.indexOf("end if;", code.indexOf("assert_referral_months_finalized", start)));
  assert.match(block, /p_cutoff_month > '2026-07'/, "RPC に締め月上限が無い");
});

test("8-c. RPC と定数の上限が一致している", () => {
  const matched = MIGRATION.match(/p_cutoff_month > '(\d{4}-\d{2})'/);
  assert.ok(matched, "RPC の上限が読めない");
  assert.equal(
    matched[1],
    cutoff.MAX_REFERRAL_PAYMENT_CUTOFF_MONTH,
    "RPC と lib の上限がずれている",
  );
});

test("8-d. サーバーアクションも紹介者の締め月を検証する", () => {
  const code = codeOnly(ACTIONS);
  assert.match(code, /referralPaymentCutoffError\(cutoffMonth\)/);
  assert.match(
    code,
    /validateCutoff\(cutoffMonth, startMonth, payeeKind\)/,
    "claim 時に支払先区分を渡していない",
  );
});

test("8-e. 集計範囲も 2026-08 を含めない", () => {
  const code = codeOnly(QUERIES);
  assert.match(code, /MAX_REFERRAL_PAYMENT_CUTOFF_MONTH/);
  assert.match(
    code,
    /inReferralClaimRange/,
    "紹介報酬の集計に上限付きの範囲判定が無い",
  );
});

// =============================================================================
// 9. legacy agency_id guard の削除
// =============================================================================
test("9. referrers.agency_id だけを理由に紹介者claimを止めない", () => {
  const code = codeOnly(MIGRATION);
  assert.equal(
    /は代理店に帰属しています/.test(code),
    false,
    "legacy agency_id guard が残っている",
  );
  assert.equal(
    /v_referrer_agency_id/.test(code),
    false,
    "agency_id を claim の判定に使っている",
  );
});

test("9-b. 紹介報酬を代理店の支払へ合算しない", () => {
  const code = codeOnly(MIGRATION);
  const agencyBlock = code.slice(
    code.indexOf("if p_payee_kind = 'agency' then\n    with claimed as ("),
    code.indexOf("else\n    with claimed as ("),
  );
  assert.equal(
    /referral_reward_items/.test(agencyBlock),
    false,
    "代理店の claim が紹介報酬を占有している",
  );
});

// =============================================================================
// 10. in-house を理由に一覧から消さない
// =============================================================================
test("10. 自社を理由に支払対象から外すのは代理店だけ", () => {
  const code = codeOnly(MIGRATION);
  assert.match(
    code,
    /if p_payee_kind = 'agency' and v_is_in_house then/,
    "紹介者にも自社 guard が掛かっている",
  );
});

test("10-b. 一覧の自社判定も代理店だけに掛かる", () => {
  const code = codeOnly(QUERIES);
  assert.match(
    code,
    /isInHouse: payeeKind === "agency" && meta\?\.isInHouse === true/,
    "紹介者が自社だけを理由に支払不可になる",
  );
});

test("10-c. 紹介者の行を作る（一覧から消さない）", () => {
  const code = codeOnly(QUERIES);
  assert.match(code, /buildRow\(\s*"referrer"/, "紹介者行を作っていない");
  assert.equal(
    /紹介者の行は作らない/.test(QUERIES),
    false,
    "旧方針のコメントが残っている",
  );
});

// =============================================================================
// 12. 代理店側への影響なし
// =============================================================================
test("12. 代理店の claim 条件は変更されていない", () => {
  const code = codeOnly(MIGRATION);
  const start = code.indexOf("update public.agency_reward_items");
  const block = code.slice(start, code.indexOf("returning", start));

  assert.match(block, /and is_reward_target = true/);
  assert.match(block, /and is_paid = false/);
  assert.match(block, /and payout_id is null/);
  assert.match(block, /and payment_batch_id is null/);
  assert.equal(
    /payment_hold_reason/.test(block),
    false,
    "代理店側に紹介報酬用の条件が混ざっている",
  );
});

test("12-b. agency_reward_items に列を足していない", () => {
  const code = codeOnly(MIGRATION);
  assert.equal(
    /alter table public\.agency_reward_items/.test(code),
    false,
    "代理店の報酬テーブルを変更している",
  );
});

test("12-c. 代理店の最低支払額は変えていない", () => {
  assert.equal(minimum.AGENCY_PAYOUT_THRESHOLD_YEN, 1000);
});

// =============================================================================
// 監査情報
// =============================================================================
test("hold の設定者と時刻を保存する", () => {
  const code = codeOnly(MIGRATION);
  assert.match(code, /payment_hold_set_by = auth\.uid\(\)/);
  assert.match(code, /payment_hold_set_at = now\(\)/);
  assert.match(MIGRATION, /add column if not exists payment_hold_set_by uuid references auth\.users\(id\)/);
});
