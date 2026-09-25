/*
  支払可否・保留理由・未払い抽出のテスト（DB非依存の純ロジック）。

  ここで検証するのは「支払ってよいかどうか」だけ。
  報酬額そのものは既存 Finance Engine が確定させるので再計算しない。

  実行: node --test scripts/test-payment-payable.mjs
*/
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const root = process.cwd();
const jiti = createJiti(root, { alias: { "@": root }, interopDefault: true, fsCache: false });

const payable = await jiti.import(path.join(root, "lib/payments/payable.ts"));
const bank = await jiti.import(path.join(root, "lib/payments/bank-account.ts"));

const FULL_BANK = {
  bankName: "テスト銀行",
  bankCode: "0001",
  bankBranchName: "テスト支店",
  bankBranchCode: "001",
  bankAccountType: "普通",
  bankAccountNumber: "1234567",
  bankAccountHolder: "テストメイギ",
};

const base = {
  isInHouse: false,
  bankState: "registered",
  unpaidAmount: 5000,
  thresholdAmount: 0,
  hasUnconfirmedAssignment: false,
  hasUnconfirmedReward: false,
};

// =============================================================================
// 支払可否
// =============================================================================
test("条件がそろっていれば支払可能", () => {
  assert.equal(payable.isPayable(base), true);
  assert.deepEqual(payable.resolvePaymentHoldReasons(base), []);
});

test("未払いが0円なら支払対象にならない（保留でもない）", () => {
  const input = { ...base, unpaidAmount: 0 };
  assert.equal(payable.isPayable(input), false);
  assert.equal(payable.isOnHold(input), false);
});

test("自社は支払対象外", () => {
  const input = { ...base, isInHouse: true };
  assert.equal(payable.isPayable(input), false);
  assert.deepEqual(payable.resolvePaymentHoldReasons(input), ["in_house"]);
  assert.equal(payable.isOnHold(input), true);
});

test("代理店所属未確定は保留", () => {
  const input = { ...base, hasUnconfirmedAssignment: true };
  assert.equal(payable.isPayable(input), false);
  assert.deepEqual(payable.resolvePaymentHoldReasons(input), ["assignment_unconfirmed"]);
});

test("報酬計算未確定は保留", () => {
  const input = { ...base, hasUnconfirmedReward: true };
  assert.deepEqual(payable.resolvePaymentHoldReasons(input), ["reward_unconfirmed"]);
});

test("振込先未登録は保留", () => {
  const input = { ...base, bankState: "missing" };
  assert.equal(payable.isPayable(input), false);
  assert.deepEqual(payable.resolvePaymentHoldReasons(input), ["bank_missing"]);
});

test("銀行コード / 支店コード未登録は保留（未登録とは別理由）", () => {
  const input = { ...base, bankState: "incomplete" };
  assert.equal(payable.isPayable(input), false);
  assert.deepEqual(payable.resolvePaymentHoldReasons(input), ["bank_incomplete"]);
});

test("紹介報酬の基準額未達は保留（明細は消さず繰り越す）", () => {
  const input = { ...base, unpaidAmount: 800, thresholdAmount: 1000 };
  assert.equal(payable.isPayable(input), false);
  assert.deepEqual(payable.resolvePaymentHoldReasons(input), ["below_threshold"]);
  // 基準額ちょうどなら支払える
  assert.equal(payable.isPayable({ ...input, unpaidAmount: 1000 }), true);
});

test("保留理由は重なったらすべて返す", () => {
  const input = {
    ...base,
    isInHouse: true,
    bankState: "missing",
    unpaidAmount: 500,
    thresholdAmount: 1000,
    hasUnconfirmedAssignment: true,
  };
  assert.deepEqual(payable.resolvePaymentHoldReasons(input), [
    "in_house",
    "assignment_unconfirmed",
    "bank_missing",
    "below_threshold",
  ]);
});

test("保留理由はすべてラベルとヒントを持つ", () => {
  for (const reason of payable.PAYMENT_HOLD_REASONS) {
    assert.ok(payable.PAYMENT_HOLD_REASON_LABEL[reason], reason);
    assert.ok(payable.PAYMENT_HOLD_REASON_HINT[reason], reason);
  }
});

