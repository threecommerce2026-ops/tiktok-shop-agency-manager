import type {
  LendingCreatorRow,
  LendingMonthlyRow,
} from "@/lib/db/creator-lending-queries";

/*
  端末貸し出しの「一括有効化」で、どの人月に本当に書き込むかを決める部分。

  画面から切り離してあるのは、ここが対象を決める唯一の場所だから。
  保存そのものは app/actions/creator-lending-rewards.ts の applyLendingTerm が
  持っているが、その手前で何を渡すかを間違えると、対象外の人月や
  支払済みの月へ一度に大量の書き込みが入る。
  月別区分ボードの lib/creators/monthly-account-type-board-draft.ts と
  同じ型にそろえてある。

  ■ 既定分配率をここに書かない
  率の決定は lib/creators/lending-reward-engine.ts の
  resolveCreatorLendingSplitRate() が単一ソース。
  空欄は null のまま運び、既定 80% はエンジン側で解決する
  （既定値が2か所に散ると食い違う）。

  ■ 初期精算の範囲と、通常運用の期間指定を分ける
  2026-02〜2026-07 の 5 名・17 人月は一度だけの過去分精算で、
  範囲は業務として確定している（2026-10-16 承認）。
  この範囲は INITIAL_LENDING_SETTLEMENT に名前付きで固定し、
  初期精算モードでは範囲外の人月を選択も処理もできないようにする。
  通常運用の期間指定（resolveLendingSyncMonths の "range"）は別経路で、
  締め月を固定しない。
*/

/** 選択キー: creatorId|targetMonth */
export type LendingTermSelection = Set<string>;

export function lendingTermRowKey(row: {
  creatorId: string;
  targetMonth: string;
}): string {
  return `${row.creatorId}|${row.targetMonth}`;
}

/** 対象月の範囲。両端を含む */
export type LendingMonthScope = {
  fromMonth: string;
  toMonth: string;
  label: string;
};

/**
 * 初期精算の範囲（2026-10-16 承認）。
 *
 * 2026-02〜2026-07 の 5 名・17 人月だけを精算する一度きりの作業。
 * 2026-08 以降はこの作業の対象外なので、初期精算モードでは
 * 選択候補にも出さず、サーバー側でも拒否する。
 */
export const INITIAL_LENDING_SETTLEMENT: LendingMonthScope = {
  fromMonth: "2026-02",
  toMonth: "2026-07",
  label: "初期精算（2026-02〜2026-07）",
};

/** 想定している初期精算の規模。実行前の確認表示と検算に使う */
export const INITIAL_LENDING_SETTLEMENT_EXPECTED = {
  creatorCount: 5,
  personMonthCount: 17,
} as const;

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isValidMonthKey(value: unknown): boolean {
  return typeof value === "string" && MONTH_PATTERN.test(value);
}

/** 対象月が範囲に入っているか。月キーは辞書順で比較できる形式 */
export function isWithinMonthScope(
  targetMonth: string,
  scope: LendingMonthScope | null,
): boolean {
  if (!isValidMonthKey(targetMonth)) return false;
  if (scope == null) return true;
  return targetMonth >= scope.fromMonth && targetMonth <= scope.toMonth;
}

/** 選択候補にできない理由。画面に出して理由が分かるようにする */
export type LendingTermBlockReason =
  | "out_of_scope"
  | "already_active"
  | "paid"
  | "in_batch"
  | "no_pending_lines";

export const LENDING_TERM_BLOCK_LABEL: Record<LendingTermBlockReason, string> = {
  out_of_scope: "この作業の対象期間外です",
  already_active: "すでに有効化されています",
  paid: "支払済みの明細があるため変更しません",
  in_batch: "支払明細に占有されているため変更しません",
  no_pending_lines: "計上できる注文明細がありません",
};

export type LendingTermCandidate = {
  creatorId: string;
  creatorName: string;
  tiktokId: string;
  targetMonth: string;
  /** 有効化すれば計上される見込みの明細数と AP */
  pendingLineCount: number;
  pendingAgencyRevenue: number;
  /** すでに計上されている明細数 */
  itemCount: number;
  /** いま適用される率（未設定なら既定。null は設定が不正） */
  effectiveSplitRate: number | null;
  isActivated: boolean;
  /** 選択できるか。false なら blockReason が入る */
  selectable: boolean;
  blockReason: LendingTermBlockReason | null;
};

function blockReasonOf(
  month: LendingMonthlyRow,
  scope: LendingMonthScope | null,
): LendingTermBlockReason | null {
  if (!isWithinMonthScope(month.targetMonth, scope)) return "out_of_scope";
  if (month.paymentState === "paid") return "paid";
  if (month.hasOpenBatch) return "in_batch";
  if (month.isActivated) return "already_active";
  /* 有効化しても計上するものが無い月は候補に出さない（無駄な書き込みを作らない） */
  if (month.pendingLineCount <= 0 && month.itemCount <= 0) return "no_pending_lines";
  return null;
}

