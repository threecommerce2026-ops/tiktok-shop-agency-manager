export const THREE_INC_AGENCY_NAME = "THREE.inc";

export function normalizeAgencyName(name: string | null | undefined): string {
  return String(name ?? "").trim().toLowerCase();
}

export function isThreeIncAgencyName(name: string | null | undefined): boolean {
  return normalizeAgencyName(name) === normalizeAgencyName(THREE_INC_AGENCY_NAME);
}

export function isInHouseCreator(params: {
  agencyId: string | null;
  agencyName?: string | null;
}): boolean {
  if (!params.agencyId) {
    return true;
  }
  return isThreeIncAgencyName(params.agencyName);
}