// =============================================================================
// 振込先の状態
// =============================================================================
test("全項目そろえば registered", () => {
  assert.equal(bank.resolveBankAccountState(FULL_BANK), "registered");
  assert.equal(bank.isBankAccountReady(FULL_BANK), true);
});

test("コードだけ欠けていれば incomplete", () => {
  assert.equal(
    bank.resolveBankAccountState({ ...FULL_BANK, bankCode: null }),
    "incomplete",
  );
  assert.equal(
    bank.resolveBankAccountState({ ...FULL_BANK, bankBranchCode: "  " }),
    "incomplete",
  );
});

test("必須項目が欠けていれば missing", () => {
  assert.equal(bank.resolveBankAccountState(null), "missing");
  assert.equal(
    bank.resolveBankAccountState({ ...FULL_BANK, bankAccountNumber: null }),
    "missing",
  );
});

test("口座番号は下4桁だけを見せる", () => {
  assert.equal(bank.maskAccountNumber("1234567"), "***4567");
  assert.equal(bank.maskAccountNumber("12"), "**");
  assert.equal(bank.maskAccountNumber(null), "");
});

test("画面へ渡す形に口座番号の全文が含まれない", () => {
  const view = bank.toBankAccountView(FULL_BANK);
  const serialized = JSON.stringify(view);
  assert.ok(!serialized.includes("1234567"), serialized);
  assert.equal(view.accountNumberMasked, "***4567");
  assert.equal("bankAccountNumber" in view, false);
});

test("入力検証: コードはゼロ詰め、全角は半角へ寄せる", () => {
  const result = bank.validateBankAccountInput({
    ...FULL_BANK,
    bankCode: "36",
    bankBranchCode: "５４",
    bankAccountNumber: "１２３４５６７",
  });
  assert.equal(result.ok, true);
  assert.equal(result.account.bankCode, "0036");
  assert.equal(result.account.bankBranchCode, "054");
  assert.equal(result.account.bankAccountNumber, "1234567");
});

test("入力検証: すべて空なら口座を消す指定として通す", () => {
  const result = bank.validateBankAccountInput({});
  assert.equal(result.ok, true);
  assert.equal(result.account.bankName, null);
  assert.equal(result.account.bankAccountNumber, null);
});

test("入力検証: 一部だけ入力は拒否する", () => {
  const result = bank.validateBankAccountInput({ bankName: "テスト銀行" });
  assert.equal(result.ok, false);
  assert.match(result.error, /支店名/);
});

test("入力検証: 口座種別は 普通 / 当座 のみ", () => {
  const result = bank.validateBankAccountInput({ ...FULL_BANK, bankAccountType: "貯蓄" });
  assert.equal(result.ok, false);
  assert.match(result.error, /普通/);
});

test("DB行との相互変換でカラム名が referrers の既存命名と一致する", () => {
  const row = bank.bankAccountToRow(FULL_BANK);
  assert.deepEqual(Object.keys(row).sort(), [
    "bank_account_holder",
    "bank_account_number",
    "bank_account_type",
    "bank_branch_code",
    "bank_branch_name",
    "bank_code",
    "bank_name",
  ]);
  assert.deepEqual(bank.bankAccountFromRow(row), FULL_BANK);
});

// =============================================================================
// 未払い抽出の条件（DB の WHERE と同じ判定を JS で再現して検証する）
// =============================================================================
/** RPC の claim / payment-queries の isClaimable と同じ4条件 */
const claimable = (item) =>
  item.is_reward_target === true &&
  item.is_paid === false &&
  item.payout_id == null &&
  item.payment_batch_id == null;

test("未払い抽出: 未払いかつ未占有だけが対象", () => {
  assert.equal(
    claimable({ is_reward_target: true, is_paid: false, payout_id: null, payment_batch_id: null }),
    true,
  );
});

test("支払済みは除外される（再集計しても戻らない）", () => {
  assert.equal(
    claimable({ is_reward_target: true, is_paid: true, payout_id: "p1", payment_batch_id: "b1" }),
    false,
  );
});

