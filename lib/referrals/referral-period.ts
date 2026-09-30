import { previousMonthOf } from "@/lib/payments/cutoff-month";
import { DEFAULT_REFERRER_LIFETIME_PAYOUT_CAP_YEN } from "@/lib/referrals/cap";
import {
  isReferralMonthActive,
  isValidTargetMonth,
  resolveReferralRate,
} from "@/lib/referrals/referral-reward-engine";

/*
  「対象月の時点で有効だった紹介関係」を決める単一ソース。

  ■ 業務ルール（2026-09-27 EMI承認）
  新しい紹介関係が始まったら、旧紹介関係の実効終了月は
  「次の紹介関係の start_month の前月」とする。

      旧 start_month = 2026-05        → 2026-05〜2026-08
      新 start_month = 2026-09        → 2026-09〜

  現在 is_active = false であっても、対象月当時に有効だった関係なら
  その月の紹介報酬は発生する。is_active を理由に過去月まで遡って
  報酬を消してはいけない。

  ■ なぜ is_active だけでは足りなかったか
  以前は creator ごとに「最も新しい is_active な関係」1件だけを採り、
  その後で期間を判定していた。この方式には2つの欠陥があった。

    ① is_active が target_month と無関係に効く
       紹介者を付け替えた瞬間、過去月の報酬まで生成されなくなる。

    ② creator につき1件しか見ない
       「旧 2026-05〜08 / 新 2026-09〜」を表現できない。
       旧関係を is_active = true に戻しても、新しい方が先に選ばれて
       期間判定で落ち、結局 0 円のままになる。

  ② のため、is_active を無視するだけでは直らない。
  関係を配列で持ち、対象月で選ぶ必要がある。

  ■ 終了月は記録値を優先する
  creator_referrals.end_month が入っていればそれが正。
  入っていないときだけ後続関係の開始月から導出する。
  導出したものは endMonthRestored = true として数えられるようにし、
  「復元で増えた分」を dry-run で必ず見せる。

  ■ 推測はしない
  無効化されているのに後続関係も end_month も無い関係は、
  いつまで有効だったかがどこにも記録されていない。
  ここで「無効化した日まで」などと決めると、DBに無い事実を作ってしまう。
  unresolved として外に出し、呼び出し側が件数を報告する。

  ■ 誤登録の履歴は期間計算に入れない（2026-09-30 確定）
  現時点で「途中から紹介者が変わった」クリエイターは1人も居ない。
  creator_referrals に複数行あるのは期間の切り替えではなく、
  登録されていた紹介者が間違っていたので後から直した履歴である。

  この履歴を期間計算に混ぜると、現在の紹介者の期間が誤登録行に
  切られてしまう。実際 eripyon.ec で、有効な関係を 2026-04 へ
  遡らせたところ、誤登録の 2026-05 行が「後続」と見なされて
  有効な関係が 2026-04 の1か月で終わり、2026-05 の報酬が
  どの紹介者にも帰属しなくなった。

  そこで期間計算に使うのは次の2つだけにする。

      is_active = true                        現在の正しい関係
      is_active = false かつ end_month あり   実際に有効だった過去の関係

  is_active = false かつ end_month が無いものは、いつまで有効だったか
  が記録されていない＝誤登録の履歴として扱い、期間の境界にも
  報酬の帰属先にも使わない。行は履歴として残すので消さない。

  ■ 本当に紹介者が変わった場合はこれまでどおり分割できる
  旧紹介者に end_month を明示して is_active = false、
  新紹介者を is_active = true にすれば、下の導出ロジックが
  そのまま期間を分ける。end_month が「実際に有効だった」ことの
  唯一の根拠になる、というのがこのルールの要点。
*/

export type ReferralRelationRow = {
  creator_id: string;
  referrer_id: string;
  referral_rate: number | string | null;
  start_month: string | null;
  end_month: string | null;
  is_active: boolean | null;
  lifetime_payout_cap: number | string | null;
  lifetime_paid_amount: number | string | null;
  created_at?: string | null;
};

