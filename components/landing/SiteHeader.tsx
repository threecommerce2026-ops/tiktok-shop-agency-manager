import Link from "next/link";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-white/[0.06] bg-surface-0/80 backdrop-blur-xl supports-[backdrop-filter]:bg-surface-0/60">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4 sm:h-16 sm:px-6">
        <Link
          href="/"
          className="group flex min-w-0 items-center gap-2.5 rounded-lg py-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-cyan)]"
        >
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-[var(--accent-cyan)]/20 to-[var(--accent-magenta)]/20 ring-1 ring-white/10 transition group-hover:ring-[var(--accent-cyan)]/40"
            aria-hidden
          >
            <span className="text-xs font-bold tracking-tight text-gradient-brand">
              TS
            </span>
          </span>
          <div className="min-w-0 flex flex-col leading-tight">
            <span className="truncate text-sm font-semibold tracking-tight text-zinc-100 sm:text-base">
              TSAM
            </span>
            <span className="hidden text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-500 sm:block">
              代理店コンソール
            </span>
          </div>
        </Link>

        <nav
          className="hidden items-center gap-1 md:flex"
          aria-label="メイン"
        >
          <a
            href="#features"
            className="rounded-lg px-3 py-2 text-sm font-medium text-zinc-400 transition hover:bg-white/[0.04] hover:text-zinc-100"
          >
            機能
          </a>
          <a
            href="#roadmap"
            className="rounded-lg px-3 py-2 text-sm font-medium text-zinc-400 transition hover:bg-white/[0.04] hover:text-zinc-100"
          >
            ロードマップ
          </a>
          <Link
            href="/login?next=/dashboard"
            className="inline-flex min-h-[44px] items-center rounded-lg px-4 text-sm font-semibold text-[var(--accent-cyan)] transition hover:bg-white/[0.04]"
          >
            代理店ログイン
          </Link>
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          <Link
            href="/login?next=/dashboard"
            className="md:hidden inline-flex min-h-[48px] min-w-[48px] touch-manipulation items-center justify-center rounded-full border border-white/[0.1] px-4 text-xs font-semibold text-zinc-200 transition hover:border-[var(--accent-cyan)]/40"
          >
            ログイン
          </Link>
          <Link
            href="/login?next=/dashboard"
            className="hidden min-h-[44px] items-center justify-center rounded-full border border-white/[0.08] px-4 text-sm font-medium text-zinc-300 transition hover:border-[var(--accent-cyan)]/40 hover:text-white sm:inline-flex"
          >
            ログイン
          </Link>
          <Link
            href="/login?next=/dashboard"
            className="inline-flex min-h-[48px] min-w-[48px] touch-manipulation items-center justify-center rounded-full bg-gradient-to-r from-[var(--accent-cyan)]/90 to-[var(--accent-magenta)]/90 px-4 text-sm font-semibold text-surface-0 shadow-lg shadow-[var(--accent-magenta)]/20 transition hover:brightness-110 active:scale-[0.98]"
          >
            <span className="sm:hidden">開く</span>
            <span className="hidden sm:inline">コンソールへ</span>
          </Link>
        </div>
      </div>
    </header>
  );
}
