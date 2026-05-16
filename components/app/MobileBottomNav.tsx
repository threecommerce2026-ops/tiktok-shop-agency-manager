"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { UserRole } from "@/lib/db/user-context";

const agencyItems = [
  { href: "/dashboard", label: "概要", short: "DS" },
  { href: "/creators", label: "売上一覧", short: "CR" },
  { href: "/orders", label: "注文", short: "OD" },
  { href: "/rewards", label: "報酬", short: "RP" },
] as const;

const adminItems = [
  { href: "/dashboard", label: "概要", short: "DS" },
  { href: "/creators", label: "売上一覧", short: "CR" },
  { href: "/orders", label: "注文", short: "OD" },
  { href: "/sales-upload", label: "CSV", short: "↑" },
  { href: "/admin/sellers", label: "セラー", short: "SL" },
  { href: "/rewards", label: "報酬", short: "RP" },
] as const;

export function MobileBottomNav({ role }: { role: UserRole }) {
  const pathname = usePathname();
  const items = role === "admin" ? adminItems : agencyItems;

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 border-t border-white/[0.08] bg-surface-0/95 backdrop-blur-xl sm:hidden"
      aria-label="メイン"
    >
      <ul className="no-scrollbar flex h-[calc(3.5rem+env(safe-area-inset-bottom))] items-stretch gap-0 overflow-x-auto px-1 pb-[env(safe-area-inset-bottom)] pt-1">
        {items.map(({ href, label, short }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={href} className="min-w-[4.5rem] flex-1">
              <Link
                href={href}
                prefetch
                className={`flex min-h-[48px] touch-manipulation flex-col items-center justify-center gap-0.5 rounded-xl px-1 text-[10px] font-semibold leading-tight transition active:scale-[0.97] ${
                  active
                    ? "bg-white/[0.08] text-[var(--accent-cyan)]"
                    : "text-zinc-500"
                }`}
              >
                <span className="font-mono text-xs opacity-90">{short}</span>
                <span className="max-w-[4.2rem] truncate text-center">{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
