/*
  締め対象月（cutoff month）。

  ■ 締め対象月とは
  「この月までの未払いを支払う」という業務上の区切り。
  支払明細に組み入れる明細は target_month <= cutoffMonth に限る。

  ■ 既定値は当月ではなく JST の前月
  当月をそのまま既定にすると、まだ締めていない当月分を誤って支払える。
  月次の締めは月が終わってから行うので、安全側の前月を既定にする。
  例: 2026-09-26（JST）→ 既定の締め対象月は 2026-08。

  ■ 不正値は勝手に丸めない
  「近い有効な月へ自動補正」は、操作者が意図した締め月と実際に支払う月が
  ずれる余地を作る。不正なら明示的に弾き、選び直してもらう。
*/

export const CUTOFF_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 支払対象データが始まる月。これより前は選ばせない */
export const EARLIEST_CUTOFF_MONTH = "2026-01";

/*
  紹介者報酬を支払対象にできる最後の締め月。

  2026-08 以降は紹介報酬の発生データがまだ揃っていない。
    ・TAP 由来 0 件（TAP の 2026-08 は未払い 871 行を含み全量未確定）
    ・旧 affiliate 由来 32 件 / 5,698.85 円 が残ったまま
    ・referral_payouts の 2026-08 / 09 は削除済みの旧 affiliate 分を含み陳腐化
  この状態で締めると、根拠の無い額を支払うか、正しい額を未払い確定させる。

  2026-08 の TAP を全量取り込んで置き換えたら、この定数を進める。
  代理店側の締め月には影響させない（代理店報酬は TAP と無関係）。
*/
export const MAX_REFERRAL_PAYMENT_CUTOFF_MONTH = "2026-07";

/** 紹介者報酬を支払対象にできる締め月か */
export function isReferralPaymentCutoffMonth(value: unknown): value is string {
  return isCutoffMonth(value) && value <= MAX_REFERRAL_PAYMENT_CUTOFF_MONTH;
}

/** 紹介者報酬の締め月として選べない理由。選べるなら null */
export function referralPaymentCutoffError(month: string): string | null {
  if (!isCutoffMonth(month)) {
    return `締め対象月の形式が不正です（YYYY-MM）: ${month}`;
  }
  if (month > MAX_REFERRAL_PAYMENT_CUTOFF_MONTH) {
    return `紹介者報酬は ${MAX_REFERRAL_PAYMENT_CUTOFF_MONTH} 末締めまでが対象です（指定 ${month}）。${MAX_REFERRAL_PAYMENT_CUTOFF_MONTH} より後の月は TAP の全量取込が済んでいません。`;
  }
  return null;
}

export function isCutoffMonth(value: unknown): value is string {
  return typeof value === "string" && CUTOFF_MONTH_PATTERN.test(value);
}

/** JST の「今日」から YYYY-MM を作る */
export function currentMonthJst(now: Date = new Date()): string {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function previousMonthOf(month: string): string {
  const [year, mon] = month.split("-").map(Number);
  return mon === 1
    ? `${year - 1}-12`
    : `${year}-${String(mon - 1).padStart(2, "0")}`;
}

/** 既定の締め対象月。JST の前月（＝直近で締め終わっている月） */
export function defaultCutoffMonth(now: Date = new Date()): string {
  return previousMonthOf(currentMonthJst(now));
}

export type CutoffResolution =
  | { ok: true; cutoffMonth: string }
  | { ok: false; error: string; fallbackMonth: string };

/**
 * URL の ?cutoff= を解決する。
 *
 * ・指定があれば最優先で使う
 * ・指定が無ければ既定（JST前月）
 * ・不正・未来月・古すぎる月はエラーにし、勝手に丸めない
 */
export function resolveCutoffMonth(
  raw: string | null | undefined,
  now: Date = new Date(),
): CutoffResolution {
  const fallbackMonth = defaultCutoffMonth(now);

  if (raw == null || raw.trim() === "") {
    return { ok: true, cutoffMonth: fallbackMonth };
  }

  const value = raw.trim();

  if (!isCutoffMonth(value)) {
    return {
      ok: false,
      error: `締め対象月の形式が不正です（YYYY-MM）: ${value}`,
      fallbackMonth,
    };
  }

  const current = currentMonthJst(now);
  if (value > current) {
    return {
      ok: false,
      error: `締め対象月に未来月は指定できません（指定 ${value} / 当月 ${current}）`,
      fallbackMonth,
    };
  }

  if (value < EARLIEST_CUTOFF_MONTH) {
    return {
      ok: false,
      error: `締め対象月は ${EARLIEST_CUTOFF_MONTH} 以降で指定してください: ${value}`,
      fallbackMonth,
    };
  }

  return { ok: true, cutoffMonth: value };
}

/** セレクタに並べる選択肢。EARLIEST 〜 当月（JST）を新しい順で返す */
export function cutoffMonthOptions(now: Date = new Date()): string[] {
  const last = currentMonthJst(now);
  const out: string[] = [];
  let cursor = last;
  while (cursor >= EARLIEST_CUTOFF_MONTH && out.length < 120) {
    out.push(cursor);
    cursor = previousMonthOf(cursor);
  }
  return out;
}

/** 「2026年7月末」の形 */
export function formatCutoffLabel(month: string): string {
  if (!isCutoffMonth(month)) return month;
  const [year, mon] = month.split("-");
  return `${year}年${Number(mon)}月末`;
}
