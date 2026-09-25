import { buildAffiliateOrderSourceRowKey } from "@/lib/orders/affiliate-order-source-key";
import type { AffiliateOrderImportRow } from "@/lib/orders/parse-affiliate-order-export";

/*
  Excel取込のやり取り形式（ブラウザ ⇄ サーバー共通）。

  ■ Excelファイル自体をサーバーへ送らない
  Vercel Functions のリクエストボディ上限は 4.5MB（実測で 5MB は 413）、
  Next.js の Server Action 既定上限は 1MB。
  Partner Center のエクスポートは 4〜5MB あるため、ファイルを直接POSTすると
  Production では必ず失敗する。
  そこでブラウザ側で解析し、小さなJSONチャンクに分けて送る。

  ■ ブラウザの値を信用しない
  サーバー側で source_row_key を同じ関数から再生成して一致を確認し、
  必須項目・数値・日付・対象月も再検証する。

  ■ 同一ファイル内の重複
  Postgres の INSERT ... ON CONFLICT は、1文の中に同じキーが2回現れると
  21000 (cardinality_violation) で失敗する。
  送信前に source_row_key で重複排除しておくことで構造的に防ぐ。
*/

// -----------------------------------------------------------------------------
// チャンクサイズ
// -----------------------------------------------------------------------------

/*
  1リクエストのJSONバイト数の上限。

  Next.js の Server Action 既定上限 1MB に対して十分な余裕を取る。
  next.config.ts の bodySizeLimit には依存しない（設定変更なしで成立させる）。
  実測: raw_row_json 平均 1,099 bytes / 1行あたり約 1.5KB → 1チャンク約 260行。
*/
export const MAX_CHUNK_PAYLOAD_BYTES = 400_000;

/** バイト数が小さくても1リクエストの行数はここで頭打ちにする */
export const MAX_CHUNK_ROWS = 300;

/*
  照合（プレビュー）は「既存行のダイジェストをページ単位で取り寄せる」方式にした。

  ■ なぜチャンク送信をやめたか
  以前は source_row_key を大量にサーバーへ送り、サーバーが
    .in("source_row_key", [2,000キー])
  で問い合わせていた。supabase-js の select は GET なので、
  キーがそのまま URL のクエリ文字列に載る。
  本番の実キーは | 区切り + 日本語を含み URL エンコードで約256バイトに膨らむため、
  2,000キーで URL が 487.6KB に達し Cloudflare が 414 を返した（実測）。
  16KB に収まるのは 63キーまでで、この経路はそもそも実用にならない。

  ■ 現在の方式
  URL に載せるのは「対象月」だけ。既存行のキーと指紋をページングで取得し、
  突き合わせはブラウザ側のメモリで行う。
  URL 長はファイルの大きさに一切依存しない。
*/
export const COMPARE_DIGEST_PAGE_SIZE = 2_000;

/** 1回の照合で指定できる対象月の上限（URLを短く保つ） */
export const MAX_COMPARE_MONTHS = 60;

// -----------------------------------------------------------------------------
// 送信する行の形
// -----------------------------------------------------------------------------

/**
 * 送信するのは解析済みの行そのもの。
 * raw_row_json を既存仕様どおり保存するため raw も含める。
 */
export type AffiliateOrderPayloadRow = AffiliateOrderImportRow;

function textValue(value: unknown): string {
  return String(value ?? "").trim();
}

function nullableTextValue(value: unknown): string | null {
  const v = textValue(value);
  return v || null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isIsoLike(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "string") return false;
  return !Number.isNaN(new Date(value).getTime());
}

// -----------------------------------------------------------------------------
// 同一ファイル内の重複排除
// -----------------------------------------------------------------------------

export type DedupeResult<T> = {
  rows: T[];
  /** 取り除いた行数（＝後勝ちで上書きされた行） */
  duplicateCount: number;
  /** 重複していたキー（表示用に先頭のみ持つ） */
  duplicateKeys: string[];
};

/**
 * source_row_key で重複を排除する。
 *
 * 方針は「最後の行を採用」。
 * Partner Center のエクスポートは後の行ほど新しい状態であることが多く、
 * DB側の UPSERT（後勝ち）とも挙動が揃う。
 */
