import type { TikTokOrderApiRecord, TikTokOrderApiResponse } from "@/lib/tiktok/order-types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toOrderRecord(value: unknown): TikTokOrderApiRecord | null {
  if (!isRecord(value)) return null;

  const orderId = String(value.order_id ?? value.orderId ?? "").trim();
  const creatorTiktokId = String(
    value.creator_tiktok_id ?? value.creatorTiktokId ?? value.tiktok_id ?? "",
  ).trim();

  if (!orderId || !creatorTiktokId) return null;

  return {
    order_id: orderId,
    product_name: (value.product_name as string | null | undefined) ?? null,
    product_id: (value.product_id as string | null | undefined) ?? null,
    sku: (value.sku as string | null | undefined) ?? null,
    order_amount: (value.order_amount as number | string | null | undefined) ?? null,
    commission_base: (value.commission_base as number | string | null | undefined) ?? null,
    commission_amount:
      (value.commission_amount as number | string | null | undefined) ?? null,
    payment_status: (value.payment_status as string | null | undefined) ?? null,
    order_status: (value.order_status as string | null | undefined) ?? null,
    shipping_status: (value.shipping_status as string | null | undefined) ?? null,
    cancellation_status:
      (value.cancellation_status as string | null | undefined) ??
      (value.cancel_status as string | null | undefined) ??
      null,
    return_status:
      (value.return_status as string | null | undefined) ??
      (value.refund_status as string | null | undefined) ??
      null,
    creator_tiktok_id: creatorTiktokId,
    creator_name: (value.creator_name as string | null | undefined) ?? null,
    ordered_at: (value.ordered_at as string | null | undefined) ?? null,
    paid_at: (value.paid_at as string | null | undefined) ?? null,
  };
}

function collectOrderCandidates(value: unknown, bucket: unknown[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      bucket.push(item);
    }
    return;
  }

  if (!isRecord(value)) return;

  const nestedKeys = [
    "orders",
    "order_list",
    "orderList",
    "data",
    "items",
    "records",
    "list",
  ];

  for (const key of nestedKeys) {
    if (key in value) {
      collectOrderCandidates(value[key], bucket);
    }
  }
}

export function parseTikTokOrderApiPayloadFromJson(parsed: unknown): {
  records: TikTokOrderApiRecord[];
  error: string | null;
} {
  const candidates: unknown[] = [];
  if (Array.isArray(parsed)) {
    candidates.push(...parsed);
  } else if (isRecord(parsed)) {
    collectOrderCandidates(parsed, candidates);
    if (candidates.length === 0) {
      candidates.push(parsed);
    }
  } else {
    return { records: [], error: "注文データを含む JSON ではありません" };
  }

  const records: TikTokOrderApiRecord[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const record = toOrderRecord(candidate);
    if (!record) continue;
    if (seen.has(record.order_id)) continue;
    seen.add(record.order_id);
    records.push(record);
  }

  if (records.length === 0) {
    return {
      records: [],
      error:
        "注文レコードを抽出できませんでした。order_id と creator_tiktok_id を含むレスポンスを確認してください。",
    };
  }

  return { records, error: null };
}

export function parseTikTokOrderApiPayload(rawJson: string): {
  records: TikTokOrderApiRecord[];
  error: string | null;
} {
  const trimmed = rawJson.trim();
  if (!trimmed) {
    return { records: [], error: "JSON を入力してください" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { records: [], error: "JSON の形式が正しくありません" };
  }

  return parseTikTokOrderApiPayloadFromJson(parsed);
}

export function parseTikTokOrderApiResponse(rawJson: string): TikTokOrderApiResponse {
  const { records } = parseTikTokOrderApiPayload(rawJson);
  return { orders: records };
}
