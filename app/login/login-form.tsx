"use client";

import { createClient } from "@/lib/supabase/client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

type Mode = "login" | "signup";

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? "/dashboard";

  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const urlError = searchParams.get("error");
  const initialError =
    urlError === "auth"
      ? "認証に失敗しました。もう一度お試しください。"
      : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    setLoading(true);

    const supabase = createClient();
    const origin = window.location.origin;

    try {
      if (mode === "signup") {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
          },
        });

        if (signUpError) {
          setError(signUpError.message);
          return;
        }

        if (data.session) {
          router.refresh();
          router.push(next);
          return;
        }

        setMessage(
          "確認メールを送信しました。メール内のリンクを開くとログインが完了します。",
        );
        return;
      }

      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

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
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-md">
      <div className="mb-8 text-center">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm text-zinc-500 transition hover:text-zinc-300"
        >
          ← トップへ
        </Link>
        <h1 className="mt-6 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
          アカウント
        </h1>
        <p className="mt-2 text-sm text-zinc-500">
          メールアドレスとパスワードでログインまたは新規登録
        </p>
      </div>

      <div className="flex rounded-full border border-white/[0.08] bg-surface-1/80 p-1">
        <button
          type="button"
          onClick={() => {
            setMode("login");
            setError(null);
            setMessage(null);
          }}
          className={`min-h-[44px] flex-1 rounded-full text-sm font-semibold transition ${
            mode === "login"
              ? "bg-gradient-to-r from-[var(--accent-cyan)]/90 to-[var(--accent-magenta)]/90 text-surface-0 shadow-lg"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          ログイン
        </button>
        <button
          type="button"
          onClick={() => {
            setMode("signup");
            setError(null);
            setMessage(null);
          }}
          className={`min-h-[44px] flex-1 rounded-full text-sm font-semibold transition ${
            mode === "signup"
              ? "bg-gradient-to-r from-[var(--accent-cyan)]/90 to-[var(--accent-magenta)]/90 text-surface-0 shadow-lg"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          新規登録
        </button>
      </div>

      <form
        onSubmit={handleSubmit}
        className="mt-8 space-y-5 rounded-2xl border border-white/[0.06] bg-surface-2/40 p-6 ring-glow sm:p-8"
      >
        {(error || initialError) && (
          <p
            className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200"
            role="alert"
          >
            {error ?? initialError}
          </p>
        )}
        {message && (
          <p className="rounded-lg border border-[var(--accent-cyan)]/30 bg-[var(--accent-cyan)]/10 px-3 py-2 text-sm text-zinc-200">
            {message}
          </p>
        )}

        <div>
          <label
            htmlFor="email"
            className="block text-xs font-semibold uppercase tracking-wider text-zinc-500"
          >
            メールアドレス
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-2 block w-full min-h-[48px] rounded-xl border border-white/[0.08] bg-surface-0/80 px-4 text-zinc-100 placeholder:text-zinc-600 outline-none ring-0 transition focus:border-[var(--accent-cyan)]/50 focus:ring-2 focus:ring-[var(--accent-cyan)]/20"
            placeholder="you@example.com"
          />
        </div>

        <div>
          <label
            htmlFor="password"
            className="block text-xs font-semibold uppercase tracking-wider text-zinc-500"
          >
            パスワード
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete={
              mode === "signup" ? "new-password" : "current-password"
            }
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-2 block w-full min-h-[48px] rounded-xl border border-white/[0.08] bg-surface-0/80 px-4 text-zinc-100 placeholder:text-zinc-600 outline-none transition focus:border-[var(--accent-cyan)]/50 focus:ring-2 focus:ring-[var(--accent-cyan)]/20"
            placeholder="6文字以上"
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="flex w-full min-h-[48px] items-center justify-center rounded-full bg-zinc-100 text-base font-semibold text-surface-0 transition hover:bg-white disabled:opacity-60"
        >
          {loading
            ? "処理中…"
            : mode === "login"
              ? "ログイン"
              : "登録する"}
        </button>
      </form>
    </div>
  );
}
