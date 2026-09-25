"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { isNavItemActive, navItemsForRole } from "@/lib/nav/app-nav";
import type { UserRole } from "@/lib/db/user-context";

export function AppSidebar({
  role,
  agencyName,
}: {
  role: UserRole;
  agencyName: string | null;
}) {
  const pathname = usePathname();
  const items = navItemsForRole(role);

  return (
    <aside
      className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-white/[0.06] bg-surface-0/80 px-3 py-5 lg:flex"
      aria-label="メインナビゲーション"
    >
      <Link
        href="/dashboard"
        className="mb-6 flex items-center gap-2 rounded-lg px-2 py-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-cyan)]"
      >
        <span
          className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-[var(--accent-cyan)]/20 to-[var(--accent-magenta)]/20 ring-1 ring-white/10"
          aria-hidden
        >
          <span className="text-xs font-bold tracking-tight text-gradient-brand">TS</span>
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-zinc-100">
            THREE COMMERCE
          </span>
          <span className="block truncate text-[11px] text-zinc-500">
            {role === "admin" ? "親管理者" : agencyName ?? "代理店"}
          </span>
        </span>
      </Link>

      <nav className="flex flex-1 flex-col gap-0.5">
        {items.map((item) => {
          const active = isNavItemActive(pathname, item);
          return (
            <Link
              key={item.href}
              href={item.href}
              prefetch
              aria-current={active ? "page" : undefined}
              className={`group flex min-h-[40px] items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition ${
                active
                  ? "bg-white/[0.08] font-semibold text-zinc-50"
                  : "font-medium text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100"
              }`}
            >
              <span
                className={`font-mono text-[10px] ${
                  active ? "text-[var(--accent-cyan)]" : "text-zinc-600"
                }`}
                aria-hidden
              >
                {item.short}
              </span>
              <span className="truncate">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <p className="mt-4 px-3 text-[11px] leading-relaxed text-zinc-600">
        紹介者報酬は年間累積1,000円以上で支払対象になります。
      </p>
    </aside>
  );
}
