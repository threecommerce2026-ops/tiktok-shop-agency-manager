import type { SupabaseClient } from "@supabase/supabase-js";

import { fetchAllFrom } from "@/lib/db/paged-select";
import { sumAgencyAmounts } from "@/lib/agency/agency-reward-engine";
import {
  REFERRAL_PAYOUT_THRESHOLD_YEN,
  resolveRewardItemAmount,
  sumReferralAmounts,
} from "@/lib/referrals/referral-reward-engine";
import { toAmount } from "@/lib/revenue/amount";
import {
  bankAccountFromRow,
  toBankAccountView,
  type BankAccountView,
  type PayeeBankAccount,
} from "@/lib/payments/bank-account";
import {
  isPayable,
  resolvePaymentHoldReasons,
  type PayeeKind,
  type PaymentHoldReason,
} from "@/lib/payments/payable";
import {
  isOpenPaymentBatchStatus,
  type PaymentBatchAction,
  type PaymentBatchStatus,
} from "@/lib/payments/payment-status";

/*
  支払管理のデータソース。

  ■ 金額の正式source
    代理店   agency_reward_items.reward_amount
    紹介者   referral_reward_items.coalesce(adjusted_reward_amount, reward_amount)

  agency_payouts / referral_payouts の total_reward_amount は
  「対象月時点の年初来累積スナップショット」で行をまたいで重複するため、
  このモジュールでは金額の根拠として一切使わない。

  ■ 支払先は代理店に一本化する
  紹介者は独立した支払先ではない。referrers.agency_id が指す代理店へ
  紹介者報酬を合算し、代理店単位で1行にまとめる。会計上の報酬種別は
  agencyRewardAmount / referralRewardAmount として保持する。
  agency_id が未設定の紹介者だけ従来どおり紹介者の行として出し、
  referrer_agency_unassigned で保留する（名前から推測して寄せない）。

  ■ 報酬計算はしない
  既存 Finance Engine が確定させた明細を読み、支払状態ごとに束ねるだけ。

  ■ 口座番号
  一覧・明細では toBankAccountView()（下4桁マスク）しか返さない。
  全文を返すのは fetchPaymentBatchBankAccount()（CSV生成専用）だけ。
*/

const AGENCY_ITEM_COLUMNS =
  "id, target_month, agency_id, creator_id, agency_source, reward_amount, is_reward_target, is_paid, payout_id, payment_batch_id";

const REFERRAL_ITEM_COLUMNS =
  "id, target_month, referrer_id, creator_id, base_amount, reward_amount, adjusted_reward_amount, is_reward_target, is_paid, payout_id, payment_batch_id";

const BATCH_COLUMNS =
  "id, payee_kind, agency_id, referrer_id, cutoff_month, period_start_month, period_end_month, item_count, gross_amount, payment_amount, status, memo, failure_reason, created_at, approved_at, paid_at, paid_on, bank_name, bank_code, bank_branch_name, bank_branch_code, bank_account_type, bank_account_holder";

type AgencyItemRow = {
  id: string;
  target_month: string;
  agency_id: string;
  creator_id: string;
  agency_source: string | null;
  reward_amount: number | string | null;
  is_reward_target: boolean;
  is_paid: boolean;
  payout_id: string | null;
  payment_batch_id: string | null;
};

type ReferralItemRow = {
  id: string;
  target_month: string;
  referrer_id: string;
  creator_id: string;
  base_amount: number | string | null;
  reward_amount: number | string | null;
  adjusted_reward_amount: number | string | null;
  is_reward_target: boolean;
  is_paid: boolean;
  payout_id: string | null;
  payment_batch_id: string | null;
};

export type PaymentBatchSummary = {
  id: string;
  payeeKind: PayeeKind;
  payeeId: string;
  payeeName: string;
  /** 締め対象月（YYYY-MM）。この月までの未払いを組み入れたことを表す */
  cutoffMonth: string;
  periodStartMonth: string;
  periodEndMonth: string;
  itemCount: number;
  grossAmount: number;
  paymentAmount: number;
  status: PaymentBatchStatus;
  memo: string | null;
  failureReason: string | null;
  createdAt: string | null;
  approvedAt: string | null;
  paidAt: string | null;
  paidOn: string | null;
  /** 承認時にスナップショットした振込先（口座番号は含めない） */
  bank: BankAccountView | null;
};

export type PaymentUnpaidRow = {
  payeeKind: PayeeKind;
  payeeId: string;
  payeeName: string;
  isInHouse: boolean;
  /** 支払対象（未占有・未払い）の期間 */
  periodStartMonth: string | null;
  periodEndMonth: string | null;
  /** 全期間の発生額 */
  grossAmount: number;
  /** 全期間の支払済額 */
  paidAmount: number;
  /** 支払予定中（draft / approved / processing に占有されている額） */
  claimedAmount: number;
  /** 未払残高＝今回支払額の初期値（代理店報酬＋紹介者報酬） */
  unpaidAmount: number;
  /** 内訳: 代理店報酬ぶんの未払残高 */
  agencyRewardAmount: number;
  /** 内訳: この支払先へ合算した紹介者報酬ぶんの未払残高 */
  referralRewardAmount: number;
  /** 合算した紹介者の数（代理店行のみ） */
  referrerCount: number;
  itemCount: number;
  creatorCount: number;
  thresholdAmount: number;
  bank: BankAccountView;
  holdReasons: PaymentHoldReason[];
  isPayable: boolean;
  /** 占有中の支払明細 */
  openBatches: PaymentBatchSummary[];
};

export type SellerInvoiceTabRow = {
  invoiceId: string;
  invoiceNumber: string | null;
  sellerId: string;
  sellerName: string;
  targetMonth: string;
  billingGmvAmount: number;
  tspRate: number;
  invoiceAmount: number;
  status: string;
  issuedAt: string | null;
  dueDate: string | null;
  paidAt: string | null;
};

