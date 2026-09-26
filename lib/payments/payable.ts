import type { BankAccountState } from "@/lib/payments/bank-account";

/*
  支払可否と保留理由の判定（単一ソース）。

  ■ ここで金額計算はしない
  発生額・未払残高は既存 Finance Engine が確定させた
  agency_reward_items / referral_reward_items の合計をそのまま受け取る。
  報酬率・対象判定・CAP/TAP の式はここには無い。

  ■ 保留は「支払対象から外す」が「画面から消す」ではない
  理由を付けて /payments の振込保留タブに必ず表示する。

  ■ 未帰属クリエイター
  代理店が決まっていないクリエイターには報酬明細そのものが作られないため、
  支払先として現れない。ここで代理店を推測して割り当てることはしない。

  ■ 支払先は代理店に一本化する
  紹介者は独立した支払先ではない。紹介者報酬は referrers.agency_id が指す
  代理店へ合算して支払う。代理店が決まっていない紹介者は
  referrer_agency_unassigned として保留する。名前などから推測はしない。
*/

export const PAYEE_KINDS = ["agency", "referrer"] as const;
export type PayeeKind = (typeof PAYEE_KINDS)[number];

export const PAYEE_KIND_LABEL: Record<PayeeKind, string> = {
  agency: "代理店",
  referrer: "紹介者",
};

export function isPayeeKind(value: unknown): value is PayeeKind {
  return PAYEE_KINDS.includes(value as PayeeKind);
}

export const PAYMENT_HOLD_REASONS = [
  "in_house",
  "assignment_unconfirmed",
  "reward_unconfirmed",
  "referrer_agency_unassigned",
  "bank_missing",
  "bank_incomplete",
  "below_threshold",
] as const;

export type PaymentHoldReason = (typeof PAYMENT_HOLD_REASONS)[number];

export const PAYMENT_HOLD_REASON_LABEL: Record<PaymentHoldReason, string> = {
  in_house: "自社（支払対象外）",
  assignment_unconfirmed: "所属未確定",
  reward_unconfirmed: "報酬計算未確定",
  referrer_agency_unassigned: "所属代理店未設定",
  bank_missing: "振込先未登録",
  bank_incomplete: "銀行コード / 支店コード未登録",
  below_threshold: "支払基準額未達",
};

export const PAYMENT_HOLD_REASON_HINT: Record<PaymentHoldReason, string> = {
  in_house:
    "自社の代理店 / 紹介者です。実績としては集計しますが外部への振込対象ではありません。",
  assignment_unconfirmed:
    "月別所属が未確定のクリエイターが含まれています。「月別所属 一括確認・確定」で確定してください。",
  reward_unconfirmed:
    "報酬対象として確定していない明細が含まれています。再集計で確定してください。",
  referrer_agency_unassigned:
    "紹介者の所属代理店が未設定です。紹介者報酬は所属代理店へ合算して支払うため、「紹介者管理」で所属代理店を設定してください。",
  bank_missing: "支払先マスタに振込先口座を登録してください。",
  bank_incomplete:
    "振込CSVの出力に金融機関コードと支店コードが必要です。支払先マスタへ登録してください。",
  below_threshold:
    "未払残高が支払基準額に達していません。基準額に達するまで翌月へ繰り越します。",
};

export type PayableInput = {
  /** 自社か（agencies.is_in_house / referrers.is_in_house のみが根拠） */
  isInHouse: boolean;
  /** 振込先の状態 */
  bankState: BankAccountState;
  /** 未払残高（占有中を除いた、いま支払える額） */
  unpaidAmount: number;
  /**
   * 支払基準額。
   * 代理店の支払明細は合算額に対して 0（基準額なし）。
   * 代理店へ未帰属の紹介者だけ 1,000（環境変数で変更可）を使う。
   */
  thresholdAmount: number;
  /** 月別所属が未確定の明細を含むか（代理店のみ） */
  hasUnconfirmedAssignment: boolean;
  /** 報酬対象として未確定の明細を含むか */
  hasUnconfirmedReward: boolean;
  /** 紹介者の所属代理店が未設定か（紹介者のみ） */
  hasUnassignedReferrerAgency?: boolean;
};

/**
 * 保留理由をすべて返す。空配列なら支払可能。
 * 並び順は PAYMENT_HOLD_REASONS の定義順（重いものから）。
 */
export function resolvePaymentHoldReasons(
  input: PayableInput,
): PaymentHoldReason[] {
  const reasons: PaymentHoldReason[] = [];

  if (input.isInHouse) reasons.push("in_house");
  if (input.hasUnconfirmedAssignment) reasons.push("assignment_unconfirmed");
  if (input.hasUnconfirmedReward) reasons.push("reward_unconfirmed");
  if (input.hasUnassignedReferrerAgency) reasons.push("referrer_agency_unassigned");

  if (input.bankState === "missing") reasons.push("bank_missing");
  else if (input.bankState === "incomplete") reasons.push("bank_incomplete");

  /*
    基準額未達。
    未払いが 0 円のときは「保留」ではなく「支払うものが無い」なので
    理由を立てない（画面の保留タブに 0 円の行が並ばないようにする）。
  */
  if (input.unpaidAmount > 0 && input.unpaidAmount < input.thresholdAmount) {
    reasons.push("below_threshold");
  }

  return reasons;
}

/** 支払明細を作成してよいか */
export function isPayable(input: PayableInput): boolean {
  if (input.unpaidAmount <= 0) return false;
  return resolvePaymentHoldReasons(input).length === 0;
}

/** 保留として画面に出すべきか（未払いがあるのに支払えない） */
export function isOnHold(input: PayableInput): boolean {
  return input.unpaidAmount > 0 && resolvePaymentHoldReasons(input).length > 0;
}

export function describeHoldReasons(reasons: PaymentHoldReason[]): string {
  return reasons.map((reason) => PAYMENT_HOLD_REASON_LABEL[reason]).join(" / ");
}
