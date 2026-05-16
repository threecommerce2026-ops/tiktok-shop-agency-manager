import Link from "next/link";

export function HeroSection() {
  return (
    <section className="relative overflow-hidden px-4 pb-16 pt-10 sm:px-6 sm:pb-24 sm:pt-16 lg:pt-20">
      <div
        className="pointer-events-none absolute inset-0 bg-radial-fade"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-0 bg-radial-magenta"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-0 bg-grid-fine opacity-40 [mask-image:linear-gradient(to_bottom,black_30%,transparent)]"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute -left-1/4 top-1/4 h-96 w-96 rounded-full bg-[var(--accent-cyan)]/10 blur-[100px] [animation:float-glow_12s_ease-in-out_infinite]"
        aria-hidden
      />

      <div className="relative mx-auto max-w-6xl">
        <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.25em] text-zinc-400 sm:text-xs">
          <span
            className="h-1.5 w-1.5 rounded-full bg-[var(--accent-cyan)] shadow-[0_0_8px_var(--accent-cyan)]"
            aria-hidden
          />
          TikTok Shop 代理店向け
        </p>

        <h1 className="max-w-4xl text-3xl font-bold leading-[1.15] tracking-tight text-zinc-50 sm:text-5xl sm:leading-[1.1] lg:text-6xl lg:leading-[1.08]">
          紹介クリエイターの
          <br className="hidden sm:block" />
          <span className="text-gradient-brand">売上・収益・報酬</span>
          を一箇所で。
        </h1>

        <p className="mt-5 max-w-2xl text-base leading-relaxed text-zinc-400 sm:text-lg">
          代理店ごとに閲覧を分離。紹介クリエイターの売上・収益進捗、分配率に基づく代理店報酬、月次の集計まで。CSV
          取り込みと将来的な TikTok Shop API 連携を想定した設計です。
        </p>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
          <Link
            href="/login?next=/dashboard"
            className="inline-flex min-h-[52px] items-center justify-center rounded-full bg-zinc-100 px-8 text-base font-semibold text-surface-0 transition hover:bg-white active:scale-[0.98]"
          >
            代理店ログイン
          </Link>
          <a
            href="#features"
            className="inline-flex min-h-[52px] items-center justify-center gap-2 rounded-full border border-white/[0.1] px-6 text-base font-medium text-zinc-300 transition hover:border-[var(--accent-cyan)]/35 hover:text-white"
          >
            機能を見る
            <span className="text-[var(--accent-cyan)]" aria-hidden>
              ↓
            </span>
          </a>
        </div>

        <dl className="mt-12 grid grid-cols-2 gap-4 sm:mt-16 sm:grid-cols-4 sm:gap-6">
          {[
            ["スコープ", "代理店単位", "テナント分離"],
            ["データ", "CSV → DB", "API 拡張予定"],
            ["UI", "Dark Luxe", "モバイル最適化"],
            ["報酬計算", "収益×分配率", "月次集計"],
          ].map(([k, v, d]) => (
            <div
              key={k}
              className="rounded-2xl border border-white/[0.06] bg-surface-1/80 p-4 ring-glow sm:p-5"
            >
              <dt className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                {k}
              </dt>
              <dd className="mt-1 font-mono text-lg font-semibold text-zinc-100 sm:text-xl">
                {v}
              </dd>
              <p className="mt-0.5 text-xs text-zinc-500">{d}</p>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