export type PaymentOverview = {
  rows: PaymentUnpaidRow[];
  batches: PaymentBatchSummary[];
  sellerInvoices: SellerInvoiceTabRow[];
  totals: {
    /** 今回支払予定総額（draft / approved / processing の合計） */
    scheduledAmount: number;
    scheduledBatchCount: number;
    agencyUnpaidAmount: number;
    referrerUnpaidAmount: number;
    holdAmount: number;
    holdCount: number;
    payeeCount: number;
    /** セラー請求（支払総額には加算しない） */
    sellerUnpaidAmount: number;
    sellerUnpaidCount: number;
  };
  error: string | null;
};

const EMPTY_TOTALS: PaymentOverview["totals"] = {
  scheduledAmount: 0,
  scheduledBatchCount: 0,
  agencyUnpaidAmount: 0,
  referrerUnpaidAmount: 0,
  holdAmount: 0,
  holdCount: 0,
  payeeCount: 0,
  sellerUnpaidAmount: 0,
  sellerUnpaidCount: 0,
};

type PayeeAccumulator = {
  gross: number[];
  paid: number[];
  claimed: number[];
  claimable: number[];
  /** 内訳: 代理店報酬ぶんの未払い */
  agencyClaimable: number[];
  /** 内訳: 合算した紹介者報酬ぶんの未払い */
  referralClaimable: number[];
  /** 合算した紹介者（代理店行のみ） */
  referrers: Set<string>;
  itemCount: number;
  creators: Set<string>;
  minMonth: string | null;
  maxMonth: string | null;
  hasUnconfirmedAssignment: boolean;
  hasUnconfirmedReward: boolean;
  /** 紹介者の所属代理店が未設定（紹介者行のみ） */
  hasUnassignedReferrerAgency: boolean;
};

function createAccumulator(): PayeeAccumulator {
  return {
    gross: [],
    paid: [],
    claimed: [],
    claimable: [],
    agencyClaimable: [],
    referralClaimable: [],
    referrers: new Set<string>(),
    itemCount: 0,
    creators: new Set<string>(),
    minMonth: null,
    maxMonth: null,
    hasUnconfirmedAssignment: false,
    hasUnconfirmedReward: false,
    hasUnassignedReferrerAgency: false,
  };
}

function trackMonth(acc: PayeeAccumulator, month: string) {
  if (!acc.minMonth || month < acc.minMonth) acc.minMonth = month;
  if (!acc.maxMonth || month > acc.maxMonth) acc.maxMonth = month;
}

/** 未払いかつ未占有か（支払明細に組み入れできる明細） */
function isClaimable(item: {
  is_reward_target: boolean;
  is_paid: boolean;
  payout_id: string | null;
  payment_batch_id: string | null;
}): boolean {
  return (
    item.is_reward_target &&
    !item.is_paid &&
    item.payout_id == null &&
    item.payment_batch_id == null
  );
}

function mapBatchRow(
  row: Record<string, unknown>,
  payeeName: string,
): PaymentBatchSummary {
  const payeeKind = String(row.payee_kind) as PayeeKind;
  const bankAccount: PayeeBankAccount = bankAccountFromRow(row);
  const hasSnapshot =
    bankAccount.bankName != null || bankAccount.bankAccountHolder != null;

  return {
    id: String(row.id),
    payeeKind,
    payeeId: String(
      (payeeKind === "agency" ? row.agency_id : row.referrer_id) ?? "",
    ),
    payeeName,
    cutoffMonth: String(row.cutoff_month ?? row.period_end_month ?? ""),
    periodStartMonth: String(row.period_start_month ?? ""),
    periodEndMonth: String(row.period_end_month ?? ""),
    itemCount: Number(row.item_count ?? 0),
    grossAmount: toAmount(row.gross_amount),
    paymentAmount: toAmount(row.payment_amount),
    status: String(row.status) as PaymentBatchStatus,
    memo: (row.memo as string | null) ?? null,
    failureReason: (row.failure_reason as string | null) ?? null,
    createdAt: (row.created_at as string | null) ?? null,
    approvedAt: (row.approved_at as string | null) ?? null,
    paidAt: (row.paid_at as string | null) ?? null,
    paidOn: (row.paid_on as string | null) ?? null,
    /*
      承認時のスナップショット。
      口座番号は BATCH_COLUMNS に含めていないので、ここへは決して入らない。
    */
    bank: hasSnapshot ? toBankAccountView(bankAccount) : null,
  };
}

/**
 * 支払管理のトップ画面に必要なデータを1回で組み立てる。
 *
 * service role 前提（RLS で管理者限定のテーブルを読むため）。
 * 呼び出し側でサーバー側の管理者判定を必ず済ませること。
 */
export type PaymentOverviewOptions = {
  /**
   * 支払対象（未占有・未払い）の集計を、この期間の明細だけに絞る。
   * 一括精算のプレビューで「選んだ期間でいくら払えるか」を出すために使う。
   * 発生額・支払済額は全期間のまま（実績を欠けさせない）。
   */
  claimStartMonth?: string | null;
  /**
   * 締め対象月。この月までの未払い明細だけを集計する。
   * 支払明細の claim 上限と同じ意味なので、画面の表示と実際に作られる
   * 支払明細の内容が必ず一致する。
   */
  cutoffMonth?: string | null;
};

