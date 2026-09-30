import type { SupabaseClient } from "@supabase/supabase-js";

import { fetchAllFrom } from "@/lib/db/paged-select";
import { isTapReferralSourceLine } from "@/lib/referrals/tap-referral-source";
import {
  buildReferralPeriods,
  REFERRAL_RELATION_COLUMNS,
  resolveReferralForMonth,
  type ReferralRelationRow,
} from "@/lib/referrals/referral-period";
import { isReferralRewardEligibleType } from "@/lib/creators/account-management-type";
import {
  referralBaseAmount,
  REFERRAL_REWARD_RATE,
  resolveRewardItemAmount,
  sumReferralAmounts,
} from "@/lib/referrals/referral-reward-engine";
import { toAmount } from "@/lib/revenue/amount";
import {
  CUTOFF_MONTH_PATTERN,
  EARLIEST_CUTOFF_MONTH,
  MAX_REFERRAL_PAYMENT_CUTOFF_MONTH,
} from "@/lib/payments/cutoff-month";

/*
  TAP実績（クリエイター単位の成果と報酬構造）。

  ■ これは支払画面ではない
  代理店支払・紹介者支払とは完全に別物で、読むだけの確認用。
  TAP のクリエイター成果報酬は TikTok 側でクリエイター本人へ発生するもので、
  THREE から振り込む仕組みは現在存在しない。支払候補には混ぜない。

  ■ 4つの金額は意味が違う。合算しない
    commissionBase              成果報酬ベース。各率を掛ける前の基礎額
    tapRevenue                  THREE COMMERCE（アフィリエイトパートナー）の取り分
    creatorEstimatedCommission  クリエイター本人へ発生する推定成果報酬
    referralRewardAmount        THREE の紹介制度で紹介者へ発生した報酬

  率は行ごとに違う（partner 1〜10% / creator 2〜25%）。
  紹介報酬の 5% は commission_base に対する THREE の社内ルールで、
  TAP の partner 率とは無関係。この4つを足した「総報酬」は意味を持たない。

  ■ 対象行の判定は既存の正式条件をそのまま使う
  isTapReferralSourceLine（= creator / キー / 対象月 /
  isPayoutEligibleOrderLine / commission_base > 0）を呼ぶ。
  ここで条件を書き写すと、片方だけ直されて食い違う。

  ■ 紹介報酬は referral_reward_items が唯一の正
  ここで 5% を計算し直さない。紹介者が居ない creator に報酬を作らない。
*/

/** Excel「クリエイターの推定成果報酬額」。Production 全 23,517 行で確認した唯一のキー */
const CREATOR_COMMISSION_JSON_KEY = "クリエイターの推定成果報酬額";

/*
  PostgREST の矢印記法で JSON の1キーだけを取り出す。
  raw_row_json をまるごと運ぶと 1,000 行あたり 1.1MB になり、
  必要な列だけなら 0.12MB で済む（実測）。
*/
const TAP_LINE_COLUMNS = [
  "source_row_key",
  "creator_id",
  "target_month",
  "commission_base",
  "tap_revenue",
  "partner_estimated_commission",
  "partner_shop_ads_estimated_commission",
  "order_status",
  "payment_status",
  "refund_status",
  `creator_commission_raw:raw_row_json->>${CREATOR_COMMISSION_JSON_KEY}`,
].join(", ");

type TapLineRow = {
  source_row_key: string | null;
  creator_id: string | null;
  target_month: string | null;
  commission_base: number | string | null;
  tap_revenue: number | string | null;
  partner_estimated_commission: number | string | null;
  partner_shop_ads_estimated_commission: number | string | null;
  order_status: string | null;
  payment_status: string | null;
  refund_status: string | null;
  creator_commission_raw: string | null;
};

