import type { SupabaseClient } from "@supabase/supabase-js";

import { fetchAllFrom } from "@/lib/db/paged-select";
import { bankAccountFromRow, type PayeeBankAccount } from "@/lib/payments/bank-account";

/*
  支払管理が端末貸し出し報酬（受取人はクリエイター本人）を読むための入口。

  ■ なぜ専用モジュールにするか
  creator_lending_reward_items / creator_bank_accounts は
  20261010100000 の migration で作るテーブルで、適用前の環境には存在しない。
  支払管理は代理店・紹介者の支払いを止めてはいけないので、
  「テーブルが無い」場合だけを切り分けて空として扱う。

  ■ fail-closed
  テーブルが無い環境では creator の支払候補が1件も出ない。
  表示が消えるだけで、誤って支払える状態にはならない。
  権限・接続などそれ以外のエラーは error として返し、呼び出し側が
  支払いを止める判断に使う（握り潰さない）。

  ■ 口座
  振込先は creator_bank_accounts にしか無い。creators には口座列を作らない。
  ここでは口座の生データ（口座番号の全文）を返すので、画面へ渡す前に
  必ず toBankAccountView() でマスクすること。
*/

export const CREATOR_LENDING_ITEM_COLUMNS =
  "id, target_month, creator_id, agency_revenue, split_rate, reward_amount, self_share_amount, is_reward_target, is_paid, payout_id, payment_batch_id";

export const CREATOR_BANK_COLUMNS =
  "creator_id, bank_name, bank_code, bank_branch_name, bank_branch_code, bank_account_type, bank_account_number, bank_account_holder";

export type CreatorLendingItemRow = {
  id: string;
  target_month: string;
  creator_id: string;
  agency_revenue: number | string | null;
  split_rate: number | string | null;
  reward_amount: number | string | null;
  self_share_amount: number | string | null;
  is_reward_target: boolean;
  is_paid: boolean;
  payout_id: string | null;
  payment_batch_id: string | null;
};

/**
 * テーブル未作成を管理者に伝える文言。
 *
 * 生の Postgres エラー（relation ... does not exist）を画面に出すと
 * 原因が分からないため、やることが分かる案内に差し替える。
 */
export const LENDING_TABLE_MISSING_MESSAGE =
  "端末貸し出し報酬のテーブルが未作成です。supabase/migrations/20261010100000_creator_lending_reward_tables.sql から順に適用してください（適用まで一覧と支払候補は表示されません）。";

/* テーブルが無いことを示すエラーか（42P01 / PostgREST のスキーマキャッシュ） */
const MISSING_TABLE_CODES = new Set(["42P01", "PGRST205", "PGRST106"]);

export function isMissingLendingTable(
  message: string | null,
  code?: string | null,
): boolean {
  if (code != null && MISSING_TABLE_CODES.has(code)) return true;
  if (!message) return false;
  const text = message.toLowerCase();
  return (
    text.includes("42p01") ||
    text.includes("could not find the table") ||
    (text.includes("relation") && text.includes("does not exist"))
  );
}

export type CreatorLendingPayeeSource = {
  items: CreatorLendingItemRow[];
  /** creator_id → 振込先（口座番号の全文を含む。画面へ渡す前にマスクする） */
  bankByCreator: Map<string, PayeeBankAccount>;
  /** creator_id → 振込端数の繰越残高（0 以上 1 未満） */
  carryoverByCreator: Map<string, number>;
  /** テーブルが未作成だったか（migration 適用前） */
  tableMissing: boolean;
  /**
   * 支払経路が creator 受取種別に対応しているか。
   *
   * payment_batch_supports_creator()（20261010170000）で確かめる。
   * 関数が無い環境では false にする（fail-closed）。false のあいだ
   * 画面は支払明細の作成を無効にする（M-6）。
   */
  supportsCreatorPayee: boolean;
  error: string | null;
};

/**
 * 端末貸し出し報酬の明細と本人の振込先を読む。
 *
 * service role 前提（creator_lending_* / creator_bank_accounts は
 * authenticated ロールに権限が無い）。
 */
export async function fetchCreatorLendingPayeeSource(
  supabase: SupabaseClient,
): Promise<CreatorLendingPayeeSource> {
  const empty: CreatorLendingPayeeSource = {
    items: [],
    bankByCreator: new Map(),
    carryoverByCreator: new Map(),
    tableMissing: false,
    supportsCreatorPayee: false,
    error: null,
  };

  const itemsResult = await fetchAllFrom<CreatorLendingItemRow>(
    supabase,
    "creator_lending_reward_items",
    CREATOR_LENDING_ITEM_COLUMNS,
  );

  if (itemsResult.error) {
    if (isMissingLendingTable(itemsResult.error, itemsResult.errorCode)) {
      return { ...empty, tableMissing: true };
    }
    return { ...empty, error: itemsResult.error };
  }

  const bankResult = await fetchAllFrom<Record<string, unknown>>(
    supabase,
    "creator_bank_accounts",
    CREATOR_BANK_COLUMNS,
    undefined,
    /* 主キーは creator_id。id 列が無いのでページング順をここで指定する */
    { tiebreakColumn: "creator_id" },
  );

  if (bankResult.error) {
    if (isMissingLendingTable(bankResult.error, bankResult.errorCode)) {
      return { ...empty, items: itemsResult.data, tableMissing: true };
    }
    return { ...empty, items: itemsResult.data, error: bankResult.error };
  }

  const bankByCreator = new Map<string, PayeeBankAccount>();
  for (const row of bankResult.data) {
    bankByCreator.set(String(row.creator_id), bankAccountFromRow(row));
  }

  /*
    振込端数の繰越残高（20261010160000）。
    テーブルが無い環境では残高なしとして扱う（0 円で計算される）。
  */
  const carryoverResult = await fetchAllFrom<{
    creator_id: string;
    balance: number | string | null;
  }>(supabase, "creator_lending_carryovers", "creator_id, balance", undefined, {
    tiebreakColumn: "creator_id",
  });

  if (
    carryoverResult.error &&
    !isMissingLendingTable(carryoverResult.error, carryoverResult.errorCode)
  ) {
    return { ...empty, items: itemsResult.data, bankByCreator, error: carryoverResult.error };
  }

  const carryoverByCreator = new Map<string, number>();
  for (const row of carryoverResult.data ?? []) {
    const parsed = Number(row.balance ?? 0);
    carryoverByCreator.set(
      String(row.creator_id),
      Number.isFinite(parsed) ? parsed : 0,
    );
  }

  /*
    支払経路が creator に対応しているかを DB に聞く。
    関数が無い（= 未適用）場合は false にする。例外を握り潰すのではなく
    「未対応」という答えとして扱い、画面側で操作を止める。
  */
  let supportsCreatorPayee = false;
  const { data: supportsData, error: supportsError } = await supabase.rpc(
    "payment_batch_supports_creator",
  );
  if (!supportsError) supportsCreatorPayee = supportsData === true;

  return {
    items: itemsResult.data,
    bankByCreator,
    carryoverByCreator,
    tableMissing: false,
    supportsCreatorPayee,
    error: null,
  };
}
