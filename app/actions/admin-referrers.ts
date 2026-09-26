"use server";

import { requireAdminAction } from "@/lib/db/admin-access";
import { mapSupabaseErrorToJa } from "@/lib/supabase/error-ja";
import { generateReferralCode } from "@/lib/referrals/referral-code";
import { revalidatePath } from "next/cache";

export type AdminActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

function readText(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function readOptionalText(formData: FormData, key: string): string | null {
  const value = readText(formData, key);
  return value.length > 0 ? value : null;
}

function readBoolean(formData: FormData, key: string): boolean {
  const value = String(formData.get(key) ?? "").trim().toLowerCase();
  return value === "on" || value === "true" || value === "1";
}

export async function saveReferrerAction(
  _prev: AdminActionResult | null,
  formData: FormData,
): Promise<AdminActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const referrerId = readOptionalText(formData, "referrer_id");
  const referrerName = readText(formData, "referrer_name");
  const email = readOptionalText(formData, "email");
  const phone = readOptionalText(formData, "phone");
  const memo = readOptionalText(formData, "memo");
  const isActive = readBoolean(formData, "is_active");

  if (!referrerId && !referrerName) {
    return { ok: false, error: "紹介者名は必須です" };
  }

  /*
    紹介者名の変更はここでは行わない。
    既存紹介者の名称変更は app/actions/master-name-edit.ts の renameReferrerAction に
    一本化している（name / referrer_name を同時更新し、履歴も残す）。
  */
  const payload = {
    email,
    phone,
    memo,
    is_active: isActive,
    updated_at: new Date().toISOString(),
  };

  if (referrerId) {
    const { error } = await auth.supabase.from("referrers").update(payload).eq("id", referrerId);
    if (error) return { ok: false, error: mapSupabaseErrorToJa(error.message) };
  } else {
    let referralCode = generateReferralCode();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const { data: existing } = await auth.supabase
        .from("referrers")
        .select("id")
        .eq("referral_code", referralCode)
        .maybeSingle();
      if (!existing) break;
      referralCode = generateReferralCode();
    }
    const { error } = await auth.supabase.from("referrers").insert({
      ...payload,
      name: referrerName,
      referrer_name: referrerName,
      referral_code: referralCode,
    });
    if (error) return { ok: false, error: mapSupabaseErrorToJa(error.message) };
  }

  revalidatePath("/admin/referrers");
  revalidatePath("/admin/creator-referrals");
  return {
    ok: true,
    message: referrerId
      ? "紹介者情報を更新しました（紹介者名は「名称編集」から変更してください）"
      : "紹介者を追加しました",
  };
}

/*
  紹介者の所属代理店を設定する。

  ■ なぜ必要か
  紹介者は独立した支払先ではない。紹介者報酬は所属代理店へ合算し、
  代理店へ1回だけ支払う。その帰属先をここで決める。

  ■ 支払中の整合性を壊さない
  既に支払明細へ組み入れられた（payment_batch_id あり）未完了の紹介報酬が
  あるときは変更を拒否する。帰属先を動かすと、その支払明細の金額と
  実際の支払先が食い違う。
  支払済みの明細は履歴なのでそのまま残す（遡って付け替えない）。
*/
export async function saveReferrerAgencyAction(
  _prev: AdminActionResult | null,
  formData: FormData,
): Promise<AdminActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const referrerId = readOptionalText(formData, "referrer_id");
  const agencyId = readOptionalText(formData, "agency_id");

  if (!referrerId) {
    return { ok: false, error: "紹介者を指定してください" };
  }

  const { data: referrer, error: referrerError } = await auth.supabase
    .from("referrers")
    .select("id, referrer_name, name, agency_id")
    .eq("id", referrerId)
    .maybeSingle();

  if (referrerError) {
    return { ok: false, error: mapSupabaseErrorToJa(referrerError.message) };
  }
  if (!referrer?.id) {
    return { ok: false, error: "紹介者が見つかりません" };
  }

  const referrerLabel = String(referrer.referrer_name ?? referrer.name ?? "この紹介者");

  if (String(referrer.agency_id ?? "") === String(agencyId ?? "")) {
    return { ok: true, message: `${referrerLabel} の所属代理店は変更ありません` };
  }

  // 支払明細に組み入れ済みで未完了の紹介報酬があるなら動かさない
  const { count: claimedCount, error: claimedError } = await auth.supabase
    .from("referral_reward_items")
    .select("id", { count: "exact", head: true })
    .eq("referrer_id", referrerId)
    .not("payment_batch_id", "is", null)
    .eq("is_paid", false);

  if (claimedError) {
    return { ok: false, error: mapSupabaseErrorToJa(claimedError.message) };
  }
  if ((claimedCount ?? 0) > 0) {
    return {
      ok: false,
      error: `${referrerLabel} には支払明細へ組み入れ済みの紹介報酬が ${claimedCount} 件あります。支払明細を振込完了にするか取り消してから所属代理店を変更してください。`,
    };
  }

  if (agencyId) {
    const { data: agency, error: agencyError } = await auth.supabase
      .from("agencies")
      .select("id, name")
      .eq("id", agencyId)
      .maybeSingle();

    if (agencyError) {
      return { ok: false, error: mapSupabaseErrorToJa(agencyError.message) };
    }
    if (!agency?.id) {
      return { ok: false, error: "代理店が見つかりません" };
    }
  }

  const { error } = await auth.supabase
    .from("referrers")
    .update({ agency_id: agencyId, updated_at: new Date().toISOString() })
    .eq("id", referrerId);

  if (error) return { ok: false, error: mapSupabaseErrorToJa(error.message) };

  revalidatePath("/admin/referrers");
  revalidatePath("/payments");

  return {
    ok: true,
    message: agencyId
      ? `${referrerLabel} の所属代理店を設定しました。紹介報酬はこの代理店へ合算して支払われます。`
      : `${referrerLabel} の所属代理店を解除しました。所属代理店が無いあいだ紹介報酬は支払保留になります。`,
  };
}
