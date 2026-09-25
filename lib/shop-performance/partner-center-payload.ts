import { isTikTokShopIdFormat } from "@/lib/sellers/shop-id-candidates";
import { normalizeShopName } from "@/lib/shop-performance/normalize";

/*
  Partner Center JSON の検証。

  この endpoint は「Shop ID 付きショップ情報の供給元」であって、
  sellers.shop_id を書き換える場所ではない。
  最終的な Shop ID の設定は /admin/sellers の紐付けパネルへ一本化する。

  Shop ID の形式判定は lib/sellers/shop-id-candidates.ts の
  isTikTokShopIdFormat() だけを使う（別実装を作らない）。
*/

export type PartnerShopInput = {
  shop_id?: unknown;
  shop_name?: unknown;
  revenue?: unknown;
  orders?: unknown;
  buyers?: unknown;
  product_viewers?: unknown;
  product_clicks?: unknown;
  shop_ranking?: unknown;
  revenue_percentage?: unknown;
  cmp_revenue?: unknown;
};

export type PartnerShopIssueKind =
  | "invalid_shop_id"
  | "missing_shop_name"
  | "duplicate_shop_id"
  /** 同じショップ名に別の Shop ID が付いている（どちらが正か判断できない） */
  | "conflicting_shop_name";

export const PARTNER_SHOP_ISSUE_LABEL: Record<PartnerShopIssueKind, string> = {
  invalid_shop_id: "Shop ID が不正",
  missing_shop_name: "ショップ名が空",
  duplicate_shop_id: "Shop ID が重複",
  conflicting_shop_name: "同名ショップに別の Shop ID",
};

export type PartnerShopIssue = {
  /** 1始まり。管理者が原因の行を特定できるようにする */
  index: number;
  kind: PartnerShopIssueKind;
  shopId: string;
  shopName: string;
  message: string;
};

export type PartnerShopValidRow = {
  index: number;
  shopId: string;
  shopName: string;
  shopNameNormalized: string;
  revenue: number;
  shopRanking: number | null;
  revenuePercentage: number | null;
  raw: PartnerShopInput;
};

export type PartnerCenterValidation = {
  rows: PartnerShopValidRow[];
  issues: PartnerShopIssue[];
  counts: {
    total: number;
    valid: number;
    invalidShopId: number;
    missingShopName: number;
    duplicateShopId: number;
    conflictingShopName: number;
  };
};

export function toPartnerRevenue(value: unknown): number {
  if (value == null || value === "") return 0;

  // Partner Center は { amount: "1,234" } のネスト形でも来る
  if (typeof value === "object") {
    const amount = (value as { amount?: unknown }).amount;
    return toPartnerRevenue(amount);
  }

  const parsed = Number(
    typeof value === "string"
      ? value.replace(/,/g, "").replace(/円/g, "").trim()
      : value,
  );
  return Number.isFinite(parsed) ? parsed : 0;
}

function toNullableInteger(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function toNullableNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(
    typeof value === "string" ? value.replace(/[,%]/g, "").trim() : value,
  );
  return Number.isFinite(parsed) ? parsed : null;
}

export function isValidTargetMonth(value: unknown): boolean {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}$/.test(text)) return false;
  const month = Number(text.slice(5, 7));
  return month >= 1 && month <= 12;
}

/** 対象月 → 月初 */
export function defaultPeriodStart(targetMonth: string): string {
  return `${targetMonth}-01`;
}

/** 対象月 → 月末（うるう年も正しく扱う） */
export function defaultPeriodEnd(targetMonth: string): string {
  const year = Number(targetMonth.slice(0, 4));
  const month = Number(targetMonth.slice(5, 7));
  const last = new Date(Date.UTC(year, month, 0));
  return last.toISOString().slice(0, 10);
}

/**
 * 貼り付けられたショップ配列を検証する。
 * プレビューと保存で同じ関数を使い、判定がずれないようにする。
 */