export async function fetchPaymentOverview(
  supabase: SupabaseClient,
  options: PaymentOverviewOptions = {},
): Promise<PaymentOverview> {
  const claimStart = options.claimStartMonth ?? null;
  const claimEnd = options.cutoffMonth ?? null;

  const inClaimRange = (targetMonth: string): boolean => {
    if (claimStart && targetMonth < claimStart) return false;
    if (claimEnd && targetMonth > claimEnd) return false;
    return true;
  };

  const empty: PaymentOverview = {
    rows: [],
    batches: [],
    sellerInvoices: [],
    totals: { ...EMPTY_TOTALS },
    error: null,
  };

  const [
    agencyItems,
    referralItems,
    agenciesResult,
    referrersResult,
    batchesResult,
    invoicesResult,
  ] = await Promise.all([
    fetchAllFrom<AgencyItemRow>(supabase, "agency_reward_items", AGENCY_ITEM_COLUMNS),
    fetchAllFrom<ReferralItemRow>(
      supabase,
      "referral_reward_items",
      REFERRAL_ITEM_COLUMNS,
    ),
    supabase
      .from("agencies")
      .select(
        "id, name, is_in_house, bank_name, bank_code, bank_branch_name, bank_branch_code, bank_account_type, bank_account_number, bank_account_holder",
      ),
    supabase
      .from("referrers")
      .select(
        "id, name, referrer_name, is_in_house, agency_id, bank_name, bank_code, bank_branch_name, bank_branch_code, bank_account_type, bank_account_number, bank_account_holder",
      ),
    supabase
      .from("payment_batches")
      .select(BATCH_COLUMNS)
      .order("created_at", { ascending: false }),
    supabase
      .from("seller_invoices")
      .select(
        "id, invoice_number, seller_id, target_month, billing_gmv_amount, tsp_rate, invoice_amount, status, issued_at, due_date, paid_at, sellers ( seller_name )",
      )
      .order("target_month", { ascending: false }),
  ]);

  const error =
    agencyItems.error ??
    referralItems.error ??
    agenciesResult.error?.message ??
    referrersResult.error?.message ??
    batchesResult.error?.message ??
    invoicesResult.error?.message ??
    null;

  if (error) return { ...empty, error };

  // ---- 支払先マスタ ---------------------------------------------------------
  type PayeeMeta = {
    name: string;
    isInHouse: boolean;
    bank: PayeeBankAccount;
    /** 紹介者の帰属先代理店。代理店自身では常に null */
    agencyId: string | null;
  };

  const agencyById = new Map<string, PayeeMeta>();
  for (const row of agenciesResult.data ?? []) {
    agencyById.set(String(row.id), {
      name: String(row.name ?? "（削除済み代理店）"),
      isInHouse: row.is_in_house === true,
      bank: bankAccountFromRow(row as Record<string, unknown>),
      agencyId: null,
    });
  }

  const referrerById = new Map<string, PayeeMeta>();
  for (const row of referrersResult.data ?? []) {
    referrerById.set(String(row.id), {
      name: String(row.referrer_name ?? row.name ?? "（削除済み紹介者）"),
      isInHouse: row.is_in_house === true,
      bank: bankAccountFromRow(row as Record<string, unknown>),
      agencyId: row.agency_id == null ? null : String(row.agency_id),
    });
  }

  // ---- 明細の集計 -----------------------------------------------------------
  const agencyAcc = new Map<string, PayeeAccumulator>();

  for (const item of agencyItems.data) {
    const acc = agencyAcc.get(item.agency_id) ?? createAccumulator();
    const value = toAmount(item.reward_amount);

    if (item.is_reward_target) {
      acc.gross.push(value);
      if (item.is_paid) acc.paid.push(value);
      else if (item.payment_batch_id != null) acc.claimed.push(value);
    }

    if (isClaimable(item) && inClaimRange(item.target_month)) {
      acc.claimable.push(value);
      acc.agencyClaimable.push(value);
      acc.itemCount += 1;
      acc.creators.add(item.creator_id);
      trackMonth(acc, item.target_month);
      // 月別確定でない所属が混ざっていたら支払わない（推測で割り当てない）
      if (item.agency_source !== "monthly") acc.hasUnconfirmedAssignment = true;
      // 金額が確定していない明細（本来ありえない）は支払対象にしない
      if (!(value > 0)) acc.hasUnconfirmedReward = true;
    }

    agencyAcc.set(item.agency_id, acc);
  }

  /*
    紹介者報酬は帰属先代理店の行へ合算する。
    帰属先の判定は referrers.agency_id のみ。名前では寄せない。
    agency_id が未設定の紹介者だけ従来どおり紹介者の行として残す。
  */
  const referralAcc = new Map<string, PayeeAccumulator>();

  for (const item of referralItems.data) {
    const value = resolveRewardItemAmount(item);
    const referrerMeta = referrerById.get(item.referrer_id);
    const mergeAgencyId = referrerMeta?.agencyId ?? null;

    const acc = mergeAgencyId
      ? agencyAcc.get(mergeAgencyId) ?? createAccumulator()
      : referralAcc.get(item.referrer_id) ?? createAccumulator();

    if (item.is_reward_target) {
      acc.gross.push(value);
      if (item.is_paid) acc.paid.push(value);
      else if (item.payment_batch_id != null) acc.claimed.push(value);
    }

    if (isClaimable(item) && inClaimRange(item.target_month)) {
      acc.claimable.push(value);
      acc.referralClaimable.push(value);
      acc.itemCount += 1;
      acc.creators.add(item.creator_id);
      trackMonth(acc, item.target_month);
      if (!(value > 0)) acc.hasUnconfirmedReward = true;
      if (mergeAgencyId) acc.referrers.add(item.referrer_id);
      else acc.hasUnassignedReferrerAgency = true;
    }

    if (mergeAgencyId) agencyAcc.set(mergeAgencyId, acc);
    else referralAcc.set(item.referrer_id, acc);
  }

  // ---- 支払明細 -------------------------------------------------------------
  const batches: PaymentBatchSummary[] = (batchesResult.data ?? []).map((row) => {
    const record = row as Record<string, unknown>;
    const kind = String(record.payee_kind);
    const payeeId = String(
      (kind === "agency" ? record.agency_id : record.referrer_id) ?? "",
    );
    const meta =
      kind === "agency" ? agencyById.get(payeeId) : referrerById.get(payeeId);
    return mapBatchRow(record, meta?.name ?? "（不明な支払先）");
  });

  const openBatchesByPayee = new Map<string, PaymentBatchSummary[]>();
  for (const batch of batches) {
    if (!isOpenPaymentBatchStatus(batch.status)) continue;
    const key = `${batch.payeeKind}:${batch.payeeId}`;
    const list = openBatchesByPayee.get(key) ?? [];
    list.push(batch);
    openBatchesByPayee.set(key, list);
  }

  // ---- 未払い行 -------------------------------------------------------------
  const rows: PaymentUnpaidRow[] = [];

  const buildRow = (
    payeeKind: PayeeKind,
    payeeId: string,
    acc: PayeeAccumulator,
    meta: PayeeMeta | undefined,
    sum: (values: number[]) => number,
    thresholdAmount: number,
  ): PaymentUnpaidRow => {
    const bankView = toBankAccountView(meta?.bank);
    const unpaidAmount = sum(acc.claimable);

    const payableInput = {
      isInHouse: meta?.isInHouse === true,
      bankState: bankView.state,
      unpaidAmount,
      thresholdAmount,
      hasUnconfirmedAssignment: acc.hasUnconfirmedAssignment,
      hasUnconfirmedReward: acc.hasUnconfirmedReward,
      hasUnassignedReferrerAgency: acc.hasUnassignedReferrerAgency,
    };

    return {
      payeeKind,
      payeeId,
      payeeName:
        meta?.name ??
        (payeeKind === "agency" ? "（削除済み代理店）" : "（削除済み紹介者）"),
      isInHouse: meta?.isInHouse === true,
      periodStartMonth: acc.minMonth,
      periodEndMonth: acc.maxMonth,
      grossAmount: sum(acc.gross),
      paidAmount: sum(acc.paid),
      claimedAmount: sum(acc.claimed),
      unpaidAmount,
      agencyRewardAmount: sum(acc.agencyClaimable),
      referralRewardAmount: sum(acc.referralClaimable),
      referrerCount: acc.referrers.size,
      itemCount: acc.itemCount,
      creatorCount: acc.creators.size,
      thresholdAmount,
      bank: bankView,
      holdReasons: resolvePaymentHoldReasons(payableInput),
      isPayable: isPayable(payableInput),
      openBatches: openBatchesByPayee.get(`${payeeKind}:${payeeId}`) ?? [],
    };
  };

  for (const [agencyId, acc] of agencyAcc) {
    rows.push(
      buildRow("agency", agencyId, acc, agencyById.get(agencyId), sumAgencyAmounts, 0),
    );
  }

  for (const [referrerId, acc] of referralAcc) {
    rows.push(
      buildRow(
        "referrer",
        referrerId,
        acc,
        referrerById.get(referrerId),
        sumReferralAmounts,
        REFERRAL_PAYOUT_THRESHOLD_YEN,
      ),
    );
  }

  rows.sort(
    (a, b) =>
      b.unpaidAmount - a.unpaidAmount ||
      b.claimedAmount - a.claimedAmount ||
      a.payeeName.localeCompare(b.payeeName, "ja"),
  );

  // ---- セラー請求（支払総額には混ぜない）-----------------------------------
  const sellerInvoices: SellerInvoiceTabRow[] = (invoicesResult.data ?? []).map(
    (row) => {
      const sellerJoin = row.sellers as
        | { seller_name?: string }
        | Array<{ seller_name?: string }>
        | null;
      const seller = Array.isArray(sellerJoin) ? sellerJoin[0] : sellerJoin;

      return {
        invoiceId: String(row.id),
        invoiceNumber: (row.invoice_number as string | null) ?? null,
        sellerId: String(row.seller_id ?? ""),
        sellerName: String(seller?.seller_name ?? "（不明なセラー）"),
        targetMonth: String(row.target_month ?? ""),
        billingGmvAmount: toAmount(row.billing_gmv_amount),
        tspRate: toAmount(row.tsp_rate),
        invoiceAmount: toAmount(row.invoice_amount),
        status: String(row.status ?? "draft"),
        issuedAt: (row.issued_at as string | null) ?? null,
        dueDate: (row.due_date as string | null) ?? null,
        paidAt: (row.paid_at as string | null) ?? null,
      };
    },
  );

  const scheduledBatches = batches.filter((batch) =>
    isOpenPaymentBatchStatus(batch.status),
  );

  const holdRows = rows.filter(
    (row) => row.unpaidAmount > 0 && row.holdReasons.length > 0,
  );

  return {
    rows,
    batches,
    sellerInvoices,
    totals: {
      scheduledAmount: sumAgencyAmounts(
        scheduledBatches.map((batch) => batch.paymentAmount),
      ),
      scheduledBatchCount: scheduledBatches.length,
      /*
        支払先は代理店へ統合したが、この2つのKPIは「報酬種別」の内訳を
        表す。支払先の束ね方が変わっても会計上の内訳は保つ。
      */
      agencyUnpaidAmount: sumAgencyAmounts(
        rows.map((row) => row.agencyRewardAmount),
      ),
      referrerUnpaidAmount: sumReferralAmounts(
        rows.map((row) => row.referralRewardAmount),
      ),
      holdAmount: sumAgencyAmounts(holdRows.map((row) => row.unpaidAmount)),
      holdCount: holdRows.length,
      payeeCount: rows.filter((row) => row.isPayable).length,
      /*
        セラー請求は「セラー → THREE COMMERCE」の入金であり、
        代理店・紹介者への振込とはお金の向きが逆。
        支払予定総額には絶対に加算しない。別のKPIとして出す。
      */
      sellerUnpaidAmount: sumAgencyAmounts(
        sellerInvoices
          .filter((invoice) => invoice.status === "issued")
          .map((invoice) => invoice.invoiceAmount),
      ),
      sellerUnpaidCount: sellerInvoices.filter(
        (invoice) => invoice.status === "issued",
      ).length,
    },
    error: null,
  };
}

