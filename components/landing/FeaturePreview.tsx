import Link from "next/link";

type FeatureItem = {
  title: string;
  desc: string;
  tag: string;
  span: string;
  href?: string;
};

const features: FeatureItem[] = [
  {
    title: "ダッシュボード",
    desc: "今月の総売上・総収益・代理店報酬予定・紹介/稼働クリエイター数。",
    tag: "Home",
    span: "sm:col-span-2",
    href: "/login?next=/dashboard",
  },
  {
    title: "クリエイター一覧",
    desc: "TikTok ID・売上/収益の累計・分配率・報酬予定・ステータス。",
    tag: "People",
    span: "",
    href: "/login?next=/creators",
  },
  {
    title: "売上 CSV",
    desc: "対象月・ID・金額・注文数をアップロード（次段で Supabase 反映）。",
    tag: "Import",
    span: "",
    href: "/login?next=/sales-upload",
  },
  {
    title: "売上・収益一覧",
    desc: "月別サマリとクリエイター別内訳。",
    tag: "Ledger",
    span: "sm:col-span-2",
    href: "/login?next=/sales",
  },
  {
    title: "代理店報酬一覧",
    desc: "収益 × 分配率による報酬を一覧（計算式を固定）。",
    tag: "Payout",
    span: "",
    href: "/login?next=/rewards",
  },
  {
    title: "代理店ログイン",
    desc: "認証済みユーザーのみ自社データを表示（RLS 想定）。",
    tag: "Auth",
    span: "",
    href: "/login?next=/dashboard",
  },
  {
    title: "Supabase",
    desc: "テナント別テーブル設計・CSV パイプライン。",
    tag: "DB",
    span: "",
  },
  {
    title: "TikTok Shop API",
    desc: "注文・取引同期用のアダプタ層を別モジュールで。",
    tag: "API",
    span: "sm:col-span-2",
  },
];

const cardClass = `group relative overflow-hidden rounded-2xl border border-white/[0.06] bg-surface-2/60 p-5 transition hover:border-[var(--accent-cyan)]/25 hover:shadow-[0_0_40px_-12px_rgba(37,244,238,0.2)]`;

export function FeaturePreview() {
  return (
    <section
      id="features"
      className="scroll-mt-20 border-t border-white/[0.06] bg-surface-1/40 px-4 py-16 sm:px-6 sm:py-24"
    >
      <div className="mx-auto max-w-6xl">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
            機能
            <span className="text-gradient-brand"> 一覧</span>
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-zinc-400 sm:text-base">
            ログイン後、代理店に紐づくクリエイターの売上・収益・報酬のみを表示します（閲覧制限は
            DB / RLS で実装予定）。
          </p>
        </div>

        <ul className="mt-10 grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4">
          {features.map((f) => {
            const body = (
              <>
                <div
                  className="pointer-events-none absolute -right-8 -top-8 h-24 w-24 rounded-full bg-gradient-to-br from-[var(--accent-cyan)]/15 to-transparent opacity-0 blur-2xl transition group-hover:opacity-100"
                  aria-hidden
                />
                <span className="relative inline-flex rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                  {f.tag}
                </span>
                <h3 className="relative mt-3 text-lg font-semibold text-zinc-100">
                  {f.title}
                  {f.href ? (
                    <span className="ml-2 text-xs font-normal text-[var(--accent-cyan)]">
                      ログイン後に開く
                    </span>
                  ) : null}
                </h3>
                <p className="relative mt-1 text-sm leading-relaxed text-zinc-500">
                  {f.desc}
                </p>
              </>
            );

            return (
              <li key={f.title} className={`relative ${f.span}`}>
                {f.href ? (
                  <Link
                    href={f.href}
                    prefetch
                    className={`${cardClass} block min-h-[132px] touch-manipulation outline-none ring-offset-2 ring-offset-surface-0 focus-visible:ring-2 focus-visible:ring-[var(--accent-cyan)] active:opacity-95`}
                  >
                    {body}
                  </Link>
                ) : (
                  <div className={cardClass}>{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