export function validatePartnerCenterShops(
  shops: PartnerShopInput[],
): PartnerCenterValidation {
  const rows: PartnerShopValidRow[] = [];
  const issues: PartnerShopIssue[] = [];

  /* 重複判定のため、先に正常な shop_id を数える */
  const seen = new Map<string, number>();
  for (const shop of shops) {
    const id = String(shop?.shop_id ?? "").trim();
    if (!isTikTokShopIdFormat(id)) continue;
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }

  /*
    同じショップ名に別の Shop ID が付いているケースを検出する。
    どちらが正しいか機械的に決められないので、自動で正常扱いにしない。
  */
  const shopIdsByName = new Map<string, Set<string>>();
  for (const shop of shops) {
    const id = String(shop?.shop_id ?? "").trim();
    const nameKey = normalizeShopName(String(shop?.shop_name ?? ""));
    if (!isTikTokShopIdFormat(id) || !nameKey) continue;
    const set = shopIdsByName.get(nameKey) ?? new Set<string>();
    set.add(id);
    shopIdsByName.set(nameKey, set);
  }

  for (let i = 0; i < shops.length; i++) {
    const shop = shops[i] ?? {};
    const index = i + 1;
    const shopId = String(shop.shop_id ?? "").trim();
    const shopName = String(shop.shop_name ?? "").trim();

    if (!isTikTokShopIdFormat(shopId)) {
      issues.push({
        index,
        kind: "invalid_shop_id",
        shopId,
        shopName,
        message: `${index}件目の shop_id が不正です（${shopId || "空"}）。Shop ID は数値のみです`,
      });
      continue;
    }

    if (!shopName) {
      issues.push({
        index,
        kind: "missing_shop_name",
        shopId,
        shopName,
        message: `${index}件目の shop_name が空です（shop_id: ${shopId}）`,
      });
      continue;
    }

    if ((seen.get(shopId) ?? 0) > 1) {
      issues.push({
        index,
        kind: "duplicate_shop_id",
        shopId,
        shopName,
        message: `${index}件目の shop_id が重複しています（${shopId}）`,
      });
      // 重複は片方だけ残す、という自動判断をしない。すべて不正として扱う
      continue;
    }

    const nameKey = normalizeShopName(shopName);
    if ((shopIdsByName.get(nameKey)?.size ?? 0) > 1) {
      issues.push({
        index,
        kind: "conflicting_shop_name",
        shopId,
        shopName,
        message: `${index}件目「${shopName}」に複数の shop_id が存在します（${[...(shopIdsByName.get(nameKey) ?? [])].join(", ")}）`,
      });
      continue;
    }

    rows.push({
      index,
      shopId,
      shopName,
      shopNameNormalized: normalizeShopName(shopName),
      revenue: toPartnerRevenue(shop.revenue),
      shopRanking: toNullableInteger(shop.shop_ranking),
      revenuePercentage: toNullableNumber(shop.revenue_percentage),
      raw: shop,
    });
  }

  return {
    rows,
    issues,
    counts: {
      total: shops.length,
      valid: rows.length,
      invalidShopId: issues.filter((i) => i.kind === "invalid_shop_id").length,
      missingShopName: issues.filter((i) => i.kind === "missing_shop_name").length,
      duplicateShopId: issues.filter((i) => i.kind === "duplicate_shop_id").length,
      conflictingShopName: issues.filter((i) => i.kind === "conflicting_shop_name")
        .length,
    },
  };
}

/** 貼り付けJSONから shops 配列を取り出す（配列そのもの / { shops: [...] } の両方） */
export function extractPartnerShops(parsed: unknown): PartnerShopInput[] | null {
  if (Array.isArray(parsed)) return parsed as PartnerShopInput[];
  if (parsed && typeof parsed === "object") {
    const shops = (parsed as { shops?: unknown }).shops;
    if (Array.isArray(shops)) return shops as PartnerShopInput[];
  }
  return null;
}

/** 貼り付けJSONに対象月が含まれていればそれを優先する */
export function extractTargetMonth(parsed: unknown): string | null {
  if (!parsed || typeof parsed === "object" === false) return null;
  const month = (parsed as { target_month?: unknown }).target_month;
  return isValidTargetMonth(month) ? String(month).trim() : null;
}

/** 貼り付けJSONに期間が含まれていればそれを優先する */
export function extractPeriod(
  parsed: unknown,
): { periodStart: string | null; periodEnd: string | null } {
  const isDate = (v: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? "").trim());
  if (!parsed || typeof parsed !== "object") {
    return { periodStart: null, periodEnd: null };
  }
  const obj = parsed as { period_start?: unknown; period_end?: unknown };
  return {
    periodStart: isDate(obj.period_start) ? String(obj.period_start).trim() : null,
    periodEnd: isDate(obj.period_end) ? String(obj.period_end).trim() : null,
  };
}

/* ---------------------------------------------------------------------------
   Partner Center「ショップ分析」の実レスポンス対応

   管理者が Network タブからコピーした Response JSON をそのまま貼り付ける。

   ■ 非公開エンドポイントをサーバーから叩かない
   /api/v2/insights/partner/shop/list はブラウザセッション
   （Cookie / sessionid / msToken / X-Bogus / _signature 等）に依存する。
   これらをコード・DB・環境変数へ保存したり再利用したりしない。
   このシステムが受け取るのは「レスポンス本文だけ」。

   ■ 受け付ける形
     1) 実レスポンス全体      { code, message, data: { time_descriptor, list_control, stats } }
     2) data 部分だけ          { time_descriptor, list_control, stats }
     3) 旧来の簡易形           { target_month, shops: [...] } / [...]
--------------------------------------------------------------------------- */

/** Partner Center が返した件数と、実際に含まれていた件数の整合性 */
export type PartnerCenterCompleteness = {
  /** data.list_control.next_pagination.total */
  expectedTotal: number | null;
  /** data.stats.length */
  actualCount: number;
  /** data.list_control.next_pagination.has_more */
  hasMore: boolean;
  /** 全ショップが揃っているか */
  isComplete: boolean;
  /** 揃っていない理由 */
  reason: string | null;
};