/*
  紹介者の状態。

  「紹介者が -」と「紹介者が未設定」を必ず分ける。
  「-」は取込時に作られた名前だが、管理者が正式に設定した有効な紹介者で
  あり、報酬もそこへ帰属する。未設定（relation そのものが無い）と
  同じ扱いにすると、入力漏れを見つけられなくなる。
*/
export type TapReferrerState =
  /** 通常の紹介者が設定済み */
  | "assigned"
  /** 紹介者「-」が正式に設定済み。未設定ではない */
  | "dash_referrer"
  /** 関係はあるが TAP の対象月を1つも覆わない */
  | "out_of_period"
  /** 有効な紹介関係が無い＝紹介者未設定。入力漏れの可能性 */
  | "none"
  /** 有効な関係が複数あるなど、期間を決められない異常 */
  | "conflict";

/** 紹介者名が「-」かどうか。表記ゆれ（全角ダッシュなど）も拾う */
export function isDashReferrerName(name: string | null | undefined): boolean {
  const trimmed = String(name ?? "").trim();
  return trimmed === "-" || trimmed === "−" || trimmed === "ー" || trimmed === "—";
}

/** 紹介者の確認が必要な状態か（未設定・期間外・異常） */
export function needsReferrerReview(state: TapReferrerState): boolean {
  return state === "none" || state === "out_of_period" || state === "conflict";
}

/** 所属の状態 */
export type TapAgencyState =
  | "in_house"
  | "external"
  | "partially_unconfirmed"
  | "unconfirmed";

export type TapCreatorRow = {
  creatorId: string;
  tiktokId: string;
  creatorName: string | null;
  firstTargetMonth: string;
  lastTargetMonth: string;
  eligibleItemCount: number;
  /** 成果報酬ベース（各率の計算基礎額） */
  commissionBase: number;
  /** THREE COMMERCE の取り分 */
  tapRevenue: number;
  /** クリエイター本人へ発生する推定成果報酬 */
  creatorEstimatedCommission: number;
  /**
   * クリエイター報酬が Excel に記録されていなかった行数。
   * 0 として黙って飲み込まず、件数を持って画面へ出す。
   */
  creatorCommissionMissingCount: number;
  /** 紹介報酬（referral_reward_items の実績。ここで再計算しない） */
  referralRewardAmount: number;
  referralRewardItemCount: number;
  /** クリエイター区分。紹介報酬の対象かどうかの判断に使う */
  accountManagementType: string | null;
  /** 紹介報酬の算定元（W + X）。報酬が未生成でも金額規模が分かるようにする */
  referralBaseAmount: number;
  /** 算定元 × 5%。まだ発生していない場合の想定額 */
  estimatedReferralReward: number;
  /** 紹介報酬が発生しうる区分か（standard のみ true） */
  referralEligibleType: boolean;
  /** 紹介者の確認状態（creators.referrer_assignment_state） */
  referrerAssignmentState: string | null;
  referrerState: TapReferrerState;
  /** 紹介者名。関係が無ければ null */
  referrerName: string | null;
  /** 紹介関係の期間（期間外のときに「いつからか」を示す） */
  referralPeriodLabel: string | null;
  agencyState: TapAgencyState;
  /** 所属の表示名。月で変わる場合は「A → B」のように並べる */
  agencyLabel: string;
};

export type TapCreatorOverview = {
  rows: TapCreatorRow[];
  startMonth: string;
  endMonth: string;
  totals: {
    creatorCount: number;
    eligibleItemCount: number;
    commissionBase: number;
    tapRevenue: number;
    creatorEstimatedCommission: number;
    referralRewardAmount: number;
    /** クリエイター報酬が記録されていない行数（全体） */
    creatorCommissionMissingCount: number;
    referrerAssignedCount: number;
    referrerDashCount: number;
    referrerOutOfPeriodCount: number;
    referrerNoneCount: number;
    referrerConflictCount: number;
    /** 確認が必要な件数（未設定 + 期間外 + 異常） */
    referrerReviewCount: number;
    /** 算定元（W + X）の合計 */
    referralBaseAmount: number;
    /*
      紹介者の入力漏れ警告に使う数。

      紹介報酬が発生しうる区分（standard）だけを数える。
      self_operated / account_lending は区分により報酬対象外なので、
      紹介者が無くても入力漏れではない。混ぜると警告が過大になる。
    */
    missingReferrerCreatorCount: number;
    missingReferrerBaseAmount: number;
    missingReferrerEstimatedReward: number;
  };
  error: string | null;
};

