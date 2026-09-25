import Link from "next/link";
import { redirect } from "next/navigation";

import { SellerBillingClient } from "@/app/(app)/admin/seller-billing/SellerBillingClient";
import {
  fetchSellerBillingData,
  fetchSellerInvoiceList,
} from "@/lib/db/seller-billing-queries";
import { currentMonthKey } from "@/lib/db/dashboard-queries";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/*
  セラー請求画面。

  対象月 → CSVアップロード → 取込結果 → 請求プレビュー
  → 請求書作成 → PDF → 発行 → 入金済み
  という流れで進められるようにしている。

  請求額の根拠はショップ実績CSVのみ（B列GMV − I列Refunds）× 契約料率。
*/
export default async function SellerBillingPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login?next=/admin/seller-billing");

  const appUser = await resolveAppUserContext(supabase, user);
  if (!isAdminRole(appUser.data.role)) redirect("/dashboard");

  const params = await searchParams;
  const admin = getSupabaseAdmin();

  // 月指定がなければ、実績CSVが入っている最新月を既定にする
  const probe = await fetchSellerBillingData(admin, params.month ?? currentMonthKey());
  const month =
    params.month ??
    (probe.rows.length > 0 ? probe.targetMonth : probe.months[0] ?? currentMonthKey());

  const [billing, invoices] = await Promise.all([
    month === probe.targetMonth
      ? Promise.resolve(probe)
      : fetchSellerBillingData(admin, month),
    fetchSellerInvoiceList(admin),
  ]);

  return (
    <div className="space-y-8">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">親管理画面</p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
          セラー請求
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-500">
          毎月のショップ実績CSVを正として請求額を計算します。
          請求対象GMV =（CSV B列 GMV − I列 Refunds）、請求額（税込）= 請求対象GMV × 契約料率。
          算出額がそのまま税込請求額です（消費税を別途加算しません）。
        </p>
      </div>

      {billing.error ? (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100" role="alert">
          {billing.error}
        </div>
      ) : (
        <SellerBillingClient
          billing={billing}
          invoices={invoices.data}
          invoiceError={invoices.error}
        />
      )}

      <div className="flex justify-center">
        <Link href="/dashboard" className="text-sm font-medium text-[var(--accent-cyan)] hover:underline">
          ← ダッシュボード
        </Link>
      </div>
    </div>
  );
}