/**
 * 画面に出す人月の候補を、クリエイター横断で平らに並べる。
 *
 * 選択できない行も理由つきで返す（黙って消すと、なぜ対象に
 * 出てこないのか画面から分からなくなる）。
 */
export function collectLendingTermCandidates(
  rows: readonly LendingCreatorRow[],
  scope: LendingMonthScope | null = null,
): LendingTermCandidate[] {
  const out: LendingTermCandidate[] = [];

  for (const row of rows) {
    for (const month of row.monthlyRows) {
      const blockReason = blockReasonOf(month, scope);

      out.push({
        creatorId: row.creatorId,
        creatorName: row.creatorName,
        tiktokId: row.tiktokId,
        targetMonth: month.targetMonth,
        pendingLineCount: month.pendingLineCount,
        pendingAgencyRevenue: month.pendingAgencyRevenue,
        itemCount: month.itemCount,
        effectiveSplitRate: month.effectiveSplitRate,
        isActivated: month.isActivated,
        selectable: blockReason == null,
        blockReason,
      });
    }
  }

  return out.sort(
    (a, b) =>
      a.targetMonth.localeCompare(b.targetMonth) ||
      a.tiktokId.localeCompare(b.tiktokId),
  );
}

/** 初期精算で選ぶべき人月（範囲内で選択可能なもの）をすべて選ぶ */
export function selectLendingTermCandidates(
  candidates: readonly LendingTermCandidate[],
): LendingTermSelection {
  const selection: LendingTermSelection = new Set();

  for (const candidate of candidates) {
    if (!candidate.selectable) continue;
    selection.add(lendingTermRowKey(candidate));
  }

  return selection;
}

export type LendingTermChange = {
  creatorId: string;
  creatorName: string;
  tiktokId: string;
  targetMonth: string;
  /** null なら既定 80%（エンジン側で解決する） */
  splitRate: number | null;
  isActive: true;
  pendingLineCount: number;
  pendingAgencyRevenue: number;
};

export type LendingTermPlan = {
  /** 実際に書き込む行 */
  changes: LendingTermChange[];
  /** 選択されたが書き込み不要・不可だった行 */
  skipped: Array<{
    creatorId: string;
    targetMonth: string;
    reason: LendingTermBlockReason;
  }>;
};

/**
 * 選択内容から、実際に書き込む行を決める。
 *
 * 範囲外・支払済み・占有中・すでに有効のものは書き込まない。
 * 二重実行したときに already_active で落ちるので、同じ操作を
 * 繰り返しても terms は増えず、監査ログも増えない。
 */
export function buildLendingTermChanges(
  rows: readonly LendingCreatorRow[],
  selection: LendingTermSelection,
  options: { splitRate?: number | null; scope?: LendingMonthScope | null } = {},
): LendingTermPlan {
  const scope = options.scope ?? null;
  const splitRate = options.splitRate ?? null;
  const candidates = collectLendingTermCandidates(rows, scope);

  const changes: LendingTermChange[] = [];
  const skipped: LendingTermPlan["skipped"] = [];

  for (const candidate of candidates) {
    if (!selection.has(lendingTermRowKey(candidate))) continue;

    if (!candidate.selectable) {
      skipped.push({
        creatorId: candidate.creatorId,
        targetMonth: candidate.targetMonth,
        reason: candidate.blockReason as LendingTermBlockReason,
      });
      continue;
    }

    changes.push({
      creatorId: candidate.creatorId,
      creatorName: candidate.creatorName,
      tiktokId: candidate.tiktokId,
      targetMonth: candidate.targetMonth,
      splitRate,
      isActive: true,
      pendingLineCount: candidate.pendingLineCount,
      pendingAgencyRevenue: candidate.pendingAgencyRevenue,
    });
  }

  return { changes, skipped };
}

export type LendingTermPlanSummary = {
  creatorCount: number;
  personMonthCount: number;
  months: string[];
  pendingLineCount: number;
  pendingAgencyRevenue: number;
  /** null なら既定率を使う */
  splitRate: number | null;
  skippedCount: number;
};

/** 実行前の確認に出す集計。件数はここでだけ数える */
export function summarizeLendingTermPlan(
  plan: LendingTermPlan,
): LendingTermPlanSummary {
  const { changes } = plan;

  return {
    creatorCount: new Set(changes.map((change) => change.creatorId)).size,
    personMonthCount: changes.length,
    months: [...new Set(changes.map((change) => change.targetMonth))].sort(),
    pendingLineCount: changes.reduce(
      (total, change) => total + change.pendingLineCount,
      0,
    ),
    pendingAgencyRevenue: changes.reduce(
      (total, change) => total + change.pendingAgencyRevenue,
      0,
    ),
    splitRate: changes.length > 0 ? changes[0].splitRate : null,
    skippedCount: plan.skipped.length,
  };
}