const EMPTY_TOTALS: TapCreatorOverview["totals"] = {
  creatorCount: 0,
  eligibleItemCount: 0,
  commissionBase: 0,
  tapRevenue: 0,
  creatorEstimatedCommission: 0,
  referralRewardAmount: 0,
  creatorCommissionMissingCount: 0,
  referrerAssignedCount: 0,
  referrerDashCount: 0,
  referrerOutOfPeriodCount: 0,
  referrerNoneCount: 0,
  referrerConflictCount: 0,
  referrerReviewCount: 0,
  referralBaseAmount: 0,
  missingReferrerCreatorCount: 0,
  missingReferrerBaseAmount: 0,
  missingReferrerEstimatedReward: 0,
};

type Bucket = {
  months: Set<string>;
  itemCount: number;
  commissionBase: number[];
  tapRevenue: number[];
  /** 紹介報酬の算定元（W + X） */
  referralBase: number[];
  creatorCommission: number[];
  creatorCommissionMissing: number;
};

/*
  クリエイター報酬の値を読む。

  Production の 22,169 行のうち 4,564 行は空文字で、
  Excel 側にそもそも金額が入っていない（パース失敗ではない）。
  空も数値にならない値も 0 として足すが、件数を別に数えて画面へ出す。
*/
function readCreatorCommission(raw: string | null): {
  amount: number;
  missing: boolean;
} {
  const text = String(raw ?? "").trim();
  if (text === "") return { amount: 0, missing: true };

  const parsed = Number(text.replace(/,/g, ""));
  if (!Number.isFinite(parsed)) return { amount: 0, missing: true };

  return { amount: parsed, missing: false };
}

/**
 * TAP実績をクリエイター単位で集計する（READ ONLY）。
 *
 * 画面へ渡すのは集計後の行だけ。明細はサーバー側で畳んでから返す。
 */
/*
  紹介者を「確認する」範囲の終わり。

  ■ 支払の上限とは別物
  MAX_REFERRAL_PAYMENT_CUTOFF_MONTH（2026-07）は「紹介報酬を支払って
  よい最後の締め月」で、TAP が全量確定していない月を支払わないための
  歯止め。確認は読むだけで支払を発生させないので、同じ値に縛る理由がない。

  実際 2026-08 は月次確定の対象になっているのに、確認範囲が 2026-07 の
  ままだと未設定のクリエイターが画面にも警告にも出ず、入力漏れを
  見逃す。確定できる月は確認もできなければならない。

  ■ 月次確定の対象月から決める
  referral_month_settlements に行がある月が「確定しようとしている対象」
  そのものなので、その最大月を確認範囲の終わりにする。月が増えれば
  画面も自動で追随し、定数を書き換え忘れる余地が無くなる。

  ■ 読み取りは RPC 経由
  referral_month_settlements は authenticated / service_role に SELECT が
  grant されていない（postgres のみ）。権限を緩めず、既存の
  list_referral_month_settlements() を使う。呼び出しには auth.uid() を
  持つ認証済みクライアントが要る（サービスロールでは呼べない）。

  取得できなかった場合は支払上限まで狭める。広げる方向へ倒すと、
  根拠の無い月まで確認対象に見せてしまう。
*/
export async function resolveReferralReviewEndMonth(
  supabase: SupabaseClient,
): Promise<string> {
  const { data, error } = await supabase.rpc("list_referral_month_settlements");

  if (error) return MAX_REFERRAL_PAYMENT_CUTOFF_MONTH;

  const months = ((data as Array<Record<string, unknown>> | null) ?? [])
    .map((row) => String(row.target_month ?? ""))
    .filter((month) => CUTOFF_MONTH_PATTERN.test(month))
    .sort();

  const latest = months.at(-1);
  if (!latest) return MAX_REFERRAL_PAYMENT_CUTOFF_MONTH;

  /* 確定対象が支払上限より手前なら、狭い方に合わせる */
  return latest < MAX_REFERRAL_PAYMENT_CUTOFF_MONTH
    ? MAX_REFERRAL_PAYMENT_CUTOFF_MONTH
    : latest;
}