export type ReferralPeriod = {
  referrerId: string;
  referralRate: number;
  startMonth: string;
  /** 実効終了月。null は継続中（後続関係なし） */
  endMonth: string | null;
  lifetimePayoutCap: number;
  lifetimePaidAmount: number;
  /** DB の is_active。判定には使わず、報告のために持つ */
  isActive: boolean;
  /** end_month が未記録で、後続関係の開始月から導出したか */
  endMonthRestored: boolean;
};

export type UnresolvedReferralReason =
  | "invalid_start_month"
  | "missing_end_month"
  | "superseded";

export const UNRESOLVED_REFERRAL_LABEL: Record<UnresolvedReferralReason, string> =
  {
    invalid_start_month: "開始月が不正（YYYY-MM でない）",
    missing_end_month: "無効化済みだが終了月も後続関係も無い（期間を推測しない）",
    superseded: "後続関係が同月以前に始まっており有効期間が存在しない",
  };

export type UnresolvedReferral = {
  creatorId: string;
  referrerId: string;
  startMonth: string | null;
  reason: UnresolvedReferralReason;
};

export type ReferralPeriodIndex = {
  /** creator → 実効期間つきの紹介関係（開始月の昇順） */
  byCreator: Map<string, ReferralPeriod[]>;
  /** 期間を決められなかった関係。推測せず外に出す */
  unresolved: UnresolvedReferral[];
  /** end_month を後続関係から導出した関係の件数 */
  restoredCount: number;
};

function toNumber(value: unknown, fallback: number): number {
  const parsed = Number(value ?? NaN);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * creator_referrals の生データから、対象月で引ける実効期間を組み立てる。
 *
 * 並びは start_month の昇順（同じ月なら created_at の昇順）。
 * 実効終了月は end_month があればそれ、無ければ後続関係の開始月の前月。
 */
/**
 * 期間計算に使ってよい関係か。
 *
 * 誤登録を直した履歴（無効化されていて終了月も無い行）を除く。
 * 詳しい理由はこのファイル冒頭の「誤登録の履歴は期間計算に入れない」。
 */
function isUsableForPeriod(row: ReferralRelationRow): boolean {
  if (row.is_active === true) return true;
  return row.end_month != null;
}

export function buildReferralPeriods(
  rows: readonly ReferralRelationRow[],
): ReferralPeriodIndex {
  const grouped = new Map<string, ReferralRelationRow[]>();

  for (const row of rows) {
    const creatorId = row.creator_id;
    if (!creatorId) continue;
    if (!isUsableForPeriod(row)) continue;
    const list = grouped.get(creatorId);
    if (list) list.push(row);
    else grouped.set(creatorId, [row]);
  }

  const byCreator = new Map<string, ReferralPeriod[]>();
  const unresolved: UnresolvedReferral[] = [];
  let restoredCount = 0;

  for (const [creatorId, list] of grouped) {
    const sorted = [...list].sort((a, b) => {
      const byStart = String(a.start_month ?? "").localeCompare(
        String(b.start_month ?? ""),
      );
      if (byStart !== 0) return byStart;
      return String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""));
    });

    const periods: ReferralPeriod[] = [];

    for (let index = 0; index < sorted.length; index += 1) {
      const row = sorted[index];
      const startMonth = String(row.start_month ?? "");
      const referrerId = row.referrer_id;
      const isActive = row.is_active === true;

      if (!referrerId) continue;

      if (!isValidTargetMonth(startMonth)) {
        unresolved.push({
          creatorId,
          referrerId,
          startMonth: row.start_month ?? null,
          reason: "invalid_start_month",
        });
        continue;
      }

      /*
        後続関係の開始月。同じ creator の次の世代が始まる月。
        start_month が不正な後続は境界に使えないので飛ばす。
      */
      let nextStartMonth: string | null = null;
      for (let next = index + 1; next < sorted.length; next += 1) {
        const candidate = String(sorted[next].start_month ?? "");
        if (isValidTargetMonth(candidate)) {
          nextStartMonth = candidate;
          break;
        }
      }

      const recordedEnd = row.end_month ?? null;
      const derivedEnd =
        nextStartMonth == null ? null : previousMonthOf(nextStartMonth);
      const endMonth = recordedEnd ?? derivedEnd;
      const endMonthRestored = recordedEnd == null && derivedEnd != null;

      /*
        後続も終了月も無いのに無効化されている関係。
        いつまで有効だったかが DB のどこにも無いので推測しない。
      */
      if (endMonth == null && !isActive) {
        unresolved.push({
          creatorId,
          referrerId,
          startMonth,
          reason: "missing_end_month",
        });
        continue;
      }

      // 後続が同月以前に始まっている＝有効期間が1か月も無い
      if (endMonth != null && endMonth < startMonth) {
        unresolved.push({
          creatorId,
          referrerId,
          startMonth,
          reason: "superseded",
        });
        continue;
      }

      if (endMonthRestored) restoredCount += 1;

      periods.push({
        referrerId,
        referralRate: resolveReferralRate(row.referral_rate),
        startMonth,
        endMonth,
        lifetimePayoutCap: toNumber(
          row.lifetime_payout_cap,
          DEFAULT_REFERRER_LIFETIME_PAYOUT_CAP_YEN,
        ),
        lifetimePaidAmount: toNumber(row.lifetime_paid_amount, 0),
        isActive,
        endMonthRestored,
      });
    }

    if (periods.length > 0) byCreator.set(creatorId, periods);
  }

  return { byCreator, unresolved, restoredCount };
}

