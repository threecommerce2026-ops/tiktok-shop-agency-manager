import type { SupabaseClient } from "@supabase/supabase-js";

import { fetchAllFrom } from "@/lib/db/paged-select";

/*
  端末貸し出しの分配条件（本人×対象月）を読む。

  ■ どこに入っているか
  creator_lending_terms。
    split_rate  null なら既定 80%
    is_active   その月に本人へ分配するか。false / 行が無い → 報酬を作らない

  ■ ここで既定値を埋めない
  率の決定は lib/creators/lending-reward-engine.ts の
  resolveCreatorLendingSplitRate() が単一ソース。
  未設定は null のまま返し、エンジン側で既定 80% を適用する
  （既定値が2か所に散ると食い違う）。

  ■ 有効化と確定条件を分けている理由
  「その月に分配する」という運用上の決定（is_active）と、
  「区分がアカウント貸し出しで、所属が自社で、AK が 100%」という
  事実の確認は別物。前者はこのテーブル、後者はそれぞれの正データ
  （区分・所属・注文明細）を読んで判定する。

  ■ テーブルが無い環境
  migration 適用前のローカル・CI では存在しない。その場合は
  「有効化された月が1件も無い」と同じ状態なので空の索引を返す。
  テーブルが無いことを支払可否の判断には使わない
  （有効化が読めない＝報酬を作らない側に倒れる）。
*/

export const CREATOR_LENDING_TERMS_TABLE = "creator_lending_terms" as const;

export type LendingTerm = {
  creatorId: string;
  targetMonth: string;
  /** null なら既定 80% */
  splitRate: number | null;
  isActive: boolean;
  note: string | null;
};

export type LendingTermIndex = Map<string, LendingTerm>;

export function lendingTermKey(creatorId: string, targetMonth: string): string {
  return `${creatorId}|${targetMonth}`;
}

type LendingTermRow = {
  creator_id: string;
  target_month: string;
  split_rate: number | string | null;
  is_active: boolean | null;
  note: string | null;
};

/* テーブルが無いことを示すエラーか（Postgres 42P01 / PostgREST のメッセージ） */
export function isMissingLendingTermsTable(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes("42p01") ||
    text.includes("creator_lending_terms") ||
    (text.includes("relation") && text.includes("does not exist")) ||
    text.includes("could not find the table")
  );
}

/**
 * 対象月の分配条件を読み込む（読み取りのみ）。
 *
 * 値の検証はしない。範囲外の率はエンジン側の
 * resolveCreatorLendingSplitRate() が不正として弾く（報酬を作らない）。
 */
export async function fetchLendingTerms(
  supabase: SupabaseClient,
  options: { targetMonth?: string } = {},
): Promise<{ index: LendingTermIndex; tableMissing: boolean; error: string | null }> {
  const result = await fetchAllFrom<LendingTermRow>(
    supabase,
    CREATOR_LENDING_TERMS_TABLE,
    "creator_id, target_month, split_rate, is_active, note",
    (query) =>
      options.targetMonth ? query.eq("target_month", options.targetMonth) : query,
  );

  if (result.error) {
    if (isMissingLendingTermsTable(result.error)) {
      return { index: new Map(), tableMissing: true, error: null };
    }
    return { index: new Map(), tableMissing: false, error: result.error };
  }

  const index: LendingTermIndex = new Map();

  for (const row of result.data) {
    if (!row.creator_id || !row.target_month) continue;

    const parsed = row.split_rate == null ? null : Number(row.split_rate);

    index.set(lendingTermKey(row.creator_id, row.target_month), {
      creatorId: row.creator_id,
      targetMonth: row.target_month,
      splitRate: parsed != null && Number.isFinite(parsed) ? parsed : null,
      isActive: row.is_active === true,
      note: row.note ?? null,
    });
  }

  return { index, tableMissing: false, error: null };
}

/** 索引から1件引く。行が無い月は「有効化されていない」として扱う */
export function getLendingTerm(
  index: LendingTermIndex,
  creatorId: string,
  targetMonth: string,
): LendingTerm {
  return (
    index.get(lendingTermKey(creatorId, targetMonth)) ?? {
      creatorId,
      targetMonth,
      splitRate: null,
      isActive: false,
      note: null,
    }
  );
}
