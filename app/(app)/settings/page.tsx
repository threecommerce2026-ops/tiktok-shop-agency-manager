import Link from "next/link";
import { redirect } from "next/navigation";

import { SignOutButton } from "@/components/app/SignOutButton";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import { createClient } from "@/lib/supabase/server";
import { ACCOUNT_MANAGEMENT_TYPE_OPTIONS } from "@/lib/creators/account-management-type";
import { AGENCY_PAYOUT_THRESHOLD_YEN } from "@/lib/payments/minimum-payout";
import { REFERRAL_PAYOUT_THRESHOLD_YEN } from "@/lib/referrals/referral-reward-engine";
import { formatYenPrecise } from "@/lib/revenue/calc";

export const dynamic = "force-dynamic";

const ADMIN_INTERNAL_LINKS = [
  { href: "/admin/creator-master-editor", label: "クリエイターマスタ 一括編集" },
  { href: "/admin/referrers", label: "紹介者マスタ" },
  { href: "/admin/creator-assignment", label: "クリエイター振り分け（旧画面）" },
  { href: "/admin/creator-referrals", label: "紹介者紐付け（旧画面）" },
  { href: "/admin/monthly-agency-assignments", label: "月別所属 一括確認・確定" },
  { href: "/admin/creator-assignment-logs", label: "振り分け履歴" },
  { href: "/admin/creator-commission-rate-logs", label: "分配率履歴" },
  { href: "/admin/referral-payouts", label: "紹介者報酬支払い（旧画面）" },
  { href: "/admin/agencies-ranking", label: "代理店ランキング" },
  { href: "/orders", label: "注文一覧" },
  { href: "/notifications", label: "通知" },
];

export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/settings");
  }

  const appUser = await resolveAppUserContext(supabase, user);
  const isAdmin = isAdminRole(appUser.data.role);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">設定</p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
            アカウントと業務ルール
          </h1>
        </div>
        <SignOutButton />
      </div>

      <section className="rounded-xl border border-white/[0.07] bg-surface-1/50 p-5">
        <h2 className="text-sm font-semibold text-zinc-200">ログイン情報</h2>
        <dl className="mt-3 space-y-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-zinc-500">メールアドレス</dt>
            <dd className="break-all font-mono text-xs text-zinc-300">{user.email}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-zinc-500">権限</dt>
            <dd className="text-zinc-200">{isAdmin ? "親管理者（admin）" : "代理店（agency）"}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-zinc-500">所属代理店</dt>
            <dd className="text-zinc-200">{appUser.data.agencyName ?? "—"}</dd>
          </div>
        </dl>
      </section>

      <section className="rounded-xl border border-white/[0.07] bg-surface-1/50 p-5">
        <h2 className="text-sm font-semibold text-zinc-200">報酬ルール</h2>
        <ul className="mt-3 space-y-2 text-sm leading-relaxed text-zinc-400">
          <li>
            紹介者報酬は、支払い確定した注文の Commission Base × 5%。
          </li>
          <li>
            支払判定は月単位ではなく<strong className="text-zinc-200">その年の未払い累積</strong>で行い、
            {formatYenPrecise(REFERRAL_PAYOUT_THRESHOLD_YEN)} 以上で支払対象になります。
          </li>
          <li>{formatYenPrecise(REFERRAL_PAYOUT_THRESHOLD_YEN)} 未満の報酬は消えず、翌月へ繰り越されます。</li>
          <li>
            代理店分配報酬も同じく、
            <strong className="text-zinc-200">締め月までの未払い累積</strong>が{" "}
            {formatYenPrecise(AGENCY_PAYOUT_THRESHOLD_YEN)} 以上で支払対象になります。
            単月ではなく累積で判定します。
          </li>
          <li>
            {formatYenPrecise(AGENCY_PAYOUT_THRESHOLD_YEN)}{" "}
            未満の代理店分配報酬も消えず、累積が達した時点でまとめて支払います。
          </li>
          <li>支払い済みの明細は再集計しても二重払いされません。</li>
          <li>代理店への支払は代理店分配報酬のみです。紹介制度報酬と TAP 収益は含まれません。</li>
        </ul>
      </section>

      <section className="rounded-xl border border-white/[0.07] bg-surface-1/50 p-5">
        <h2 className="text-sm font-semibold text-zinc-200">クリエイター区分</h2>
        <dl className="mt-3 space-y-3 text-sm">
          {ACCOUNT_MANAGEMENT_TYPE_OPTIONS.map((option) => (
            <div key={option.value}>
              <dt className="font-medium text-zinc-200">{option.label}</dt>
              <dd className="text-xs leading-relaxed text-zinc-500">{option.description}</dd>
            </div>
          ))}
        </dl>
      </section>

      {isAdmin ? (
        <section className="rounded-xl border border-white/[0.07] bg-surface-1/50 p-5">
          <h2 className="text-sm font-semibold text-zinc-200">個別管理画面</h2>
          <p className="mt-1 text-xs text-zinc-600">
            通常業務では使いません。既存データの確認・監査が必要なときだけ利用してください。
          </p>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {ADMIN_INTERNAL_LINKS.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="block rounded-lg border border-white/[0.06] px-3 py-2 text-xs text-zinc-300 transition hover:border-white/[0.14] hover:bg-white/[0.04]"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