export type PartnerCenterEnvelope = {
  /** レスポンスの code（0 が成功） */
  code: number | null;
  message: string | null;
  shops: PartnerShopInput[];
  targetMonth: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  completeness: PartnerCenterCompleteness;
  /** 実レスポンス形式（time_descriptor / stats）として読めたか */
  isRealResponse: boolean;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** "2026-08-01T00:00:00" → "2026-08-01" */
function toDateOnly(value: unknown): string | null {
  const text = String(value ?? "").trim();
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  return m ? m[1] : null;
}

/** 前日を返す（end が翌月1日の排他境界で来るため） */
function previousDay(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * time_descriptor から対象月と期間を決める。
 *
 * start = 2026-08-01T00:00:00 / end = 2026-09-01T00:00:00
 *   → target_month 2026-08 / 期間 2026-08-01 〜 2026-08-31
 *
 * end は「翌月1日」の排他境界で来るため、1日戻して期間末にする。
 * ただし end が start と同月内なら、そのまま期間末として扱う。
 */
export function resolveTimeDescriptor(timeDescriptor: unknown): {
  targetMonth: string | null;
  periodStart: string | null;
  periodEnd: string | null;
} {
  const td = asObject(timeDescriptor);
  if (!td) return { targetMonth: null, periodStart: null, periodEnd: null };

  const start = toDateOnly(td.start);
  const rawEnd = toDateOnly(td.end);
  if (!start) return { targetMonth: null, periodStart: null, periodEnd: null };

  const targetMonth = start.slice(0, 7);
  if (!isValidTargetMonth(targetMonth)) {
    return { targetMonth: null, periodStart: null, periodEnd: null };
  }

  let periodEnd: string;
  if (!rawEnd) {
    periodEnd = defaultPeriodEnd(targetMonth);
  } else if (rawEnd.slice(0, 7) === targetMonth) {
    periodEnd = rawEnd;
  } else {
    // 翌月1日など、対象月の外を指している → 排他境界とみなして1日戻す
    const shifted = previousDay(rawEnd);
    periodEnd =
      shifted.slice(0, 7) === targetMonth ? shifted : defaultPeriodEnd(targetMonth);
  }

  return { targetMonth, periodStart: start, periodEnd };
}

/** next_pagination から完全性を判定する */
export function resolveCompleteness(
  listControl: unknown,
  actualCount: number,
): PartnerCenterCompleteness {
  const lc = asObject(listControl);
  const pagination = asObject(lc?.next_pagination);

  const rawTotal = pagination?.total;
  const expectedTotal =
    rawTotal == null || rawTotal === "" || !Number.isFinite(Number(rawTotal))
      ? null
      : Math.trunc(Number(rawTotal));

  const hasMore = pagination?.has_more === true;

  let reason: string | null = null;
  if (hasMore) {
    reason =
      "has_more = true です。次ページが残っているため、全ショップが含まれていません";
  } else if (expectedTotal != null && actualCount < expectedTotal) {
    reason = `Partner Center の報告件数 ${expectedTotal} 件に対し、JSON に含まれるのは ${actualCount} 件です`;
  }

  return {
    expectedTotal,
    actualCount,
    hasMore,
    isComplete: reason == null,
    reason,
  };
}

/**
 * 貼り付けJSONを解釈する。実レスポンス形式と旧来の簡易形の両方を受ける。
 * 解釈できない場合は null。
 */
export function parsePartnerCenterResponse(
  parsed: unknown,
): PartnerCenterEnvelope | null {
  const root = asObject(parsed);

  // data を持つ実レスポンス、または data 部分だけを貼った場合
  const data = asObject(root?.data) ?? root;
  const stats = data ? data.stats : null;

  if (Array.isArray(stats)) {
    const shops = stats as PartnerShopInput[];
    const time = resolveTimeDescriptor(data?.time_descriptor);
    const rawCode = root?.code;

    return {
      code:
        rawCode == null || !Number.isFinite(Number(rawCode))
          ? null
          : Number(rawCode),
      message: root?.message == null ? null : String(root.message),
      shops,
      targetMonth: time.targetMonth,
      periodStart: time.periodStart,
      periodEnd: time.periodEnd,
      completeness: resolveCompleteness(data?.list_control, shops.length),
      isRealResponse: true,
    };
  }

  // 旧来の簡易形（配列そのもの / { shops: [...] }）
  const shops = extractPartnerShops(parsed);
  if (!shops) return null;

  const period = extractPeriod(parsed);
  return {
    code: null,
    message: null,
    shops,
    targetMonth: extractTargetMonth(parsed),
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    // 件数情報が無い形式なので完全性は判定できない。不完全とはみなさない
    completeness: resolveCompleteness(null, shops.length),
    isRealResponse: false,
  };
}

/** レスポンスの code が成功以外なら、その旨を返す */
export function partnerResponseError(
  envelope: PartnerCenterEnvelope,
): string | null {
  if (envelope.code == null || envelope.code === 0) return null;
  return `Partner Center がエラーを返しています（code: ${envelope.code}${
    envelope.message ? ` / ${envelope.message}` : ""
  }）`;
}