export async function fetchTapCreatorOverview(
  supabase: SupabaseClient,
  options: { startMonth?: string; endMonth?: string } = {},
): Promise<TapCreatorOverview> {
  const startMonth = options.startMonth ?? EARLIEST_CUTOFF_MONTH;
  const endMonth = options.endMonth ?? MAX_REFERRAL_PAYMENT_CUTOFF_MONTH;

  const empty: TapCreatorOverview = {
    rows: [],
    startMonth,
    endMonth,
    totals: { ...EMPTY_TOTALS },
    error: null,
  };

  const [
    linesResult,
    creatorsResult,
    referralsResult,
    rewardResult,
    monthlyResult,
    agenciesResult,
    referrersResult,
  ] = await Promise.all([
      fetchAllFrom<TapLineRow>(
        supabase,
        "tap_affiliate_order_lines",
        TAP_LINE_COLUMNS,
        (query) =>
          query.gte("target_month", startMonth).lte("target_month", endMonth),
      ),
      fetchAllFrom<{
        id: string;
        tiktok_id: string | null;
        creator_name: string | null;
        account_management_type: string | null;
        referrer_assignment_state: string | null;
      }>(
        supabase,
        "creators",
        "id, tiktok_id, creator_name, account_management_type, referrer_assignment_state",
      ),
      fetchAllFrom<ReferralRelationRow>(
        supabase,
        "creator_referrals",
        REFERRAL_RELATION_COLUMNS,
      ),
      fetchAllFrom<{
        creator_id: string;
        target_month: string;
        reward_amount: number | string | null;
        adjusted_reward_amount: number | string | null;
        is_reward_target: boolean;
      }>(
        supabase,
        "referral_reward_items",
        "creator_id, target_month, reward_amount, adjusted_reward_amount, is_reward_target",
        (query) =>
          query.gte("target_month", startMonth).lte("target_month", endMonth),
      ),
      fetchAllFrom<{ creator_id: string; target_month: string; agency_id: string | null }>(
        supabase,
        "creator_monthly_agency_assignments",
        "creator_id, target_month, agency_id",
        (query) =>
          query.gte("target_month", startMonth).lte("target_month", endMonth),
      ),
      supabase.from("agencies").select("id, name, is_in_house"),
      supabase.from("referrers").select("id, name, referrer_name"),
    ]);

  const error =
    linesResult.error ??
    creatorsResult.error ??
    referralsResult.error ??
    rewardResult.error ??
    monthlyResult.error ??
    agenciesResult.error?.message ??
    referrersResult.error?.message ??
    null;

  if (error) return { ...empty, error };

  // ---- マスタ ---------------------------------------------------------------
  const creatorById = new Map<
    string,
    {
      tiktokId: string;
      creatorName: string | null;
      accountManagementType: string | null;
      referrerAssignmentState: string | null;
    }
  >();
  for (const row of creatorsResult.data) {
    creatorById.set(String(row.id), {
      tiktokId: String(row.tiktok_id ?? ""),
      creatorName: row.creator_name == null ? null : String(row.creator_name),
      accountManagementType:
        row.account_management_type == null ? null : String(row.account_management_type),
      referrerAssignmentState:
        row.referrer_assignment_state == null
          ? null
          : String(row.referrer_assignment_state),
    });
  }

  const agencyById = new Map<string, { name: string; isInHouse: boolean }>();
  for (const row of agenciesResult.data ?? []) {
    agencyById.set(String(row.id), {
      name: String(row.name ?? "（削除済み代理店）"),
      isInHouse: row.is_in_house === true,
    });
  }

  const referrerNameById = new Map<string, string>();
  for (const row of referrersResult.data ?? []) {
    referrerNameById.set(
      String(row.id),
      String(row.referrer_name ?? row.name ?? "（不明な紹介者）"),
    );
  }

  const monthlyByCreator = new Map<string, Map<string, string | null>>();
  for (const row of monthlyResult.data) {
    const byMonth = monthlyByCreator.get(row.creator_id) ?? new Map();
    byMonth.set(row.target_month, row.agency_id);
    monthlyByCreator.set(row.creator_id, byMonth);
  }

  const referralIndex = buildReferralPeriods(referralsResult.data);

  // ---- 紹介報酬（実績のみ。ここで再計算しない）------------------------------
  const rewardByCreator = new Map<string, { amounts: number[]; itemCount: number }>();
  for (const item of rewardResult.data) {
    if (!item.is_reward_target) continue;
    const current = rewardByCreator.get(item.creator_id) ?? { amounts: [], itemCount: 0 };
    current.amounts.push(resolveRewardItemAmount(item));
    current.itemCount += 1;
    rewardByCreator.set(item.creator_id, current);
  }

  // ---- TAP 明細を creator 単位へ畳む ----------------------------------------
  const buckets = new Map<string, Bucket>();

  for (const line of linesResult.data) {
    /*
      対象行の判定は既存の正式条件をそのまま呼ぶ。
      ここに条件を書き写さない（紹介報酬側と食い違う元になる）。
    */
    if (
      !isTapReferralSourceLine({
        source_row_key: line.source_row_key,
        order_id: null,
        product_id: null,
        creator_id: line.creator_id,
        target_month: line.target_month,
        commission_base: line.commission_base,
        payment_status: line.payment_status,
        order_status: line.order_status,
        refund_status: line.refund_status,
      })
    ) {
      continue;
    }

    const creatorId = String(line.creator_id);
    const targetMonth = String(line.target_month);
    const bucket =
      buckets.get(creatorId) ??
      ({
        months: new Set<string>(),
        itemCount: 0,
        commissionBase: [],
        tapRevenue: [],
        referralBase: [],
        creatorCommission: [],
        creatorCommissionMissing: 0,
      } satisfies Bucket);

    const creatorCommission = readCreatorCommission(line.creator_commission_raw);

    bucket.months.add(targetMonth);
    bucket.itemCount += 1;
    bucket.commissionBase.push(toAmount(line.commission_base));
    bucket.tapRevenue.push(toAmount(line.tap_revenue));
    /*
      紹介報酬の算定元は referralBaseAmount が唯一の入口（W + X）。
      ここで W や X から自前で足し直さない（報酬側と食い違う元になる）。
    */
    bucket.referralBase.push(referralBaseAmount(line));
    bucket.creatorCommission.push(creatorCommission.amount);
    if (creatorCommission.missing) bucket.creatorCommissionMissing += 1;

    buckets.set(creatorId, bucket);
  }

  // ---- 行の組み立て ---------------------------------------------------------
  const rows: TapCreatorRow[] = [];

  for (const [creatorId, bucket] of buckets) {
    const months = [...bucket.months].sort();
    const firstTargetMonth = months[0];
    const lastTargetMonth = months[months.length - 1];

    const creator = creatorById.get(creatorId);
    const periods = referralIndex.byCreator.get(creatorId);
    const reward = rewardByCreator.get(creatorId);
    const referralBase = sumReferralAmounts(bucket.referralBase);
    const eligibleType = isReferralRewardEligibleType(
      creator?.accountManagementType ?? null,
    );

    /*
      紹介者の状態。

      対象月のどれかを覆う関係があれば assigned。
      関係はあるが TAP の対象月を1つも覆わないなら out_of_period。
      （株）3 を 2026-09 開始で登録した creator がこれに当たる。
    */
    let referrerState: TapReferrerState = "none";
    let referrerName: string | null = null;
    let referralPeriodLabel: string | null = null;

    if (periods && periods.length > 0) {
      /*
        対象月のどれかで期間が重なっていたら異常として出す。
        黙ってどれかを選ぶと、誰に帰属するのか分からないまま
        画面だけ正常に見えてしまう。
      */
      const conflicted = months.some(
        (month) => resolveReferralForMonth(periods, month).conflicts.length > 0,
      );
      const covering = months
        .map((month) => resolveReferralForMonth(periods, month).period)
        .find((period) => period != null);

      const shown = covering ?? periods[periods.length - 1];
      referrerName =
        referrerNameById.get(shown.referrerId) ?? "（不明な紹介者）";
      referralPeriodLabel = `${shown.startMonth}〜${shown.endMonth ?? ""}`;

      if (conflicted) {
        referrerState = "conflict";
      } else if (!covering) {
        referrerState = "out_of_period";
      } else if (isDashReferrerName(referrerName)) {
        /*
          紹介者「-」。取込時に作られた名前だが管理者が正式に設定した
          有効な紹介者で、報酬もここへ帰属する。未設定とは別に数える。
        */
        referrerState = "dash_referrer";
      } else {
        referrerState = "assigned";
      }
    }

    // ---- 所属 ---------------------------------------------------------------
    const assignments = monthlyByCreator.get(creatorId);
    const assignedAgencies: string[] = [];
    let confirmedMonths = 0;

    for (const month of months) {
      const agencyId = assignments?.get(month);
      if (agencyId === undefined) continue;
      confirmedMonths += 1;
      const name = agencyId == null ? "（所属なし）" : agencyById.get(agencyId)?.name ?? "（不明）";
      if (assignedAgencies[assignedAgencies.length - 1] !== name) {
        assignedAgencies.push(name);
      }
    }

    let agencyState: TapAgencyState;
    let agencyLabel: string;

    if (confirmedMonths === 0) {
      agencyState = "unconfirmed";
      agencyLabel = "所属未確認";
    } else if (confirmedMonths < months.length) {
      agencyState = "partially_unconfirmed";
      agencyLabel = `一部未確認（${assignedAgencies.join(" → ")}）`;
    } else {
      const allInHouse = months.every((month) => {
        const agencyId = assignments?.get(month);
        return agencyId != null && agencyById.get(agencyId)?.isInHouse === true;
      });
      agencyState = allInHouse ? "in_house" : "external";
      agencyLabel = allInHouse ? "自社運営" : assignedAgencies.join(" → ");
    }

    rows.push({
      creatorId,
      tiktokId: creator?.tiktokId ?? "",
      creatorName: creator?.creatorName ?? null,
      firstTargetMonth,
      lastTargetMonth,
      eligibleItemCount: bucket.itemCount,
      commissionBase: sumReferralAmounts(bucket.commissionBase),
      tapRevenue: sumReferralAmounts(bucket.tapRevenue),
      creatorEstimatedCommission: sumReferralAmounts(bucket.creatorCommission),
      creatorCommissionMissingCount: bucket.creatorCommissionMissing,
      accountManagementType: creator?.accountManagementType ?? null,
      referralBaseAmount: referralBase,
      estimatedReferralReward: sumReferralAmounts([referralBase * REFERRAL_REWARD_RATE]),
      referralEligibleType: eligibleType,
      referrerAssignmentState: creator?.referrerAssignmentState ?? null,
      referralRewardAmount: sumReferralAmounts(reward?.amounts ?? []),
      referralRewardItemCount: reward?.itemCount ?? 0,
      referrerState,
      referrerName,
      referralPeriodLabel,
      agencyState,
      agencyLabel,
    });
  }

  rows.sort(
    (a, b) =>
      b.commissionBase - a.commissionBase ||
      a.tiktokId.localeCompare(b.tiktokId, "ja"),
  );

  /** 紹介者の入力漏れ（報酬対象の区分なのに紹介者が未設定） */
  const missingReferrer = rows.filter(
    (row) => row.referrerState === "none" && row.referralEligibleType,
  );

  return {
    rows,
    startMonth,
    endMonth,
    totals: {
      creatorCount: rows.length,
      eligibleItemCount: rows.reduce((sum, row) => sum + row.eligibleItemCount, 0),
      commissionBase: sumReferralAmounts(rows.map((row) => row.commissionBase)),
      tapRevenue: sumReferralAmounts(rows.map((row) => row.tapRevenue)),
      creatorEstimatedCommission: sumReferralAmounts(
        rows.map((row) => row.creatorEstimatedCommission),
      ),
      referralRewardAmount: sumReferralAmounts(
        rows.map((row) => row.referralRewardAmount),
      ),
      creatorCommissionMissingCount: rows.reduce(
        (sum, row) => sum + row.creatorCommissionMissingCount,
        0,
      ),
      referrerAssignedCount: rows.filter((row) => row.referrerState === "assigned").length,
      referrerDashCount: rows.filter((row) => row.referrerState === "dash_referrer").length,
      referrerOutOfPeriodCount: rows.filter((row) => row.referrerState === "out_of_period")
        .length,
      referrerNoneCount: rows.filter((row) => row.referrerState === "none").length,
      referrerConflictCount: rows.filter((row) => row.referrerState === "conflict").length,
      referrerReviewCount: rows.filter((row) => needsReferrerReview(row.referrerState))
        .length,
      referralBaseAmount: sumReferralAmounts(rows.map((row) => row.referralBaseAmount)),
      /*
        入力漏れ警告の対象は「紹介報酬が発生しうる区分で、紹介者が未設定」。
        self_operated / account_lending は区分により報酬対象外なので、
        紹介者が無くても入力漏れではない。混ぜると警告が過大になる。
      */
      missingReferrerCreatorCount: missingReferrer.length,
      missingReferrerBaseAmount: sumReferralAmounts(
        missingReferrer.map((row) => row.referralBaseAmount),
      ),
      missingReferrerEstimatedReward: sumReferralAmounts(
        missingReferrer.map((row) => row.estimatedReferralReward),
      ),
    },
    error: null,
  };
}

