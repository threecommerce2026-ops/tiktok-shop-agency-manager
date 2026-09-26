import { buildAffiliateOrderSourceRowKey } from "@/lib/orders/affiliate-order-source-key";
import { normalizeTiktokId } from "@/lib/sales/parse-partner-sales";
import type { AffiliateOrderImportRow } from "@/lib/orders/parse-affiliate-order-export";

/*
  クリエイターの改名（旧ユーザー名 → 正式ユーザー名）の解決。

  ■ なぜ必要か
  source_row_key は「クリエイターのユーザー名」を含む。
  TikTok 側で改名されると同じ注文明細でもキーが変わり、
  UPSERT が効かずに新規行として二重に入る。
  本番では kanyatoyselect_jp → kanyaselect_jp の改名で
  2026-07 の 153 明細が二重登録された。

  ■ 何を変えて、何を変えないか
    変える  : source_row_key を作る「前」に渡すユーザー名
    変えない: source_row_key の組み立てルールそのもの
              （buildAffiliateOrderSourceRowKey は無変更）
    変えない: 既存行の source_row_key
    変えない: 代理店報酬 / 紹介者報酬の計算式

  ■ プレビューと本取込で必ず同じ解決を使う
  ここは純粋な関数なので、ブラウザ側（プレビュー・送信前）と
  サーバー側（受信時の再検証）の両方から同じものを呼ぶ。
  サーバーは「すでに正式名へ寄せてあること」を確認し、
  寄っていない行は受け付けない。これにより両者がずれない。
*/

/** 別名の連鎖をたどる上限。これを超えたら循環とみなす */
const MAX_ALIAS_DEPTH = 10;

export type CreatorAliasRecord = {
  aliasTiktokId: string;
  canonicalTiktokId: string;
  note?: string | null;
  createdAt?: string | null;
  createdByEmail?: string | null;
};

/** DB 行（スネークケース）から共通形へ */
export function creatorAliasFromRow(
  row: Record<string, unknown>,
): CreatorAliasRecord {
  return {
    aliasTiktokId: String(row.alias_tiktok_id ?? ""),
    canonicalTiktokId: String(row.canonical_tiktok_id ?? ""),
    note: (row.note as string | null) ?? null,
    createdAt: (row.created_at as string | null) ?? null,
    createdByEmail: (row.created_by_email as string | null) ?? null,
  };
}

/**
 * 別名表を Map にする。
 * キー・値とも normalizeTiktokId 済みに揃える。
 */
export function buildCreatorAliasMap(
  records: Array<{ aliasTiktokId: string; canonicalTiktokId: string }>,
): Map<string, string> {
  const map = new Map<string, string>();

  for (const record of records) {
    const alias = normalizeTiktokId(record.aliasTiktokId);
    const canonical = normalizeTiktokId(record.canonicalTiktokId);

    if (!alias || !canonical || alias === canonical) continue;
    map.set(alias, canonical);
  }

  return map;
}

/**
 * 正式なユーザー名へ解決する。
 *
 * ・連鎖（A→B, B→C）は C まで辿る
 * ・循環（A→B, B→A）や深すぎる連鎖は「解決しない」で返す
 *   （誤って途中の名前に寄せるより、元のまま別明細にした方が安全）
 * ・別名が無ければ正規化しただけの値を返す
 */
export function resolveCanonicalTiktokId(
  tiktokId: string,
  aliasMap: Map<string, string>,
): string {
  const start = normalizeTiktokId(tiktokId);
  if (!start) return start;

  let current = start;
  const visited = new Set<string>([current]);

  for (let depth = 0; depth < MAX_ALIAS_DEPTH; depth += 1) {
    const next = aliasMap.get(current);
    if (!next) return current;

    // 循環していたら解決しない（元の名前を返す）
    if (visited.has(next)) return start;

    visited.add(next);
    current = next;
  }

  // 連鎖が長すぎる。壊れた設定とみなして解決しない
  return start;
}

export type AliasApplication = {
  rows: AffiliateOrderImportRow[];
  /** 別名で正式名へ寄せた行数 */
  aliasedRowCount: number;
  /** 実際に使われた 旧名 → 正式名 の組 */
  appliedAliases: Array<{ from: string; to: string; rowCount: number }>;
};

