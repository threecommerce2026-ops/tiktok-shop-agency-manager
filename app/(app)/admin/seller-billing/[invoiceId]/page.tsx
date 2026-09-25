import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { SellerInvoiceDocument } from "@/app/(app)/admin/seller-billing/[invoiceId]/SellerInvoiceDocument";
import { fetchSellerInvoice } from "@/lib/db/seller-billing-queries";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function SellerInvoicePage({
  params,
}: {
  params: Promise<{ invoiceId: string }>;
}) {
  const { invoiceId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect(`/login?next=/admin/seller-billing/${invoiceId}`);

  const appUser = await resolveAppUserContext(supabase, user);
  if (!isAdminRole(appUser.data.role)) redirect("/dashboard");

  const { data: invoice, error } = await fetchSellerInvoice(
    getSupabaseAdmin(),
    invoiceId,
  );

  if (error) {
    return (
      <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
        {error}
      </div>
    );
  }
  if (!invoice) notFound();

  return (
    <div className="space-y-6">
      <div className="print:hidden">
        <Link
          href="/admin/seller-billing"
          className="text-sm font-medium text-[var(--accent-cyan)] hover:underline"
        >
          ← セラー請求
        </Link>
      </div>

      <SellerInvoiceDocument invoice={invoice} />
    </div>
  );
}
