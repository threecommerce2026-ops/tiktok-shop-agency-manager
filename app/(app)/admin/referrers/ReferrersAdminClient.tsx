"use client";

import {
  saveReferrerAction,
  type AdminActionResult,
} from "@/app/actions/admin-referrers";
import type { ReferrerAdminCreatorRow, ReferrerAdminRow } from "@/lib/db/referrer-admin-queries";
import { formatYen, formatYenPrecise } from "@/lib/revenue/calc";
import Link from "next/link";
import { useActionState } from "react";

type Props = {
  referrers: ReferrerAdminRow[];
  referralLinks: Record<string, string>;
  targetMonth: string;
  selectedReferrerId: string | null;
  selectedReferrer: ReferrerAdminRow | null;
  creators: ReferrerAdminCreatorRow[];
};

const inputClass =
  "mt-1.5 w-full rounded-xl border border-white/[0.08] bg-surface-0 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-[var(--accent-cyan)]/40";
const labelClass = "text-[11px] font-medium uppercase tracking-wider text-zinc-500";

function ReferrerForm({ referrer }: { referrer?: ReferrerAdminRow }) {
  const [state, formAction, isPending] = useActionState(saveReferrerAction, null as AdminActionResult | null);

  return (
    <form action={formAction} className="space-y-4 rounded-2xl border border-white/[0.06] bg-surface-1/40 p-4 sm:p-5">
      {referrer ? <input type="hidden" name="referrer_id" value={referrer.id} /> : null}
      <h2 className="text-sm font-semibold text-zinc-100">
        {referrer ? `${referrer.referrerName} の情報を編集` : "紹介者を追加"}
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {referrer ? (
          <div className="rounded-xl border border-white/[0.08] bg-surface-0 px-3 py-2.5 sm:col-span-2">
            <p className={labelClass}>紹介者名</p>
            <p className="mt-1 text-sm font-medium text-zinc-100">{referrer.referrerName}</p>
            <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
              紹介者名はこのフォームからは変更できません。上部の「紹介者マスタ（名称編集）」の
              <span className="text-zinc-300">名称編集</span>
              から変更してください（変更履歴が残ります）。
            </p>
          </div>
        ) : (
          <div>
            <label className={labelClass} htmlFor="referrer-name-new">紹介者名</label>
            <input id="referrer-name-new" name="referrer_name" defaultValue="" required className={inputClass} />
          </div>
        )}
        <div>
          <label className={labelClass} htmlFor={`referrer-email-${referrer?.id ?? "new"}`}>メール</label>
          <input id={`referrer-email-${referrer?.id ?? "new"}`} name="email" type="email" defaultValue={referrer?.email ?? ""} className={inputClass} />
        </div>
        <div>
          <label className={labelClass} htmlFor={`referrer-phone-${referrer?.id ?? "new"}`}>電話番号</label>
          <input id={`referrer-phone-${referrer?.id ?? "new"}`} name="phone" defaultValue={referrer?.phone ?? ""} className={inputClass} />
        </div>
        <div className="sm:col-span-2">
          <label className={labelClass} htmlFor={`referrer-memo-${referrer?.id ?? "new"}`}>メモ</label>
          <textarea id={`referrer-memo-${referrer?.id ?? "new"}`} name="memo" defaultValue={referrer?.memo ?? ""} rows={3} className={inputClass} />
        </div>
        <label className="flex min-h-[44px] items-center gap-2 rounded-xl border border-white/[0.08] bg-surface-0 px-3 py-2 text-sm text-zinc-300 sm:col-span-2">
          <input type="checkbox" name="is_active" defaultChecked={referrer?.isActive ?? true} />
          有効な紹介者として扱う
        </label>
      </div>
      {state?.ok ? <p className="text-sm text-emerald-300">{state.message}</p> : null}
      {state && !state.ok ? <p className="text-sm text-red-300">{state.error}</p> : null}
      <button type="submit" disabled={isPending} className="inline-flex min-h-[40px] items-center justify-center rounded-lg bg-gradient-to-r from-[var(--accent-cyan)]/90 to-[var(--accent-magenta)]/80 px-4 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-50">
        {isPending ? "保存中…" : referrer ? "情報を更新" : "紹介者を追加"}
      </button>
    </form>
  );
}

