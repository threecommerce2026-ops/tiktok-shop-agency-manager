import type { TikTokApiConnectionRow } from "@/lib/db/tiktok-api-connection-queries";
import { createTikTokShopSign } from "@/lib/tiktok/oauth";
import { parseTikTokOrderApiPayloadFromJson } from "@/lib/tiktok/parse-order-api-payload";
import type { TikTokOrderApiRecord } from "@/lib/tiktok/order-types";

const ORDER_API_PATH = "/order/202309/orders/search";

function buildOrdersApiUrl(
  connection: TikTokApiConnectionRow,
  body: string,
): string | null {
  const host = process.env.TIKTOK_SHOP_ORDERS_API_URL?.trim();

  if (!host) return null;

  if (!connection.app_key?.trim()) return null;
  if (!connection.app_secret?.trim()) return null;
  if (!connection.shop_cipher?.trim()) return null;

  const queryParams: Record<string, string> = {
    app_key: connection.app_key.trim(),
    timestamp: String(Math.floor(Date.now() / 1000)),
    shop_cipher: connection.shop_cipher.trim(),
    page_size: "20",
  };

  queryParams.sign = createTikTokShopSign({
    path: ORDER_API_PATH,
    queryParams,
    body,
    appSecret: connection.app_secret.trim(),
  });

  const url = new URL(ORDER_API_PATH, host);

  for (const [key, value] of Object.entries(queryParams)) {
    url.searchParams.set(key, value);
  }

  return url.toString();
}

export async function fetchShopOrdersFromConnection(
  connection: TikTokApiConnectionRow,
): Promise<{ records: TikTokOrderApiRecord[]; error: string | null }> {
  if (!connection.access_token?.trim()) {
    return { records: [], error: "access_token が未設定です" };
  }

  if (!connection.app_key?.trim()) {
    return { records: [], error: "app_key が未設定です" };
  }

  if (!connection.app_secret?.trim()) {
    return { records: [], error: "app_secret が未設定です" };
  }

  if (!connection.shop_cipher?.trim()) {
    return { records: [], error: "shop_cipher が未設定です" };
  }

  const body = JSON.stringify({});

  const endpoint = buildOrdersApiUrl(connection, body);

  if (!endpoint) {
    return {
      records: [],
      error: "Order API のURLまたは接続情報が不足しています",
    };
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "x-tts-access-token": connection.access_token.trim(),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body,
      cache: "no-store",
    });

    const payload = (await response.json()) as {
      code?: number;
      message?: string;
      request_id?: string;
      data?: unknown;
    };

    if (!response.ok || (typeof payload.code === "number" && payload.code !== 0)) {
      return {
        records: [],
        error: `Order API error (${connection.shop_id}): ${
          payload.message ?? `HTTP ${response.status}`
        }`,
      };
    }

    const parsed = parseTikTokOrderApiPayloadFromJson(payload);

    if (parsed.error) {
      return {
        records: [],
        error: `${connection.shop_id}: ${parsed.error}`,
      };
    }

    return {
      records: parsed.records,
      error: null,
    };
  } catch (error) {
    return {
      records: [],
      error:
        error instanceof Error
          ? `${connection.shop_id}: ${error.message}`
          : `${connection.shop_id}: Order API の取得に失敗しました`,
    };
  }
}
