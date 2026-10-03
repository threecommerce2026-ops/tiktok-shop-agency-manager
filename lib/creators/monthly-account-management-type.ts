import type { SupabaseClient } from "@supabase/supabase-js";

import { fetchAllFrom } from "@/lib/db/paged-select";
import {
  normalizeAccountManagementType,
  type AccountManagementType,
} from "@/lib/creators/account-management-type";

/*
  クリエイターの「対象月の区分」を解決する単一ソース。

  区分は紹介報酬が発生しうるかを決める（standard だけが 5% の対象）。
  紹介報酬は発生月ごとに帰属が決まるので、判定も月単位で行う。

  ■ 優先順位（2026-10-02 確定）
    ① creator_monthly_account_management_types に対象月の確定がある
         → monthly（確定）
    ② 無ければ creators.account_management_type
         → current（暫定）

  ■ なぜ ② で現在値へ落とすのか（fallback 仕様）
  月別所属は「未確定なら支払対象にしない」が正しい。所属が分からない
  相手へ振り込むことはできないからで、未確定は欠落そのもの。

  区分は違う。未確定であっても creators 側に必ず 1 つ値があり、
  大半のクリエイターは一度も区分を変えていない（実測: 区分変更履歴を
  持つのは 14 名だけ）。その人たちに月別確定を要求すると、
  区分を変えていないクリエイターの紹介報酬まで止まる。

  他の案を実データで比較した結果（2026-10-02 / 月別確定 0 件の時点）:
    ① 現在値へ fallback       8,448 件 / 40,292.00 円（＝現状と同じ判定）
    ② 未確定を standard 扱い 20,397 件 / 121,845.50 円（区分を無視する）
    ③ 未確定は対象外              0 件 / 0.00 円（既存 47,902.90 が全消滅）

  ②は区分という制度自体を壊し、③は既存の紹介報酬をすべて消す。
  現在値へ落とす案だけが、月別確定を入れた月から順に正しくなり、
  入れていない月は今までと同じ結果になる（移行中に金額が動かない）。

  ■ 重要
  current（現在値）は暫定であり、「その月の区分を確定した」ことには
  しない。保存もしない。過去月の正式な区分は管理者が月別確定として
  明示的に保存する。月別確定がある月は、現在区分を変えても動かない。
*/

/** 区分の確定状態 */
export type AccountManagementTypeSource = "monthly" | "current";

export type MonthlyAccountManagementType = {
  creatorId: string;
  targetMonth: string;
  accountManagementType: AccountManagementType;
  /** monthly = 月別確定 / current = 現在区分（暫定） */
  source: AccountManagementTypeSource;
};

export const ACCOUNT_TYPE_SOURCE_LABEL: Record<
  AccountManagementTypeSource,
  string
> = {
  monthly: "✓ 月別確定",
  current: "△ 現在区分（暫定）",
};

export const ACCOUNT_TYPE_SOURCE_DESCRIPTION: Record<
  AccountManagementTypeSource,
  string
> = {
  monthly: "対象月の区分として確定済み。現在区分を変えても過去は動かない。",
  current:
    "対象月の確定が無いため、クリエイターマスタの現在区分で暫定判定している。現在区分を変えると過去月の紹介報酬も変わる。",
};

/** 区分が月別に確定済みか（遡及の影響を受けないか） */
export function isConfirmedAccountManagementType(
  source: AccountManagementTypeSource,
): boolean {
  return source === "monthly";
}

/**
 * 対象月の区分を決める。
 *
 * monthly に値があればそれを使い、無ければ現在値へ落とす。
 * ここが紹介報酬の区分判定の唯一の入口。
 * 呼び出し側でこの優先順位を書き直さないこと。
 */
export function resolveMonthlyAccountManagementType(params: {
  creatorId: string;
  targetMonth: string;
  /** その月の月別確定。無ければ null */
  monthlyType: string | null | undefined;
  /** creators.account_management_type（現在値） */
  currentType: string | null | undefined;
}): MonthlyAccountManagementType {
  const { creatorId, targetMonth, monthlyType, currentType } = params;

  const monthly = String(monthlyType ?? "").trim();

  if (monthly) {
    return {
      creatorId,
      targetMonth,
      accountManagementType: normalizeAccountManagementType(monthly),
      source: "monthly",
    };
  }

  return {
    creatorId,
    targetMonth,
    accountManagementType: normalizeAccountManagementType(currentType),
    source: "current",
  };
}

export type MonthlyAccountTypeRow = {
  creator_id: string;
  target_month: string;
  account_management_type: string | null;
};

/** creator_id|target_month をキーにした索引 */
export type MonthlyAccountTypeIndex = Map<string, string>;

export function monthlyAccountTypeKey(
  creatorId: string,
  targetMonth: string,
): string {
  return `${creatorId}|${targetMonth}`;
}

export function buildMonthlyAccountTypeIndex(
  rows: MonthlyAccountTypeRow[],
): MonthlyAccountTypeIndex {
  const index: MonthlyAccountTypeIndex = new Map();

  for (const row of rows) {
    if (!row.creator_id || !row.target_month) continue;
    const type = String(row.account_management_type ?? "").trim();
    if (!type) continue;
    index.set(monthlyAccountTypeKey(row.creator_id, row.target_month), type);
  }

  return index;
}

export const MONTHLY_ACCOUNT_TYPE_TABLE =
  "creator_monthly_account_management_types" as const;

/**
 * 月別区分を読み込む（読み取りのみ）。
 *
 * targetMonth を渡すとその月だけ、省略すると全期間を読む。
 * テーブルが未作成の環境でも落ちないように、存在しないエラーは
 * 空の索引として扱う（migration 適用前のローカルや CI のため）。
 */
export async function fetchMonthlyAccountTypes(
  supabase: SupabaseClient,
  options: { targetMonth?: string; creatorIds?: string[] } = {},
): Promise<{ index: MonthlyAccountTypeIndex; error: string | null }> {
  const result = await fetchAllFrom<MonthlyAccountTypeRow>(
    supabase,
    MONTHLY_ACCOUNT_TYPE_TABLE,
    "creator_id, target_month, account_management_type",
    (query) => {
      let next = query;
      if (options.targetMonth) next = next.eq("target_month", options.targetMonth);
      if (options.creatorIds?.length) next = next.in("creator_id", options.creatorIds);
      return next;
    },
  );

  if (result.error) {
    if (isMissingTableError(result.error)) {
      return { index: new Map(), error: null };
    }
    return { index: new Map(), error: result.error };
  }

  return { index: buildMonthlyAccountTypeIndex(result.data), error: null };
}

/*
  テーブル未作成を示すエラーか。
  Postgres の 42P01（undefined_table）と
  PostgREST の PGRST205（スキーマキャッシュに無い）を見る。
*/
function isMissingTableError(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes("42p01") ||
    text.includes("pgrst205") ||
    text.includes("does not exist") ||
    text.includes("could not find the table")
  );
}
