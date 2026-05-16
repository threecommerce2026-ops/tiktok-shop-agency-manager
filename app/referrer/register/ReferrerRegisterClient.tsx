"use client";

import {
  registerReferrerAction,
  type ReferrerPortalActionResult,
} from "@/app/actions/referrer-portal";
import { createClient } from "@/lib/supabase/client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";

const inputClass =
  "mt-2 block w-full min-h-[48px] rounded-xl border border-white/[0.08] bg-surface-0/80 px-4 text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-[var(--accent-cyan)]/50 focus:ring-2 focus:ring-[var(--accent-cyan)]/20";
const labelClass = "block text-xs font-semibold uppercase tracking-wider text-zinc-500";

type RegisterFormState = {
  name: string;
  email: string;
  phone: string;
  password: string;
  bankName: string;
  bankBranchName: string;
  bankAccountType: string;
  bankAccountNumber: string;
  bankAccountHolder: string;
  lineId: string;
  memo: string;
};

const initialForm: RegisterFormState = {
  name: "",
  email: "",
  phone: "",
  password: "",
  bankName: "",
  bankBranchName: "",
  bankAccountType: "普通",
  bankAccountNumber: "",
  bankAccountHolder: "",
  lineId: "",
  memo: "",
};

function validateForm(form: RegisterFormState): string | null {
  if (!form.name.trim()) return "本名を入力してください";
  if (!form.email.trim()) return "メールアドレスを入力してください";
  if (!form.phone.trim()) return "電話番号を入力してください";
  if (!form.password.trim()) return "パスワードを入力してください";
  if (form.password.length < 6) return "パスワードは 6 文字以上で入力してください";
  if (!form.bankName.trim()) return "振込先銀行名を入力してください";
  if (!form.bankBranchName.trim()) return "支店名を入力してください";
  if (!form.bankAccountType.trim()) return "口座種別を選択してください";
  if (!form.bankAccountNumber.trim()) return "口座番号を入力してください";
  if (!form.bankAccountHolder.trim()) return "口座名義を入力してください";
  return null;
}

export function ReferrerRegisterClient() {
  const router = useRouter();
  const [form, setForm] = useState<RegisterFormState>(initialForm);
  const [clientError, setClientError] = useState<string | null>(null);
  const [state, formAction, isPending] = useActionState(
    registerReferrerAction,
    null as ReferrerPortalActionResult | null,
  );

  useEffect(() => {
    if (!state?.ok) return;

    let cancelled = false;
    async function completeRegistration() {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithPassword({
        email: form.email,
        password: form.password,
      });
      if (cancelled) return;
      if (error) {
        setClientError(
          error.message === "Invalid login credentials"
            ? "登録は完了しましたがログインに失敗しました。ログイン画面から再度お試しください。"
            : error.message,
        );
        return;
      }
      router.refresh();
      router.push("/referrer/dashboard");
    }

    void completeRegistration();
    return () => {
      cancelled = true;
    };
  }, [state?.ok, form.email, form.password, router]);

  function updateField<K extends keyof RegisterFormState>(key: K, value: RegisterFormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setClientError(null);
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validationError = validateForm(form);
    if (validationError) {
      setClientError(validationError);
      return;
    }

    const formData = new FormData(event.currentTarget);
    formData.set("name", form.name.trim());
    formData.set("email", form.email.trim());
    formData.set("phone", form.phone.trim());
    formData.set("password", form.password);
    formData.set("bank_name", form.bankName.trim());
    formData.set("bank_branch_name", form.bankBranchName.trim());
    formData.set("bank_account_type", form.bankAccountType);
    formData.set("bank_account_number", form.bankAccountNumber.trim());
    formData.set("bank_account_holder", form.bankAccountHolder.trim());
    formData.set("line_id", form.lineId.trim());
    formData.set("memo", form.memo.trim());
    formAction(formData);
  }

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-8 sm:px-6 sm:py-10">
      <div className="mb-6 text-center">
        <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-300">
          ← トップへ
        </Link>
      </div>

      <form
        onSubmit={handleSubmit}
        className="space-y-4 rounded-2xl border border-white/[0.06] bg-surface-1/40 p-5 sm:p-6"
      >
        <div>
          <label className={labelClass} htmlFor="name">本名</label>
          <input
            id="name"
            name="name"
            value={form.name}
            onChange={(event) => updateField("name", event.target.value)}
            required
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="email">メールアドレス</label>
          <input
            id="email"
            name="email"
            type="email"
            value={form.email}
            onChange={(event) => updateField("email", event.target.value)}
            required
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="phone">電話番号</label>
          <input
            id="phone"
            name="phone"
            value={form.phone}
            onChange={(event) => updateField("phone", event.target.value)}
            required
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="password">ログインパスワード</label>
          <input
            id="password"
            name="password"
            type="password"
            minLength={6}
            value={form.password}
            onChange={(event) => updateField("password", event.target.value)}
            required
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="bank_name">振込先銀行名</label>
          <input
            id="bank_name"
            name="bank_name"
            value={form.bankName}
            onChange={(event) => updateField("bankName", event.target.value)}
            required
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="bank_branch_name">支店名</label>
          <input
            id="bank_branch_name"
            name="bank_branch_name"
            value={form.bankBranchName}
            onChange={(event) => updateField("bankBranchName", event.target.value)}
            required
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="bank_account_type">口座種別</label>
          <select
            id="bank_account_type"
            name="bank_account_type"
            value={form.bankAccountType}
            onChange={(event) => updateField("bankAccountType", event.target.value)}
            required
            className={inputClass}
          >
            <option value="普通">普通</option>
            <option value="当座">当座</option>
          </select>
        </div>
        <div>
          <label className={labelClass} htmlFor="bank_account_number">口座番号</label>
          <input
            id="bank_account_number"
            name="bank_account_number"
            value={form.bankAccountNumber}
            onChange={(event) => updateField("bankAccountNumber", event.target.value)}
            required
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="bank_account_holder">口座名義</label>
          <input
            id="bank_account_holder"
            name="bank_account_holder"
            value={form.bankAccountHolder}
            onChange={(event) => updateField("bankAccountHolder", event.target.value)}
            required
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="line_id">LINE ID（任意）</label>
          <input
            id="line_id"
            name="line_id"
            value={form.lineId}
            onChange={(event) => updateField("lineId", event.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="memo">メモ（任意）</label>
          <textarea
            id="memo"
            name="memo"
            rows={3}
            value={form.memo}
            onChange={(event) => updateField("memo", event.target.value)}
            className={inputClass}
          />
        </div>

        {state?.ok ? <p className="text-sm text-emerald-300">{state.message}</p> : null}
        {clientError ? <p className="text-sm text-red-300">{clientError}</p> : null}
        {state && !state.ok ? <p className="text-sm text-red-300">{state.error}</p> : null}

        <button
          type="submit"
          disabled={isPending || Boolean(state?.ok)}
          className="flex w-full min-h-[48px] items-center justify-center rounded-full bg-zinc-100 text-base font-semibold text-surface-0 disabled:opacity-60"
        >
          {isPending || state?.ok ? "登録中…" : "紹介者として登録する"}
        </button>
      </form>
    </div>
  );
}
