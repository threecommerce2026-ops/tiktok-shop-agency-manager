const steps = [
  {
    phase: "01",
    title: "代理店 × 認証",
    body: "代理店 ID とユーザーを紐づけ、RLS で閲覧を制限。",
  },
  {
    phase: "02",
    title: "Supabase + CSV",
    body: "売上テーブルへインポート、冪等キーで再実行可能に。",
  },
  {
    phase: "03",
    title: "TikTok Shop API",
    body: "注文・取引イベントを正規化し、同じ KPI にマッピング。",
  },
];

export function RoadmapTeaser() {
  return (
    <section
      id="roadmap"
      className="scroll-mt-20 px-4 py-16 sm:px-6 sm:py-20"
    >
      <div className="mx-auto max-w-6xl">
        <h2 className="text-xl font-bold text-zinc-100 sm:text-2xl">
          ロードマップ（方向性）
        </h2>
        <ol className="mt-8 grid gap-4 sm:grid-cols-3">
          {steps.map((s) => (
            <li
              key={s.phase}
              className="relative overflow-hidden rounded-2xl border border-white/[0.06] bg-gradient-to-b from-surface-2/80 to-surface-0 p-6"
            >
              <span className="font-mono text-xs font-bold text-[var(--accent-magenta)]">
                {s.phase}
              </span>
              <h3 className="mt-2 text-lg font-semibold text-zinc-50">{s.title}</h3>
              <p className="mt-2 text-sm text-zinc-500">{s.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