export function dedupeAffiliateOrderRows<T extends { sourceRowKey: string }>(
  rows: T[],
  options: { sampleLimit?: number } = {},
): DedupeResult<T> {
  const sampleLimit = options.sampleLimit ?? 20;

  const byKey = new Map<string, T>();
  const duplicateKeys: string[] = [];
  let duplicateCount = 0;

  for (const row of rows) {
    if (byKey.has(row.sourceRowKey)) {
      duplicateCount += 1;
      if (duplicateKeys.length < sampleLimit) {
        duplicateKeys.push(row.sourceRowKey);
      }
    }
    // 後勝ち
    byKey.set(row.sourceRowKey, row);
  }

  return { rows: [...byKey.values()], duplicateCount, duplicateKeys };
}

// -----------------------------------------------------------------------------
// バイト数を見ながらのチャンク分割
// -----------------------------------------------------------------------------

const encoder = new TextEncoder();

export function jsonByteLength(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

export type ChunkResult<T> = {
  chunks: T[][];
  /** 1行だけで上限を超えた行の行番号（単独チャンクとして送る） */
  oversizedRowNumbers: number[];
  /** 実際に作られたチャンクの最大バイト数 */
  maxChunkBytes: number;
};

/**
 * 固定件数ではなくJSONバイト数でチャンクを切る。
 * 1行が極端に大きくても上限を超えたまま束ねない。
 */
export function buildPayloadChunks<T>(
  rows: T[],
  options: { maxBytes?: number; maxRows?: number } = {},
): ChunkResult<T> {
  const maxBytes = options.maxBytes ?? MAX_CHUNK_PAYLOAD_BYTES;
  const maxRows = options.maxRows ?? MAX_CHUNK_ROWS;

  const chunks: T[][] = [];
  const oversizedRowNumbers: number[] = [];

  let current: T[] = [];
  // 配列としての JSON オーバーヘッド（角括弧と区切りのカンマ）
  let currentBytes = 2;
  let maxChunkBytes = 0;

  const flush = () => {
    if (current.length === 0) return;
    maxChunkBytes = Math.max(maxChunkBytes, currentBytes);
    chunks.push(current);
    current = [];
    currentBytes = 2;
  };

  for (const row of rows) {
    const rowBytes = jsonByteLength(row) + 1;

    if (rowBytes + 2 > maxBytes) {
      // 1行だけで上限超え。単独チャンクにして必ず送れる形にする
      flush();
      maxChunkBytes = Math.max(maxChunkBytes, rowBytes + 2);
      chunks.push([row]);
      const rowNumber = (row as { rowNumber?: unknown }).rowNumber;
      if (typeof rowNumber === "number") {
        oversizedRowNumbers.push(rowNumber);
      }
      continue;
    }

    if (current.length >= maxRows || currentBytes + rowBytes > maxBytes) {
      flush();
    }

    current.push(row);
    currentBytes += rowBytes;
  }

  flush();

  return { chunks, oversizedRowNumbers, maxChunkBytes };
}

// -----------------------------------------------------------------------------
// 指紋（新規 / 更新あり / 変更なし の判定用）
// -----------------------------------------------------------------------------

/**
 * 金額の正規化。
 * DB の numeric は "1502238.00" のような文字列で返るため、
 * クライアントの number と同じ表現へ揃えてから比較する。
 */
function amountKey(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "";
  return String(Math.round(parsed * 100) / 100);
}

/** FNV-1a 32bit。環境非依存で同じ値になる */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * 更新判定に使う「中身」の指紋。
 *
 * 対象は UPSERT が実際に書き換える業務フィールドだけ。
 * created_at / import_batch_id / updated_at のような取込メタは含めない
 * （毎回変わるため、含めると常に「更新あり」になってしまう）。
 */
export function affiliateOrderFingerprint(fields: {
  targetMonth: string | null;
  paymentStatus: string | null;
  orderStatus: string | null;
  refundStatus: string | null;
  refundAmount: unknown;
  productPrice: unknown;
  quantity: unknown;
  commissionGmv: unknown;
  commissionBase: unknown;
  creatorRevenueBeforeSplit: unknown;
  agencySplitRate: unknown;
  agencyRevenue: unknown;
}): string {
  return fnv1a(
    [
      textValue(fields.targetMonth),
      textValue(fields.paymentStatus),
      textValue(fields.orderStatus),
      textValue(fields.refundStatus),
      amountKey(fields.refundAmount),
      amountKey(fields.productPrice),
      amountKey(fields.quantity),
      amountKey(fields.commissionGmv),
      amountKey(fields.commissionBase),
      amountKey(fields.creatorRevenueBeforeSplit),
      amountKey(fields.agencySplitRate),
      amountKey(fields.agencyRevenue),
      /*
        区切りなしで連結すると隣り合う値の境目が曖昧になり、
        別の内容が同じ指紋になりうる。データに現れない制御文字で区切る。
      */
    ].join("\u001f"),
  );
}

/** 解析済み行（ブラウザ側）から指紋を作る */
export function fingerprintFromPayloadRow(row: AffiliateOrderPayloadRow): string {
  return affiliateOrderFingerprint({
    targetMonth: row.targetMonth,
    // DB の payment_status には payoutStatus（支払い状況）が入る既存仕様
    paymentStatus: row.payoutStatus,
    // DB の order_status には paymentStatus（注文の決済状況）が入る既存仕様
    orderStatus: row.paymentStatus,
    refundStatus: row.isFullyRefunded ? "fully_refunded" : null,
    refundAmount: row.isFullyRefunded ? row.productPrice * row.quantity : 0,
    productPrice: row.productPrice,
    quantity: row.quantity,
    commissionGmv: row.commissionGmv,
    commissionBase: row.commissionBase,
    creatorRevenueBeforeSplit: row.creatorRevenueBeforeSplit,
    agencySplitRate: row.agencySplitRate,
    agencyRevenue: row.agencyRevenue,
  });
}

/** DB 行（サーバー側）から指紋を作る */
export function fingerprintFromDbRow(row: Record<string, unknown>): string {
  return affiliateOrderFingerprint({
    targetMonth: (row.target_month as string | null) ?? null,
    paymentStatus: (row.payment_status as string | null) ?? null,
    orderStatus: (row.order_status as string | null) ?? null,
    refundStatus: (row.refund_status as string | null) ?? null,
    refundAmount: row.refund_amount,
    productPrice: row.product_price,
    quantity: row.quantity,
    commissionGmv: row.commission_gmv,
    commissionBase: row.commission_base,
    creatorRevenueBeforeSplit: row.creator_revenue_before_split,
    agencySplitRate: row.agency_split_rate,
    agencyRevenue: row.agency_revenue,
  });
}

/** 指紋の突き合わせに必要な DB 列 */
export const FINGERPRINT_DB_COLUMNS =
  "source_row_key, target_month, payment_status, order_status, refund_status, refund_amount, product_price, quantity, commission_gmv, commission_base, creator_revenue_before_split, agency_split_rate, agency_revenue";

/**
 * 既存行のダイジェスト1件。
 * 金額そのものは載せず、キーと指紋だけを返す。
 */
export type CompareDigestRow = {
  /** source_row_key */
  k: string;
  /** fingerprint */
  f: string;
};

export function toDigestRow(row: {
  source_row_key?: unknown;
  [key: string]: unknown;
}): CompareDigestRow {
  return {
    k: String(row.source_row_key ?? ""),
    f: fingerprintFromDbRow(row),
  };
}

/**
 * 取込対象の行を、既存行のダイジェストと突き合わせる。
 *
 * 新規     … ダイジェストにキーが無い
 * 更新あり … キーがあり指紋が違う
 * 変更なし … キーがあり指紋も同じ
 *
 * 純粋な関数なのでブラウザ側で実行でき、
 * source_row_key をサーバーへ送る必要がない。
 */
export function compareAgainstDigest(
  rows: AffiliateOrderPayloadRow[],
  digest: Map<string, string>,
): { newRows: number; changedRows: number; unchangedRows: number } {
  let newRows = 0;
  let changedRows = 0;
  let unchangedRows = 0;

  for (const row of rows) {
    const existing = digest.get(row.sourceRowKey);
    if (existing === undefined) newRows += 1;
    else if (existing === fingerprintFromPayloadRow(row)) unchangedRows += 1;
    else changedRows += 1;
  }

  return { newRows, changedRows, unchangedRows };
}

/**
 * 照合に必要な対象月の一覧。
 * 対象月が取れなかった行がある場合は null 月も取り寄せる。
 */
export function resolveCompareMonths(rows: AffiliateOrderPayloadRow[]): {
  months: string[];
  includeNullMonth: boolean;
} {
  const months = new Set<string>();
  let includeNullMonth = false;

  for (const row of rows) {
    if (row.targetMonth) months.add(row.targetMonth);
    else includeNullMonth = true;
  }

  return { months: [...months].sort(), includeNullMonth };
}

// -----------------------------------------------------------------------------
// サーバー側の再検証
// -----------------------------------------------------------------------------

export type PayloadRowValidation =
  | { ok: true; row: AffiliateOrderPayloadRow }
  | { ok: false; rowNumber: number; error: string };

const MONTH_PATTERN = /^\d{4}-\d{2}$/;

const NULLABLE_STRING_FIELDS = [
  "skuId",
  "productId",
  "productName",
  "contentId",
  "invitationId",
  "factorType",
  "commissionType",
  "shopName",
  "shopCode",
  "paymentStatus",
  "payoutStatus",
  "contentType",
  "paymentId",
  "creatorTagId",
  "currency",
  "orderType",
] as const;

const REQUIRED_NUMBER_FIELDS = [
  "productPrice",
  "quantity",
  "commissionGmv",
  "commissionBase",
  "creatorRevenueBeforeSplit",
  "agencyRevenueBeforeTax",
  "agencyRevenue",
] as const;

const NULLABLE_NUMBER_FIELDS = [
  "agencySplitRate",
  "standardCommissionRate",
  "shopAdsCommissionRate",
  "tiktokBonusCommissionRate",
  "partnerBonusCommissionRate",
] as const;

/**
 * ブラウザから届いた1行を検証する。
 *
 * ブラウザ側の検証結果は一切信用せず、ここで作り直して確かめる。
 * とくに source_row_key は送られてきた値を使わず、
 * 行の識別子から同じ関数で再生成して一致を確認する。
 */
export function validateAffiliateOrderPayloadRow(
  value: unknown,
): PayloadRowValidation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, rowNumber: 0, error: "行の形式が不正です" };
  }

  const row = value as Record<string, unknown>;
  const rowNumber =
    typeof row.rowNumber === "number" && Number.isFinite(row.rowNumber)
      ? row.rowNumber
      : 0;

  const fail = (error: string): PayloadRowValidation => ({
    ok: false,
    rowNumber,
    error,
  });

  // ---- 必須項目（既存の取込条件を維持）----
  const orderId = textValue(row.orderId);
  if (!orderId) return fail("注文IDがありません");

  const creatorTiktokId = textValue(row.creatorTiktokId);
  if (!creatorTiktokId) return fail("クリエイターのユーザー名がありません");

  // ---- 型 ----
  for (const key of NULLABLE_STRING_FIELDS) {
    if (!isNullableString(row[key])) return fail(`${key} の型が不正です`);
  }

  if (typeof row.isFullyRefunded !== "boolean") {
    return fail("返金フラグの型が不正です");
  }

  for (const key of REQUIRED_NUMBER_FIELDS) {
    if (!isFiniteNumber(row[key])) return fail(`${key} が数値ではありません`);
  }

  for (const key of NULLABLE_NUMBER_FIELDS) {
    if (!isNullableFiniteNumber(row[key])) {
      return fail(`${key} が数値ではありません`);
    }
  }

  const quantity = row.quantity as number;
  if (quantity < 0 || !Number.isInteger(quantity)) {
    return fail("数量が不正です");
  }

  // ---- 日付 ----
  if (!isIsoLike(row.orderedAt)) return fail("作成日時が不正です");
  if (!isIsoLike(row.deliveredAt)) return fail("注文配達日時が不正です");

  // ---- 対象月 ----
  const targetMonth = row.targetMonth;
  if (
    targetMonth !== null &&
    (typeof targetMonth !== "string" || !MONTH_PATTERN.test(targetMonth))
  ) {
    return fail("対象月が YYYY-MM 形式ではありません");
  }

  // ---- raw ----
  if (typeof row.raw !== "object" || row.raw === null || Array.isArray(row.raw)) {
    return fail("元データ（raw）の形式が不正です");
  }

  // ---- source_row_key の再生成と一致確認（改ざん検出）----
  const expectedKey = buildAffiliateOrderSourceRowKey({
    orderId,
    skuId: nullableTextValue(row.skuId),
    productId: nullableTextValue(row.productId),
    creatorTiktokId,
    contentId: nullableTextValue(row.contentId),
    invitationId: nullableTextValue(row.invitationId),
    factorType: nullableTextValue(row.factorType),
    commissionType: nullableTextValue(row.commissionType),
  });

  if (textValue(row.sourceRowKey) !== expectedKey) {
    return fail("明細キーが一致しません（送信データが改ざんされた可能性）");
  }

  return {
    ok: true,
    row: { ...(row as AffiliateOrderPayloadRow), sourceRowKey: expectedKey },
  };
}
