import type { SupabaseClient, User } from "@supabase/supabase-js";
import { isAllowlistedAdminEmail } from "@/lib/db/admin-email-allowlist";
import { ensureAgencyForUser } from "@/lib/db/agency-context";

export type UserRole = "admin" | "agency";

export type AppUserContext = {
  userId: string;
  email: string;
  role: UserRole;
  agencyId: string | null;
  agencyName: string | null;
  profileId: string | null;
  profileRoleRaw: string | null;
  profileLoadError: string | null;
};

export function isAdminRole(role: UserRole): boolean {
  return role === "admin";
}

export function normalizeUserRole(value: unknown): UserRole {
  return String(value ?? "").trim().toLowerCase() === "admin" ? "admin" : "agency";
}

export async function resolveAppUserContext(
  supabase: SupabaseClient,
  user: User,
): Promise<{ data: AppUserContext; error: string | null }> {
  const userId = user.id;
  const email = user.email ?? "";
  const agencyResult = await ensureAgencyForUser(supabase, userId);

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, role")
    .eq("id", userId)
    .maybeSingle();

  const profileId = (profile?.id as string | undefined) ?? null;
  const profileRoleRaw =
    profile?.role == null ? null : String(profile.role).trim() || null;
  let role = normalizeUserRole(profileRoleRaw);
  if (isAllowlistedAdminEmail(email)) {
    role = "admin";
  }

  const profileLoadError = profileError?.message ?? null;
  const agencyError = agencyResult.error;

  return {
    data: {
      userId,
      email,
      role,
      agencyId: agencyResult.data?.agencyId ?? null,
      agencyName: agencyResult.data?.agencyName ?? null,
      profileId,
      profileRoleRaw,
      profileLoadError,
    },
    error: profileLoadError ?? agencyError,
  };
}
