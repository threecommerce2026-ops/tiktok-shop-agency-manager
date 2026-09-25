"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { isNavItemActive, navItemsForRole } from "@/lib/nav/app-nav";
import type { UserRole } from "@/lib/db/user-context";

/*
  ヘッダーはデスクトップではタイトル表示のみ。
  ナビゲーションは lg 以上ではサイドバー（AppSidebar）が担当し、
  タブレット以下ではこのヘッダーの横スクロールナビが担当する。
*/

const linkClass =
  "rounded-lg px-2.5 py-2 text-xs font-medium text-zinc-400 transition hover:bg-white/[0.04] hover:text-zinc-100 min-h-[40px] sm:px-3 sm:text-sm inline-flex items-center whitespace-nowrap";

const activeClass =
  "rounded-lg px-2.5 py-2 text-xs font-semibold text-zinc-100 bg-white/[0.08] min-h-[40px] sm:px-3 sm:text-sm inline-flex items-center whitespace-nowrap";

export function AppHeader({ role }: { role: UserRole }) {
  const pathname = usePathname();
  const nav = navItemsForRole(role);

  return (
    <header className="sticky top-0 z-40 border-b border-white/[0.06] bg-surface-0/90 backdrop-blur-xl supports-[backdrop-filter]:bg-surface-0/75 lg:hidden">
      <div className="mx-auto flex w-full flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-6 sm:py-4">
        <div className="flex items-center justify-between gap-3 px-4 sm:px-0">
          <Link
            href="/dashboard"
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
            <span className="max-w-[12rem] truncate text-sm font-semibold text-zinc-100 sm:max-w-none">
              THREE COMMERCE 管理コンソール
            </span>
          </Link>
        </div>

        <nav
          className="no-scrollbar flex flex-nowrap items-center gap-1 overflow-x-auto px-4 pb-1 sm:justify-end sm:px-0 sm:pb-0"
          aria-label="アプリ"
        >
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              prefetch
              className={isNavItemActive(pathname, item) ? activeClass : linkClass}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
