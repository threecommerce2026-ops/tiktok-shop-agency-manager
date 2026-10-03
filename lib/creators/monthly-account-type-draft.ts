import {
  ACCOUNT_MANAGEMENT_TYPES,
  accountManagementTypeLabel,
  type AccountManagementType,
} from "@/lib/creators/account-management-type";
import type { CreatorMonthTypeRow } from "@/lib/db/creator-monthly-account-type-queries";

/*
  月別区分パネルの「選択内容 → 実際に保存する変更」を決める部分。

  画面から切り離してあるのは、ここが「どの月に本当に書き込むか」を
  決める唯一の場所だから。保存そのものは
  lib/creators/confirm-monthly-account-types.ts が持っているが、
  その手前で何を渡すかを間違えると、無駄な書き込みや
  支払済みの月への書き込みが起きる。
*/

/** 月ごとの選択。空文字は「この月は変更しない」 */
export type MonthlyAccountTypeDraft = Record<string, string>;

export type PlannedTypeChange = {
  targetMonth: string;
  accountManagementType: AccountManagementType;
  typeLabel: string;
  /** 変更前に確定済だった区分。未確定なら null */
  previousType: AccountManagementType | null;
  previousLabel: string | null;
  /** 変更前に適用されていた区分（確定が無ければ現在区分） */
  effectiveType: AccountManagementType;
  /** この変更で紹介報酬の対象・対象外が切り替わるか */
  eligibilityChanges: boolean;
};

export function isAccountTypeValue(value: string): value is AccountManagementType {
  return (ACCOUNT_MANAGEMENT_TYPES as readonly string[]).includes(value);
}

/**
 * 画面の選択内容から「実際に DB が変わる月」だけを取り出す。
 *
 * ・空の選択（変更しない）は対象外
 * ・いま確定済の区分と同じ選択は対象外（無駄な書き込みをしない）
 * ・支払済みの月は対象外（サーバー側でも弾かれるが、確認画面にも出さない）
 */
export function buildPlannedTypeChanges(
  rows: CreatorMonthTypeRow[],
  draft: MonthlyAccountTypeDraft,
): PlannedTypeChange[] {
  const changes: PlannedTypeChange[] = [];

  for (const row of rows) {
    if (row.hasPaidReward) continue;

    const selected = (draft[row.targetMonth] ?? "").trim();
    if (!selected) continue;
    if (!isAccountTypeValue(selected)) continue;
    if (selected === row.monthlyType) continue;

    changes.push({
      targetMonth: row.targetMonth,
      accountManagementType: selected,
      typeLabel: accountManagementTypeLabel(selected),
      previousType: row.monthlyType,
      previousLabel: row.monthlyType
        ? accountManagementTypeLabel(row.monthlyType)
        : null,
      effectiveType: row.effectiveType,
      /*
        紹介報酬の対象かどうかは standard かで決まる。
        適用されていた区分と選んだ区分で可否が変わる月だけ、
        確認画面で「紹介報酬の対象が変わる」と出す。
      */
      eligibilityChanges:
        (row.effectiveType === "standard") !== (selected === "standard"),
    });
  }

  return changes.sort((a, b) => a.targetMonth.localeCompare(b.targetMonth));
}

/** 確定済の月を別の区分へ付け替える変更。警告を強める対象 */
export function reconfirmedTypeChanges(
  changes: PlannedTypeChange[],
): PlannedTypeChange[] {
  return changes.filter((change) => change.previousType !== null);
}

/** 紹介報酬の対象・対象外が切り替わる変更。再集計が要る */
export function eligibilityChangingTypeChanges(
  changes: PlannedTypeChange[],
): PlannedTypeChange[] {
  return changes.filter((change) => change.eligibilityChanges);
}
