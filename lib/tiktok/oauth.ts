import { createHmac, randomBytes } from "node:crypto";

const TIKTOK_AUTH_HOST = "https://auth.tiktok-shops.com";
const TIKTOK_OPEN_API_HOST = "https://open-api.tiktokglobalshop.com";
const TIKTOK_API_VERSION = "202309";
const DEFAULT_REDIRECT_URI = "http://localhost:3001/api/tiktok/callback";

export type TikTokOAuthTokenData = {
  access_token: string;
  refresh_token: string | null;
  access_token_expire_in: number | null;
  refresh_token_expire_in: number | null;
};

export type TikTokAuthorizedShop = {
  shop_id: string;
  shop_cipher: string | null;
  name: string | null;
};

type TikTokApiEnvelope<T> = {
  code?: number;
  message?: string;
  data?: T;
};

function readRedirectUri(): string {
  return process.env.TIKTOK_SHOP_REDIRECT_URI?.trim() || DEFAULT_REDIRECT_URI;
}

export function createTikTokOAuthState(): string {
  return randomBytes(24).toString("hex");
}

export function buildTikTokAuthorizeUrl(appKey: string, state: string): string {
  const url = new URL(`${TIKTOK_AUTH_HOST}/oauth/authorize`);
  url.searchParams.set("app_key", appKey);
  url.searchParams.set("state", state);
  return url.toString();
}

function parseExpireSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return null;
}

function toTokenExpiredAt(expireInSeconds: number | null): string | null {
  if (!expireInSeconds) {
    return null;
  }
  return new Date(Date.now() + expireInSeconds * 1000).toISOString();
}

function createTikTokShopSign(params: {
  path: string;
  queryParams: Record<string, string>;
  body: string;
  appSecret: string;
}): string {
  const paramsToSign = { ...params.queryParams };
  delete paramsToSign.sign;
  delete paramsToSign.access_token;
  delete paramsToSign["x-tts-access-token"];

  const keys = Object.keys(paramsToSign).sort();
  let stringToBeSigned = params.path;
  for (const key of keys) {
    stringToBeSigned += `${key}${paramsToSign[key]}`;
  }
  if (params.body) {
    stringToBeSigned += params.body;
  }
  stringToBeSigned = `${params.appSecret}${stringToBeSigned}${params.appSecret}`;
  return createHmac("sha256", params.appSecret).update(stringToBeSigned).digest("hex");
}

async function readTikTokApiError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as TikTokApiEnvelope<unknown>;
    if (payload.message) {
      return payload.message;
    }
  } catch {
    // ignore JSON parse errors
  }
  return `HTTP ${response.status}`;
}

export async function exchangeTikTokAuthCodeForToken(params: {
  appKey: string;
  appSecret: string;
  code: string;
}): Promise<{ data: TikTokOAuthTokenData; tokenExpiredAt: string | null }> {
  const url = new URL(`${TIKTOK_AUTH_HOST}/api/v2/token/get`);
  url.searchParams.set("app_key", params.appKey);
  url.searchParams.set("app_secret", params.appSecret);
  url.searchParams.set("auth_code", params.code);
  url.searchParams.set("grant_type", "authorized_code");

  const response = await fetch(url.toString(), { cache: "no-store" });
  const payload = (await response.json()) as TikTokApiEnvelope<Record<string, unknown>>;

  if (!response.ok || payload.code !== 0 || !payload.data) {
    throw new Error(payload.message ?? (await readTikTokApiError(response)));
  }

  const accessToken = String(payload.data.access_token ?? "").trim();
  if (!accessToken) {
    throw new Error("access_token を取得できませんでした");
  }

  const refreshToken = String(payload.data.refresh_token ?? "").trim();
  const accessTokenExpireIn = parseExpireSeconds(
    payload.data.access_token_expire_in ?? payload.data.expires_in,
  );

  return {
    data: {
      access_token: accessToken,
      refresh_token: refreshToken || null,
      access_token_expire_in: accessTokenExpireIn,
      refresh_token_expire_in: parseExpireSeconds(payload.data.refresh_token_expire_in),
    },
    tokenExpiredAt: toTokenExpiredAt(accessTokenExpireIn),
  };
}

function mapAuthorizedShop(row: Record<string, unknown>): TikTokAuthorizedShop | null {
  const shopId = String(row.id ?? row.shop_id ?? "").trim();
  if (!shopId) {
    return null;
  }

  const shopCipher = String(row.cipher ?? row.shop_cipher ?? "").trim();
  const name = String(row.name ?? row.shop_name ?? "").trim();

  return {
    shop_id: shopId,
    shop_cipher: shopCipher || null,
    name: name || null,
  };
}

export async function fetchTikTokAuthorizedShops(params: {
  appKey: string;
  appSecret: string;
  accessToken: string;
}): Promise<TikTokAuthorizedShop[]> {
  const path = `/authorization/${TIKTOK_API_VERSION}/shops`;
  const queryParams: Record<string, string> = {
    app_key: params.appKey,
    timestamp: String(Math.floor(Date.now() / 1000)),
  };
  queryParams.sign = createTikTokShopSign({
    path,
    queryParams,
    body: "",
    appSecret: params.appSecret,
  });

  const url = new URL(path, TIKTOK_OPEN_API_HOST);
  for (const [key, value] of Object.entries(queryParams)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString(), {
    headers: {
      "x-tts-access-token": params.accessToken,
      Accept: "application/json",
    },
    cache: "no-store",
  });

  const payload = (await response.json()) as TikTokApiEnvelope<{
    shops?: Record<string, unknown>[];
  }>;

  if (!response.ok || payload.code !== 0) {
    throw new Error(payload.message ?? (await readTikTokApiError(response)));
  }

  const shops = payload.data?.shops ?? [];
  return shops
    .map((shop) => mapAuthorizedShop(shop))
    .filter((shop): shop is TikTokAuthorizedShop => shop !== null);
}

export function getTikTokOAuthRedirectUri(): string {
  return readRedirectUri();
}
