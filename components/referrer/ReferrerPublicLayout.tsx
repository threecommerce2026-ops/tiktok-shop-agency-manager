import type { ReactNode } from "react";
import Link from "next/link";

export function ReferrerPublicLayout({
  children,
  title,
  description,
  headerLinkHref = "/referrer/login",
  headerLinkLabel = "ログイン",
}: {
  children: ReactNode;
  title: string;
  description?: string;
  headerLinkHref?: string | null;
  headerLinkLabel?: string;
}) {
  return (
    <div className="min-h-full bg-surface-0">
      <header className="border-b border-white/[0.06] bg-surface-0/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">Referrer Portal</p>
            <h1 className="mt-1 text-lg font-bold text-zinc-50 sm:text-xl">{title}</h1>
            {description ? <p className="mt-1 text-sm text-zinc-500">{description}</p> : null}
          </div>
          {headerLinkHref ? (
            <Link href={headerLinkHref} className="text-sm text-[var(--accent-cyan)] hover:underline">
              {headerLinkLabel}
            </Link>
          ) : null}
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}