// =============================================================================
// 支払明細の詳細
// =============================================================================

/*
  会計上の報酬種別。支払先は代理店へ統合するが、明細では必ず
  どちらの報酬なのかを判別できるようにする。
*/
export const REWARD_KINDS = ["agency", "referral"] as const;
export type RewardKind = (typeof REWARD_KINDS)[number];

/*
  TAP と混同しないよう、画面表記は種別が分かる名前にする。
  ・代理店分配報酬 … TikTok が算出した代理店への分配実額
  ・紹介制度報酬   … 紹介制度によって発生する報酬
  TAP 収益はどちらにも含まれない（別テーブル tap_affiliate_order_lines）。
*/
export const REWARD_KIND_LABEL: Record<RewardKind, string> = {
  agency: "代理店分配報酬",
  referral: "紹介制度報酬",
};

export type PaymentBatchItemRow = {
  id: string;
  /** この明細がどちらの報酬か。agency_reward_items / referral_reward_items の由来 */
  rewardKind: RewardKind;
  /** 紹介報酬のときの紹介者名。代理店報酬では null */
  referrerName: string | null;
  targetMonth: string;
  creatorId: string;
  creatorName: string;
  tiktokId: string;
  /** 報酬計算元（代理店=成果報酬ベース / 紹介者=紹介報酬のベース額） */
  baseAmount: number;
  /** 報酬率(%)。代理店は表示専用（掛け算には使わない） */
  ratePct: number;
  rewardAmount: number;
  isPaid: boolean;
};

