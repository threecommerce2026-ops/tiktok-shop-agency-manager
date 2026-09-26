"use server";

import { revalidatePath } from "next/cache";

import { requireAdminAction } from "@/lib/db/admin-access";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { mapSupabaseErrorToJa } from "@/lib/supabase/error-ja";
import {
  bankAccountToRow,
  validateBankAccountInput,
} from "@/lib/payments/bank-account";
import { isPayeeKind } from "@/lib/payments/payable";

/*
  支払先（代理店・紹介者）の振込先口座の登録・編集。

  ■ サービスロールで書く理由
  agencies の銀行列は authenticated から列単位で SELECT / UPDATE を外してある
  （migration 20260925100000）。ログインユーザーのクライアントでは書けない。
  管理者判定は requireAdminAction() がサーバー側で担保する。

  ■ 口座番号を画面へ返さない
  保存後に値をそのまま返すことはしない。一覧は常にマスク済みの形を読み直す。

  ■ 触らないもの
  報酬明細・支払明細・請求書には一切アクセスしない。
*/

export type PayeeBankActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

function readText(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

export async function savePayeeBankAccountAction(
  _prev: PayeeBankActionResult | null,
  formData: FormData,
): Promise<PayeeBankActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const payeeKind = readText(formData, "payee_kind");
  const payeeId = readText(formData, "payee_id");

  if (!isPayeeKind(payeeKind)) {
    return { ok: false, error: "支払先の種別が不正です" };
  }
  if (!payeeId) {
    return { ok: false, error: "支払先を指定してください" };
  }

  /*
    振込先は代理店側だけで管理する。
    紹介者報酬は所属代理店へ合算して支払うため、紹介者に口座を
    二重登録する運用にはしない。所属代理店が未設定なら、口座登録ではなく
    「紹介者管理」で所属代理店を設定するのが正しい解決。
    既存の紹介者口座データは残す（参照しなくなるだけ）。
  */
  if (payeeKind === "referrer") {
    return {
      ok: false,
      error:
        "紹介者への振込先は登録しません。紹介者報酬は所属代理店へ合算して支払います。「紹介者管理」で所属代理店を設定し、その代理店に振込先を登録してください。",
    };
  }

  const admin = getSupabaseAdmin();
  const table = payeeKind === "agency" ? "agencies" : "referrers";

  /*
    口座番号はフォームの初期値に入れていない（画面へ全文を出さないため）。
    未入力のときは既存の値を据え置く。
    「口座を消す」意図は、全項目を空にして送ったときだけ成立させる。
  */
  const { data: current, error: currentError } = await admin
    .from(table)
    .select("id, bank_account_number")
    .eq("id", payeeId)
    .maybeSingle();

  if (currentError) {
    return { ok: false, error: mapSupabaseErrorToJa(currentError.message) };
  }
  if (!current?.id) {
    return { ok: false, error: "支払先が見つかりません" };
  }

  const inputAccountNumber = readText(formData, "bank_account_number");
  const otherFieldsFilled = [
    "bank_name",
    "bank_code",
    "bank_branch_name",
    "bank_branch_code",
    "bank_account_type",
    "bank_account_holder",
  ].some((key) => readText(formData, key).length > 0);

  const accountNumber =
    inputAccountNumber ||
    (otherFieldsFilled ? String(current.bank_account_number ?? "") : "");

  const validation = validateBankAccountInput({
    bankName: readText(formData, "bank_name"),
    bankCode: readText(formData, "bank_code"),
    bankBranchName: readText(formData, "bank_branch_name"),
    bankBranchCode: readText(formData, "bank_branch_code"),
    bankAccountType: readText(formData, "bank_account_type"),
    bankAccountNumber: accountNumber,
    bankAccountHolder: readText(formData, "bank_account_holder"),
  });

  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }

  const payload: Record<string, unknown> = bankAccountToRow(validation.account);

  // agencies には updated_at が無いので触らない

  const { data, error } = await admin
    .from(table)
    .update(payload)
    .eq("id", payeeId)
    .select("id")
    .maybeSingle();

  if (error) {
    return { ok: false, error: mapSupabaseErrorToJa(error.message) };
  }
  if (!data?.id) {
    return { ok: false, error: "支払先が見つかりません" };
  }

  revalidatePath("/payments");
  revalidatePath("/admin/agencies");
  revalidatePath("/admin/referrers");

  return {
    ok: true,
    message: validation.account.bankName
      ? "振込先を保存しました。"
      : "振込先を削除しました。",
  };
}
