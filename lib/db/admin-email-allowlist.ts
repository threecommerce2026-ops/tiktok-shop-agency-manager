/**
 * profiles.role が agency でも、ここに含まれるログインメールは親管理者として扱う（一時運用・緊急用）。
 * 本番では profiles.role = 'admin' と Supabase の is_app_admin() を揃えることを推奨します。
 *
 * 追加はカンマ区切りの環境変数 ADMIN_EMAIL_ALLOWLIST でも可能（例: a@x.com,b@y.com）
 */
const DEFAULT_ADMIN_EMAIL_ALLOWLIST = ["duffy.hat@gmail.com"] as const;

function parseEnvAllowlist(): string[] {
  const raw = process.env.ADMIN_EMAIL_ALLOWLIST ?? "";
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function getAdminEmailAllowlist(): Set<string> {
  const set = new Set<string>();
  for (const e of DEFAULT_ADMIN_EMAIL_ALLOWLIST) {
    set.add(e.toLowerCase());
  }
  for (const e of parseEnvAllowlist()) {
    set.add(e);
  }
  return set;
}

export function isAllowlistedAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return getAdminEmailAllowlist().has(email.trim().toLowerCase());
}