/*
  支払根拠の内訳。

  ■ 金額は claim 済み明細の snapshot だけを使う
  affiliate_order_lines から作り直さない。所属変更・分配率変更・売上再取込が
  あっても、支払明細の根拠が動かないようにするため。

  ■ 代理店分配額は AP をそのまま合計する
  AJ（分配計算基準額）× AK（分配率）を掛け直して作らない。TikTok は注文明細
  単位で計算・丸めをしているので、THREE 側で再計算すると実額とずれる。
  AJ と AK は「なぜこの金額なのか」を説明するための表示値。

  TODO: 支払時点の名称まで完全に snapshot するなら、reward item へ
  creator_name / creator_tiktok_id、batch へ agency_name を持たせる検討が必要。
  現在は creator_id からの live join で、改名すると過去明細の表示名が変わる。
*/
export type PaymentRewardMonthRow = {
  targetMonth: string;
  /** 参考値。分配・紹介いずれの計算基準でもない */
  gmv: number;
  /** 代理店=creator_revenue_before_split(AJ) / 紹介=base_amount(AD) */
  baseAmount: number;
  /** 代理店=agency_split_rate(%) / 紹介=reward_rate を % 化した値 */
  ratePct: number;
  /** 代理店=reward_amount(AP実額) / 紹介=adjusted または reward_amount */
  rewardAmount: number;
  itemCount: number;
};

export type PaymentRewardCreatorGroup = {
  creatorId: string;
  creatorName: string;
  tiktokId: string;
  /** 紹介制度報酬のときだけ入る紹介者名 */
  referrerName: string | null;
  periodStartMonth: string;
  periodEndMonth: string;
  gmv: number;
  baseAmount: number;
  rewardAmount: number;
  itemCount: number;
  months: PaymentRewardMonthRow[];
};

export type PaymentRewardBreakdown = {
  rewardKind: RewardKind;
  creators: PaymentRewardCreatorGroup[];
  totalAmount: number;
  itemCount: number;
};

export type PaymentBatchAuditRow = {
  id: string;
  action: PaymentBatchAction;
  fromStatus: string | null;
  toStatus: string | null;
  itemCount: number | null;
  amount: number | null;
  actorEmail: string | null;
  note: string | null;
  createdAt: string;
};

export type PaymentBatchDetail = {
  batch: PaymentBatchSummary | null;
  items: PaymentBatchItemRow[];
  auditLogs: PaymentBatchAuditRow[];
  /** 明細実額の合計。支払明細のスナップショットと突き合わせる検算用 */
  itemsTotalAmount: number;
  /** 内訳: 代理店分配報酬ぶんの合計 */
  agencyRewardAmount: number;
  /** 内訳: 紹介制度報酬ぶんの合計 */
  referralRewardAmount: number;
  /** 代理店分配報酬の根拠（creator別 → 月別） */
  agencyBreakdown: PaymentRewardBreakdown;
  /** 紹介制度報酬の根拠（紹介者×creator別 → 月別） */
  referralBreakdown: PaymentRewardBreakdown;
  /**
   * 画面合計と支払明細スナップショットが一致しているか。
   * false のときは画面に金額を出さずエラーとして扱う。
   */
  totalsMatchBatch: boolean;
  error: string | null;
};

