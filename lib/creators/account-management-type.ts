/*
  クリエイター区分（creators.account_management_type）の単一定義。

  standard         通常クリエイター。THREE.inc または二次代理店所属。
                   紹介者が設定されていれば紹介者報酬5%の対象。

  self_operated    自社運用アカウント。収益は100%THREE側へ入るため、
                   通常の紹介者報酬5%は発生させない。

  account_lending  アカウント貸出。運用者へ8:2等の収益分配を行うが、
                   これは紹介者報酬とは別制度。5%の対象外。
*/

export const ACCOUNT_MANAGEMENT_TYPES = [
  "standard",
  "self_operated",
  "account_lending",
] as const;

export type AccountManagementType = (typeof ACCOUNT_MANAGEMENT_TYPES)[number];

export const DEFAULT_ACCOUNT_MANAGEMENT_TYPE: AccountManagementType = "standard";

const LABELS: Record<AccountManagementType, string> = {
  standard: "通常",
  self_operated: "自社運用",
  account_lending: "アカウント貸出",
};

const DESCRIPTIONS: Record<AccountManagementType, string> = {
  standard: "THREE.inc または二次代理店所属。紹介者があれば紹介報酬5%の対象。",
  self_operated: "自社運用アカウント。収益は100%自社。紹介報酬5%は発生しない。",
  account_lending: "運用者へ収益分配するアカウント。紹介報酬5%とは別制度。",
};

export function isAccountManagementType(
  value: unknown,
): value is AccountManagementType {
  return ACCOUNT_MANAGEMENT_TYPES.includes(value as AccountManagementType);
}

export function normalizeAccountManagementType(
  value: unknown,
): AccountManagementType {
  const normalized = String(value ?? "").trim();
  return isAccountManagementType(normalized)
    ? normalized
    : DEFAULT_ACCOUNT_MANAGEMENT_TYPE;
}

export function accountManagementTypeLabel(value: unknown): string {
  return LABELS[normalizeAccountManagementType(value)];
}

/**
 * 通常の紹介者報酬5%が発生しうる区分か。
 * 自社運用・アカウント貸出は対象外。
 */
export function isReferralRewardEligibleType(value: unknown): boolean {
  return normalizeAccountManagementType(value) === "standard";
}

export const ACCOUNT_MANAGEMENT_TYPE_OPTIONS = ACCOUNT_MANAGEMENT_TYPES.map(
  (value) => ({
    value,
    label: LABELS[value],
    description: DESCRIPTIONS[value],
  }),
);
