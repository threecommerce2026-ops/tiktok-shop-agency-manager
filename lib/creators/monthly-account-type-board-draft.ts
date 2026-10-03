import {
  accountManagementTypeLabel,
  type AccountManagementType,
} from "@/lib/creators/account-management-type";
import type { MonthlyAccountTypeBoardRow } from "@/lib/db/monthly-account-type-board-queries";

/*
  月別区分ボードの「選択内容 → 実際に保存する行」を決める部分。

  画面から切り離してあるのは、ここが「どの creator×month に本当に
  書き込むか」を決める唯一の場所だから。保存そのものは
  lib/creators/confirm-monthly-account-types.ts が持っているが、
  その手前で何を渡すかを間違えると、無駄な書き込みや
  支払済みの月への書き込みが起きる。

  ■ 現在区分をそのまま使う
  埋める値は creators.account_management_type（現在区分）。
  creator_master_change_logs の変更日時から過去区分を推測しない
  （2026-10-03 確定の業務ルール。9月末の変更はマスタ訂正であって
  実運用の変更日ではない）。
*/

/** 選択キー: creatorId|targetMonth */
export type BoardSelection = Set<string>;

export function boardRowKey(row: {
  creatorId: string;
  targetMonth: string;
}): string {
  return `${row.creatorId}|${row.targetMonth}`;
}

export type BoardPlannedChange = {
  creatorId: string;
  tiktokId: string;
  creatorName: string;
  targetMonth: string;
  accountManagementType: AccountManagementType;
  typeLabel: string;
  /** 変更前に確定済だった区分。未確定なら null */
  previousType: AccountManagementType | null;
};

/**
 * 未確定の行を「現在区分で埋める」対象に選ぶ。
 *
 * DB へは書き込まない。画面の draft を作るだけ。
 * 支払済み・支払予定中の行は確定処理が拒否するので最初から外す。
 */
export function selectUnconfirmedRows(
  rows: MonthlyAccountTypeBoardRow[],
): BoardSelection {
  const selection: BoardSelection = new Set();

  for (const row of rows) {
    if (row.hasPaidReward) continue;
    if (row.source === "monthly") continue;
    selection.add(boardRowKey(row));
  }

  return selection;
}

/**
 * 選択された行から「実際に DB が変わる行」だけを取り出す。
 *
 * ・選択されていない行は対象外
 * ・いま確定済みの区分と同じ行は対象外（無駄な書き込みをしない）
 * ・支払済みの行は対象外（サーバー側でも弾かれるが、確認画面にも出さない）
 */
export function buildBoardChanges(
  rows: MonthlyAccountTypeBoardRow[],
  selection: BoardSelection,
): BoardPlannedChange[] {
  const changes: BoardPlannedChange[] = [];

  for (const row of rows) {
    if (row.hasPaidReward) continue;
    if (!selection.has(boardRowKey(row))) continue;

    /* 埋める値は現在区分。推測はしない */
    const next = row.currentType;
    if (next === row.monthlyType) continue;

    changes.push({
      creatorId: row.creatorId,
      tiktokId: row.tiktokId,
      creatorName: row.creatorName,
      targetMonth: row.targetMonth,
      accountManagementType: next,
      typeLabel: accountManagementTypeLabel(next),
      previousType: row.monthlyType,
    });
  }

  return changes.sort(
    (a, b) =>
      a.tiktokId.localeCompare(b.tiktokId) ||
      a.targetMonth.localeCompare(b.targetMonth),
  );
}

export type BoardChangeSummary = {
  creatorCount: number;
  rowCount: number;
  standardCount: number;
  selfOperatedCount: number;
  accountLendingCount: number;
  /** 既に確定済みの行を別の区分へ付け替える件数 */
  reconfirmCount: number;
};

/** 確定前の確認画面に出す集計。件数はここでだけ数える */
export function summarizeBoardChanges(
  changes: BoardPlannedChange[],
): BoardChangeSummary {
  return {
    creatorCount: new Set(changes.map((change) => change.creatorId)).size,
    rowCount: changes.length,
    standardCount: changes.filter(
      (change) => change.accountManagementType === "standard",
    ).length,
    selfOperatedCount: changes.filter(
      (change) => change.accountManagementType === "self_operated",
    ).length,
    accountLendingCount: changes.filter(
      (change) => change.accountManagementType === "account_lending",
    ).length,
    reconfirmCount: changes.filter((change) => change.previousType !== null).length,
  };
}

/*
  報酬影響の確認に出すクリエイター。

  金額が大きい、または既に紹介報酬が発生している creator は
  確定前に目視してほしいので、確認画面で名指しする。
  ここに固定の ID を書かない（データが変われば対象も変わる）。
*/
export function pickRewardImpactRows(
  rows: MonthlyAccountTypeBoardRow[],
  changes: BoardPlannedChange[],
  limit = 10,
): MonthlyAccountTypeBoardRow[] {
  const changedKeys = new Set(
    changes.map((change) => `${change.creatorId}|${change.targetMonth}`),
  );

  const targets = rows.filter((row) => changedKeys.has(boardRowKey(row)));

  /* 対象外区分になる月のうち、報酬実績か算定元が大きい順 */
  const impactful = targets
    .filter((row) => row.rewardAmount > 0 || row.referralBase > 0)
    .sort(
      (a, b) =>
        b.rewardAmount - a.rewardAmount || b.referralBase - a.referralBase,
    );

  /* creator 単位でまとめ、上位だけ返す */
  const seen = new Set<string>();
  const picked: MonthlyAccountTypeBoardRow[] = [];

  for (const row of impactful) {
    if (seen.size >= limit && !seen.has(row.creatorId)) break;
    seen.add(row.creatorId);
    picked.push(row);
  }

  return picked.sort(
    (a, b) =>
      a.tiktokId.localeCompare(b.tiktokId) ||
      a.targetMonth.localeCompare(b.targetMonth),
  );
}