// =============================================================================
// 紹介者の入力漏れ（月次確定前の警告用）
// =============================================================================
/*
  月次確定の前に「TAP報酬が発生しているのに紹介者が未設定」の
  クリエイターを知るための集計。

  ■ 月ごとに判定する
  確定するのはひと月ずつなので、その月より後の TAP だけを理由に
  過去月の確定を警告してはいけない。各 target_month について、
  その月の TAP 算定元が発生していて、かつその月を覆う紹介関係が
  無いクリエイターだけを数える。

  ■ 区分で絞る
  紹介報酬が発生しうる区分（standard）だけを対象にする。
  self_operated / account_lending は区分により報酬対象外なので、
  紹介者が無くても入力漏れではない。

  ■ ここでは何も書かない
  検出するだけ。紹介者の自動登録も報酬の生成も行わない。
*/

export type ReferrerGapMonth = {
  targetMonth: string;
  /** その月に紹介者が未設定だったクリエイター数 */
  creatorCount: number;
  /** その月の算定元（W + X）合計 */
  referralBaseAmount: number;
  /** 算定元 × 5% */
  estimatedReferralReward: number;
};

export type ReferrerGapSummary = {
  months: ReferrerGapMonth[];
  /** 確認した範囲の終わり。支払上限とは別 */
  endMonth: string;
  /** 支払ってよい最後の締め月（画面で取り違えないよう一緒に返す） */
  paymentCutoffMonth: string;
  /** 全期間で一度でも未設定だったクリエイターの実数（月をまたいで重複させない） */
  creatorCount: number;
  referralBaseAmount: number;
  estimatedReferralReward: number;
  error: string | null;
};

