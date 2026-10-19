"use server";

import { revalidatePath } from "next/cache";

import { requireAdminAction } from "@/lib/db/admin-access";
import { currentMonthKey } from "@/lib/db/dashboard-queries";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { mapSupabaseErrorToJa } from "@/lib/supabase/error-ja";
import {
  isValidRewardYear,
  isValidTargetMonth,
} from "@/lib/agency/agency-reward-engine";
import {
  BANK_ACCOUNT_STATE_LABEL,
  BANK_ACCOUNT_TYPES,
  resolveBankAccountState,
  type BankAccountType,
} from "@/lib/payments/bank-account";
import {
  CREATOR_LENDING_SPLIT_RATE,
  resolveCreatorLendingSplitRate,
  sumLendingAmounts,
} from "@/lib/creators/lending-reward-engine";
import { syncCreatorLendingRewardsForMonth } from "@/lib/creators/sync-lending-rewards";
import {
  buildLendingTermChanges,
  collectLendingTermCandidates,
  INITIAL_LENDING_SETTLEMENT,
  isValidMonthKey,
  LENDING_TERM_BLOCK_LABEL,
  lendingTermRowKey,
  resolveLendingSyncMonths,
  summarizeLendingTermPlan,
} from "@/lib/creators/lending-term-bulk-draft";
import { fetchCreatorLendingSummary } from "@/lib/db/creator-lending-queries";

/*
  端末貸し出し報酬（受取人はクリエイター本人）の管理操作。

  ■ 受取人について
  受取人はクリエイター本人。代理店マスタへ架空登録したり、
  THREE.inc の代理店 ID で代用したりしない。
  そのため報酬明細は creator_lending_reward_items、
  口座は creator_bank_accounts で管理する。

  ■ 変更しないもの
  クリエイターの所属（creator_monthly_agency_assignments）、
  AK（affiliate_order_lines.agency_split_rate）、管理区分は読むだけ。
  代理店報酬（agency_reward_items）と紹介者報酬（referral_reward_items）には触れない。

  ■ クライアントの使い分け
  creator_lending_* / creator_bank_accounts は authenticated ロールに
  権限を与えていない（口座情報を含むため）。書き込みは service role で行い、
  管理者判定は requireAdminAction() がサーバー側で担保する。

  ■ 監査ログ
  分配率・有効化の変更は creator_lending_term_logs に必ず残す。
  ログには口座情報を一切書かない。
*/

export type LendingActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

const MIGRATION_HINT =
  "端末貸し出し報酬テーブルが見つかりません。supabase/migrations/20261010100000_creator_lending_reward_tables.sql を適用してください。";

/*
  テーブル未作成を示すコードだけを migration 未適用として扱う。
  権限エラー（42501）をここで握り潰すと原因が分からなくなる。
*/
const MISSING_TABLE_CODES = new Set(["42P01", "PGRST205", "PGRST106"]);

function isMissingTable(code: string | null | undefined): boolean {
  return code != null && MISSING_TABLE_CODES.has(code);
}

function describeError(message: string, code?: string | null): string {
  const mapped = mapSupabaseErrorToJa(message);
  return code ? `${mapped}（エラーコード: ${code}）` : mapped;
}

