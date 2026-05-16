import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-white/[0.06] bg-surface-0 px-4 py-10 sm:px-6">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-zinc-200">
            TikTok Shop 代理店コンソール
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            クリエイター紹介型代理店向けの売上・収益・報酬管理（デモは仮データ）。
          </p>
        </div>
        <div className="flex flex-wrap gap-4 text-sm text-zinc-500">
          <Link
            href="/login?next=/dashboard"
            className="min-h-[44px] inline-flex items-center hover:text-zinc-300"
          >
            ログイン
          </Link>
          <Link
            href="/login?next=/dashboard"
            className="min-h-[44px] inline-flex items-center hover:text-zinc-300"
          >
            コンソール
          </Link>
        </div>
      </div>
    </footer>
  );
}
