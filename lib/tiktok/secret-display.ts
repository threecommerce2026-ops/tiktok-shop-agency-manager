/**
 * 秘密情報をブラウザへ渡さないための表示用ヘルパー。
 *
 * ここでは「値そのもの」を返す関数を提供しません。
 * 呼び出し側は真偽値・状態ラベルだけを Client Component へ渡してください。
 */

/** 値が設定されているかどうかだけを返す（値自体は返さない） */
export function hasSecretValue(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * production では credential のデバッグ情報を一切返さない。
 * Server / Client のどちらから呼んでも同じ判定になる。
 */
export function isCredentialDebugEnabled(): boolean {
  return process.env.NODE_ENV !== "production";
}

export type SecretPresenceLabel = "設定済み" | "未設定";

export function secretPresenceLabel(present: boolean): SecretPresenceLabel {
  return present ? "設定済み" : "未設定";
}

export type ConnectionStatus = "connected" | "token_expired" | "disconnected";

/**
 * 画面表示用の接続状態。
 * - connected: access_token があり、期限切れでもない
 * - token_expired: access_token はあるが token_expired_at を過ぎている
 * - disconnected: access_token が未設定
 */
export function resolveConnectionStatus(params: {
  hasAccessToken: boolean;
  tokenExpiredAt: string | null;
}): ConnectionStatus {
  if (!params.hasAccessToken) {
    return "disconnected";
  }
  if (isTokenExpired(params.tokenExpiredAt)) {
    return "token_expired";
  }
  return "connected";
}

export function isTokenExpired(tokenExpiredAt: string | null): boolean {
  if (!tokenExpiredAt) {
    return false;
  }
  const expiredAt = new Date(tokenExpiredAt);
  if (Number.isNaN(expiredAt.getTime())) {
    return false;
  }
  return expiredAt.getTime() <= Date.now();
}

export function connectionStatusLabel(status: ConnectionStatus): string {
  switch (status) {
    case "connected":
      return "接続済み";
    case "token_expired":
      return "トークン期限切れ";
    default:
      return "未接続";
  }
}