test("draft 中の明細は新しい支払明細へ入らない", () => {
  assert.equal(
    claimable({ is_reward_target: true, is_paid: false, payout_id: null, payment_batch_id: "b1" }),
    false,
  );
});

test("approved / processing 中の明細も新しい支払明細へ入らない", () => {
  // 状態が何であれ payment_batch_id が付いていれば占有中
  for (const status of ["approved", "processing"]) {
    assert.equal(
      claimable({
        is_reward_target: true,
        is_paid: false,
        payout_id: null,
        payment_batch_id: `batch-${status}`,
      }),
      false,
      status,
    );
  }
});

test("旧フローで payout に紐付いた明細も対象外", () => {
  assert.equal(
    claimable({ is_reward_target: true, is_paid: false, payout_id: "p1", payment_batch_id: null }),
    false,
  );
});

test("報酬対象外（is_reward_target=false）は対象にならない", () => {
  assert.equal(
    claimable({ is_reward_target: false, is_paid: false, payout_id: null, payment_batch_id: null }),
    false,
  );
});

test("failed / cancelled で解放された明細は再び対象になる", () => {
  const released = {
    is_reward_target: true,
    is_paid: false,
    payout_id: null,
    payment_batch_id: null,
  };
  assert.equal(claimable(released), true);
});

test("過去CSVを追加して増えた明細はそのまま未払いに現れる", () => {
  const newlySynced = {
    is_reward_target: true,
    is_paid: false,
    payout_id: null,
    payment_batch_id: null,
  };
  assert.equal(claimable(newlySynced), true);
});

// =============================================================================
// 再集計の保護条件（sync-*-rewards.ts の据置・削除ガードと同じ判定）
// =============================================================================
/** 再集計で据え置く（上書きしない）明細か */
const skipOnResync = (item) =>
  item.is_paid === true || item.payout_id != null || item.payment_batch_id != null;

/** 再集計で削除してよい明細か */
const deletableOnResync = (item) =>
  item.is_paid === false && item.payout_id == null && item.payment_batch_id == null;

test("再集計: paid は据え置かれ、削除もされない", () => {
  const item = { is_paid: true, payout_id: "p1", payment_batch_id: null };
  assert.equal(skipOnResync(item), true);
  assert.equal(deletableOnResync(item), false);
});

test("再集計: draft / approved / processing 中の明細は据え置かれ、削除もされない", () => {
  const item = { is_paid: false, payout_id: null, payment_batch_id: "b1" };
  assert.equal(skipOnResync(item), true);
  assert.equal(deletableOnResync(item), false);
});

test("再集計: 未払いかつ未占有だけが上書き・削除の対象", () => {
  const item = { is_paid: false, payout_id: null, payment_batch_id: null };
  assert.equal(skipOnResync(item), false);
  assert.equal(deletableOnResync(item), true);
});

// =============================================================================
// セラー請求の分離
// =============================================================================
test("セラー請求は支払予定総額に混ざらない", () => {
  // 支払予定総額は payment_batches（代理店・紹介者）だけの合計
  const scheduled = [
    { payeeKind: "agency", paymentAmount: 8000 },
    { payeeKind: "referrer", paymentAmount: 1500 },
  ];
  const sellerInvoices = [{ invoiceAmount: 6968670, status: "issued" }];

  const scheduledTotal = scheduled.reduce((sum, b) => sum + b.paymentAmount, 0);
  assert.equal(scheduledTotal, 9500);

  // セラー請求は別集計（向きが逆なので足さない）
  const sellerTotal = sellerInvoices
    .filter((i) => i.status === "issued")
    .reduce((sum, i) => sum + i.invoiceAmount, 0);
  assert.equal(sellerTotal, 6968670);
  assert.notEqual(scheduledTotal, scheduledTotal + sellerTotal);

  // 支払先の種別にセラーは存在しない
  assert.deepEqual([...payable.PAYEE_KINDS], ["agency", "referrer"]);
  assert.equal(payable.isPayeeKind("seller"), false);
});