export type ReferralMonthResolution = {
  /** 対象月に有効だった関係。無ければ null */
  period: ReferralPeriod | null;
  /**
   * 対象月に2件以上が該当した場合の全件。
   * 期間が重なっている異常データなので、黙ってどれかを選んではいけない。
   */
  conflicts: ReferralPeriod[];
};

/**
 * 対象月の時点で有効だった紹介関係を1件返す。
 *
 * 期間が重なっていて2件以上該当した場合は period を返さず conflicts に入れる。
 * 呼び出し側は必ずエラーとして扱うこと（黙って1件選ぶと支払額が静かにずれる）。
 */
export function resolveReferralForMonth(
  periods: readonly ReferralPeriod[] | undefined,
  targetMonth: string,
): ReferralMonthResolution {
  if (!periods || periods.length === 0) {
    return { period: null, conflicts: [] };
  }

  const matched = periods.filter((period) =>
    isReferralMonthActive(targetMonth, period.startMonth, period.endMonth),
  );

  if (matched.length === 0) return { period: null, conflicts: [] };
  if (matched.length > 1) return { period: null, conflicts: matched };

  return { period: matched[0], conflicts: [] };
}

/** 対象月に有効だった関係が重複している creator を洗い出す（事前チェック用） */
export function findReferralPeriodConflicts(
  index: ReferralPeriodIndex,
  targetMonth: string,
): Array<{ creatorId: string; periods: ReferralPeriod[] }> {
  const out: Array<{ creatorId: string; periods: ReferralPeriod[] }> = [];

  for (const [creatorId, periods] of index.byCreator) {
    const { conflicts } = resolveReferralForMonth(periods, targetMonth);
    if (conflicts.length > 0) out.push({ creatorId, periods: conflicts });
  }

  return out;
}

/** creator_referrals から読むべき列（sync と dry-run で同じものを使う） */
export const REFERRAL_RELATION_COLUMNS =
  "creator_id, referrer_id, referral_rate, start_month, end_month, is_active, lifetime_payout_cap, lifetime_paid_amount, created_at";
