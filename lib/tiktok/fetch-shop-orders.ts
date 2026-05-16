import type { TikTokApiConnectionRow } from "@/lib/db/tiktok-api-connection-queries";
import { parseTikTokOrderApiPayloadFromJson } from "@/lib/tiktok/parse-order-api-payload";
import type { TikTokOrderApiRecord } from "@/lib/tiktok/order-types";

function buildOrdersApiUrl(connection: TikTokApiConnectionRow): string | null {
  const template = process.env.TIKTOK_SHOP_ORDERS_API_URL?.trim();
  if (!template) return null;

  const url = new URL(template);
  if (connection.shop_cipher) {
    url.searchParams.set("shop_cipher", connection.shop_cipher);
  }
  if (connection.shop_id) {
    url.searchParams.set("shop_id", connection.shop_id);
  }
  if (connection.app_key) {
    url.searchParams.set("app_key", connection.app_key);
  }

  return url.toString();
}

export async function fetchShopOrdersFromConnection(
  connection: TikTokApiConnectionRow,
): Promise<{ records: TikTokOrderApiRecord[]; error: string | null }> {
  const endpoint = buildOrdersApiUrl(connection);
  if (!endpoint) {
    return {
      records: [],
      error:
        "TIKTOK_SHOP_ORDERS_API_URL が未設定です。Order API のエンドポイント URL を環境変数に設定してください。",
    };
  }

  if (!connection.access_token?.trim()) {
    return { records: [], error: "access_token が未設定です" };
  }

  try {
    const response = await fetch(endpoint, {
      headers: {
        Authorization: `Bearer ${connection.access_token}`,
        "x-tts-access-token": connection.access_token,
        Accept: "application/json",
      },
      cache: "no-store",
    });

    if (!response.ok) {
      return {
        records: [],
        error: `Order API error (${connection.shop_id}): ${response.status}`,
      };
    }

    const payload = (await response.json()) as unknown;
    const parsed = parseTikTokOrderApiPayloadFromJson(payload);
    if (parsed.error) {
      return { records: [], error: `${connection.shop_id}: ${parsed.error}` };
    }

    return { records: parsed.records, error: null };
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
