/*
  セラー請求書の支払期限。単一ソース。

  ■ 正式ルール: 月末締め・翌月末払い
    支払期限 = 請求対象月（target_month）の翌月の末日

      2026-08 → 2026-09-30
      2026-09 → 2026-10-31
      2026-11 → 2026-12-31
      2026-12 → 2027-01-31   （年跨ぎ）
      2027-01 → 2027-02-28
      2028-01 → 2028-02-29   （うるう年）

  ■ 発行日は基準にしない
    「発行日 + 30日」でも「固定30日」でもない。
    いつ発行しても、対象月が同じなら支払期限は同じになる。

  ■ 月末日の求め方
    Date.UTC(year, month, 0) は「1始まりの month 月の末日」を返す。
    翌月末日が欲しいので month + 1 を渡す。
    月の繰り上がり（12月→翌年1月）とうるう年は Date が処理する。
    タイムゾーンで日付がずれないよう UTC で組み立てる。
*/

/** 支払期限を求める。target_month は "YYYY-MM" */
export function calculateSellerInvoiceDueDate(targetMonth: string): string | null {
  const match = /^(\d{4})-(\d{2})$/.exec(String(targetMonth ?? "").trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);

  if (month < 1 || month > 12) return null;

  // 1始まりの (month + 1) 月の末日
  const dueDate = new Date(Date.UTC(year, month + 1, 0));

  return dueDate.toISOString().slice(0, 10);
}

/** 画面表示用（2026-09-30 → 2026年9月30日） */
export function formatDueDateLabel(dueDate: string | null | undefined): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dueDate ?? "").trim());
  if (!match) return "—";
  return `${Number(match[1])}年${Number(match[2])}月${Number(match[3])}日`;
}
