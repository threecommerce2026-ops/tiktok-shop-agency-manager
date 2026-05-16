"use client";

import {
  saveCreatorReferralAction,
  updateCreatorTiktokIdAction,
  type AdminActionResult,
} from "@/app/actions/admin-creator-referrals";
import type { CreatorReferralAdminRow } from "@/lib/db/creator-referral-admin-queries";
import { formatYen } from "@/lib/revenue/calc";
import { useActionState } from "react";

type Props = {
  rows: CreatorReferralAdminRow[];
  creators: Array<{ id: string; creatorName: string; tiktokId: string }>;
  referrers: Array<{ id: string; referrerName: string }>;
};

const inputClass =
  "mt-1.5 w-full rounded-xl border border-white/[0.08] bg-surface-0 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-[var(--accent-cyan)]/40";
const labelClass = "text-[11px] font-medium uppercase tracking-wider text-zinc-500";

function CreatorTiktokUpdateForm({ row }: { row: CreatorReferralAdminRow }) {
  const [state, formAction, isPending] = useActionState(
    updateCreatorTiktokIdAction,
    null as AdminActionResult | null,
  );

  if (!row.tiktokIdEditable) {
    return null;
  }

  return (
    <form action={formAction} className="mt-3 space-y-2 rounded-xl border border-white/[0.06] bg-surface-0/50 p-3">
      <input type="hidden" name="creator_id" value={row.creatorId} />
      <label className={labelClass} htmlFor={`tiktok-${row.creatorId}`}>
        TikTok ID を補完
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id={`tiktok-${row.creatorId}`}
          name="tiktok_id"
          placeholder="@username"
          required
          className={inputClass}
        />
        <button
          type="submit"
          disabled={isPending}
          className="inline-flex min-h-[40px] shrink-0 items-center justify-center rounded-lg border border-white/[0.12] px-4 py-2 text-sm font-semibold text-zinc-100 disabled:opacity-50"
        >
          {isPending ? "保存中…" : "TikTok ID を保存"}
        </button>
      </div>
      {state?.ok ? <p className="text-sm text-emerald-300">{state.message}</p> : null}
      {state && !state.ok ? <p className="text-sm text-red-300">{state.error}</p> : null}
    </form>
  );
}

function CreatorReferralForm({
  row,
  creators,
  referrers,
}: {
  row?: CreatorReferralAdminRow;
  creators: Props["creators"];
  referrers: Props["referrers"];
}) {
  const [state, formAction, isPending] = useActionState(saveCreatorReferralAction, null as AdminActionResult | null);
  const isExisting = Boolean(row?.referrerId);

  return (
    <form action={formAction} className="space-y-4 rounded-2xl border border-white/[0.06] bg-surface-1/40 p-4 sm:p-5">
      {isExisting ? <input type="hidden" name="referral_id" value={row?.id} /> : null}
      <h2 className="text-sm font-semibold text-zinc-100">
        {row ? `${row.creatorName} の紹介者紐付け` : "紹介者を紐付け"}
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor={`creator-${row?.id ?? "new"}`}>クリエイター</label>
          <select
            id={`creator-${row?.id ?? "new"}`}
            name="creator_id"
            defaultValue={row?.creatorId ?? ""}
            required
            className={inputClass}
          >
            <option value="">選択してください</option>
            {creators.map((creator) => (
              <option key={creator.id} value={creator.id}>
                {creator.creatorName} ({creator.tiktokId})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass} htmlFor={`referrer-${row?.id ?? "new"}`}>紹介者</label>
          <select
            id={`referrer-${row?.id ?? "new"}`}
            name="referrer_id"
            defaultValue={row?.referrerId ?? ""}
            required
            className={inputClass}
          >
            <option value="">選択してください</option>
            {referrers.map((referrer) => (
              <option key={referrer.id} value={referrer.id}>
                {referrer.referrerName}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass} htmlFor={`rate-${row?.id ?? "new"}`}>紹介率 (0.05 = 5%)</label>
          <input
            id={`rate-${row?.id ?? "new"}`}
            name="referral_rate"
            defaultValue={row?.referralRate ?? 0.05}
            required
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor={`start-${row?.id ?? "new"}`}>開始月</label>
          <input
            id={`start-${row?.id ?? "new"}`}
            name="start_month"
            placeholder="YYYY-MM"
            defaultValue={row?.startMonth ?? ""}
            required
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor={`end-${row?.id ?? "new"}`}>終了月</label>
          <input
            id={`end-${row?.id ?? "new"}`}
            name="end_month"
            placeholder="YYYY-MM"
            defaultValue={row?.endMonth ?? ""}
            className={inputClass}
          />
        </div>
      </div>
      {state?.ok ? <p className="text-sm text-emerald-300">{state.message}</p> : null}
      {state && !state.ok ? <p className="text-sm text-red-300">{state.error}</p> : null}
      {row ? <CreatorTiktokUpdateForm row={row} /> : null}
      <button type="submit" disabled={isPending} className="inline-flex min-h-[40px] items-center justify-center rounded-lg bg-gradient-to-r from-[var(--accent-cyan)]/90 to-[var(--accent-magenta)]/80 px-4 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-50">
        {isPending ? "保存中…" : isExisting ? "紐付けを更新" : "紹介者を紐付け"}
      </button>
    </form>
  );
}

export function CreatorReferralsAdminClient({ rows, creators, referrers }: Props) {
  return (
    <div className="space-y-6">
      <CreatorReferralForm creators={creators} referrers={referrers} />
      <div className="overflow-x-auto rounded-2xl border border-white/[0.06] bg-surface-1/40">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b border-white/[0.06] text-xs uppercase tracking-wider text-zinc-500">
            <tr>
              <th className="px-4 py-3">TikTok名</th>
              <th className="px-4 py-3">TikTok ID</th>
              <th className="px-4 py-3">公式LINE</th>
              <th className="px-4 py-3">登録ステータス</th>
              <th className="px-4 py-3">紹介者</th>
              <th className="px-4 py-3">紹介率</th>
              <th className="px-4 py-3">開始月</th>
              <th className="px-4 py-3">終了月</th>
              <th className="px-4 py-3">今月収益</th>
              <th className="px-4 py-3">今月報酬</th>
              <th className="px-4 py-3">支払い</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-white/[0.04] text-zinc-200">
                <td className="px-4 py-3 font-medium">{row.creatorName}</td>
                <td className="px-4 py-3 font-mono text-xs text-zinc-400">{row.tiktokId}</td>
                <td className="px-4 py-3">{row.officialLineRegistered}</td>
                <td className="px-4 py-3">{row.registrationStatus}</td>
                <td className="px-4 py-3">{row.referrerName ?? "未設定"}</td>
                <td className="px-4 py-3">{row.referralRate}</td>
                <td className="px-4 py-3 font-mono text-xs">{row.startMonth}</td>
                <td className="px-4 py-3 font-mono text-xs">{row.endMonth ?? "—"}</td>
                <td className="px-4 py-3">{formatYen(row.paidProfitMonth)}</td>
                <td className="px-4 py-3">{formatYen(row.referralRewardMonth)}</td>
                <td className="px-4 py-3">
                  {row.payoutStatus ?? "—"}
                  {row.isPayable ? " / 対象" : " / 対象外"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="space-y-6">
        {rows
          .filter((row) => row.referrerId)
          .map((row) => (
            <CreatorReferralForm key={row.id} row={row} creators={creators} referrers={referrers} />
          ))}
      </div>
    </div>
  );
}