export function ReferrersAdminClient({
  referrers,
  referralLinks,
  targetMonth,
  selectedReferrerId,
  selectedReferrer,
  creators,
}: Props) {
  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-white/[0.06] bg-surface-1/40 px-4 py-3 text-xs text-zinc-400">
        報酬の集計・支払い確定は{" "}
        <Link href="/revenue?tab=referral" className="text-[var(--accent-cyan)] hover:underline">
          売上・報酬 › 紹介者報酬
        </Link>{" "}
        に集約しています。この画面は紹介者マスタの編集用です。
      </div>

      <ReferrerForm />
      <div className="overflow-x-auto rounded-2xl border border-white/[0.06] bg-surface-1/40">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b border-white/[0.06] text-xs uppercase tracking-wider text-zinc-500">
            <tr>
              <th className="px-4 py-3">紹介者名</th>
              <th className="px-4 py-3">メール</th>
              <th className="px-4 py-3">電話</th>
              <th className="px-4 py-3">紹介リンク</th>
              <th className="px-4 py-3">紹介CR数</th>
              <th className="px-4 py-3">今月報酬</th>
              <th className="px-4 py-3">累計報酬</th>
              <th className="px-4 py-3">支払い対象</th>
              <th className="px-4 py-3">状態</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {referrers.map((referrer) => (
              <tr key={referrer.id} className="border-b border-white/[0.04] text-zinc-200">
                <td className="px-4 py-3 font-medium">{referrer.referrerName}</td>
                <td className="px-4 py-3">{referrer.email ?? "—"}</td>
                <td className="px-4 py-3">{referrer.phone ?? "—"}</td>
                <td className="px-4 py-3">
                  {referrer.referralCode ? (
                    <span className="break-all font-mono text-xs text-zinc-400">
                      {referralLinks[referrer.id] ?? referrer.referralCode}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-4 py-3">{referrer.creatorCount}</td>
                <td className="px-4 py-3">{formatYenPrecise(referrer.rewardMonth)}</td>
                <td className="px-4 py-3">{formatYenPrecise(referrer.rewardTotal)}</td>
                <td className="px-4 py-3">{referrer.isPayableMonth ? "対象" : "対象外"}</td>
                <td className="px-4 py-3">{referrer.isActive ? "有効" : "無効"}</td>
                <td className="px-4 py-3">
                  <Link href={`/admin/referrers?referrerId=${referrer.id}`} className="text-[var(--accent-cyan)] hover:underline">
                    詳細
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selectedReferrerId && selectedReferrer ? (
        <section className="space-y-5 rounded-2xl border border-white/[0.06] bg-surface-1/40 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-zinc-100">
                {selectedReferrer.referrerName} の紹介クリエイター
              </h2>
              <p className="mt-1 text-xs text-zinc-500">対象月: {targetMonth}</p>
            </div>
            <div className="flex gap-3">
              <Link
                href={`/revenue?tab=referral&referrerId=${selectedReferrerId}`}
                className="text-sm text-[var(--accent-cyan)] hover:underline"
              >
                報酬・支払いを見る
              </Link>
              <Link href="/admin/referrers" className="text-sm text-zinc-400 hover:text-zinc-200">
                一覧に戻る
              </Link>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <SummaryCard label="今月報酬" value={formatYenPrecise(selectedReferrer.rewardMonth)} />
            <SummaryCard label="累計報酬" value={formatYenPrecise(selectedReferrer.rewardTotal)} />
            <SummaryCard
              label="支払い対象"
              value={selectedReferrer.isPayableMonth ? "対象" : "対象外（繰越）"}
            />
          </div>

          <div className="overflow-x-auto rounded-xl border border-white/[0.06]">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b border-white/[0.06] text-xs uppercase tracking-wider text-zinc-500">
                <tr>
                  <th className="px-3 py-2">TikTok名</th>
                  <th className="px-3 py-2">TikTok ID</th>
                  <th className="px-3 py-2">公式LINE</th>
                  <th className="px-3 py-2">開始月</th>
                  <th className="px-3 py-2">今月報酬</th>
                  <th className="px-3 py-2">累計支払い</th>
                  <th className="px-3 py-2">残り上限</th>
                  <th className="px-3 py-2">上限</th>
                  <th className="px-3 py-2">状態</th>
                </tr>
              </thead>
              <tbody>
                {creators.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-3 py-6 text-center text-zinc-500">
                      紹介クリエイターがいません
                    </td>
                  </tr>
                ) : (
                  creators.map((creator) => (
                    <tr key={creator.creatorId} className="border-b border-white/[0.04] text-zinc-200">
                      <td className="px-3 py-2">{creator.creatorName}</td>
                      <td className="px-3 py-2 font-mono text-xs text-zinc-400">{creator.tiktokId}</td>
                      <td className="px-3 py-2">{creator.officialLineRegistered}</td>
                      <td className="px-3 py-2 font-mono text-xs">{creator.startMonth}</td>
                      <td className="px-3 py-2">{formatYenPrecise(creator.rewardMonth)}</td>
                      <td className="px-3 py-2">{formatYen(creator.lifetimePaidAmount)}</td>
                      <td className="px-3 py-2">{formatYen(creator.remainingCap)}</td>
                      <td className="px-3 py-2">
                        {creator.capReached ? (
                          <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-100">
                            上限到達
                          </span>
                        ) : (
                          formatYen(creator.lifetimePayoutCap)
                        )}
                      </td>
                      <td className="px-3 py-2">{creator.isActive ? "有効" : "無効"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <div className="space-y-6">
        {referrers.map((referrer) => (
          <ReferrerForm key={referrer.id} referrer={referrer} />
        ))}
      </div>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-surface-0/60 px-4 py-3">
      <p className="text-[11px] uppercase tracking-wider text-zinc-500">{label}</p>
      <p className="mt-1 text-base font-semibold text-zinc-100">{value}</p>
    </div>
  );
}