function readText(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function formatAmount(value: number): string {
  return value.toLocaleString("ja-JP", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

function revalidateLendingViews() {
  revalidatePath("/revenue");
  revalidatePath("/payments");
}

/** uuid の形だけ確認する（存在確認は FK に任せる） */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * 対象月（または年内の全月）の端末貸し出し報酬を再集計する。
 *
 * source_row_key で冪等。支払い済み・支払明細に占有済みの明細は書き換えない。
 */
export async function syncCreatorLendingRewardsAction(
  _prev: LendingActionResult | null,
  formData: FormData,
): Promise<LendingActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  /*
    対象月の決定は lib/creators/lending-term-bulk-draft.ts の
    resolveLendingSyncMonths が単一ソース（純関数なのでテストできる）。

    scope=initial_settlement  承認済みの固定範囲（2026-02〜2026-07）だけ
    scope=range               通常運用の期間指定（締め月を固定しない）
    scope=year / month        従来どおり
    いずれも当月より後の月は落とす。
  */
  const resolved = resolveLendingSyncMonths({
    scope: readText(formData, "scope"),
    month: readText(formData, "target_month"),
    year: readText(formData, "year"),
    fromMonth: readText(formData, "from_month"),
    toMonth: readText(formData, "to_month"),
    currentMonth: currentMonthKey(),
  });

  if (!resolved.ok) return { ok: false, error: resolved.error };

  const months = resolved.months;

  const writeClient = getSupabaseAdmin();

  let upserted = 0;
  let deleted = 0;
  let skippedPaid = 0;
  let skipCount = 0;
  const rewardAmounts: number[] = [];
  const selfAmounts: number[] = [];

  for (const targetMonth of months) {
    const result = await syncCreatorLendingRewardsForMonth(writeClient, targetMonth);

    if (result.error) {
      if (isMissingTable(result.errorCode)) {
        return { ok: false, error: MIGRATION_HINT };
      }
      return { ok: false, error: describeError(result.error, result.errorCode) };
    }

    upserted += result.upsertedCount;
    deleted += result.deletedCount;
    skippedPaid += result.skippedPaidCount;
    skipCount += result.skips.reduce((sum, skip) => sum + skip.lineCount, 0);
    rewardAmounts.push(result.rewardAmount);
    selfAmounts.push(result.selfShareAmount);
  }

  revalidateLendingViews();

  const skipNote = skipCount > 0 ? ` / 対象外 ${skipCount} 明細` : "";

  return {
    ok: true,
    message: `${months[0]}〜${months[months.length - 1]} の端末貸し出し報酬を再集計しました（明細 ${upserted} 件 / 削除 ${deleted} 件 / 支払済据置 ${skippedPaid} 件 / 本人報酬 ${formatAmount(
      sumLendingAmounts(rewardAmounts),
    )} 円 / 自社取り分 ${formatAmount(sumLendingAmounts(selfAmounts))} 円${skipNote}）`,
  };
}

type LendingTermEntry = {
  creatorId: string;
  targetMonth: string;
  /** null なら既定 80%（エンジン側で解決する） */
  splitRate: number | null;
  isActive: boolean;
  note: string | null;
};

type ApplyLendingTermResult =
  | {
      ok: true;
      entryCount: number;
      /** 実際に保存できた人月の数 */
      applied: number;
      /** 変更が無かった人月の数（再実行したときはここに入る） */
      unchanged: number;
      /** 実際に保存できた監査ログの行数（書こうとした数ではない） */
      logCount: number;
    }
  | { ok: false; error: string };

export const LENDING_TERMS_RPC = "set_creator_lending_terms" as const;

const RPC_MISSING_HINT =
  "分配条件を保存する関数（set_creator_lending_terms）がありません。" +
  "supabase/migrations/20261019100000_creator_lending_terms_rpc.sql を適用してください。";

/* 関数が無いことを示すコードだけを migration 未適用として扱う */
function isMissingFunction(code: string | null | undefined, message: string): boolean {
  if (code === "42883" || code === "PGRST202") return true;
  return /could not find the function|does not exist/i.test(message) &&
    message.includes(LENDING_TERMS_RPC);
}

/**
 * 分配条件を保存する（書き込み経路はここだけ）。
 *
 * ■ 監査ログと同一トランザクション
 * terms の upsert と creator_lending_term_logs の追記を
 * RPC set_creator_lending_terms の中で行う。supabase-js は
 * PostgREST 越しで複数リクエストをまたぐトランザクションを張れないため、
 * アプリ層で2回に分けると片方だけ成立し得る（履歴の欠落）。
 *
 * ■ 全件成功または全件ロールバック
 * 複数件を1回の呼び出しで渡す。RPC は1件でも検証に失敗したら例外を投げ、
 * 関数呼び出し全体がロールバックされる。部分適用は起きない。
 *
 * ■ ユーザーセッションで呼ぶ
 * service role では auth.uid() が null で RPC が拒否する。
 * 実行者は DB 側が auth.uid() から記録するので、アプリが入れた値を
 * 信用しない作りになっている。
 *
 * ■ 冪等
 * 分配率と有効化が変更前と同じ人月は RPC 側で unchanged として扱い、
 * terms も監査ログも増やさない。
 */
async function applyLendingTerms(
  userClient: Awaited<ReturnType<typeof requireAdminAction>>["supabase"],
  entries: readonly LendingTermEntry[],
  scope: { fromMonth: string; toMonth: string } | null,
): Promise<ApplyLendingTermResult> {
  if (entries.length === 0) {
    return { ok: false, error: "対象の人月が指定されていません" };
  }

  const { data, error } = await userClient.rpc(LENDING_TERMS_RPC, {
    p_entries: entries.map((entry) => ({
      creator_id: entry.creatorId,
      target_month: entry.targetMonth,
      split_rate: entry.splitRate,
      is_active: entry.isActive,
      note: entry.note,
    })),
    p_from_month: scope?.fromMonth ?? null,
    p_to_month: scope?.toMonth ?? null,
  });

  if (error) {
    if (isMissingFunction(error.code, error.message)) {
      return { ok: false, error: RPC_MISSING_HINT };
    }
    if (isMissingTable(error.code)) return { ok: false, error: MIGRATION_HINT };
    return { ok: false, error: describeError(error.message, error.code) };
  }

  const result = (data ?? {}) as Record<string, unknown>;

  return {
    ok: true,
    entryCount: Number(result.entry_count ?? entries.length),
    applied: Number(result.applied ?? 0),
    unchanged: Number(result.unchanged ?? 0),
    logCount: Number(result.log_count ?? 0),
  };
}

/**
 * 分配率と有効化の設定（クリエイター本人 × 対象月）。
 *
 * ■ 入力の扱い
 * 空欄 → 既定 80%（split_rate を null にする）
 * それ以外は 0 < rate <= 1。「80」のような % 表記は拒否する
 * （0.8 と解釈すると支払額が 100 倍になるため、推測で直さない）。
 *
 * 設定するだけでは報酬は変わらない。対象月の再集計で反映される。
 */
export async function setCreatorLendingTermAction(
  _prev: LendingActionResult | null,
  formData: FormData,
): Promise<LendingActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const creatorId = readText(formData, "creator_id");
  const targetMonth = readText(formData, "target_month");
  const rateInput = readText(formData, "split_rate");
  const note = readText(formData, "note");
  const isActive = readText(formData, "is_active") !== "false";

  if (!isUuid(creatorId)) {
    return { ok: false, error: "クリエイターを指定してください" };
  }
  if (!isValidTargetMonth(targetMonth)) {
    return { ok: false, error: "対象月の形式が正しくありません（例: 2026-08）" };
  }
  if (note.length > 500) {
    return { ok: false, error: "備考は 500 文字以内で入力してください" };
  }

  /* 空欄は「既定値を使う」。null を保存し、既定値はエンジン側で解決する */
  let splitRate: number | null = null;

  if (rateInput !== "") {
    const parsed = Number(rateInput);

    if (!Number.isFinite(parsed)) {
      return { ok: false, error: "分配率は数値で入力してください（例: 0.8）" };
    }
    /*
      「80」のような % 表記を 0.8 と読み替えない。
      読み替えると桁を間違えた入力がそのまま支払額になる。
    */
    if (parsed <= 0 || parsed > 1) {
      return {
        ok: false,
        error: `分配率は 0 より大きく 1 以下の小数で入力してください（80% なら 0.8）。入力値: ${rateInput}`,
      };
    }
    if (resolveCreatorLendingSplitRate(parsed) == null) {
      return { ok: false, error: `分配率が不正です。入力値: ${rateInput}` };
    }

    splitRate = parsed;
  }

  /* 一括保存と同じ RPC を1件で呼ぶ（書き込み経路を2本にしない） */
  const applied = await applyLendingTerms(
    auth.supabase,
    [{ creatorId, targetMonth, splitRate, isActive, note: note || null }],
    null,
  );

  if (!applied.ok) return { ok: false, error: applied.error };

  revalidateLendingViews();

  const rateLabel =
    splitRate == null
      ? `既定 ${Math.round(CREATOR_LENDING_SPLIT_RATE * 100)}%`
      : `${(splitRate * 100).toLocaleString("ja-JP", { maximumFractionDigits: 2 })}%`;

  const unchangedNote =
    applied.applied === 0 && applied.unchanged > 0 ? "（設定は変更前と同じでした）" : "";

  return {
    ok: true,
    message: `${targetMonth} の分配率を ${rateLabel}／${
      isActive ? "有効" : "無効"
    } に設定しました${unchangedNote}。監査ログ ${applied.logCount} 行。金額へ反映するには対象月を再集計してください。`,
  };
}

/**
 * 分配条件をまとめて有効化する（管理者のみ）。
 *
 * ■ クライアントの指定を信用しない（fail-closed）
 * 画面から送られてくる人月を、サーバー側で
 * fetchCreatorLendingSummary（本番の一覧と同じ関数）から組み直した
 * 候補と突き合わせる。候補に無い人月・支払済み・占有中・
 * 対象期間外の人月は書き込まずに却下する。
 *
 * ■ 初期精算モード
 * scope=initial_settlement のときは INITIAL_LENDING_SETTLEMENT の
 * 範囲（2026-02〜2026-07）に限定し、範囲外の人月を一切受け付けない。
 * 通常運用で期間を広げたいときは scope=all を使う（範囲の限定なし）。
 *
 * ■ 二重実行
 * すでに有効化されている人月は候補の段階で already_active として外れる。
 * terms は upsert、監査ログは差分だけなので、同じ操作を繰り返しても
 * 行は増えない。
 */
export async function bulkSetCreatorLendingTermsAction(
  _prev: BulkLendingTermResult | null,
  formData: FormData,
): Promise<BulkLendingTermResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const year = readText(formData, "year");
  const scopeInput = readText(formData, "scope");
  const rateInput = readText(formData, "split_rate");
  const note = readText(formData, "note");

  if (!isValidRewardYear(year)) {
    return { ok: false, error: "対象年の形式が正しくありません" };
  }
  if (note.length > 500) {
    return { ok: false, error: "備考は 500 文字以内で入力してください" };
  }

  const scope =
    scopeInput === "all" ? null : INITIAL_LENDING_SETTLEMENT;

  /* 率の扱いは単発保存と同じ。空欄は null（既定率はエンジンが解決する） */
  let splitRate: number | null = null;

  if (rateInput !== "") {
    const parsed = Number(rateInput);

    if (!Number.isFinite(parsed)) {
      return { ok: false, error: "分配率は数値で入力してください（例: 0.8）" };
    }
    if (resolveCreatorLendingSplitRate(parsed) == null) {
      return {
        ok: false,
        error: `分配率は 0 より大きく 1 以下の小数で入力してください（80% なら 0.8）。入力値: ${rateInput}`,
      };
    }

    splitRate = parsed;
  }

  /* entries は "creatorId|targetMonth"。画面でチェックされた行だけが送られてくる */
  const requested = formData
    .getAll("entries")
    .map((value) => String(value).split("|"))
    .filter((parts) => parts.length === 2)
    .map(([creatorId, targetMonth]) => ({
      creatorId: creatorId.trim(),
      targetMonth: targetMonth.trim(),
    }))
    .filter((entry) => isUuid(entry.creatorId) && isValidMonthKey(entry.targetMonth));

  if (requested.length === 0) {
    return { ok: false, error: "有効化する人月を1つ以上選択してください" };
  }

  const writeClient = getSupabaseAdmin();

  /* サーバー側で候補を組み直す（画面の値を信用しない） */
  const summary = await fetchCreatorLendingSummary(writeClient, year);

  if (summary.tableMissing) return { ok: false, error: MIGRATION_HINT };
  if (summary.error) return { ok: false, error: summary.error };

  const selection = new Set(requested.map((entry) => lendingTermRowKey(entry)));
  const plan = buildLendingTermChanges(summary.rows, selection, { splitRate, scope });

  /* 候補にそもそも載っていない人月（対象者違い・年違いなど） */
  const candidateKeys = new Set(
    collectLendingTermCandidates(summary.rows, scope).map((candidate) =>
      lendingTermRowKey(candidate),
    ),
  );
  const unknown = requested.filter(
    (entry) => !candidateKeys.has(lendingTermRowKey(entry)),
  );

  if (plan.changes.length === 0) {
    return {
      ok: false,
      error:
        "書き込む人月がありませんでした" +
        describeRejections(plan.skipped, unknown, true),
    };
  }

  /*
    1回の RPC 呼び出しで全件を渡す。
    RPC は1件でも検証に失敗したら例外を投げ、全件ロールバックされる。
    「前半だけ有効化された」状態は作らない。
  */
  const applied = await applyLendingTerms(
    auth.supabase,
    plan.changes.map((change) => ({
      creatorId: change.creatorId,
      targetMonth: change.targetMonth,
      splitRate: change.splitRate,
      isActive: true,
      note: note || null,
    })),
    scope,
  );

  const alreadyActive = plan.skipped.filter((item) => item.reason === "already_active").length;
  const rejected = plan.skipped.length - alreadyActive + unknown.length;

  if (!applied.ok) {
    /* 全件ロールバック済み。何件書けたかではなく「0件」を返す */
    return {
      ok: false,
      error:
        `有効化できませんでした（全件を取り消しました）: ${applied.error}` +
        describeRejections(plan.skipped, unknown, false),
    };
  }

  revalidateLendingViews();

  const summaryInfo = summarizeLendingTermPlan(plan);
  const rateLabel =
    splitRate == null
      ? `既定 ${Math.round(CREATOR_LENDING_SPLIT_RATE * 100)}%`
      : `${(splitRate * 100).toLocaleString("ja-JP", { maximumFractionDigits: 2 })}%`;

  return {
    ok: true,
    message:
      `${applied.applied} 人月を有効化しました（クリエイター ${summaryInfo.creatorCount} 名 / ` +
      `対象月 ${summaryInfo.months.join(", ")} / 分配率 ${rateLabel} / 監査ログ ${applied.logCount} 行）。` +
      `金額へ反映するには対象月を再集計してください。` +
      describeRejections(plan.skipped, unknown, false),
    succeededCount: applied.applied,
    /* RPC 側で「設定が同じ」と判定された分と、画面側で外した分の合計 */
    unchangedCount: applied.unchanged + alreadyActive,
    rejectedCount: rejected,
    failedCount: 0,
    logCount: applied.logCount,
  };
}

