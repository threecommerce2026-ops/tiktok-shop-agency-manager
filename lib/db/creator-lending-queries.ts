import type { SupabaseClient } from "@supabase/supabase-js";

import {
  LENDING_EXCLUSION_LABEL,
  CREATOR_LENDING_SPLIT_RATE,
  resolveCreatorLendingSplitRate,
  resolveLendingExclusionReason,
  sumLendingAmounts,
  type LendingExclusionReason,
  type LendingOrderLine,
} from "@/lib/creators/lending-reward-engine";
import { fetchLendingTerms, getLendingTerm } from "@/lib/creators/lending-terms";
import {
  fetchMonthlyAccountTypes,
  monthlyAccountTypeKey,
  resolveMonthlyAccountManagementType,
} from "@/lib/creators/monthly-account-management-type";
import { fetchAllFrom } from "@/lib/db/paged-select";
import {
  bankAccountFromRow,
  resolveBankAccountState,
  type BankAccountState,
} from "@/lib/payments/bank-account";
import {
  isMissingLendingTable,
  LENDING_TABLE_MISSING_MESSAGE,
} from "@/lib/payments/creator-lending-payee";
import { roundAgencyAmount } from "@/lib/agency/agency-reward-engine";

/*
  端末貸し出し報酬の画面用の読み取り。

  ■ 金額の計算はしない
  creator_lending_reward_items に保存済みの本人報酬・自社取り分を集計するだけ。

  ■ 一覧の母集合は「対象月の区分がアカウント貸し出しの人」
  報酬明細だけを母集合にすると、まだ有効化していないクリエイターが
  一覧に出ない。有効化のフォームは一覧の行を展開した先にあるため、
  それでは初回の有効化が画面からできなくなる（鶏と卵）。

  そこで母集合を次の和集合にする。
    ① 報酬明細があるクリエイター（計上済み）
    ② 対象月の区分が account_lending の注文明細があるクリエイター（対象候補）

  ②には報酬 0 円の行も出し、「なぜ計上されていないか」を月ごとに添える。
  これで未有効化の人も一覧に並び、分配率設定と口座登録に進める。

  ■ 対象外の理由は計算と同じ関数で出す
  lib/creators/lending-reward-engine.ts の resolveLendingExclusionReason()
  を呼ぶ。画面と計算で理由が食い違わないようにする。

  ■ 口座情報
  一覧へは「登録済みか」と口座番号の下4桁しか渡さない。
  全桁は画面にもログにも出さない。
*/

/*
  月の支払状態。creator_lending_reward_items だけから決める。

    none      その月に計上された明細が無い
    unpaid    未払い（支払明細にも入っていない）
    in_batch  支払明細に占有されている（承認前〜振込前）
    partial   一部だけ支払済み
    paid      全額支払済み
*/
export type LendingMonthPaymentState =
  | "none"
  | "unpaid"
  | "in_batch"
  | "partial"
  | "paid";

export type LendingMonthlyRow = {
  targetMonth: string;
  itemCount: number;
  agencyRevenue: number;
  rewardAmount: number;
  selfShareAmount: number;
  /** 明細に記録された適用分配率。複数あれば混在として null */
  splitRate: number | null;
  /** 分配条件から解決した、いま適用される率（未設定なら既定 80%） */
  effectiveSplitRate: number | null;
  /** その月が端末貸し出しの対象として有効化されているか */
  isActivated: boolean;
  paidAmount: number;
  unpaidAmount: number;
  /**
   * その月の支払状態。明細（is_paid）と支払明細の占有だけから導く。
   *
   * creator_lending_payouts.total_reward_amount は「対象月時点の年初来累積」
   * スナップショットで、月別の未払い債務ではない。支払後も古い行が
   * 残るため、画面と支払候補の判断には使わない（M-3）。
   */
  paymentState: LendingMonthPaymentState;
  /** 支払明細に占有されている明細があるか */
  hasOpenBatch: boolean;
  /** 報酬が作られていない理由（計上済みなら null） */
  exclusionReason: LendingExclusionReason | null;
  exclusionLabel: string | null;
  /** まだ計上されていない注文明細の件数 */
  pendingLineCount: number;
  /** まだ計上されていない AP の合計 */
  pendingAgencyRevenue: number;
};

