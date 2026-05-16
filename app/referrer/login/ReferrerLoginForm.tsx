"use client";

import { createClient } from "@/lib/supabase/client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

export function ReferrerLoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? "/referrer/dashboard";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    setLoading(false);
    if (signInError) {
      setError(
        signInError.message === "Invalid login credentials"
          ? "メールアドレスまたはパスワードが正しくありません。"
          : signInError.message,
      );
      return;
    }

    router.refresh();
    router.push(next);
  }

  return (
    <div className="mx-auto w-full max-w-md px-4 py-8 sm:px-6 sm:py-10">
      <div className="mb-6 text-center">
        <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-300">
          ← トップへ
        </Link>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5 rounded-2xl border border-white/[0.06] bg-surface-1/40 p-6">
        {error ? (
          <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200" role="alert">
            {error}
          </p>
        ) : null}
        <div>
          <label htmlFor="email" className="block text-xs font-semibold uppercase tracking-wider text-zinc-500">
            メールアドレス
          </label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            className="mt-2 block w-full min-h-[48px] rounded-xl border border-white/[0.08] bg-surface-0/80 px-4 text-zinc-100 outline-none focus:border-[var(--accent-cyan)]/50"
          />
        </div>
        <div>
          <label htmlFor="password" className="block text-xs font-semibold uppercase tracking-wider text-zinc-500">
            パスワード
          </label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            minLength={6}
            className="mt-2 block w-full min-h-[48px] rounded-xl border border-white/[0.08] bg-surface-0/80 px-4 text-zinc-100 outline-none focus:border-[var(--accent-cyan)]/50"
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          className="flex w-full min-h-[48px] items-center justify-center rounded-full bg-zinc-100 text-base font-semibold text-surface-0 disabled:opacity-60"
        >
          {loading ? "ログイン中…" : "ログイン"}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-zinc-500">
        初めての方は{" "}
        <Link href="/referrer/register" className="text-[var(--accent-cyan)] hover:underline">
          紹介者登録
        </Link>
      </p>
    </div>
  );
}
