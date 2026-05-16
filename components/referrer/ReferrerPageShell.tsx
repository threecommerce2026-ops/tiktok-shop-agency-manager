import type { ReactNode } from "react";
import Link from "next/link";
import { ReferrerSignOutButton } from "@/components/referrer/ReferrerSignOutButton";

export function ReferrerPageShell({
  children,
  title,
  description,
}: {
  children: ReactNode;
  title: string;
  description?: string;
}) {
  return (
    <div className="min-h-full bg-surface-0">
      <header className="border-b border-white/[0.06] bg-surface-0/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">Referrer Portal</p>
            <h1 className="mt-1 text-lg font-bold text-zinc-50 sm:text-xl">{title}</h1>
            {description ? <p className="mt-1 text-sm text-zinc-500">{description}</p> : null}
          </div>
          <div className="flex items-center gap-2">
            <Link href="/referrer/dashboard" className="text-sm text-[var(--accent-cyan)] hover:underline">
              ダッシュボード
            </Link>
            <ReferrerSignOutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl px-4 py-6 pb-16 sm:px-6 sm:py-8">{children}</main>
    </div>
  );
}