export type LendingCreatorRow = {
  creatorId: string;
  creatorName: string;
  tiktokId: string;
  /** 対象月の所属（自社であることが条件） */
  inHouseAgencyName: string | null;
  itemCount: number;
  agencyRevenue: number;
  rewardAmount: number;
  selfShareAmount: number;
  paidAmount: number;
  unpaidAmount: number;
  /** 報酬が計上されている月の数 */
  monthCount: number;
  /** 計上されていない月の数 */
  pendingMonthCount: number;
  /** 計上されていない AP の合計 */
  pendingAgencyRevenue: number;
  /** 1か月でも有効化されているか */
  isActivated: boolean;
  /**
   * 振込先の状態。支払系と同じ判定（lib/payments/bank-account.ts）を使う。
   *   registered  振込に必要な項目がすべて揃っている
   *   incomplete  銀行コード / 支店コードが未登録（振込CSVを出せない）
   *   missing     必須項目が欠けている
   */
  bankState: BankAccountState;
  /** 振込先がそのまま使えるか（registered のときだけ true） */
  hasBankAccount: boolean;
  monthlyRows: LendingMonthlyRow[];
};

export type LendingExclusionRow = {
  creatorId: string;
  creatorName: string;
  tiktokId: string;
  targetMonth: string;
  reason: LendingExclusionReason;
  reasonLabel: string;
  lineCount: number;
  agencyRevenue: number;
};

export type LendingTermRow = {
  creatorId: string;
  creatorName: string;
  tiktokId: string;
  targetMonth: string;
  /** null なら既定率が適用される */
  splitRate: number | null;
  /** 実際に適用される率（既定を解決した値） */
  effectiveSplitRate: number;
  isActive: boolean;
  note: string | null;
};

export type LendingSummary = {
  year: string;
  defaultSplitRate: number;
  /**
   * 端末貸し出し報酬のテーブルが未作成か（migration 適用前）。
   * true のときは error ではなく案内を出す（生の DB エラーを見せない）。
   */
  tableMissing: boolean;
  rows: LendingCreatorRow[];
  terms: LendingTermRow[];
  exclusions: LendingExclusionRow[];
  totals: {
    creatorCount: number;
    /** 1件でも報酬が計上されているクリエイターの数 */
    activatedCreatorCount: number;
    itemCount: number;
    agencyRevenue: number;
    rewardAmount: number;
    selfShareAmount: number;
    paidAmount: number;
    unpaidAmount: number;
    /** 未計上の月数と AP（有効化すれば計上される見込み） */
    pendingMonthCount: number;
    pendingAgencyRevenue: number;
  };
  error: string | null;
};

const ITEM_COLUMNS =
  "target_month, creator_id, in_house_agency_id, agency_revenue, split_rate, reward_amount, self_share_amount, is_reward_target, is_paid, payout_id, payment_batch_id";

const ORDER_LINE_COLUMNS =
  "source_row_key, order_id, product_id, creator_id, target_month, commission_base, commission_gmv, creator_revenue_before_split, agency_split_rate, agency_revenue, payment_status, order_status, refund_status";

type ItemRow = {
  target_month: string;
  creator_id: string;
  in_house_agency_id: string | null;
  agency_revenue: number | string | null;
  split_rate: number | string | null;
  reward_amount: number | string | null;
  self_share_amount: number | string | null;
  is_reward_target: boolean;
  is_paid: boolean;
  payout_id: string | null;
  payment_batch_id: string | null;
};

/** 対象候補（区分がアカウント貸し出しの人月）の集計 */
type CandidateMonth = {
  lineCount: number;
  agencyRevenue: number;
  /** その人月で最初に見つかった理由。計上済みの明細しか無ければ null */
  reason: LendingExclusionReason | null;
  pendingLineCount: number;
  pendingAgencyRevenue: number;
  agencyId: string | null;
};

