import type { PostgrestFilterBuilder } from "@supabase/postgrest-js";
import type { SupabaseClient } from "@supabase/supabase-js";

/*
  Supabase の 1,000 行制限を超えるテーブルを全件取得するための共通ページャ。

  各クエリモジュールで同じ while ループを書かないこと。

  ■ 必ず一意列で並べてからページングする
  ORDER BY が無い（または同値が並ぶ）状態で range() を繰り返すと、
  ページ間で行順が保証されず、重複取得と取りこぼしが同時に発生する。

  実測（affiliate_order_lines 16,618行を target_month 範囲で取得）:
    order 無し : 16,618行取得したが実体は 10,969行（5,649行が重複・欠落）
    id で order: 16,618行すべて一意 ← 正しい

  そのため常に一意列（既定は id）を最後のソートキーとして付与する。
*/

const SUPABASE_PAGE_SIZE = 1000;

/** ページング順を確定させるための既定の一意列 */
const DEFAULT_TIEBREAK_COLUMN = "id";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFilterBuilder = PostgrestFilterBuilder<any, any, any, any, any>;

export type PagedSelectOptions = {
  /** ページング順を確定させる一意列。既定は "id" */
  tiebreakColumn?: string;
  pageSize?: number;
};

type PagedSelectResult<T> = {
  data: T[];
  error: string | null;
  /** Postgres / PostgREST のエラーコード（42P01 や 42501 など） */
  errorCode?: string | null;
};

/**
 * build() が返すクエリをページングして全件取得する。
 * build は呼び出しごとに新しいクエリを組み立てること。
 */
async function fetchAllRows<T>(
  build: () => AnyFilterBuilder,
  options: PagedSelectOptions = {},
): Promise<PagedSelectResult<T>> {
  const pageSize = options.pageSize ?? SUPABASE_PAGE_SIZE;
  const tiebreakColumn = options.tiebreakColumn ?? DEFAULT_TIEBREAK_COLUMN;

  const rows: T[] = [];
  let from = 0;

  for (;;) {
    // 呼び出し側の order の後に一意列を足して順序を確定させる
    const query = build().order(tiebreakColumn, { ascending: true });
    const { data, error } = await query.range(from, from + pageSize - 1);

    if (error) {
      return { data: [], error: error.message, errorCode: error.code ?? null };
    }

    const page = (data ?? []) as unknown as T[];
    rows.push(...page);

    if (page.length < pageSize) break;
    from += pageSize;
  }

  return { data: rows, error: null };
}

/**
 * 対象テーブルの全件を、任意の絞り込みを適用して取得する。
 */
export async function fetchAllFrom<T>(
  supabase: SupabaseClient,
  table: string,
  columns: string,
  applyFilters?: (query: AnyFilterBuilder) => AnyFilterBuilder,
  options: PagedSelectOptions = {},
): Promise<PagedSelectResult<T>> {
  return fetchAllRows<T>(() => {
    const query = supabase.from(table).select(columns) as AnyFilterBuilder;
    return applyFilters ? applyFilters(query) : query;
  }, options);
}
