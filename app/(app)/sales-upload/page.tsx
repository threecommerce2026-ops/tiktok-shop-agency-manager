import { SalesUploadClient } from "./SalesUploadClient";
import { ensureAgencyForUser } from "@/lib/db/agency-context";
import { currentMonthKey } from "@/lib/db/dashboard-queries";
import { fetchUploadHistory } from "@/lib/db/sales-queries";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export default async function SalesUploadPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/sales-upload");
  }

  const appUser = await resolveAppUserContext(supabase, user);
  if (!isAdminRole(appUser.data.role)) {
    redirect("/dashboard");
  }

  const ctx = await ensureAgencyForUser(supabase, user.id);
  const month = currentMonthKey();

  if (!ctx.data) {
    return (
      <SalesUploadClient
        agencyName="—"
        month={month}
        history={[]}
        loadError={ctx.error ?? "代理店を初期化できませんでした"}
      />
    );
  }

  const hist = await fetchUploadHistory(supabase, ctx.data.agencyId, 50);
  const loadError = hist.error ?? null;

  return (
    <SalesUploadClient
      agencyName={ctx.data.agencyName}
      month={month}
      history={hist.data}
      loadError={loadError}
    />
  );
}
