import { signOutReferrer } from "@/lib/auth/actions";

export function ReferrerSignOutButton() {
  return (
    <form action={signOutReferrer}>
      <button
        type="submit"
        className="min-h-[44px] touch-manipulation rounded-full border border-white/[0.12] px-5 text-sm font-medium text-zinc-300 transition hover:border-[var(--accent-magenta)]/40 hover:text-white"
      >
        ログアウト
      </button>
    </form>
  );
}
