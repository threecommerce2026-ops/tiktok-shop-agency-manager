"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { UserRole } from "@/lib/db/user-context";

const agencyNav = [
  { href: "/dashboard", label: "ダッシュボード" },
  { href: "/creators", label: "クリエイター売上一覧" },
  { href: "/orders", label: "注文一覧" },
  { href: "/sales", label: "売上・収益" },
  { href: "/rewards", label: "代理店報酬" },
] as const;

const adminNav = [
  { href: "/dashboard", label: "ダッシュボード" },
  { href: "/creators", label: "クリエイター売上一覧" },
  { href: "/orders", label: "注文一覧" },
  { href: "/sales-upload", label: "売上CSV" },
  { href: "/sales", label: "売上・収益" },
  { href: "/rewards", label: "代理店報酬" },
  { href: "/csv-logs", label: "CSV履歴" },
  { href: "/admin/agencies", label: "代理店管理" },
  { href: "/admin/referrers", label: "紹介者管理" },
  { href: "/admin/creator-referrals", label: "CR紹介者管理" },
  { href: "/admin/referral-payouts", label: "紹介者報酬" },
  { href: "/admin/agencies-ranking", label: "代理店ランキング" },
  { href: "/admin/sellers", label: "セラー管理" },
  { href: "/admin/seller-import-histories", label: "セラー取込履歴" },
  { href: "/admin/creator-assignment", label: "クリエイター振り分け管理" },
  { href: "/admin/creator-assignment-logs", label: "振り分け履歴" },
  { href: "/admin/api-connections", label: "API設定" },
  { href: "/admin/api-test-sync", label: "APIテスト同期" },
  { href: "/admin/api-sync", label: "本番API同期" },
  { href: "/sync-jobs", label: "API同期" },
  { href: "/notifications", label: "通知ログ" },
] as const;

const linkClass =
  "rounded-lg px-2.5 py-2 text-xs font-medium text-zinc-400 transition hover:bg-white/[0.04] hover:text-zinc-100 min-h-[40px] sm:px-3 sm:text-sm inline-flex items-center whitespace-nowrap";

const activeClass =
  "rounded-lg px-2.5 py-2 text-xs font-semibold text-zinc-100 bg-white/[0.08] min-h-[40px] sm:px-3 sm:text-sm inline-flex items-center whitespace-nowrap";

function navActive(pathname: string, href: string) {
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppHeader({ role }: { role: UserRole }) {
  const pathname = usePathname();
  const nav = role === "admin" ? adminNav : agencyNav;

  return (
    <header className="sticky top-0 z-40 border-b border-white/[0.06] bg-surface-0/90 backdrop-blur-xl supports-[backdrop-filter]:bg-surface-0/75">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-6 sm:py-4">
        <div className="flex items-center justify-between gap-3 px-4 sm:px-0">
          <Link
            href="/"
            className="group flex shrink-0 items-center gap-2 rounded-lg py-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-cyan)]"
          >
            <span
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-[var(--accent-cyan)]/20 to-[var(--accent-magenta)]/20 ring-1 ring-white/10 sm:h-9 sm:w-9"
              aria-hidden
            >
              <span className="text-[10px] font-bold tracking-tight text-gradient-brand sm:text-xs">
                TS
              </span>
            </span>
            <span className="max-w-[10rem] truncate text-sm font-semibold text-zinc-100 sm:max-w-none">
              TikTok Shop 代理店コンソール
            </span>
          </Link>
        </div>

        <nav
          className="no-scrollbar flex flex-nowrap items-center gap-1 overflow-x-auto px-4 pb-1 sm:justify-end sm:px-0 sm:pb-0"
          aria-label="アプリ"
        >
          {nav.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              prefetch
              className={navActive(pathname, href) ? activeClass : linkClass}
            >
              {label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
