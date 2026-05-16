import { AppShell } from "@/components/app/AppShell";
import { resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

export const dynamic = "force-dynamic";

export default async function AppAreaLayout({
  children,
}: {
  children: ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const appUser = await resolveAppUserContext(supabase, user);

  return (
    <AppShell
      role={appUser.data.role}
      profileRoleRaw={appUser.data.profileRoleRaw}
      profileLoadError={appUser.data.profileLoadError}
    >
      {children}
    </AppShell>
  );
}
