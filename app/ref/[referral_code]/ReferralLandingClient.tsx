"use client";

import {
  registerCreatorViaReferralAction,
  type ReferrerPortalActionResult,
} from "@/app/actions/referrer-portal";
import { useActionState, useState } from "react";

const inputClass =
  "mt-2 block w-full min-h-[48px] rounded-xl border border-white/[0.08] bg-surface-0/80 px-4 text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-[var(--accent-cyan)]/50 focus:ring-2 focus:ring-[var(--accent-cyan)]/20";
const labelClass = "block text-xs font-semibold uppercase tracking-wider text-zinc-500";

export function ReferralLandingClient({
  referralCode,
  officialLineUrl,
}: {
  referralCode: string;
  officialLineUrl: string | null;
}) {
  const [officialLineRegistered, setOfficialLineRegistered] = useState(false);
  const [state, formAction, isPending] = useActionState(
    registerCreatorViaReferralAction,
    null as ReferrerPortalActionResult | null,
  );

  if (state?.ok) {
    return (
      <div className="mx-auto w-full max-w-xl px-4 pb-10 pt-6 sm:px-6 sm:pb-12">
        <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/10 p-6 text-center">
          <p className="text-lg font-semibold text-emerald-100">
            登録ありがとうございます。公式LINEの案内に従ってください。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-xl px-4 pb-10 pt-6 sm:px-6 sm:pb-12">
      {officialLineUrl ? (
        <div>
          <a
            href={officialLineUrl}
            target="_blank"
            rel="noreferrer"
            className="flex min-h-[72px] w-full items-center justify-center rounded-2xl bg-[#06C755] px-6 text-lg font-bold text-white shadow-lg shadow-[#06C755]/20 hover:brightness-110"
          >
            公式LINEを追加する
          </a>
          <p className="mt-3 text-center text-sm text-zinc-500">
            公式LINEを追加したうえで、下のフォームを送信してください
          </p>
        </div>
      ) : (
        <p className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          公式LINE URL が未設定です。管理者に `NEXT_PUBLIC_OFFICIAL_LINE_URL` の設定を依頼してください。
        </p>
      )}

      <form action={formAction} className="mt-8 space-y-4 rounded-2xl border border-white/[0.06] bg-surface-1/40 p-5 sm:p-6">
        <input type="hidden" name="referral_code" value={referralCode} />
        <div>
          <label className={labelClass} htmlFor="creator_name">
            TikTok名
          </label>
          <input id="creator_name" name="creator_name" required className={inputClass} />
        </div>
        <div>
          <label className={labelClass} htmlFor="tiktok_id">
            TikTok ID（プロフィールに記載の＠以降）
          </label>
          <input
            id="tiktok_id"
            name="tiktok_id"
            placeholder="username"
            autoComplete="off"
            required
            className={inputClass}
          />
        </div>
        <label className="flex min-h-[48px] items-start gap-3 rounded-xl border border-white/[0.08] bg-surface-0/60 px-4 py-3 text-sm text-zinc-200">
          <input
            type="checkbox"
            name="official_line_registered"
            checked={officialLineRegistered}
            onChange={(event) => setOfficialLineRegistered(event.target.checked)}
            className="mt-1 h-4 w-4 rounded border-white/20"
          />
          <span>公式LINEに登録しました</span>
        </label>

        {state && !state.ok ? <p className="text-sm text-red-300">{state.error}</p> : null}

        <button
          type="submit"
          disabled={isPending || !officialLineRegistered}
          className="flex w-full min-h-[48px] items-center justify-center rounded-full bg-zinc-100 text-base font-semibold text-surface-0 disabled:opacity-60"
        >
          {isPending ? "送信中…" : "登録する"}
        </button>
      </form>
    </div>
  );
}