export async function fetchPaymentBatchDetail(
  supabase: SupabaseClient,
  batchId: string,
): Promise<PaymentBatchDetail> {
  const emptyBreakdown = (rewardKind: RewardKind): PaymentRewardBreakdown => ({
    rewardKind,
    creators: [],
    totalAmount: 0,
    itemCount: 0,
  });

  const empty: PaymentBatchDetail = {
    batch: null,
    items: [],
    auditLogs: [],
    itemsTotalAmount: 0,
    agencyRewardAmount: 0,
    referralRewardAmount: 0,
    agencyBreakdown: emptyBreakdown("agency"),
    referralBreakdown: emptyBreakdown("referral"),
    totalsMatchBatch: true,
    error: null,
  };

  const { data: batchRow, error: batchError } = await supabase
    .from("payment_batches")
    .select(BATCH_COLUMNS)
    .eq("id", batchId)
    .maybeSingle();

  if (batchError) return { ...empty, error: batchError.message };
  if (!batchRow) return empty;

  const record = batchRow as Record<string, unknown>;
  const payeeKind = String(record.payee_kind) as PayeeKind;
  const payeeId = String(
    (payeeKind === "agency" ? record.agency_id : record.referrer_id) ?? "",
  );

  const payeeResult =
    payeeKind === "agency"
      ? await supabase.from("agencies").select("id, name").eq("id", payeeId).maybeSingle()
      : await supabase
          .from("referrers")
          .select("id, name, referrer_name")
          .eq("id", payeeId)
          .maybeSingle();

  if (payeeResult.error) return { ...empty, error: payeeResult.error.message };

  const payeeName =
    payeeKind === "agency"
      ? String(payeeResult.data?.name ?? "（削除済み代理店）")
      : String(
          (payeeResult.data as { referrer_name?: string; name?: string } | null)
            ?.referrer_name ??
            (payeeResult.data as { name?: string } | null)?.name ??
            "（削除済み紹介者）",
        );

  const batch = mapBatchRow(record, payeeName);

  /*
    代理店の支払明細には、帰属する紹介者の紹介報酬も組み入れている。
    どちらの報酬かはテーブルの由来で判別する（種別を失わない）。
  */
  const [agencyItemsResult, referralItemsResult, auditResult] = await Promise.all([
    payeeKind === "agency"
      ? fetchAllFrom<Record<string, unknown>>(
          supabase,
          "agency_reward_items",
          "id, target_month, creator_id, commission_base, commission_gmv, creator_revenue_before_split, agency_split_rate, reward_amount, is_paid",
          (query) => query.eq("payment_batch_id", batchId),
        )
      : Promise.resolve({
          data: [] as Array<Record<string, unknown>>,
          error: null,
          errorCode: null,
        }),
    fetchAllFrom<Record<string, unknown>>(
      supabase,
      "referral_reward_items",
      "id, target_month, creator_id, referrer_id, source_row_key, base_amount, reward_rate, reward_amount, adjusted_reward_amount, is_paid",
      (query) => query.eq("payment_batch_id", batchId),
    ),
    supabase
      .from("payment_batch_audit_logs")
      .select(
        "id, action, from_status, to_status, item_count, amount, actor_email, note, created_at",
      )
      .eq("batch_id", batchId)
      .order("created_at", { ascending: false }),
  ]);

  if (agencyItemsResult.error) {
    return { ...empty, batch, error: agencyItemsResult.error };
  }
  if (referralItemsResult.error) {
    return { ...empty, batch, error: referralItemsResult.error };
  }
  if (auditResult.error) {
    return { ...empty, batch, error: auditResult.error.message };
  }

  const creatorIds = [
    ...new Set(
      [...agencyItemsResult.data, ...referralItemsResult.data].map((item) =>
        String(item.creator_id),
      ),
    ),
  ];

  const referrerIds = [
    ...new Set(
      referralItemsResult.data
        .map((item) => (item.referrer_id == null ? null : String(item.referrer_id)))
        .filter((value): value is string => value != null),
    ),
  ];

  const batchReferrersResult =
    referrerIds.length > 0
      ? await supabase
          .from("referrers")
          .select("id, name, referrer_name")
          .in("id", referrerIds)
      : { data: [] as Array<Record<string, unknown>>, error: null };

  if (batchReferrersResult.error) {
    return { ...empty, batch, error: batchReferrersResult.error.message };
  }

  const referrerNameById = new Map(
    (batchReferrersResult.data ?? []).map((row) => [
      String(row.id),
      String(row.referrer_name ?? row.name ?? "（削除済み紹介者）"),
    ]),
  );

  /*
    紹介制度報酬の GMV は参考値。referral_reward_items が持たないので
    注文行から引く。金額の計算には一切使わない（使うと snapshot ではなくなる）。

    source_row_key で .in() すると URL が巨大になり 414 になる
    （1キーあたり URL エンコードで約256バイト）。短い UUID の creator_id で
    引いて、source_row_key の突き合わせはメモリで行う。
  */
  const referralSourceKeys = new Set(
    referralItemsResult.data
      .map((row) => (row.source_row_key == null ? null : String(row.source_row_key)))
      .filter((value): value is string => value != null && value.length > 0),
  );

  const referralCreatorIds = [
    ...new Set(
      referralItemsResult.data
        .map((row) => (row.creator_id == null ? null : String(row.creator_id)))
        .filter((value): value is string => value != null),
    ),
  ];

  const gmvBySourceKey = new Map<string, number>();

  if (referralCreatorIds.length > 0) {
    const linesResult = await fetchAllFrom<{
      source_row_key: string | null;
      commission_gmv: number | string | null;
    }>(
      supabase,
      "affiliate_order_lines",
      "id, source_row_key, commission_gmv",
      (query) => query.in("creator_id", referralCreatorIds),
    );

    if (linesResult.error) return { ...empty, batch, error: linesResult.error };

    for (const line of linesResult.data) {
      const key = String(line.source_row_key ?? "");
      if (!referralSourceKeys.has(key)) continue;
      gmvBySourceKey.set(key, toAmount(line.commission_gmv));
    }
  }

  const creatorsResult =
    creatorIds.length > 0
      ? await supabase
          .from("creators")
          .select("id, creator_name, tiktok_id")
          .in("id", creatorIds)
      : { data: [] as Array<Record<string, unknown>>, error: null };

  if (creatorsResult.error) {
    return { ...empty, batch, error: creatorsResult.error.message };
  }

  const creatorById = new Map(
    (creatorsResult.data ?? []).map((row) => [
      String(row.id),
      {
        creatorName: String(row.creator_name ?? "—"),
        tiktokId: String(row.tiktok_id ?? ""),
      },
    ]),
  );

  const buildItem = (
    row: Record<string, unknown>,
    rewardKind: RewardKind,
  ): PaymentBatchItemRow => {
    const creator = creatorById.get(String(row.creator_id));
    const isAgency = rewardKind === "agency";

    return {
      id: String(row.id),
      rewardKind,
      referrerName: isAgency
        ? null
        : referrerNameById.get(String(row.referrer_id)) ?? "（不明な紹介者）",
      targetMonth: String(row.target_month ?? ""),
      creatorId: String(row.creator_id ?? ""),
      creatorName: creator?.creatorName ?? "—",
      tiktokId: creator?.tiktokId ?? "",
      baseAmount: toAmount(isAgency ? row.commission_base : row.base_amount),
      ratePct: isAgency
        ? toAmount(row.agency_split_rate)
        : toAmount(row.reward_rate) * 100,
      rewardAmount: isAgency ? toAmount(row.reward_amount) : resolveRewardItemAmount(row),
      isPaid: row.is_paid === true,
    };
  };

  const items: PaymentBatchItemRow[] = [
    ...agencyItemsResult.data.map((row) => buildItem(row, "agency")),
    ...referralItemsResult.data.map((row) => buildItem(row, "referral")),
  ];

  /*
    報酬種別ごとにまとめて並べる。代理店報酬を先、紹介報酬を後。
    同種別の中では対象月 → 金額の降順。
  */
  items.sort(
    (a, b) =>
      a.rewardKind.localeCompare(b.rewardKind) ||
      a.targetMonth.localeCompare(b.targetMonth) ||
      b.rewardAmount - a.rewardAmount,
  );

  /*
    丸めは代理店・紹介者いずれも Math.round(x * 100) / 100 で同一実装なので
    合算しても丸め不整合は生じない。
  */
  const sum = sumAgencyAmounts;

  /*
    代理店分配報酬の根拠。
    基準額は AJ（creator_revenue_before_split）、率は AK（agency_split_rate）、
    金額は AP（reward_amount）の実額。GMV は commission_gmv で参考値。
  */
  const agencyBreakdown = buildRewardBreakdown(
    "agency",
    agencyItemsResult.data.map((row) => {
      const creator = creatorById.get(String(row.creator_id));
      return {
        creatorId: String(row.creator_id ?? ""),
        creatorName: creator?.creatorName ?? "—",
        tiktokId: creator?.tiktokId ?? "",
        referrerName: null,
        targetMonth: String(row.target_month ?? ""),
        gmv: toAmount(row.commission_gmv),
        baseAmount: toAmount(row.creator_revenue_before_split),
        ratePct: toAmount(row.agency_split_rate),
        rewardAmount: toAmount(row.reward_amount),
      };
    }),
    sumAgencyAmounts,
  );

  /*
    紹介制度報酬の根拠。
    基準額は AD（base_amount）、率は reward_rate（0.05 → 5%）、
    金額は adjusted_reward_amount ないし reward_amount。
    GMV はこのテーブルに無いので、同じ明細の注文行から参考値として引く。
  */
  const referralBreakdown = buildRewardBreakdown(
    "referral",
    referralItemsResult.data.map((row) => {
      const creator = creatorById.get(String(row.creator_id));
      return {
        creatorId: String(row.creator_id ?? ""),
        creatorName: creator?.creatorName ?? "—",
        tiktokId: creator?.tiktokId ?? "",
        referrerName:
          referrerNameById.get(String(row.referrer_id)) ?? "（不明な紹介者）",
        targetMonth: String(row.target_month ?? ""),
        gmv: toAmount(gmvBySourceKey.get(String(row.source_row_key ?? "")) ?? 0),
        baseAmount: toAmount(row.base_amount),
        ratePct: toAmount(row.reward_rate) * 100,
        rewardAmount: resolveRewardItemAmount(row),
      };
    }),
    sumReferralAmounts,
  );

  const itemsTotalAmount = sum(items.map((item) => item.rewardAmount));
  const agencyRewardAmount = agencyBreakdown.totalAmount;
  const referralRewardAmount = referralBreakdown.totalAmount;

  /*
    画面合計と支払明細スナップショットの突き合わせ。
    ずれているときは画面に金額を出さずエラーとして扱う。
  */
  const totalsMatchBatch =
    Math.abs(sum([agencyRewardAmount, referralRewardAmount]) - batch.paymentAmount) <=
    0.005;

  return {
    batch,
    items,
    auditLogs: (auditResult.data ?? []).map((row) => ({
      id: String(row.id),
      action: String(row.action) as PaymentBatchAction,
      fromStatus: (row.from_status as string | null) ?? null,
      toStatus: (row.to_status as string | null) ?? null,
      itemCount: row.item_count == null ? null : Number(row.item_count),
      amount: row.amount == null ? null : toAmount(row.amount),
      actorEmail: (row.actor_email as string | null) ?? null,
      note: (row.note as string | null) ?? null,
      createdAt: String(row.created_at ?? ""),
    })),
    itemsTotalAmount,
    agencyRewardAmount,
    referralRewardAmount,
    agencyBreakdown,
    referralBreakdown,
    totalsMatchBatch,
    error: null,
  };
}