export type BulkLendingTermResult =
  | {
      ok: true;
      message: string;
      succeededCount: number;
      unchangedCount: number;
      rejectedCount: number;
      failedCount: number;
      logCount: number;
    }
  | { ok: false; error: string };

/*
  却下・未変更の内訳を文章にする。
  黙って飲み込むと「残りだけ成功」が成功に見えて、
  有効化できていない月に気づかないまま再集計へ進んでしまう。
*/
function describeRejections(
  skipped: ReturnType<typeof buildLendingTermChanges>["skipped"],
  unknown: Array<{ creatorId: string; targetMonth: string }>,
  standalone: boolean,
): string {
  const parts: string[] = [];
  const byReason = new Map<string, number>();

  for (const item of skipped) {
    byReason.set(item.reason, (byReason.get(item.reason) ?? 0) + 1);
  }

  for (const [reason, count] of byReason) {
    parts.push(
      `${LENDING_TERM_BLOCK_LABEL[reason as keyof typeof LENDING_TERM_BLOCK_LABEL]} ${count} 件`,
    );
  }

  if (unknown.length > 0) {
    parts.push(`対象候補に存在しない人月 ${unknown.length} 件`);
  }

  if (parts.length === 0) return "";

  return standalone ? `: ${parts.join(" / ")}` : `（対象外 ${parts.join(" / ")}）`;
}

