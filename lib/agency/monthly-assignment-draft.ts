import type { CreatorMonthRow } from "@/lib/db/creator-monthly-assignment-queries";

/*
  月別所属パネルの「選択内容 → 実際に保存する変更」を決める部分。

  画面から切り離してあるのは、ここが
  「どの月に本当に書き込むか」を決める唯一の場所だから。
  保存そのものは既存の confirmMonthlyAssignments が持っているが、
  その手前で何を渡すかを間違えると、無駄な書き込みや
  支払済の月への書き込みが起きる。
*/

/** 月ごとの選択。空文字は「この月は変更しない」 */
export type MonthlyAssignmentDraft = Record<string, string>;

export type PlannedChange = {
  targetMonth: string;
  agencyId: string;
  agencyName: string;
  /** 変更前に確定済だった代理店。未確定なら null */
  previousAgencyId: string | null;
  previousAgencyName: string | null;
};

/**
 * 画面の選択内容から「実際に DB が変わる月」だけを取り出す。
 *
 * ・空の選択（変更しない）は対象外
 * ・いま確定済の代理店と同じ選択は対象外（無駄な書き込みをしない）
 * ・支払済の月は対象外（サーバー側でも弾かれるが、確認画面にも出さない）
 */
export function buildPlannedChanges(
  rows: CreatorMonthRow[],
  draft: MonthlyAssignmentDraft,
  agencies: Array<{ id: string; name: string }>,
): PlannedChange[] {
  const nameOf = (id: string) =>
    agencies.find((agency) => agency.id === id)?.name ?? id;

  const changes: PlannedChange[] = [];

  for (const row of rows) {
    if (row.hasPaidReward) continue;

    const agencyId = (draft[row.targetMonth] ?? "").trim();
    if (!agencyId) continue;
    if (agencyId === row.monthlyAgencyId) continue;

    changes.push({
      targetMonth: row.targetMonth,
      agencyId,
      agencyName: nameOf(agencyId),
      previousAgencyId: row.monthlyAgencyId,
      previousAgencyName: row.monthlyAgencyName,
    });
  }

  return changes.sort((a, b) => a.targetMonth.localeCompare(b.targetMonth));
}

/**
 * 確定済の月を別の代理店へ付け替える変更。
 * 新規確定より影響が大きいので、確認画面で警告を強める対象にする。
 */
export function reconfirmedChanges(changes: PlannedChange[]): PlannedChange[] {
  return changes.filter((change) => change.previousAgencyId !== null);
}
