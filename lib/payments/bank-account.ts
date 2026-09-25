/*
  支払先（代理店・紹介者）の振込先口座。

  ■ カラム名は referrers の既存カラムが正
    bank_name / bank_branch_name / bank_account_type /
    bank_account_number / bank_account_holder
  これに振込CSVで必要な bank_code / bank_branch_code を足したものを
  代理店・紹介者の共通形とする。

  ■ 口座番号の扱い
  口座番号の全文は「振込CSVを生成するサーバー側」だけが扱う。
  一覧・明細画面へは toBankAccountView() を通した形（下4桁マスク）
  しか渡さない。クライアントコンポーネントへ全文を渡さないこと。
*/

export type PayeeBankAccount = {
  bankName: string | null;
  bankCode: string | null;
  bankBranchName: string | null;
  bankBranchCode: string | null;
  bankAccountType: string | null;
  bankAccountNumber: string | null;
  bankAccountHolder: string | null;
};

/**
 * registered   振込CSVを出せる（全項目そろっている）
 * incomplete   振込はできるが金融機関コード / 支店コードが無くCSVを出せない
 * missing      口座そのものが未登録
 */
export type BankAccountState = "registered" | "incomplete" | "missing";

export const BANK_ACCOUNT_STATE_LABEL: Record<BankAccountState, string> = {
  registered: "登録済",
  incomplete: "不備",
  missing: "未登録",
};

/** 振込に最低限必要な項目 */
const CORE_FIELDS = [
  "bankName",
  "bankBranchName",
  "bankAccountType",
  "bankAccountNumber",
  "bankAccountHolder",
] as const;

/** 振込CSVに必要な追加項目 */
const CODE_FIELDS = ["bankCode", "bankBranchCode"] as const;

export const BANK_ACCOUNT_TYPES = ["普通", "当座"] as const;
export type BankAccountType = (typeof BANK_ACCOUNT_TYPES)[number];

function filled(value: string | null | undefined): boolean {
  return String(value ?? "").trim().length > 0;
}

export function resolveBankAccountState(
  account: PayeeBankAccount | null | undefined,
): BankAccountState {
  if (!account) return "missing";
  if (!CORE_FIELDS.every((field) => filled(account[field]))) return "missing";
  if (!CODE_FIELDS.every((field) => filled(account[field]))) return "incomplete";
  return "registered";
}

/** 振込CSVを出せる状態か */
export function isBankAccountReady(
  account: PayeeBankAccount | null | undefined,
): boolean {
  return resolveBankAccountState(account) === "registered";
}

/**
 * 口座番号のマスク。
 * 画面に出してよいのはこの形だけ。
 */
export function maskAccountNumber(value: string | null | undefined): string {
  const digits = String(value ?? "").trim();
  if (!digits) return "";
  if (digits.length <= 4) return "*".repeat(digits.length);
  return `${"*".repeat(digits.length - 4)}${digits.slice(-4)}`;
}

/** クライアントへ渡してよい形。口座番号の全文を含まない */
export type BankAccountView = {
  state: BankAccountState;
  bankName: string | null;
  bankCode: string | null;
  bankBranchName: string | null;
  bankBranchCode: string | null;
  bankAccountType: string | null;
  /** 下4桁以外を伏せたもの */
  accountNumberMasked: string;
  bankAccountHolder: string | null;
};

export function toBankAccountView(
  account: PayeeBankAccount | null | undefined,
): BankAccountView {
  return {
    state: resolveBankAccountState(account),
    bankName: account?.bankName ?? null,
    bankCode: account?.bankCode ?? null,
    bankBranchName: account?.bankBranchName ?? null,
    bankBranchCode: account?.bankBranchCode ?? null,
    bankAccountType: account?.bankAccountType ?? null,
    accountNumberMasked: maskAccountNumber(account?.bankAccountNumber),
    bankAccountHolder: account?.bankAccountHolder ?? null,
  };
}

