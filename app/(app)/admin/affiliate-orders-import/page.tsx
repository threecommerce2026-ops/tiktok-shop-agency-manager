import { AffiliateOrdersImportClient } from "./AffiliateOrdersImportClient";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function AffiliateOrdersImportPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/admin/affiliate-orders-import");
  }

  const appUser = await resolveAppUserContext(supabase, user);

  if (!isAdminRole(appUser.data.role)) {
    redirect("/dashboard");
  }

  return <AffiliateOrdersImportClient />;
}
