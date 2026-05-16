import { headers } from "next/headers";

export async function resolvePublicSiteOrigin(): Promise<string> {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) {
    return configured.replace(/\/$/, "");
  }

  const headerStore = await headers();
  const host = headerStore.get("x-forwarded-host") ?? headerStore.get("host");
  const protocol = headerStore.get("x-forwarded-proto") ?? "http";
  if (host) {
    return `${protocol}://${host}`;
  }

  return "http://localhost:3000";
}

export async function buildReferralLink(referralCode: string): Promise<string> {
  const origin = await resolvePublicSiteOrigin();
  return `${origin}/ref/${encodeURIComponent(referralCode)}`;
}

export function getOfficialLineUrl(): string | null {
  const value = process.env.NEXT_PUBLIC_OFFICIAL_LINE_URL?.trim();
  return value || null;
}