/* --- 再集計の対象月 -------------------------------------------------------- */

export type LendingSyncScope = "month" | "year" | "range" | "initial_settlement";

export type LendingSyncMonthsInput = {
  scope: string;
  /** scope=month */
  month?: string | null;
  /** scope=year */
  year?: string | null;
  /** scope=range（通常運用。締め月を固定しない） */
  fromMonth?: string | null;
  toMonth?: string | null;
  /** 当月。これより後の月は再集計しない */
  currentMonth: string;
  /** scope=initial_settlement で使う固定範囲 */
  settlementScope?: LendingMonthScope;
};

export type LendingSyncMonthsResult =
  | { ok: true; months: string[]; scope: LendingSyncScope }
  | { ok: false; error: string };

/** 一度の再集計で許す月数の上限（操作ミスで全期間を流さないため） */
export const LENDING_SYNC_MAX_MONTHS = 24;

/**
 * 再集計する対象月を決める（純関数）。
 *
 * 当月より後の月は常に落とす。
 * initial_settlement は承認済みの固定範囲だけを返し、
 * 範囲外の月を混ぜられないようにする。
 */
export function resolveLendingSyncMonths(
  input: LendingSyncMonthsInput,
): LendingSyncMonthsResult {
  const { currentMonth } = input;

  if (!isValidMonthKey(currentMonth)) {
    return { ok: false, error: "当月の取得に失敗しました" };
  }

  const clamp = (months: string[]): string[] =>
    months.filter((month) => month <= currentMonth);

  if (input.scope === "initial_settlement") {
    const scope = input.settlementScope ?? INITIAL_LENDING_SETTLEMENT;
    const months = clamp(expandMonths(scope.fromMonth, scope.toMonth));

    if (months.length === 0) {
      return { ok: false, error: "初期精算の対象月がありません" };
    }

    return { ok: true, months, scope: "initial_settlement" };
  }

  if (input.scope === "range") {
    const from = String(input.fromMonth ?? "").trim();
    const to = String(input.toMonth ?? "").trim();

    if (!isValidMonthKey(from) || !isValidMonthKey(to)) {
      return { ok: false, error: "開始月と終了月を YYYY-MM の形式で指定してください" };
    }
    if (from > to) {
      return { ok: false, error: "開始月が終了月より後になっています" };
    }

    const expanded = expandMonths(from, to);

    if (expanded.length > LENDING_SYNC_MAX_MONTHS) {
      return {
        ok: false,
        error: `一度に再集計できるのは ${LENDING_SYNC_MAX_MONTHS} か月までです（指定 ${expanded.length} か月）`,
      };
    }

    const months = clamp(expanded);

    if (months.length === 0) {
      return { ok: false, error: "再集計する対象月がありません（当月より後の月は対象外です）" };
    }

    return { ok: true, months, scope: "range" };
  }

  if (input.scope === "year") {
    const year = String(input.year ?? "").trim();

    if (!/^\d{4}$/.test(year)) {
      return { ok: false, error: "対象年の形式が正しくありません" };
    }

    const months = clamp(expandMonths(`${year}-01`, `${year}-12`));

    if (months.length === 0) {
      return { ok: false, error: "再集計する対象月がありません" };
    }

    return { ok: true, months, scope: "year" };
  }

  const month = String(input.month ?? "").trim();

  if (!isValidMonthKey(month)) {
    return { ok: false, error: "対象月の形式が正しくありません（例: 2026-07）" };
  }
  if (month > currentMonth) {
    return { ok: false, error: "当月より後の月は再集計できません" };
  }

  return { ok: true, months: [month], scope: "month" };
}

/*
  月の展開。lib/referrals/referral-reward-preview.ts の expandMonthRange と
  同じ結果になるが、このモジュールを紹介者側へ依存させたくないので
  ここに小さく持つ（純粋な月計算で、業務ルールは含まない）。
*/
function expandMonths(fromMonth: string, toMonth: string): string[] {
  if (!isValidMonthKey(fromMonth) || !isValidMonthKey(toMonth)) return [];
  if (fromMonth > toMonth) return [];

  const out: string[] = [];
  let [year, month] = fromMonth.split("-").map((part) => Number(part));

  for (let guard = 0; guard < 240; guard += 1) {
    const key = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
    out.push(key);
    if (key === toMonth) break;

    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return out;
}
