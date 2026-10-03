"use server";

import { revalidatePath } from "next/cache";

import { requireAdminAction } from "@/lib/db/admin-access";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { mapSupabaseErrorToJa } from "@/lib/supabase/error-ja";
import {
  buildRelationRepairPlan,
  canApplyRelationRepair,
  describeRelationRepairBlocks,
  listInvalidInactiveRelations,
  repairInvalidInactiveReferralRelation,
  type RelationRepairCandidate,
  type RelationRepairPlan,
} from "@/lib/referrals/repair-invalid-inactive-relation";

/*
  有効期間を持たない無効 relation の修復。

  紹介者の付け替えで end_month < start_month になった行の
  end_month を null へ戻すだけ。
  紹介者 / 開始月 / 他の関係 / 紹介報酬 は変更しない。

  ■ 必ずプレビューを経る
  確定は plan を作り直してから実行する。
  画面から渡された金額や判定を信じない。

  ■ 紹介報酬は再計算しない
  修復後に「紹介報酬の再集計が必要」と伝えるだけにする。
  区分変更と同じく 修復 → dry-run → 承認 → sync の順序を保つ。
*/

export type RelationRepairActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

export type ListRepairCandidatesResult =
  | { ok: true; rows: RelationRepairCandidate[] }
  | { ok: false; error: string };

export type RepairPlanActionResult =
  | { ok: true; plan: RelationRepairPlan }
  | { ok: false; error: string };

/** 修復候補の一覧（読み取りのみ）。一括修復はしない */
export async function listRelationRepairCandidatesAction(): Promise<ListRepairCandidatesResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const result = await listInvalidInactiveRelations(getSupabaseAdmin());
  if (result.error) return { ok: false, error: mapSupabaseErrorToJa(result.error) };

  return { ok: true, rows: result.rows };
}

/** 修復前プレビュー（読み取りのみ） */
export async function previewRelationRepairAction(
  relationId: string,
): Promise<RepairPlanActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  /*
    月次確定の読み取りに auth.uid() が必要な RPC を使うため、
    プレビューはユーザーのクライアントで作る。
  */
  const plan = await buildRelationRepairPlan(auth.supabase, relationId);
  if (plan.error) return { ok: false, error: mapSupabaseErrorToJa(plan.error) };

  return { ok: true, plan };
}

/** 修復を実行する（1 件ずつ） */
export async function repairRelationAction(
  _prev: RelationRepairActionResult | null,
  formData: FormData,
): Promise<RelationRepairActionResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const relationId = String(formData.get("relation_id") ?? "").trim();
  if (!relationId) {
    return { ok: false, error: "対象の関係を選択してください" };
  }

  /*
    plan は必ずサーバー側で作り直す。
    画面から送られた判定を信用しない（確定までに状態が変わりうる）。
  */
  const plan = await buildRelationRepairPlan(auth.supabase, relationId);
  if (plan.error) return { ok: false, error: mapSupabaseErrorToJa(plan.error) };

  if (!canApplyRelationRepair(plan)) {
    return {
      ok: false,
      error: `この関係は修復できません（${describeRelationRepairBlocks(plan)}）`,
    };
  }

  const repaired = await repairInvalidInactiveReferralRelation(auth.supabase, {
    plan,
    actorId: auth.user?.id ?? "",
    actorEmail: auth.user?.email ?? null,
  });

  if (!repaired.ok) {
    return { ok: false, error: mapSupabaseErrorToJa(repaired.error) };
  }

  revalidatePath("/admin/creator-referrals");
  revalidatePath("/creators");
  revalidatePath("/payments");

  const after = plan.resolutionAfter
    .map((row) => `${row.targetMonth}→${row.referrerName ?? "なし"}`)
    .join(" / ");

  return {
    ok: true,
    message: `${plan.candidate?.tiktokId} の無効な関係を修復しました（終了月 ${plan.candidate?.endMonth} → なし）。修復後の解決: ${after}。紹介報酬は再計算していません。「売上・報酬 › 紹介報酬」で差分を確認してから再集計してください。`,
  };
}