const EMPTY_GAP: ReferrerGapSummary = {
  months: [],
  endMonth: MAX_REFERRAL_PAYMENT_CUTOFF_MONTH,
  paymentCutoffMonth: MAX_REFERRAL_PAYMENT_CUTOFF_MONTH,
  creatorCount: 0,
  referralBaseAmount: 0,
  estimatedReferralReward: 0,
  error: null,
};

export async function fetchReferrerGapSummary(
  supabase: SupabaseClient,
  options: { endMonth?: string } = {},
): Promise<ReferrerGapSummary> {
  const startMonth = EARLIEST_CUTOFF_MONTH;
  const endMonth = options.endMonth ?? MAX_REFERRAL_PAYMENT_CUTOFF_MONTH;

  const [linesResult, creatorsResult, referralsResult] = await Promise.all([
    fetchAllFrom<TapLineRow>(supabase, "tap_affiliate_order_lines", TAP_LINE_COLUMNS, (query) =>
      query.gte("target_month", startMonth).lte("target_month", endMonth),
    ),
    fetchAllFrom<{ id: string; account_management_type: string | null }>(
      supabase,
      "creators",
      "id, account_management_type",
    ),
    fetchAllFrom<ReferralRelationRow>(
      supabase,
      "creator_referrals",
      REFERRAL_RELATION_COLUMNS,
    ),
  ]);

  const error =
    linesResult.error ?? creatorsResult.error ?? referralsResult.error ?? null;
  if (error) return { ...EMPTY_GAP, endMonth, error };

  const eligibleById = new Map<string, boolean>();
  for (const row of creatorsResult.data) {
    eligibleById.set(
      String(row.id),
      isReferralRewardEligibleType(row.account_management_type),
    );
  }

  const index = buildReferralPeriods(referralsResult.data);

  /* 月 → creator → 算定元 */
  const byMonth = new Map<string, Map<string, number>>();

  for (const line of linesResult.data) {
    const creatorId = line.creator_id;
    const targetMonth = line.target_month;
    if (!creatorId || !targetMonth) continue;
    if (!eligibleById.get(creatorId)) continue;

    const base = referralBaseAmount(line);
    if (!Number.isFinite(base) || base <= 0) continue;

    /* その月を覆う紹介関係があるなら入力漏れではない */
    const resolution = resolveReferralForMonth(
      index.byCreator.get(creatorId),
      targetMonth,
    );
    if (resolution.period?.referrerId) continue;

    const bucket = byMonth.get(targetMonth) ?? new Map<string, number>();
    bucket.set(creatorId, (bucket.get(creatorId) ?? 0) + base);
    byMonth.set(targetMonth, bucket);
  }

  const months: ReferrerGapMonth[] = [...byMonth]
    .map(([targetMonth, perCreator]) => {
      const base = sumReferralAmounts([...perCreator.values()]);
      return {
        targetMonth,
        creatorCount: perCreator.size,
        referralBaseAmount: base,
        estimatedReferralReward: sumReferralAmounts([base * REFERRAL_REWARD_RATE]),
      };
    })
    .sort((a, b) => a.targetMonth.localeCompare(b.targetMonth));

  /* 全期間の実数は creator を重複させずに数える */
  const allCreators = new Map<string, number>();
  for (const perCreator of byMonth.values()) {
    for (const [creatorId, base] of perCreator) {
      allCreators.set(creatorId, (allCreators.get(creatorId) ?? 0) + base);
    }
  }
  const totalBase = sumReferralAmounts([...allCreators.values()]);

  return {
    months,
    endMonth,
    paymentCutoffMonth: MAX_REFERRAL_PAYMENT_CUTOFF_MONTH,
    creatorCount: allCreators.size,
    referralBaseAmount: totalBase,
    estimatedReferralReward: sumReferralAmounts([totalBase * REFERRAL_REWARD_RATE]),
    error: null,
  };
}