/**
 * クリエイター本人の振込先を登録・更新する（管理者のみ）。
 *
 * 口座は creator_bank_accounts にだけ保存する。
 * creators には口座列を作らない（一覧・明細の画面に出さないため）。
 * 口座の中身は監査ログにも書かない（誰がいつ更新したかだけを残す）。
 */
export async function saveCreatorBankAccountAction(
  _prev: LendingActionResult | null,
  formData: FormData,
): Promise<LendingActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const creatorId = readText(formData, "creator_id");

  if (!isUuid(creatorId)) {
    return { ok: false, error: "クリエイターを指定してください" };
  }

  const bankName = readText(formData, "bank_name");
  const bankCode = readText(formData, "bank_code");
  const branchName = readText(formData, "bank_branch_name");
  const branchCode = readText(formData, "bank_branch_code");
  const accountType = readText(formData, "bank_account_type");
  const accountNumber = readText(formData, "bank_account_number");
  const accountHolder = readText(formData, "bank_account_holder");

  /*
    必須項目は支払処理（claim_payment_batch_items）が要求するものと揃える。

    claim は 銀行名・支店名・口座種別・口座番号・口座名義 に加えて
    銀行コードと支店コードも必須にしている（振込CSVに必要）。
    ここで任意にすると、画面は「登録済」でも支払時に
    「金融機関コード / 支店コードが未登録です」で止まる（M-1）。
    判定は lib/payments/bank-account.ts の resolveBankAccountState と同じ基準。
  */
  const missing = [
    ["銀行名", bankName],
    ["銀行コード", bankCode],
    ["支店名", branchName],
    ["支店コード", branchCode],
    ["口座種別", accountType],
    ["口座番号", accountNumber],
    ["口座名義", accountHolder],
  ]
    .filter(([, value]) => !String(value ?? "").trim())
    .map(([label]) => label);

  if (missing.length > 0) {
    return {
      ok: false,
      error: `振込に必要な項目が未入力です（${missing.join(" / ")}）。支払明細の作成にはすべて必要です。`,
    };
  }

  if (!/^\d{1,10}$/.test(accountNumber)) {
    return { ok: false, error: "口座番号は数字のみで入力してください（10桁以内）" };
  }
  if (!/^\d{4}$/.test(bankCode)) {
    return { ok: false, error: "銀行コードは4桁の数字で入力してください" };
  }
  if (!/^\d{3}$/.test(branchCode)) {
    return { ok: false, error: "支店コードは3桁の数字で入力してください" };
  }
  if (bankName.length > 100 || branchName.length > 100 || accountHolder.length > 100) {
    return { ok: false, error: "銀行名・支店名・口座名義は 100 文字以内で入力してください" };
  }
  /* 口座種別は支払系と同じ選択肢に限る（振込CSVの変換と食い違わせない） */
  if (!BANK_ACCOUNT_TYPES.includes(accountType as BankAccountType)) {
    return {
      ok: false,
      error: `口座種別は ${BANK_ACCOUNT_TYPES.join(" / ")} から選んでください`,
    };
  }

  const writeClient = getSupabaseAdmin();

  /* 対象が実在するクリエイターであることを確かめる */
  const { data: creator, error: creatorError } = await writeClient
    .from("creators")
    .select("id, creator_name")
    .eq("id", creatorId)
    .maybeSingle();

  if (creatorError) {
    return { ok: false, error: describeError(creatorError.message, creatorError.code) };
  }
  if (!creator) {
    return { ok: false, error: "クリエイターが見つかりません" };
  }

  /*
    保存する内容が支払系の基準で「登録済」になることを確かめる。
    ここを通らない値は保存しない（画面と支払判定を食い違わせない）。
  */
  const resolvedState = resolveBankAccountState({
    bankName,
    bankCode,
    bankBranchName: branchName,
    bankBranchCode: branchCode,
    bankAccountType: accountType,
    bankAccountNumber: accountNumber,
    bankAccountHolder: accountHolder,
  });

  if (resolvedState !== "registered") {
    return {
      ok: false,
      error: `振込先の内容が支払処理の必須条件を満たしません（判定: ${BANK_ACCOUNT_STATE_LABEL[resolvedState]}）。入力内容を確認してください。`,
    };
  }

  const { error } = await writeClient.from("creator_bank_accounts").upsert(
    {
      creator_id: creatorId,
      bank_name: bankName,
      bank_code: bankCode || null,
      bank_branch_name: branchName,
      bank_branch_code: branchCode || null,
      bank_account_type: accountType || null,
      bank_account_number: accountNumber,
      bank_account_holder: accountHolder,
      updated_by: auth.user.id,
      updated_by_email: auth.user.email ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "creator_id" },
  );

  if (error) {
    if (isMissingTable(error.code)) return { ok: false, error: MIGRATION_HINT };
    return { ok: false, error: describeError(error.message, error.code) };
  }

  revalidateLendingViews();

  /* 口座番号・名義はメッセージに含めない（画面やログに残さない） */
  return {
    ok: true,
    message: `「${creator.creator_name ?? "クリエイター"}」の振込先を登録しました`,
  };
}