/*
  claim 済み明細を creator別 → 月別へ束ねる。

  金額は明細の snapshot をそのまま足すだけで、基準額×率の再計算はしない。
  GMV は参考値なので合計はするが、どの計算にも使わない。
*/
function buildRewardBreakdown(
  rewardKind: RewardKind,
  rows: Array<{
    creatorId: string;
    creatorName: string;
    tiktokId: string;
    referrerName: string | null;
    targetMonth: string;
    gmv: number;
    baseAmount: number;
    ratePct: number;
    rewardAmount: number;
  }>,
  sumAmounts: (values: number[]) => number,
): PaymentRewardBreakdown {
  /*
    紹介制度報酬は「紹介者 × クリエイター」で1グループにする。
    同じクリエイターを別の紹介者が紹介している場合に混ざらないようにするため。
  */
  const groupKeyOf = (row: { creatorId: string; referrerName: string | null }) =>
    rewardKind === "referral"
      ? `${row.referrerName ?? ""}::${row.creatorId}`
      : row.creatorId;

  type Bucket = {
    creatorId: string;
    creatorName: string;
    tiktokId: string;
    referrerName: string | null;
    months: Map<
      string,
      { gmv: number[]; base: number[]; reward: number[]; rates: Set<number>; count: number }
    >;
  };

  const buckets = new Map<string, Bucket>();

  for (const row of rows) {
    const key = groupKeyOf(row);
    const bucket =
      buckets.get(key) ??
      ({
        creatorId: row.creatorId,
        creatorName: row.creatorName,
        tiktokId: row.tiktokId,
        referrerName: rewardKind === "referral" ? row.referrerName : null,
        months: new Map(),
      } satisfies Bucket);

    const month =
      bucket.months.get(row.targetMonth) ??
      { gmv: [], base: [], reward: [], rates: new Set<number>(), count: 0 };

    month.gmv.push(row.gmv);
    month.base.push(row.baseAmount);
    month.reward.push(row.rewardAmount);
    month.rates.add(row.ratePct);
    month.count += 1;

    bucket.months.set(row.targetMonth, month);
    buckets.set(key, bucket);
  }

  const creators: PaymentRewardCreatorGroup[] = [...buckets.values()].map((bucket) => {
    const months: PaymentRewardMonthRow[] = [...bucket.months.entries()]
      .map(([targetMonth, month]) => ({
        targetMonth,
        gmv: sumAgencyAmounts(month.gmv),
        baseAmount: sumAgencyAmounts(month.base),
        /*
          率は明細ごとに同じ想定。混在していたら最大値を出し、
          金額は明細の実額合計なので率の表示に引きずられない。
        */
        ratePct: month.rates.size === 0 ? 0 : Math.max(...month.rates),
        rewardAmount: sumAmounts(month.reward),
        itemCount: month.count,
      }))
      .sort((a, b) => a.targetMonth.localeCompare(b.targetMonth));

    return {
      creatorId: bucket.creatorId,
      creatorName: bucket.creatorName,
      tiktokId: bucket.tiktokId,
      referrerName: bucket.referrerName,
      periodStartMonth: months[0]?.targetMonth ?? "",
      periodEndMonth: months.at(-1)?.targetMonth ?? "",
      gmv: sumAgencyAmounts(months.map((m) => m.gmv)),
      baseAmount: sumAgencyAmounts(months.map((m) => m.baseAmount)),
      rewardAmount: sumAmounts(months.map((m) => m.rewardAmount)),
      itemCount: months.reduce((total, m) => total + m.itemCount, 0),
      months,
    };
  });

  creators.sort(
    (a, b) =>
      b.rewardAmount - a.rewardAmount ||
      a.tiktokId.localeCompare(b.tiktokId) ||
      a.creatorName.localeCompare(b.creatorName, "ja"),
  );

  return {
    rewardKind,
    creators,
    totalAmount: sumAmounts(creators.map((c) => c.rewardAmount)),
    itemCount: creators.reduce((total, c) => total + c.itemCount, 0),
  };
}