/** DB の行（スネークケース）から共通形へ */
export function bankAccountFromRow(
  row: Record<string, unknown> | null | undefined,
): PayeeBankAccount {
  const text = (key: string): string | null => {
    const value = row?.[key];
    if (value == null) return null;
    const trimmed = String(value).trim();
    return trimmed.length > 0 ? trimmed : null;
  };

  return {
    bankName: text("bank_name"),
    bankCode: text("bank_code"),
    bankBranchName: text("bank_branch_name"),
    bankBranchCode: text("bank_branch_code"),
    bankAccountType: text("bank_account_type"),
    bankAccountNumber: text("bank_account_number"),
    bankAccountHolder: text("bank_account_holder"),
  };
}

/** 共通形から DB の行（スネークケース）へ */
export function bankAccountToRow(
  account: PayeeBankAccount,
): Record<string, string | null> {
  return {
    bank_name: account.bankName,
    bank_code: account.bankCode,
    bank_branch_name: account.bankBranchName,
    bank_branch_code: account.bankBranchCode,
    bank_account_type: account.bankAccountType,
    bank_account_number: account.bankAccountNumber,
    bank_account_holder: account.bankAccountHolder,
  };
}

export type BankAccountValidation =
  | { ok: true; account: PayeeBankAccount }
  | { ok: false; error: string };

/**
 * 入力値の検証と正規化。
 *
 * ・全角数字は半角へ寄せる（コード・口座番号のみ）
 * ・銀行コードは4桁、支店コードは3桁へゼロ詰め
 * ・すべて空なら「口座を消す」意図として null 一式を返す
 */
export function validateBankAccountInput(
  input: Partial<Record<keyof PayeeBankAccount, string | null>>,
): BankAccountValidation {
  const text = (key: keyof PayeeBankAccount): string =>
    String(input[key] ?? "").trim();

  const normalizeDigits = (value: string): string =>
    value
      .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/[^0-9]/g, "");

  const bankName = text("bankName");
  const bankBranchName = text("bankBranchName");
  const bankAccountType = text("bankAccountType");
  const bankAccountHolder = text("bankAccountHolder");
  const bankCode = normalizeDigits(text("bankCode"));
  const bankBranchCode = normalizeDigits(text("bankBranchCode"));
  const bankAccountNumber = normalizeDigits(text("bankAccountNumber"));

  const allEmpty =
    !bankName &&
    !bankBranchName &&
    !bankAccountType &&
    !bankAccountHolder &&
    !bankCode &&
    !bankBranchCode &&
    !bankAccountNumber;

  if (allEmpty) {
    return {
      ok: true,
      account: {
        bankName: null,
        bankCode: null,
        bankBranchName: null,
        bankBranchCode: null,
        bankAccountType: null,
        bankAccountNumber: null,
        bankAccountHolder: null,
      },
    };
  }

  if (!bankName) return { ok: false, error: "銀行名を入力してください" };
  if (!bankBranchName) return { ok: false, error: "支店名を入力してください" };
  if (!bankAccountType) return { ok: false, error: "口座種別を選択してください" };
  if (!bankAccountHolder) return { ok: false, error: "口座名義を入力してください" };
  if (!bankAccountNumber) return { ok: false, error: "口座番号を入力してください" };

  if (!BANK_ACCOUNT_TYPES.includes(bankAccountType as BankAccountType)) {
    return { ok: false, error: "口座種別は 普通 / 当座 のいずれかです" };
  }

  if (bankAccountNumber.length > 10) {
    return { ok: false, error: "口座番号は10桁以内で入力してください" };
  }

  if (bankCode && bankCode.length > 4) {
    return { ok: false, error: "銀行コードは4桁で入力してください" };
  }

  if (bankBranchCode && bankBranchCode.length > 3) {
    return { ok: false, error: "支店コードは3桁で入力してください" };
  }

  return {
    ok: true,
    account: {
      bankName,
      bankCode: bankCode ? bankCode.padStart(4, "0") : null,
      bankBranchName,
      bankBranchCode: bankBranchCode ? bankBranchCode.padStart(3, "0") : null,
      bankAccountType,
      bankAccountNumber,
      bankAccountHolder,
    },
  };
}