type MonthAcc = {
  items: number;
  ap: number[];
  reward: number[];
  self: number[];
  paid: number[];
  rates: Set<number>;
  openBatch: boolean;
};

/**
 * 月の支払状態を明細から導く。
 *
 * 支払予定（creator_lending_payouts）の status は見ない。
 * あちらは年初来累積のスナップショットで、支払後も古い行が残るため
 * 月別の債務としては読めない（M-3）。
 */
function resolveMonthPaymentState(params: {
  itemCount: number;
  paidAmount: number;
  unpaidAmount: number;
  hasOpenBatch: boolean;
}): LendingMonthPaymentState {
  if (params.itemCount === 0) return "none";
  if (params.paidAmount > 0 && params.unpaidAmount <= 0.005) return "paid";
  if (params.paidAmount > 0) return "partial";
  if (params.hasOpenBatch) return "in_batch";
  return "unpaid";
}

function toAmount(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function emptySummary(year: string): LendingSummary {
  return {
    year,
    defaultSplitRate: CREATOR_LENDING_SPLIT_RATE,
    tableMissing: false,
    rows: [],
    terms: [],
    exclusions: [],
    totals: {
      creatorCount: 0,
      activatedCreatorCount: 0,
      itemCount: 0,
      agencyRevenue: 0,
      rewardAmount: 0,
      selfShareAmount: 0,
      paidAmount: 0,
      unpaidAmount: 0,
      pendingMonthCount: 0,
      pendingAgencyRevenue: 0,
    },
    error: null,
  };
}

/**
 * 対象年の端末貸し出し報酬を読み込む。
 *
 * 明細・支払予定・分配条件・対象候補・対象外の理由をまとめて返す。
 * 計算はしない（保存済みの値を集計するだけ）。
 */
export async function fetchCreatorLendingSummary(
  supabase: SupabaseClient,
  year: string,
): Promise<LendingSummary> {
  const empty = emptySummary(year);

  const [
    itemsResult,
    creatorsResult,
    agenciesResult,
    bankResult,
    termsResult,
    ordersResult,
    assignmentsResult,
    monthlyTypesResult,
  ] = await Promise.all([
    fetchAllFrom<ItemRow>(
      supabase,
      "creator_lending_reward_items",
      ITEM_COLUMNS,
      (query) =>
        query
          .gte("target_month", `${year}-01`)
          .lte("target_month", `${year}-12`)
          .order("target_month", { ascending: true }),
    ),
    fetchAllFrom<{
      id: string;
      creator_name: string | null;
      tiktok_id: string | null;
      account_management_type: string | null;
    }>(supabase, "creators", "id, creator_name, tiktok_id, account_management_type"),
    supabase.from("agencies").select("id, name, is_in_house"),
    /*
      振込先の状態判定に必要な列を読む。

      「登録済み」の基準は支払系（lib/payments/bank-account.ts）と同じにする。
      口座番号の有無だけで判定すると、銀行コード・支店コードが無い状態でも
      一覧が「登録済」と出てしまい、支払側の「不備」と食い違う（M-1）。
      画面へ渡すのは状態と下4桁だけで、全桁は返さない。

      このテーブルの主キーは creator_id で id 列が無いため、
      ページング順を creator_id で指定する（既定の id では失敗する）。
    */
    fetchAllFrom<Record<string, unknown>>(
      supabase,
      "creator_bank_accounts",
      "creator_id, bank_name, bank_code, bank_branch_name, bank_branch_code, bank_account_type, bank_account_number, bank_account_holder",
      undefined,
      { tiebreakColumn: "creator_id" },
    ),
    fetchLendingTerms(supabase),
    /* 対象候補と対象外の理由を出すために注文明細を読む */
    fetchAllFrom<LendingOrderLine>(
      supabase,
      "affiliate_order_lines",
      ORDER_LINE_COLUMNS,
      (query) =>
        query.gte("target_month", `${year}-01`).lte("target_month", `${year}-12`),
    ),
    fetchAllFrom<{ creator_id: string; target_month: string; agency_id: string | null }>(
      supabase,
      "creator_monthly_agency_assignments",
      "creator_id, target_month, agency_id",
      (query) =>
        query.gte("target_month", `${year}-01`).lte("target_month", `${year}-12`),
    ),
    fetchMonthlyAccountTypes(supabase),
  ]);

  /*
    口座の読み取り失敗も error にする。

    握り潰すと「口座未登録」と区別できず、登録済みのクリエイターが
    未登録として表示される（ローカル検証で実際に起きた）。
    支払可否の判断に使う表示なので、読めないことを黙って隠さない。
  */
  /*
    テーブル未作成（migration 適用前）は error にしない。
    生の DB エラーではなく案内を出す（M-5）。
  */
  if (
    itemsResult.error &&
    isMissingLendingTable(itemsResult.error, itemsResult.errorCode)
  ) {
    return { ...empty, tableMissing: true };
  }

  const loadError =
    itemsResult.error ??
    creatorsResult.error ??
    agenciesResult.error?.message ??
    bankResult.error ??
    termsResult.error ??
    ordersResult.error ??
    assignmentsResult.error ??
    monthlyTypesResult.error ??
    null;

  if (loadError) return { ...empty, error: loadError };

  const creatorById = new Map(
    creatorsResult.data.map((row) => [
      row.id,
      {
        creatorName: String(row.creator_name ?? "—"),
        tiktokId: String(row.tiktok_id ?? ""),
        accountManagementType: row.account_management_type ?? null,
      },
    ]),
  );

  const agencyNameById = new Map<string, string>();
  const inHouseAgencyIds = new Set<string>();
  for (const agency of agenciesResult.data ?? []) {
    agencyNameById.set(agency.id as string, String(agency.name ?? ""));
    if (agency.is_in_house === true) inHouseAgencyIds.add(agency.id as string);
  }

  /*
    口座は状態（registered / incomplete / missing）だけを持つ。
    番号などは画面へ渡さない。
  */
  const bankStateByCreator = new Map<string, BankAccountState>();
  for (const row of bankResult.data ?? []) {
    bankStateByCreator.set(
      String(row.creator_id),
      resolveBankAccountState(bankAccountFromRow(row)),
    );
  }

  const assignmentByKey = new Map<string, string | null>();
  for (const row of assignmentsResult.data) {
    assignmentByKey.set(`${row.creator_id}|${row.target_month}`, row.agency_id ?? null);
  }

  /*
    --- 対象候補（区分がアカウント貸し出しの人月）------------------------------

    区分が貸出でない明細は候補にしない。通常のクリエイターが毎月大量に並ぶと、
    本来確認したい「貸出なのに計上されていない行」が埋もれる。
  */
  const candidates = new Map<string, Map<string, CandidateMonth>>();

  for (const line of ordersResult.data) {
    const creatorId = line.creator_id;
    const targetMonth = line.target_month;
    if (!creatorId || !targetMonth) continue;

    const meta = creatorById.get(creatorId);

    const resolvedType = resolveMonthlyAccountManagementType({
      creatorId,
      targetMonth,
      monthlyType: monthlyTypesResult.index.get(
        monthlyAccountTypeKey(creatorId, targetMonth),
      ),
      currentType: meta?.accountManagementType ?? null,
    });

    if (resolvedType.accountManagementType !== "account_lending") continue;

    const assignmentKey = `${creatorId}|${targetMonth}`;
    const agencyId = assignmentByKey.get(assignmentKey) ?? null;
    const term = getLendingTerm(termsResult.index, creatorId, targetMonth);

    const reason = resolveLendingExclusionReason(line, {
      creatorId,
      targetMonth,
      accountManagementType: resolvedType.accountManagementType,
      agencyId,
      agencyIsInHouse: agencyId ? inHouseAgencyIds.has(agencyId) : false,
      assignmentConfirmed: assignmentByKey.has(assignmentKey) && agencyId != null,
      isActive: term.isActive,
      splitRateOverride: term.splitRate,
    });

    const byMonth = candidates.get(creatorId) ?? new Map<string, CandidateMonth>();
    const current =
      byMonth.get(targetMonth) ??
      {
        lineCount: 0,
        agencyRevenue: 0,
        reason: null,
        pendingLineCount: 0,
        pendingAgencyRevenue: 0,
        agencyId,
      };

    current.lineCount += 1;
    current.agencyRevenue = roundAgencyAmount(
      current.agencyRevenue + toAmount(line.agency_revenue),
    );
    if (current.agencyId == null) current.agencyId = agencyId;

    if (reason != null) {
      /* 最初に見つかった理由を代表にする（ふつうは人月で1種類） */
      if (current.reason == null) current.reason = reason;
      current.pendingLineCount += 1;
      current.pendingAgencyRevenue = roundAgencyAmount(
        current.pendingAgencyRevenue + toAmount(line.agency_revenue),
      );
    }

    byMonth.set(targetMonth, current);
    candidates.set(creatorId, byMonth);
  }

  // ---- 明細の集計 -----------------------------------------------------------
  const itemsByCreator = new Map<
    string,
    { byMonth: Map<string, MonthAcc>; inHouseAgencyId: string | null }
  >();

  for (const item of itemsResult.data) {
    if (!item.is_reward_target) continue;

    const acc =
      itemsByCreator.get(item.creator_id) ??
      {
        byMonth: new Map<string, MonthAcc>(),
        inHouseAgencyId: item.in_house_agency_id ?? null,
      };

    const month =
      acc.byMonth.get(item.target_month) ??
      {
        items: 0,
        ap: [],
        reward: [],
        self: [],
        paid: [],
        rates: new Set<number>(),
        openBatch: false,
      };

    const reward = toAmount(item.reward_amount);
    month.items += 1;
    month.ap.push(toAmount(item.agency_revenue));
    month.reward.push(reward);
    month.self.push(toAmount(item.self_share_amount));
    if (item.is_paid) month.paid.push(reward);
    month.rates.add(toAmount(item.split_rate));
    if (item.payment_batch_id != null && !item.is_paid) month.openBatch = true;

    acc.byMonth.set(item.target_month, month);
    if (acc.inHouseAgencyId == null) acc.inHouseAgencyId = item.in_house_agency_id ?? null;
    itemsByCreator.set(item.creator_id, acc);
  }

  // ---- 行の組み立て（明細 ∪ 対象候補）---------------------------------------
  const creatorIds = new Set<string>([...itemsByCreator.keys(), ...candidates.keys()]);
  const rows: LendingCreatorRow[] = [];

  for (const creatorId of creatorIds) {
    const meta = creatorById.get(creatorId);
    const itemAcc = itemsByCreator.get(creatorId);
    const candidateMonths = candidates.get(creatorId) ?? new Map<string, CandidateMonth>();

    const months = new Set<string>([
      ...(itemAcc ? itemAcc.byMonth.keys() : []),
      ...candidateMonths.keys(),
    ]);

    const monthlyRows: LendingMonthlyRow[] = [...months]
      .map((targetMonth) => {
        const m = itemAcc?.byMonth.get(targetMonth) ?? null;
        const candidate = candidateMonths.get(targetMonth) ?? null;
        const term = getLendingTerm(termsResult.index, creatorId, targetMonth);

        const rewardAmount = m ? sumLendingAmounts(m.reward) : 0;
        const paidAmount = m ? sumLendingAmounts(m.paid) : 0;
        const unpaidAmount = roundAgencyAmount(rewardAmount - paidAmount);
        const rates = m ? [...m.rates] : [];

        return {
          targetMonth,
          itemCount: m?.items ?? 0,
          agencyRevenue: m ? sumLendingAmounts(m.ap) : 0,
          rewardAmount,
          selfShareAmount: m ? sumLendingAmounts(m.self) : 0,
          splitRate: rates.length === 1 ? rates[0] : null,
          effectiveSplitRate: resolveCreatorLendingSplitRate(term.splitRate),
          isActivated: term.isActive,
          paidAmount,
          unpaidAmount,
          paymentState: resolveMonthPaymentState({
            itemCount: m?.items ?? 0,
            paidAmount,
            unpaidAmount,
            hasOpenBatch: m?.openBatch ?? false,
          }),
          hasOpenBatch: m?.openBatch ?? false,
          exclusionReason: candidate?.reason ?? null,
          exclusionLabel: candidate?.reason
            ? LENDING_EXCLUSION_LABEL[candidate.reason]
            : null,
          pendingLineCount: candidate?.pendingLineCount ?? 0,
          pendingAgencyRevenue: candidate?.pendingAgencyRevenue ?? 0,
        };
      })
      .sort((a, b) => a.targetMonth.localeCompare(b.targetMonth));

    const rewardAmount = sumLendingAmounts(monthlyRows.map((m) => m.rewardAmount));
    const paidAmount = sumLendingAmounts(monthlyRows.map((m) => m.paidAmount));

    /*
      所属の表示。
      明細がある月は記録した自社所属を使い、無ければ対象月の確定所属から引く。
    */
    const agencyIdForLabel =
      itemAcc?.inHouseAgencyId ??
      [...candidateMonths.values()].find((c) => c.agencyId != null)?.agencyId ??
      null;

    rows.push({
      creatorId,
      creatorName: meta?.creatorName ?? "—",
      tiktokId: meta?.tiktokId ?? "",
      inHouseAgencyName: agencyIdForLabel
        ? agencyNameById.get(agencyIdForLabel) ?? null
        : null,
      itemCount: monthlyRows.reduce((sum, m) => sum + m.itemCount, 0),
      agencyRevenue: sumLendingAmounts(monthlyRows.map((m) => m.agencyRevenue)),
      rewardAmount,
      selfShareAmount: sumLendingAmounts(monthlyRows.map((m) => m.selfShareAmount)),
      paidAmount,
      unpaidAmount: roundAgencyAmount(rewardAmount - paidAmount),
      monthCount: monthlyRows.filter((m) => m.itemCount > 0).length,
      pendingMonthCount: monthlyRows.filter((m) => m.pendingLineCount > 0).length,
      pendingAgencyRevenue: sumLendingAmounts(
        monthlyRows.map((m) => m.pendingAgencyRevenue),
      ),
      isActivated: monthlyRows.some((m) => m.isActivated),
      bankState: bankStateByCreator.get(creatorId) ?? "missing",
      hasBankAccount: (bankStateByCreator.get(creatorId) ?? "missing") === "registered",
      monthlyRows,
    });
  }

  /* 計上済みを上に、未計上は AP の大きい順に続ける */
  rows.sort(
    (a, b) =>
      b.rewardAmount - a.rewardAmount ||
      b.pendingAgencyRevenue - a.pendingAgencyRevenue ||
      a.tiktokId.localeCompare(b.tiktokId),
  );

  /* 分配条件の一覧（設定画面の表示用） */
  const terms: LendingTermRow[] = [];
  for (const [, term] of termsResult.index) {
    if (!term.targetMonth.startsWith(`${year}-`)) continue;
    const meta = creatorById.get(term.creatorId);
    terms.push({
      creatorId: term.creatorId,
      creatorName: meta?.creatorName ?? "—",
      tiktokId: meta?.tiktokId ?? "",
      targetMonth: term.targetMonth,
      splitRate: term.splitRate,
      effectiveSplitRate: term.splitRate ?? CREATOR_LENDING_SPLIT_RATE,
      isActive: term.isActive,
      note: term.note,
    });
  }
  terms.sort(
    (a, b) =>
      a.tiktokId.localeCompare(b.tiktokId) || a.targetMonth.localeCompare(b.targetMonth),
  );

  /* 対象外の理由（人月×理由）。一覧の月行にも同じ理由を載せている */
  const exclusions: LendingExclusionRow[] = [];
  for (const [creatorId, byMonth] of candidates) {
    const meta = creatorById.get(creatorId);
    for (const [targetMonth, candidate] of byMonth) {
      if (candidate.reason == null) continue;
      exclusions.push({
        creatorId,
        creatorName: meta?.creatorName ?? "—",
        tiktokId: meta?.tiktokId ?? "",
        targetMonth,
        reason: candidate.reason,
        reasonLabel: LENDING_EXCLUSION_LABEL[candidate.reason],
        lineCount: candidate.pendingLineCount,
        agencyRevenue: candidate.pendingAgencyRevenue,
      });
    }
  }
  exclusions.sort(
    (a, b) =>
      a.tiktokId.localeCompare(b.tiktokId) ||
      a.targetMonth.localeCompare(b.targetMonth) ||
      a.reason.localeCompare(b.reason),
  );

  return {
    year,
    defaultSplitRate: CREATOR_LENDING_SPLIT_RATE,
    tableMissing: false,
    rows,
    terms,
    exclusions,
    totals: {
      creatorCount: rows.length,
      activatedCreatorCount: rows.filter((row) => row.itemCount > 0).length,
      itemCount: rows.reduce((sum, r) => sum + r.itemCount, 0),
      agencyRevenue: sumLendingAmounts(rows.map((r) => r.agencyRevenue)),
      rewardAmount: sumLendingAmounts(rows.map((r) => r.rewardAmount)),
      selfShareAmount: sumLendingAmounts(rows.map((r) => r.selfShareAmount)),
      paidAmount: sumLendingAmounts(rows.map((r) => r.paidAmount)),
      unpaidAmount: sumLendingAmounts(rows.map((r) => r.unpaidAmount)),
      pendingMonthCount: rows.reduce((sum, r) => sum + r.pendingMonthCount, 0),
      pendingAgencyRevenue: sumLendingAmounts(rows.map((r) => r.pendingAgencyRevenue)),
    },
    error: null,
  };
}

/** 口座の登録状況（中身は返さない）。一覧画面で使う */
export type CreatorBankAccountStatus = {
  creatorId: string;
  /** 支払系と同じ判定（registered のときだけ支払明細を作れる） */
  state: BankAccountState;
  registered: boolean;
  bankName: string | null;
  bankBranchName: string | null;
  bankAccountHolder: string | null;
  /** 口座番号は下4桁だけ。全桁は画面へ渡さない */
  accountNumberTail: string | null;
  updatedByEmail: string | null;
  updatedAt: string | null;
};

/**
 * 口座の登録状況を読む（管理者のみ）。
 *
 * 口座番号は下4桁だけを返す。全桁は画面にもログにも出さない。
 * 編集画面で全桁が必要な場合は、専用のサーバー側処理でその都度読むこと。
 */
export async function fetchCreatorBankAccountStatuses(
  supabase: SupabaseClient,
  creatorIds: string[],
): Promise<{ data: Map<string, CreatorBankAccountStatus>; error: string | null }> {
  if (creatorIds.length === 0) return { data: new Map(), error: null };

  const result = await fetchAllFrom<Record<string, unknown>>(
    supabase,
    "creator_bank_accounts",
    "creator_id, bank_name, bank_code, bank_branch_name, bank_branch_code, bank_account_type, bank_account_number, bank_account_holder, updated_by_email, updated_at",
    (query) => query.in("creator_id", creatorIds),
    /* 主キーは creator_id（id 列が無い） */
    { tiebreakColumn: "creator_id" },
  );

  if (result.error) return { data: new Map(), error: result.error };

  const map = new Map<string, CreatorBankAccountStatus>();

  for (const row of result.data) {
    const account = bankAccountFromRow(row);
    const number = String(account.bankAccountNumber ?? "").trim();
    const state = resolveBankAccountState(account);
    const creatorId = String(row.creator_id);

    map.set(creatorId, {
      creatorId,
      state,
      /* 支払系と同じ基準。番号があるだけでは「登録済」にしない（M-1） */
      registered: state === "registered",
      bankName: account.bankName,
      bankBranchName: account.bankBranchName,
      bankAccountHolder: account.bankAccountHolder,
      accountNumberTail: number ? number.slice(-4) : null,
      updatedByEmail: (row.updated_by_email as string | null) ?? null,
      updatedAt: (row.updated_at as string | null) ?? null,
    });
  }

  return { data: map, error: null };
}
