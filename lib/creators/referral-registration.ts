import { randomBytes } from "node:crypto";

export const REFERRAL_LINK_CREATOR_SOURCE = "referral_link";
export const PENDING_REFERRAL_TIKTOK_PREFIX = "pending-";

export function generatePendingReferralTiktokId(): string {
  return `${PENDING_REFERRAL_TIKTOK_PREFIX}${randomBytes(8).toString("hex")}`;
}

export function isPendingReferralTiktokId(tiktokId: string | null | undefined): boolean {
  const normalized = tiktokId?.trim().toLowerCase() ?? "";
  return normalized.length === 0 || normalized.startsWith(PENDING_REFERRAL_TIKTOK_PREFIX);
}

export function formatCreatorTiktokIdLabel(tiktokId: string | null | undefined): string {
  if (isPendingReferralTiktokId(tiktokId)) {
    return "未登録";
  }
  return tiktokId?.trim() ?? "未登録";
}

export function formatCreatorRegistrationStatusLabel(
  registrationStatus: string | null | undefined,
): string {
  switch (registrationStatus) {
    case "pending":
      return "仮登録";
    case "assigned":
      return "運用中";
    case "inactive":
      return "無効";
    default:
      return registrationStatus?.trim() || "—";
  }
}

export function formatOfficialLineRegisteredLabel(
  officialLineRegistered: boolean | null | undefined,
): string {
  return officialLineRegistered ? "登録済み" : "未登録";
}

export function resolveCreatorLineName(creator: {
  line_name?: string | null;
  line_display_name?: string | null;
}): string {
  return creator.line_name?.trim() || creator.line_display_name?.trim() || "—";
}
