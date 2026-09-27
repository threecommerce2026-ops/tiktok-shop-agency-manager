import { resolveCanonicalTiktokId } from "@/lib/orders/creator-alias";
import { buildTapAffiliateOrderSourceRowKey } from "@/lib/orders/parse-tap-affiliate-order-export";
import type { TapAffiliateOrderRow } from "@/lib/orders/parse-tap-affiliate-order-export";
import { normalizeTiktokId } from "@/lib/sales/parse-partner-sales";

/*
  TAP 取込へのクリエイター改名（別名）の適用。

  ■ 別名の解決そのものは共通実装を使う
  連鎖のたどり方・循環の打ち切りは lib/orders/creator-alias.ts が唯一の正。
  ここは「TAP の行の形に合わせて当てはめる」だけで、別の解決規則を作らない。
  規則を2つ持つと、affiliate 取込と TAP 取込で寄せ先が食い違う。

  ■ なぜ TAP にも必要か
  TAP の一意キーにもクリエイター名が入る。改名されると同じ明細でも
  キーが変わり、upsert が効かずに二重行になる。
  紹介者報酬は TAP を正データにするため、二重行はそのまま二重計上になる。
*/

export type TapAliasApplication = {
  rows: TapAffiliateOrderRow[];
  /** 別名で正式名へ寄せた行数 */
  aliasedRowCount: number;
  /** 実際に使われた 旧名 → 正式名 の組 */
  appliedAliases: Array<{ from: string; to: string; rowCount: number }>;
};

/**
 * 解析済みの TAP 行へ別名を適用する。
 * creatorTikTokId を正式名へ置き換え、一意キーを作り直す。
 */
export function applyCreatorAliasesToTapRows(
  rows: TapAffiliateOrderRow[],
  aliasMap: Map<string, string>,
): TapAliasApplication {
  if (aliasMap.size === 0) {
    return { rows, aliasedRowCount: 0, appliedAliases: [] };
  }

  const counts = new Map<string, { from: string; to: string; rowCount: number }>();
  let aliasedRowCount = 0;

  const next = rows.map((row) => {
    const original = normalizeTiktokId(row.creatorTikTokId ?? "");
    const canonical = resolveCanonicalTiktokId(original, aliasMap);

    if (!canonical || canonical === original) return row;

    aliasedRowCount += 1;

    const pairKey = `${original}→${canonical}`;
    const current = counts.get(pairKey) ?? { from: original, to: canonical, rowCount: 0 };
    current.rowCount += 1;
    counts.set(pairKey, current);

    return {
      ...row,
      creatorTikTokId: canonical,
      // 組み立てルールは変えず、渡す名前だけを正式名にする
      sourceRowKey: buildTapAffiliateOrderSourceRowKey({
        orderId: row.orderId,
        skuId: row.skuId,
        productId: row.productId,
        creatorTikTokId: canonical,
        contentId: row.contentId,
        invitationId: row.invitationId,
        commissionType: row.commissionType,
      }),
    };
  });

  return {
    rows: next,
    aliasedRowCount,
    appliedAliases: [...counts.values()].sort((a, b) => b.rowCount - a.rowCount),
  };
}

export type UnknownCreatorSummary = {
  tiktokId: string;
  rowCount: number;
  commissionBase: number;
  months: string[];
};

/**
 * creators に見つからないクリエイターをまとめる。
 *
 * TAP は紹介者報酬の正データなので、知らない名前が来ても
 * その場で creators を作らない。作ると、誰の紹介かも分からないまま
 * 報酬計算の対象クリエイターが増えてしまう。
 * 取込プレビューへ出して、人が紐付けてから取り込む。
 */
export function summarizeUnknownCreators(
  rows: TapAffiliateOrderRow[],
  knownTiktokIds: Set<string>,
): UnknownCreatorSummary[] {
  const map = new Map<string, UnknownCreatorSummary>();

  for (const row of rows) {
    const tiktokId = normalizeTiktokId(row.creatorTikTokId ?? "");
    if (!tiktokId || knownTiktokIds.has(tiktokId)) continue;

    const current = map.get(tiktokId) ?? {
      tiktokId,
      rowCount: 0,
      commissionBase: 0,
      months: [] as string[],
    };
    current.rowCount += 1;
    current.commissionBase += Number(row.commissionBase ?? 0);
    if (row.targetMonth && !current.months.includes(row.targetMonth)) {
      current.months.push(row.targetMonth);
    }
    map.set(tiktokId, current);
  }

  return [...map.values()]
    .map((item) => ({ ...item, months: item.months.sort() }))
    .sort((a, b) => b.commissionBase - a.commissionBase);
}
