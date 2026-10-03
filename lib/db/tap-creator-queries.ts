import type { SupabaseClient } from "@supabase/supabase-js";

import { fetchAllFrom } from "@/lib/db/paged-select";
import { isTapReferralSourceLine } from "@/lib/referrals/tap-referral-source";
import {
  buildReferralPeriods,
  REFERRAL_RELATION_COLUMNS,
  resolveReferralForMonth,
  type ReferralRelationRow,
} from "@/lib/referrals/referral-period";
import {
  isReferralRewardEligibleType,
  type AccountManagementType,
} from "@/lib/creators/account-management-type";
import {
  fetchMonthlyAccountTypes,
  monthlyAccountTypeKey,
  resolveMonthlyAccountManagementType,
  type AccountManagementTypeSource,
} from "@/lib/creators/monthly-account-management-type";
import {
  normalizeAssignmentState,
  resolveAssignmentState,
} from "@/lib/creators/assignment-state";
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

/** 対象月ごとに解決した区分 */
export type TapAccountTypeMonth = {
  targetMonth: string;
  accountManagementType: AccountManagementType;
  /** monthly = 月別確定 / current = 現在区分（暫定） */
  source: AccountManagementTypeSource;
  /** その月が紹介報酬5%の対象か */
  referralEligible: boolean;
};

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
  /** 紹介報酬が発生しうる区分か（対象月のどれかが standard なら true） */
  referralEligibleType: boolean;
  /** 対象月ごとの区分。月によって対象・対象外が変わる場合に使う */
  typeMonths: TapAccountTypeMonth[];
  /*
    月別区分が未確定で、現在区分から暫定判定している月。

    この月は現在区分を変えると過去の紹介報酬の判定まで変わる。
    確定させれば以後は動かない。
  */
  unconfirmedTypeMonths: string[];
  /*
    紹介報酬の再集計が必要な月。

    区分・紹介者の条件は揃っているのに referral_reward_items が
    無い月。区分や紹介者を変更したあと sync していないと出る。
    ここでは検出のみで、自動では再集計しない。
  */
  staleRewardMonths: string[];
  /** 再集計で発生しうる額（見込み。referral_reward_items の実績ではない） */
  staleRewardEstimatedAmount: number;
  /** 紹介者の確認状態（creators.referrer_assignment_state） */
  referrerAssignmentState: string | null;
  /*
    正式な対象行（isTapReferralSourceLine を通ったもの）の最初の月。

    紹介者を新しく登録するときの適用開始月の初期値に使う。
    未払い・未決済・返金済みの行は「報酬が発生した」とは言えないので、
    そこを起点に開始月を決めてはいけない。
  */
  firstEligibleMonth: string;
  referrerState: TapReferrerState;
  /** 紹介者名。関係が無ければ null */
  referrerName: string | null;
  /** 紹介関係の期間（期間外のときに「いつからか」を示す） */
  referralPeriodLabel: string | null;
  agencyState: TapAgencyState;
  /** 所属の表示名。月で変わる場合は「A → B」のように並べる */
  agencyLabel: string;
  /*
    TAP の対象月のうち、月別所属が確定していない月。

    「所属未確認」「一部未確認」だけだと何月を確定すればよいか
    分からないので、月そのものを持たせる。
  */
  unconfirmedAgencyMonths: string[];
  /*
    現在の所属（creators.agency_id）。参考表示にだけ使う。

    過去月の帰属は月別確定が正で、現在所属はその証拠にならない。
    これを月別所属へ自動コピーしてはいけない。
  */
  currentAgencyName: string | null;
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
    /*
      月別所属が未確定の分（代理店報酬の確認漏れ防止）。

      TAP の対象月ごとに creator_monthly_agency_assignments を見る。
      creator 単位で「1件も無い」ではなく、対象月それぞれで判定する。
      月別確定が無いと代理店報酬の支払対象にならないので、
      TAP 実績が出たのに確定していないものを見落とさないようにする。

      現在所属（creators.agency_id）があっても確定済みとは数えない。
      過去月の帰属は月別確定が正で、現在所属はその証拠にならない。
    */
    unconfirmedAgencyCreatorCount: number;
    /** 未確定の creator × month の件数 */
    unconfirmedAgencyMonthCount: number;
    unconfirmedAgencyItemCount: number;
    unconfirmedAgencyCommissionBase: number;
    unconfirmedAgencyReferralBase: number;
    unconfirmedAgencyTapRevenue: number;
    /*
      紹介報酬の再集計が必要なクリエイター。

      区分も紹介者も条件を満たしているのに referral_reward_items が
      無い月を持つもの。区分・紹介者を変更したあと sync していないと
      ここに出る。自動では再集計しない。
    */
    staleRewardCreatorCount: number;
    staleRewardMonthCount: number;
    /** 再集計で発生しうる額（算定元 × 5%。実際の生成は sync が行う） */
    staleRewardEstimatedAmount: number;
    /** 再集計が必要な月の一覧（昇順・重複なし） */
    staleRewardMonths: string[];
    /** 月別区分が未確定で、現在区分から暫定判定している creator 数 */
    unconfirmedTypeCreatorCount: number;
    unconfirmedTypeMonthCount: number;
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
  staleRewardCreatorCount: 0,
  staleRewardMonthCount: 0,
  staleRewardEstimatedAmount: 0,
  staleRewardMonths: [],
  unconfirmedTypeCreatorCount: 0,
  unconfirmedTypeMonthCount: 0,
  creatorCount: 0,
  eligibleItemCount: 0,
  commissionBase: 0,
  tapRevenue: 0,
  creatorEstimatedCommission: 0,
  referralRewardAmount: 0,
  creatorCommissionMissingCount: 0,
  unconfirmedAgencyCreatorCount: 0,
  unconfirmedAgencyMonthCount: 0,
  unconfirmedAgencyItemCount: 0,
  unconfirmedAgencyCommissionBase: 0,
  unconfirmedAgencyReferralBase: 0,
  unconfirmedAgencyTapRevenue: 0,
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
  /** 対象月ごとの算定元。再集計が必要な月を名指しするために持つ */
  referralBaseByMonth: Map<string, number[]>;
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
    monthlyTypesResult,
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
        agency_id: string | null;
      }>(
        supabase,
        "creators",
        "id, tiktok_id, creator_name, account_management_type, referrer_assignment_state, agency_id",
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
      /*
        区分（通常 / 自社運用 / アカウント貸出）は対象月の値で判定する。
        現在値を全月へ当てると、区分変更が過去月の判定まで変えてしまう。
        優先順位は lib/creators/monthly-account-management-type.ts が単一ソース。
      */
      fetchMonthlyAccountTypes(supabase),
    ]);

  const error =
    linesResult.error ??
    creatorsResult.error ??
    referralsResult.error ??
    rewardResult.error ??
    monthlyResult.error ??
    agenciesResult.error?.message ??
    referrersResult.error?.message ??
    monthlyTypesResult.error ??
    null;

  if (error) return { ...empty, error };

  // ---- マスタ ---------------------------------------------------------------
  const agencyById = new Map<string, { name: string; isInHouse: boolean }>();
  for (const row of agenciesResult.data ?? []) {
    agencyById.set(String(row.id), {
      name: String(row.name ?? "（削除済み代理店）"),
      isInHouse: row.is_in_house === true,
    });
  }

  const creatorById = new Map<
    string,
    {
      tiktokId: string;
      creatorName: string | null;
      accountManagementType: string | null;
      referrerAssignmentState: string | null;
      currentAgencyName: string | null;
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
      /* 参考表示のみ。月別所属の根拠にはしない */
      currentAgencyName:
        row.agency_id == null ? null : agencyById.get(String(row.agency_id))?.name ?? null,
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
  /* 月ごとの実績件数。どの月が未生成かを名指しするために別に数える */
  const rewardItemCountByCreatorMonth = new Map<string, number>();
  for (const item of rewardResult.data) {
    if (!item.is_reward_target) continue;
    const current = rewardByCreator.get(item.creator_id) ?? { amounts: [], itemCount: 0 };
    current.amounts.push(resolveRewardItemAmount(item));
    current.itemCount += 1;
    rewardByCreator.set(item.creator_id, current);

    const key = monthlyAccountTypeKey(item.creator_id, item.target_month);
    rewardItemCountByCreatorMonth.set(
      key,
      (rewardItemCountByCreatorMonth.get(key) ?? 0) + 1,
    );
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
        referralBaseByMonth: new Map<string, number[]>(),
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

    /* 月ごとにも貯める（どの月の再集計が要るかを出すため） */
    const monthBase = bucket.referralBaseByMonth.get(targetMonth) ?? [];
    monthBase.push(referralBaseAmount(line));
    bucket.referralBaseByMonth.set(targetMonth, monthBase);
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

    /*
      区分は対象月ごとに解決する。

      以前はここで creators の現在値だけを見ていたため、区分を
      変更すると過去月の「対象 / 対象外」まで変わって見えていた。
      月別確定がある月はその値、無い月だけ現在値へ落ちる。
    */
    const typeMonths: TapAccountTypeMonth[] = months.map((month) => {
      const resolved = resolveMonthlyAccountManagementType({
        creatorId,
        targetMonth: month,
        monthlyType: monthlyTypesResult.index.get(
          monthlyAccountTypeKey(creatorId, month),
        ),
        currentType: creator?.accountManagementType ?? null,
      });

      return {
        targetMonth: month,
        accountManagementType: resolved.accountManagementType,
        source: resolved.source,
        referralEligible: isReferralRewardEligibleType(
          resolved.accountManagementType,
        ),
      };
    });

    /*
      1か月でも対象になる月があれば「紹介報酬が発生しうる」creator。
      月ごとの可否は typeMonths を見る。
    */
    const eligibleType = typeMonths.some((month) => month.referralEligible);

    /* 現在区分で暫定判定している月（区分変更の影響を受ける） */
    const unconfirmedTypeMonths = typeMonths
      .filter((month) => month.source === "current")
      .map((month) => month.targetMonth);

    /*
      紹介報酬の再集計が必要な月。

      その月の区分が対象で、算定元（W + X）があり、紹介関係も
      その月を覆っているのに、referral_reward_items が 1 件も無い月。
      区分や紹介者を変更したあと sync を実行していないと起きる。
      ここでは検出だけで、再集計は管理者の操作に委ねる。
    */
    const staleRewardBases = new Map<string, number>();
    const staleRewardMonths = typeMonths
      .filter((month) => {
        if (!month.referralEligible) return false;
        const base = sumReferralAmounts(
          bucket.referralBaseByMonth.get(month.targetMonth) ?? [],
        );
        if (base <= 0) return false;
        const relation = resolveReferralForMonth(periods, month.targetMonth);
        if (!relation.period?.referrerId) return false;
        if (
          (rewardItemCountByCreatorMonth.get(
            monthlyAccountTypeKey(creatorId, month.targetMonth),
          ) ?? 0) !== 0
        ) {
          return false;
        }
        /* 見込み額はその月の料率で出す（既定の 5% を決め打ちしない） */
        staleRewardBases.set(
          month.targetMonth,
          base * relation.period.referralRate,
        );
        return true;
      })
      .map((month) => month.targetMonth);

    /*
      再集計で発生しうる額。見込みであって実績ではない。
      実際の生成は sync が行う（この集計では作らない）。
    */
    const staleRewardEstimatedAmount = sumReferralAmounts([
      ...staleRewardBases.values(),
    ]);

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
    const unconfirmedAgencyMonths: string[] = [];
    let confirmedMonths = 0;

    for (const month of months) {
      const agencyId = assignments?.get(month);
      if (agencyId === undefined) {
        unconfirmedAgencyMonths.push(month);
        continue;
      }
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
      /*
        所属が自社代理店（THREE.inc /（株）3）かどうか。

        区分（account_management_type）の self_operated＝自社運用とは
        別の概念。「自社運営」と書くと区分の「自社運用」と1文字しか
        違わず、同じ行に並べると取り違える
        （nikkoro.gashi で実際に「自社運営なのにアカウント貸出？」と
         読めてしまった。所属 THREE.inc / 区分 account_lending で
         どちらも正しい）。所属側であることが分かる名前にする。
      */
      agencyState = allInHouse ? "in_house" : "external";
      agencyLabel = allInHouse ? "自社代理店所属" : assignedAgencies.join(" → ");
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
      typeMonths,
      unconfirmedTypeMonths,
      staleRewardMonths,
      staleRewardEstimatedAmount,
      referrerAssignmentState: creator?.referrerAssignmentState ?? null,
      firstEligibleMonth: firstTargetMonth,
      referralRewardAmount: sumReferralAmounts(reward?.amounts ?? []),
      referralRewardItemCount: reward?.itemCount ?? 0,
      referrerState,
      referrerName,
      referralPeriodLabel,
      agencyState,
      agencyLabel,
      unconfirmedAgencyMonths,
      currentAgencyName: creator?.currentAgencyName ?? null,
    });
  }

  rows.sort(
    (a, b) =>
      b.commissionBase - a.commissionBase ||
      a.tiktokId.localeCompare(b.tiktokId, "ja"),
  );

  /** 月別所属が1か月でも未確定なクリエイター */
  const unconfirmedAgency = rows.filter(
    (row) => row.unconfirmedAgencyMonths.length > 0,
  );

  /** 再集計が必要（条件は揃っているのに紹介報酬が無い月を持つ） */
  const staleReward = rows.filter((row) => row.staleRewardMonths.length > 0);

  /** 月別区分が未確定で、現在区分から暫定判定している月を持つ */
  const unconfirmedType = rows.filter(
    (row) => row.unconfirmedTypeMonths.length > 0,
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
      /*
        警告の母集団は「正式な対象行があるクリエイター」。
        rows 自体が isTapReferralSourceLine を通ったものだけなので、
        未払い・返金のみのクリエイターはここに居ない。
      */
      unconfirmedAgencyCreatorCount: unconfirmedAgency.length,
      unconfirmedAgencyMonthCount: unconfirmedAgency.reduce(
        (sum, row) => sum + row.unconfirmedAgencyMonths.length,
        0,
      ),
      unconfirmedAgencyItemCount: unconfirmedAgency.reduce(
        (sum, row) => sum + row.eligibleItemCount,
        0,
      ),
      unconfirmedAgencyCommissionBase: sumReferralAmounts(
        unconfirmedAgency.map((row) => row.commissionBase),
      ),
      unconfirmedAgencyReferralBase: sumReferralAmounts(
        unconfirmedAgency.map((row) => row.referralBaseAmount),
      ),
      unconfirmedAgencyTapRevenue: sumReferralAmounts(
        unconfirmedAgency.map((row) => row.tapRevenue),
      ),
      staleRewardCreatorCount: staleReward.length,
      staleRewardMonthCount: staleReward.reduce(
        (sum, row) => sum + row.staleRewardMonths.length,
        0,
      ),
      /*
        再集計で発生しうる額。

        対象月の算定元に率を掛けた見込みで、referral_reward_items の
        実績ではない。実際の生成は sync が行う（ここでは作らない）。
      */
      staleRewardEstimatedAmount: sumReferralAmounts(
        staleReward.map((row) => row.staleRewardEstimatedAmount),
      ),
      staleRewardMonths: [
        ...new Set(staleReward.flatMap((row) => row.staleRewardMonths)),
      ].sort(),
      unconfirmedTypeCreatorCount: unconfirmedType.length,
      unconfirmedTypeMonthCount: unconfirmedType.reduce(
        (sum, row) => sum + row.unconfirmedTypeMonths.length,
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

    /*
      対象行の判定は TAP実績の一覧と同じ正式条件を通す。

      ここを通していなかったため、未払い・未決済・返金済みの行だけを
      理由に警告へ入る creator が 5 名いた（いずれも 2026-08。あの月は
      1,343 行中 871 行が未払い）。報酬が発生していない行を根拠に
      「紹介者の入力漏れ」と言ってはいけない。

      一覧側の集計（missingReferrerCreatorCount）と同じ母集団になる。
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

// =============================================================================
// 紹介者の帰属状況（支払管理の紹介者タブで使う表示専用の集計）
// =============================================================================
/*
  TAP の紹介報酬の算定元があるクリエイターを、紹介者の帰属で分けて見る。

  ■ 母集団
  isTapReferralSourceLine を通り、かつ算定元（W + X）が 0 より大きいもの。
  算定元が 0 のクリエイターは紹介報酬の帰属を考える対象にならないので
  ここでは数えない（TAP実績の一覧からは消さない。別の画面の話）。

  ■ 4つを混同しない
      assigned       通常の紹介者が設定済み
      dash_referrer  紹介者「-」が正式に設定済み
      no_referrer    紹介者がいないと確認済み（state = none）
      unconfirmed    まだ確認していない（要確認）

  「-」は管理者が正式に設定した有効な紹介者で、「紹介者なし」とは別物。
  「紹介者なし（確認済み）」と「未確認」も別物で、
  creators.referrer_assignment_state でしか区別できない
  （lib/creators/assignment-state.ts が単一ソース）。

  ■ 支払とは完全に分けて持つ
  これは読むだけの集計で、PaymentUnpaidRow には混ぜない。
  支払候補・claim・支払明細・振込CSV へは一切流さない。
  支払先として成立するのは referral_reward_items に行がある紹介者だけで、
  紹介者がいないクリエイターはそもそも referrer_id を持たない。

  ■ 確定額と想定額を混ぜない
  referralRewardAmount は referral_reward_items の実績。
  未設定のクリエイターの「設定したらいくらになるか」は
  estimatedReferralReward として別に持つ。足し合わせない。
*/

export type ReferrerCoverageKind =
  | "assigned"
  | "dash_referrer"
  | "no_referrer"
  | "unconfirmed";

export const REFERRER_COVERAGE_LABEL: Record<ReferrerCoverageKind, string> = {
  assigned: "紹介者あり",
  dash_referrer: "「-」設定済み",
  no_referrer: "紹介者なし（確認済み）",
  unconfirmed: "未設定・要確認",
};

export type ReferrerCoverageCreator = {
  creatorId: string;
  tiktokId: string;
  creatorName: string | null;
  accountManagementType: string | null;
  /** 紹介報酬が発生しうる区分か（standard のみ true） */
  referralEligibleType: boolean;
  agencyLabel: string;
  firstEligibleMonth: string;
  firstTargetMonth: string;
  lastTargetMonth: string;
  eligibleItemCount: number;
  commissionBase: number;
  /** 紹介報酬の算定元（W + X） */
  referralBaseAmount: number;
  /** 実績。referral_reward_items が正 */
  referralRewardAmount: number;
  /** 算定元 × 料率。確定額ではない */
  estimatedReferralReward: number;
  referrerName: string | null;
  referrerAssignmentState: string | null;
  /*
    単純な入力漏れではなく、relation の整合を見ないといけないもの。

    関係が登録されていて確認済みになっているのに、対象月の帰属先を
    正式に解決できない状態（odebu888 が該当）。新規設定で上書きすると
    既存の関係や過去の帰属を壊すので、別物として見せる。
  */
  relationInconsistent: boolean;
  /** 不整合の内容（画面でそのまま出す） */
  relationNote: string | null;
};

export type ReferrerCoverageGroup = {
  kind: ReferrerCoverageKind;
  /** assigned のときだけ入る。紹介者ごとに1グループ */
  referrerId: string | null;
  referrerName: string | null;
  creatorCount: number;
  /** うち relation の整合を確認すべきもの（単純な入力漏れではない） */
  relationInconsistentCount: number;
  eligibleItemCount: number;
  commissionBase: number;
  referralBaseAmount: number;
  referralRewardAmount: number;
  estimatedReferralReward: number;
  firstTargetMonth: string | null;
  lastTargetMonth: string | null;
  creators: ReferrerCoverageCreator[];
};

export type ReferrerCoverage = {
  groups: ReferrerCoverageGroup[];
  totals: {
    creatorCount: number;
    assignedCount: number;
    dashReferrerCount: number;
    noReferrerCount: number;
    unconfirmedCount: number;
    /** うち relation の整合を確認すべきもの */
    relationInconsistentCount: number;
    referralBaseAmount: number;
    referralRewardAmount: number;
    /*
      現在の区分では紹介報酬の対象外なのに、DB に実績が残っている分。

      区分を standard から変えたあと reward を再集計していないと起きる。
      画面で勝手に 0 へ置き換えず、実績として見せたうえで
      「現在は対象外」と並べて出す。
    */
    ineligibleRewardAmount: number;
    ineligibleRewardCreatorCount: number;
  };
};

const EMPTY_COVERAGE: ReferrerCoverage = {
  groups: [],
  totals: {
    creatorCount: 0,
    assignedCount: 0,
    dashReferrerCount: 0,
    noReferrerCount: 0,
    unconfirmedCount: 0,
    relationInconsistentCount: 0,
    referralBaseAmount: 0,
    referralRewardAmount: 0,
    ineligibleRewardAmount: 0,
    ineligibleRewardCreatorCount: 0,
  },
};

/**
 * TapCreatorRow から紹介者の帰属状況を組み立てる。
 *
 * 集計そのものは fetchTapCreatorOverview を再利用する。母集団・区分・
 * 所属ラベル・算定元・firstEligibleMonth はすべてそちらが持っている。
 */
export function buildReferrerCoverage(
  rows: readonly TapCreatorRow[],
): ReferrerCoverage {
  /* 算定元が 0 のクリエイターは帰属を考える対象にしない */
  const target = rows.filter((row) => row.referralBaseAmount > 0);
  if (target.length === 0) return EMPTY_COVERAGE;

  /*
    紹介関係はあるのに帰属先を解決できないもの。

    relation が存在して確認済みなのに referrerState が none になる。
    期間が重なって黙って選べない、開始月が不正、同月開始が並んで
    すべて superseded になった、などが原因になりうる。
  */
  const isInconsistent = (row: TapCreatorRow): boolean => {
    if (row.referrerState !== "none") return false;
    /*
      分類に使う実効状態（resolveAssignmentState）は ID が NULL なら
      決して "assigned" を返さないので、ここでは保存値をそのまま見る。

      保存値が assigned ＝ 誰かが紹介者を設定した記録がある。
      それでいて帰属先を解決できないなら、単純な入力漏れではない。
    */
    return normalizeAssignmentState(row.referrerAssignmentState) === "assigned";
  };

  const toCreator = (row: TapCreatorRow): ReferrerCoverageCreator => ({
    creatorId: row.creatorId,
    tiktokId: row.tiktokId,
    creatorName: row.creatorName,
    accountManagementType: row.accountManagementType,
    referralEligibleType: row.referralEligibleType,
    agencyLabel: row.agencyLabel,
    firstEligibleMonth: row.firstEligibleMonth,
    firstTargetMonth: row.firstTargetMonth,
    lastTargetMonth: row.lastTargetMonth,
    eligibleItemCount: row.eligibleItemCount,
    commissionBase: row.commissionBase,
    referralBaseAmount: row.referralBaseAmount,
    referralRewardAmount: row.referralRewardAmount,
    estimatedReferralReward: row.estimatedReferralReward,
    referrerName: row.referrerName,
    referrerAssignmentState: row.referrerAssignmentState,
    relationInconsistent: isInconsistent(row),
    relationNote: isInconsistent(row)
      ? "紹介関係は登録されていますが、対象月の帰属先を解決できていません。新規設定で上書きせず、relation を個別に確認してください。"
      : null,
  });

  /*
    どの分類に入るか。

    有効な紹介関係があるかは referrerState が決める
    （期間外や relation異常もここでは「関係はある」側に寄せず、
     後続の分岐で assigned 扱いにする。帰属先が居ることは確かなので）。
    関係が無い場合だけ、確認済みか未確認かを state で分ける。
  */
  const kindOf = (row: TapCreatorRow): ReferrerCoverageKind => {
    if (row.referrerState === "none") {
      return resolveAssignmentState(null, row.referrerAssignmentState) === "none"
        ? "no_referrer"
        : "unconfirmed";
    }
    return row.referrerState === "dash_referrer" ? "dash_referrer" : "assigned";
  };

  /* 紹介者ありは紹介者ごと、それ以外は分類ごとに1グループ */
  const buckets = new Map<string, { kind: ReferrerCoverageKind; referrerId: string | null; rows: TapCreatorRow[] }>();

  for (const row of target) {
    const kind = kindOf(row);
    const key =
      kind === "assigned" ? `assigned:${row.referrerName ?? ""}` : kind;
    const bucket = buckets.get(key) ?? { kind, referrerId: null, rows: [] };
    bucket.rows.push(row);
    buckets.set(key, bucket);
  }

  const groups: ReferrerCoverageGroup[] = [...buckets.values()].map((bucket) => {
    const creators = bucket.rows.map(toCreator);
    const months = bucket.rows
      .flatMap((row) => [row.firstTargetMonth, row.lastTargetMonth])
      .filter((value) => Boolean(value))
      .sort();

    return {
      kind: bucket.kind,
      referrerId: bucket.referrerId,
      referrerName:
        bucket.kind === "assigned" || bucket.kind === "dash_referrer"
          ? bucket.rows[0]?.referrerName ?? null
          : null,
      creatorCount: creators.length,
      relationInconsistentCount: creators.filter((c) => c.relationInconsistent).length,
      eligibleItemCount: creators.reduce((sum, c) => sum + c.eligibleItemCount, 0),
      commissionBase: sumReferralAmounts(creators.map((c) => c.commissionBase)),
      referralBaseAmount: sumReferralAmounts(creators.map((c) => c.referralBaseAmount)),
      referralRewardAmount: sumReferralAmounts(creators.map((c) => c.referralRewardAmount)),
      estimatedReferralReward: sumReferralAmounts(
        creators.map((c) => c.estimatedReferralReward),
      ),
      firstTargetMonth: months[0] ?? null,
      lastTargetMonth: months.at(-1) ?? null,
      creators: creators
        .slice()
        .sort((a, b) => b.referralBaseAmount - a.referralBaseAmount),
    };
  });

  const order: Record<ReferrerCoverageKind, number> = {
    unconfirmed: 0,
    assigned: 1,
    dash_referrer: 2,
    no_referrer: 3,
  };
  groups.sort(
    (a, b) =>
      order[a.kind] - order[b.kind] ||
      b.referralBaseAmount - a.referralBaseAmount,
  );

  const countOf = (kind: ReferrerCoverageKind) =>
    groups.filter((g) => g.kind === kind).reduce((sum, g) => sum + g.creatorCount, 0);

  return {
    groups,
    totals: {
      creatorCount: target.length,
      assignedCount: countOf("assigned"),
      dashReferrerCount: countOf("dash_referrer"),
      noReferrerCount: countOf("no_referrer"),
      unconfirmedCount: countOf("unconfirmed"),
      relationInconsistentCount: target.filter((row) => isInconsistent(row)).length,
      referralBaseAmount: sumReferralAmounts(
        target.map((row) => row.referralBaseAmount),
      ),
      referralRewardAmount: sumReferralAmounts(
        target.map((row) => row.referralRewardAmount),
      ),
      ineligibleRewardAmount: sumReferralAmounts(
        target
          .filter((row) => !row.referralEligibleType)
          .map((row) => row.referralRewardAmount),
      ),
      ineligibleRewardCreatorCount: target.filter(
        (row) => !row.referralEligibleType && row.referralRewardAmount > 0,
      ).length,
    },
  };
}
