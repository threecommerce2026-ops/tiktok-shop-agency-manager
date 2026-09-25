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
  "id, payee_kind, agency_id, referrer_id, period_start_month, period_end_month, item_count, gross_amount, payment_amount, status, memo, failure_reason, created_at, approved_at, paid_at, paid_on, bank_name, bank_code, bank_branch_name, bank_branch_code, bank_account_type, bank_account_holder";

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
  /** 未払残高＝今回支払額の初期値 */
  unpaidAmount: number;
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
  itemCount: number;
  creators: Set<string>;
  minMonth: string | null;
  maxMonth: string | null;
  hasUnconfirmedAssignment: boolean;
  hasUnconfirmedReward: boolean;
};

function createAccumulator(): PayeeAccumulator {
  return {
    gross: [],
    paid: [],
    claimed: [],
    claimable: [],
    itemCount: 0,
    creators: new Set<string>(),
    minMonth: null,
    maxMonth: null,
    hasUnconfirmedAssignment: false,
    hasUnconfirmedReward: false,
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
  claimEndMonth?: string | null;
};

export async function fetchPaymentOverview(
  supabase: SupabaseClient,
  options: PaymentOverviewOptions = {},
): Promise<PaymentOverview> {
  const claimStart = options.claimStartMonth ?? null;
  const claimEnd = options.claimEndMonth ?? null;

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
        "id, name, referrer_name, is_in_house, bank_name, bank_code, bank_branch_name, bank_branch_code, bank_account_type, bank_account_number, bank_account_holder",
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
  };

  const agencyById = new Map<string, PayeeMeta>();
  for (const row of agenciesResult.data ?? []) {
    agencyById.set(String(row.id), {
      name: String(row.name ?? "（削除済み代理店）"),
      isInHouse: row.is_in_house === true,
      bank: bankAccountFromRow(row as Record<string, unknown>),
    });
  }

  const referrerById = new Map<string, PayeeMeta>();
  for (const row of referrersResult.data ?? []) {
    referrerById.set(String(row.id), {
      name: String(row.referrer_name ?? row.name ?? "（削除済み紹介者）"),
      isInHouse: row.is_in_house === true,
      bank: bankAccountFromRow(row as Record<string, unknown>),
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

  const referralAcc = new Map<string, PayeeAccumulator>();

  for (const item of referralItems.data) {
    const acc = referralAcc.get(item.referrer_id) ?? createAccumulator();
    const value = resolveRewardItemAmount(item);

    if (item.is_reward_target) {
      acc.gross.push(value);
      if (item.is_paid) acc.paid.push(value);
      else if (item.payment_batch_id != null) acc.claimed.push(value);
    }

    if (isClaimable(item) && inClaimRange(item.target_month)) {
      acc.claimable.push(value);
      acc.itemCount += 1;
      acc.creators.add(item.creator_id);
      trackMonth(acc, item.target_month);
      if (!(value > 0)) acc.hasUnconfirmedReward = true;
    }

    referralAcc.set(item.referrer_id, acc);
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
      agencyUnpaidAmount: sumAgencyAmounts(
        rows.filter((row) => row.payeeKind === "agency").map((row) => row.unpaidAmount),
      ),
      referrerUnpaidAmount: sumReferralAmounts(
        rows
          .filter((row) => row.payeeKind === "referrer")
          .map((row) => row.unpaidAmount),
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

export type PaymentBatchItemRow = {
  id: string;
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
  error: string | null;
};

export async function fetchPaymentBatchDetail(
  supabase: SupabaseClient,
  batchId: string,
): Promise<PaymentBatchDetail> {
  const empty: PaymentBatchDetail = {
    batch: null,
    items: [],
    auditLogs: [],
    itemsTotalAmount: 0,
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

  const [itemsResult, auditResult] = await Promise.all([
    payeeKind === "agency"
      ? fetchAllFrom<{
          id: string;
          target_month: string;
          creator_id: string;
          commission_base: number | string | null;
          agency_split_rate: number | string | null;
          reward_amount: number | string | null;
          is_paid: boolean;
        }>(
          supabase,
          "agency_reward_items",
          "id, target_month, creator_id, commission_base, agency_split_rate, reward_amount, is_paid",
          (query) => query.eq("payment_batch_id", batchId),
        )
      : fetchAllFrom<{
          id: string;
          target_month: string;
          creator_id: string;
          base_amount: number | string | null;
          reward_rate: number | string | null;
          reward_amount: number | string | null;
          adjusted_reward_amount: number | string | null;
          is_paid: boolean;
        }>(
          supabase,
          "referral_reward_items",
          "id, target_month, creator_id, base_amount, reward_rate, reward_amount, adjusted_reward_amount, is_paid",
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

  if (itemsResult.error) return { ...empty, batch, error: itemsResult.error };
  if (auditResult.error) {
    return { ...empty, batch, error: auditResult.error.message };
  }

  const creatorIds = [
    ...new Set(
      (itemsResult.data as Array<{ creator_id: string }>).map(
        (item) => item.creator_id,
      ),
    ),
  ];

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

  const items: PaymentBatchItemRow[] = (
    itemsResult.data as Array<Record<string, unknown>>
  ).map((row) => {
    const creator = creatorById.get(String(row.creator_id));
    const rewardAmount =
      payeeKind === "agency"
        ? toAmount(row.reward_amount)
        : resolveRewardItemAmount(row as Record<string, unknown>);

    return {
      id: String(row.id),
      targetMonth: String(row.target_month ?? ""),
      creatorId: String(row.creator_id ?? ""),
      creatorName: creator?.creatorName ?? "—",
      tiktokId: creator?.tiktokId ?? "",
      baseAmount: toAmount(
        payeeKind === "agency" ? row.commission_base : row.base_amount,
      ),
      ratePct:
        payeeKind === "agency"
          ? toAmount(row.agency_split_rate)
          : toAmount(row.reward_rate) * 100,
      rewardAmount,
      isPaid: row.is_paid === true,
    };
  });

  items.sort(
    (a, b) =>
      a.targetMonth.localeCompare(b.targetMonth) || b.rewardAmount - a.rewardAmount,
  );

  const sum = payeeKind === "agency" ? sumAgencyAmounts : sumReferralAmounts;

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
    itemsTotalAmount: sum(items.map((item) => item.rewardAmount)),
    error: null,
  };
}

// =============================================================================
// 振込CSV用（口座番号の全文を扱う唯一の関数）
// =============================================================================

export type PaymentBatchCsvSource = {
  id: string;
  payeeKind: PayeeKind;
  payeeName: string;
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
      "id, payee_kind, agency_id, referrer_id, period_start_month, period_end_month, payment_amount, status, bank_name, bank_code, bank_branch_name, bank_branch_code, bank_account_type, bank_account_number, bank_account_holder",
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