/**
 * 解析済みの行へ別名を適用する。
 *
 * creatorTiktokId を正式名へ置き換え、source_row_key を作り直す。
 * 元の Excel の値は row.raw（＝raw_row_json）にそのまま残るため、
 * どの名前で届いたかは後から追える。
 */
export function applyCreatorAliases(
  rows: AffiliateOrderImportRow[],
  aliasMap: Map<string, string>,
): AliasApplication {
  if (aliasMap.size === 0) {
    return { rows, aliasedRowCount: 0, appliedAliases: [] };
  }

  const counts = new Map<string, { from: string; to: string; rowCount: number }>();
  let aliasedRowCount = 0;

  const next = rows.map((row) => {
    const original = normalizeTiktokId(row.creatorTiktokId);
    const canonical = resolveCanonicalTiktokId(original, aliasMap);

    if (!canonical || canonical === original) return row;

    aliasedRowCount += 1;

    const pairKey = `${original}→${canonical}`;
    const current = counts.get(pairKey) ?? {
      from: original,
      to: canonical,
      rowCount: 0,
    };
    current.rowCount += 1;
    counts.set(pairKey, current);

    return {
      ...row,
      creatorTiktokId: canonical,
      // キーの組み立てルールは変えず、渡す名前だけを正式名にする
      sourceRowKey: buildAffiliateOrderSourceRowKey({
        orderId: row.orderId,
        skuId: row.skuId,
        productId: row.productId,
        creatorTiktokId: canonical,
        contentId: row.contentId,
        invitationId: row.invitationId,
        factorType: row.factorType,
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

// -----------------------------------------------------------------------------
// 登録時の検証
// -----------------------------------------------------------------------------

export type AliasValidation =
  | { ok: true; aliasTiktokId: string; canonicalTiktokId: string }
  | { ok: false; error: string };

/**
 * 別名の登録内容を検証する。
 *
 * 誤登録は「別人の注文を同一人物として統合する」ことに直結するため、
 * 機械的に防げるものはすべてここで弾く。
 */
export function validateCreatorAliasInput(
  input: { aliasTiktokId: string; canonicalTiktokId: string },
  existing: Array<{ aliasTiktokId: string; canonicalTiktokId: string }>,
): AliasValidation {
  const alias = normalizeTiktokId(input.aliasTiktokId);
  const canonical = normalizeTiktokId(input.canonicalTiktokId);

  if (!alias) return { ok: false, error: "旧ユーザー名を入力してください" };
  if (!canonical) return { ok: false, error: "正式なユーザー名を入力してください" };

  if (alias === canonical) {
    return { ok: false, error: "旧ユーザー名と正式なユーザー名が同じです" };
  }

  const map = buildCreatorAliasMap(existing);

  if (map.has(alias)) {
    return {
      ok: false,
      error: `「${alias}」は既に別名として登録されています（現在の寄せ先: ${map.get(alias)}）`,
    };
  }

  /*
    正式名の側が既に別名として登録されていてもよい（連鎖は解決できる）。
    ただし新しい別名を足したときに循環が生まれる場合は拒否する。
    例) 既存 B→A のときに A→B を足すと、どちらも解決できなくなる。
  */
  const candidate = new Map(map);
  candidate.set(alias, canonical);

  if (resolveCanonicalTiktokId(alias, candidate) === alias) {
    return {
      ok: false,
      error: "別名が循環します（A→B と B→A のような設定はできません）",
    };
  }

  return { ok: true, aliasTiktokId: alias, canonicalTiktokId: canonical };
}

/** 連鎖している別名（正式名側がさらに別名になっているもの）を洗い出す */
export function findChainedAliases(
  records: Array<{ aliasTiktokId: string; canonicalTiktokId: string }>,
): Array<{ alias: string; via: string; canonical: string }> {
  const map = buildCreatorAliasMap(records);
  const chained: Array<{ alias: string; via: string; canonical: string }> = [];

  for (const [alias, via] of map) {
    const canonical = resolveCanonicalTiktokId(alias, map);
    if (canonical !== via) chained.push({ alias, via, canonical });
  }

  return chained;
}
