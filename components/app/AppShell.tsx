import type { ReactNode } from "react";
import { AppHeader } from "@/components/AppHeader";
import { CurrentRoleIndicator } from "@/components/app/CurrentRoleIndicator";
import { MobileBottomNav } from "@/components/app/MobileBottomNav";
import type { UserRole } from "@/lib/db/user-context";

export function AppShell({
  children,
  role,
  profileRoleRaw,
  profileLoadError,
}: {
  children: ReactNode;
  role: UserRole;
  profileRoleRaw?: string | null;
  profileLoadError?: string | null;
}) {
  return (
    <>
      <AppHeader role={role} />
      <CurrentRoleIndicator
        role={role}
        profileRoleRaw={profileRoleRaw}
        profileLoadError={profileLoadError}
      />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-28 pt-6 sm:px-6 sm:pb-12 sm:pt-8">
        {children}
      </main>
      <MobileBottomNav role={role} />
    </>
  );
}
