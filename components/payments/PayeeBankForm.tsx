"use client";

import { useActionState, useState } from "react";

import {
  savePayeeBankAccountAction,
  type PayeeBankActionResult,
} from "@/app/actions/payee-bank";
import {
  BANK_ACCOUNT_STATE_LABEL,
  BANK_ACCOUNT_TYPES,
  type BankAccountView,
} from "@/lib/payments/bank-account";
import { PAYEE_KIND_LABEL, type PayeeKind } from "@/lib/payments/payable";

/*
  支払先の振込先口座フォーム（代理店・紹介者で共通）。

  ■ 口座番号を初期値に入れない
  サーバーから渡ってくるのはマスク済みの表示用データだけで、
  全文はこのコンポーネントに存在しない。
  変更するときは毎回入力し直す（画面に残さない方が安全）。
*/

const label = "block text-[11px] font-medium text-zinc-400";
const input =
  "mt-1 w-full rounded-lg border border-white/[0.1] bg-surface-1 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-[var(--accent-cyan)]";

const STATE_CLASS: Record<BankAccountView["state"], string> = {
  registered: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  incomplete: "border-amber-400/25 bg-amber-400/10 text-amber-200",
  missing: "border-red-400/25 bg-red-400/10 text-red-200",
};

export function BankStateBadge({ state }: { state: BankAccountView["state"] }) {
  return (
    <span
      className={`whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] ${STATE_CLASS[state]}`}
    >
      {BANK_ACCOUNT_STATE_LABEL[state]}
    </span>
  );
}

export function PayeeBankForm({
  payeeKind,
  payeeId,
  payeeName,
  bank,
}: {
  payeeKind: PayeeKind;
  payeeId: string;
  payeeName: string;
  bank: BankAccountView;
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(
    savePayeeBankAccountAction,
    null as PayeeBankActionResult | null,
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <BankStateBadge state={bank.state} />
        <span className="text-[11px] text-zinc-500">
          {bank.bankName
            ? `${bank.bankName}${bank.bankCode ? `（${bank.bankCode}）` : ""} ${
                bank.bankBranchName ?? ""
              }${bank.bankBranchCode ? `（${bank.bankBranchCode}）` : ""} ${
                bank.bankAccountType ?? ""
              } ${bank.accountNumberMasked}`
            : "振込先が未登録です"}
        </span>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="min-h-[32px] rounded-lg border border-white/[0.1] px-3 text-[11px] font-medium text-zinc-300 hover:bg-white/[0.06]"
        >
          {open ? "閉じる" : bank.state === "missing" ? "登録" : "編集"}
        </button>
      </div>

      {state ? (
        <p
          className={`rounded-lg border px-3 py-2 text-[11px] ${
            state.ok
              ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-200"
              : "border-red-500/25 bg-red-500/10 text-red-200"
          }`}
          role="status"
        >
          {state.ok ? state.message : state.error}
        </p>
      ) : null}

      {open ? (
        <form action={action} className="space-y-3 rounded-xl border border-white/[0.08] bg-surface-1/60 p-4">
          <input type="hidden" name="payee_kind" value={payeeKind} />
          <input type="hidden" name="payee_id" value={payeeId} />

          <p className="text-[11px] leading-relaxed text-zinc-500">
            {PAYEE_KIND_LABEL[payeeKind]}「{payeeName}」の振込先。
            銀行コードと支店コードは振込CSVの出力に必要です。
            口座番号は保存後、画面には下4桁だけを表示します。
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={label} htmlFor={`bank_name_${payeeId}`}>銀行名</label>
              <input
                id={`bank_name_${payeeId}`}
                name="bank_name"
                defaultValue={bank.bankName ?? ""}
                className={input}
                autoComplete="off"
              />
            </div>
            <div>
              <label className={label} htmlFor={`bank_code_${payeeId}`}>銀行コード（4桁）</label>
              <input
                id={`bank_code_${payeeId}`}
                name="bank_code"
                defaultValue={bank.bankCode ?? ""}
                className={input}
                inputMode="numeric"
                autoComplete="off"
              />
            </div>
            <div>
              <label className={label} htmlFor={`branch_name_${payeeId}`}>支店名</label>
              <input
                id={`branch_name_${payeeId}`}
                name="bank_branch_name"
                defaultValue={bank.bankBranchName ?? ""}
                className={input}
                autoComplete="off"
              />
            </div>
            <div>
              <label className={label} htmlFor={`branch_code_${payeeId}`}>支店コード（3桁）</label>
              <input
                id={`branch_code_${payeeId}`}
                name="bank_branch_code"
                defaultValue={bank.bankBranchCode ?? ""}
                className={input}
                inputMode="numeric"
                autoComplete="off"
              />
            </div>
            <div>
              <label className={label} htmlFor={`account_type_${payeeId}`}>口座種別</label>
              <select
                id={`account_type_${payeeId}`}
                name="bank_account_type"
                defaultValue={bank.bankAccountType ?? BANK_ACCOUNT_TYPES[0]}
                className={input}
              >
                {BANK_ACCOUNT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={label} htmlFor={`account_number_${payeeId}`}>
                口座番号{bank.accountNumberMasked ? `（現在: ${bank.accountNumberMasked}）` : ""}
              </label>
              <input
                id={`account_number_${payeeId}`}
                name="bank_account_number"
                className={input}
                inputMode="numeric"
                autoComplete="off"
                placeholder="変更する場合のみ入力"
              />
            </div>
            <div className="sm:col-span-2">
              <label className={label} htmlFor={`account_holder_${payeeId}`}>口座名義（カナ）</label>
              <input
                id={`account_holder_${payeeId}`}
                name="bank_account_holder"
                defaultValue={bank.bankAccountHolder ?? ""}
                className={input}
                autoComplete="off"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={pending}
            className="min-h-[40px] rounded-lg bg-[var(--accent-cyan)] px-4 text-sm font-semibold text-black disabled:opacity-50"
          >
            {pending ? "保存中…" : "振込先を保存"}
          </button>
        </form>
      ) : null}
    </div>
  );
}