// =============================================================================
// 振込CSV用（口座番号の全文を扱う唯一の関数）
// =============================================================================

export type PaymentBatchCsvSource = {
  id: string;
  payeeKind: PayeeKind;
  payeeName: string;
  cutoffMonth: string;
  periodStartMonth: string;
  periodEndMonth: string;
  paymentAmount: number;
  status: PaymentBatchStatus;
  bank: PayeeBankAccount;
};

/**
 * 振込CSVの元データ。口座番号の全文を含む。
 *
 * ■ この戻り値をクライアントコンポーネントへ渡さないこと
 * 呼び出してよいのは CSV を生成して文字列だけを返す server action のみ。
 */
export async function fetchPaymentBatchCsvSources(
  supabase: SupabaseClient,
  batchIds: string[],
): Promise<{ data: PaymentBatchCsvSource[]; error: string | null }> {
  if (batchIds.length === 0) return { data: [], error: null };

  const { data, error } = await supabase
    .from("payment_batches")
    .select(
      "id, payee_kind, agency_id, referrer_id, cutoff_month, period_start_month, period_end_month, payment_amount, status, bank_name, bank_code, bank_branch_name, bank_branch_code, bank_account_type, bank_account_number, bank_account_holder",
    )
    .in("id", batchIds)
    .order("created_at", { ascending: true });

  if (error) return { data: [], error: error.message };

  const rows = (data ?? []) as Array<Record<string, unknown>>;

  const agencyIds = rows
    .filter((row) => row.payee_kind === "agency")
    .map((row) => String(row.agency_id));
  const referrerIds = rows
    .filter((row) => row.payee_kind === "referrer")
    .map((row) => String(row.referrer_id));

  const [agenciesResult, referrersResult] = await Promise.all([
    agencyIds.length > 0
      ? supabase.from("agencies").select("id, name").in("id", agencyIds)
      : Promise.resolve({ data: [], error: null }),
    referrerIds.length > 0
      ? supabase
          .from("referrers")
          .select("id, name, referrer_name")
          .in("id", referrerIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (agenciesResult.error) return { data: [], error: agenciesResult.error.message };
  if (referrersResult.error) return { data: [], error: referrersResult.error.message };

  const nameById = new Map<string, string>();
  for (const row of agenciesResult.data ?? []) {
    nameById.set(`agency:${String(row.id)}`, String(row.name ?? ""));
  }
  for (const row of referrersResult.data ?? []) {
    nameById.set(
      `referrer:${String(row.id)}`,
      String(row.referrer_name ?? row.name ?? ""),
    );
  }

  return {
    data: rows.map((row) => {
      const payeeKind = String(row.payee_kind) as PayeeKind;
      const payeeId = String(
        (payeeKind === "agency" ? row.agency_id : row.referrer_id) ?? "",
      );
      return {
        id: String(row.id),
        payeeKind,
        payeeName: nameById.get(`${payeeKind}:${payeeId}`) ?? "（不明な支払先）",
        periodStartMonth: String(row.period_start_month ?? ""),
        cutoffMonth: String(row.cutoff_month ?? row.period_end_month ?? ""),
        periodEndMonth: String(row.period_end_month ?? ""),
        paymentAmount: toAmount(row.payment_amount),
        status: String(row.status) as PaymentBatchStatus,
        bank: bankAccountFromRow(row),
      };
    }),
    error: null,
  };
}

// =============================================================================
// 支払先マスタの振込先（管理画面の編集用）
// =============================================================================

export type PayeeBankRow = {
  payeeKind: PayeeKind;
  payeeId: string;
  payeeName: string;
  isInHouse: boolean;
  bank: BankAccountView;
};

export async function fetchPayeeBankAccounts(
  supabase: SupabaseClient,
  payeeKind: PayeeKind,
): Promise<{ data: PayeeBankRow[]; error: string | null }> {
  const bankColumns =
    "bank_name, bank_code, bank_branch_name, bank_branch_code, bank_account_type, bank_account_number, bank_account_holder";

  const result =
    payeeKind === "agency"
      ? await supabase
          .from("agencies")
          .select(`id, name, is_in_house, ${bankColumns}`)
          .order("name")
      : await supabase
          .from("referrers")
          .select(`id, name, referrer_name, is_in_house, ${bankColumns}`)
          .order("referrer_name");

  if (result.error) return { data: [], error: result.error.message };

  return {
    data: (result.data ?? []).map((row) => {
      const record = row as Record<string, unknown>;
      return {
        payeeKind,
        payeeId: String(record.id),
        payeeName:
          payeeKind === "agency"
            ? String(record.name ?? "")
            : String(record.referrer_name ?? record.name ?? ""),
        isInHouse: record.is_in_house === true,
        // 画面へ渡すのはマスク済みの形だけ
        bank: toBankAccountView(bankAccountFromRow(record)),
      };
    }),
    error: null,
  };
}
