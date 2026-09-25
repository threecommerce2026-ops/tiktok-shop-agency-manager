"use server";

import { revalidatePath } from "next/cache";

import { requireAdminAction } from "@/lib/db/admin-access";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { mapSupabaseErrorToJa } from "@/lib/supabase/error-ja";
import { AGENCY_MERGE_TABLES, referenceKey } from "@/lib/agency/agency-references";
import {
  dryRunAgencyMerge,
  type MergeDryRunResult,
} from "@/lib/db/agency-maintenance-queries";

/*
  代理店マスタの整理（統合 / 削除 / 無効化）。

  ■ 安全装置
  ・統合は二段階確認（confirm=1 が無ければ DRY RUN だけを返す）
  ・支払い済みの報酬・支払レコードがある代理店は統合禁止
  ・一意制約が衝突する場合は統合禁止（agency_payouts の target_month + agency_id）
  ・物理削除は参照が全て0のときだけ許可
    （agency_reward_items / agency_payouts は ON DELETE CASCADE のため、
      参照があるまま削除すると報酬データが道連れで消える）
  ・履歴は agency_maintenance_logs に記録する

  ■ 名称変更はここでは扱わない
  名称変更は app/actions/master-name-edit.ts の renameAgencyAction に一本化。
*/

export type AgencyMaintenanceResult =
  | { ok: true; message: string; dryRun?: MergeDryRunResult }
  | { ok: false; error: string; dryRun?: MergeDryRunResult };

const MIGRATION_HINT =
  "代理店整理の履歴テーブルが未適用です。supabase/migrations/20260917150000_agency_maintenance_logs.sql を適用してください。";

function readText(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function isMissingTable(code: string | null | undefined): boolean {
  return code === "42P01" || code === "PGRST205";
}

function revalidateAgencyViews() {
  revalidatePath("/admin/agencies");
  revalidatePath("/admin/creator-master-editor");
  revalidatePath("/admin/monthly-agency-assignments");
  revalidatePath("/creators");
  revalidatePath("/revenue");
}

async function writeMaintenanceLog(params: {
  action: "merge" | "delete" | "deactivate" | "activate";
  agencyId: string;
  agencyName: string;
  targetAgencyId?: string | null;
  targetAgencyName?: string | null;
  affectedCounts?: Record<string, number>;
  affectedTotal?: number;
  changedBy: string | null;
  changedByEmail: string | null;
}): Promise<string | null> {
  const { error } = await getSupabaseAdmin().from("agency_maintenance_logs").insert({
    action: params.action,
    agency_id: params.agencyId,
    agency_name: params.agencyName,
    target_agency_id: params.targetAgencyId ?? null,
    target_agency_name: params.targetAgencyName ?? null,
    affected_counts: params.affectedCounts ?? {},
    affected_total: params.affectedTotal ?? 0,
    changed_by: params.changedBy,
    changed_by_email: params.changedByEmail,
  });

  if (error && isMissingTable(error.code)) return MIGRATION_HINT;
  return error ? error.message : null;
}

/**
 * 代理店の統合。
 *
 * 1回目（confirm なし）: DRY RUN のみを返す。DBは変更しない。
 * 2回目（confirm=1）  : 実際に agency_id を付け替える。
 */
export async function mergeAgencyAction(
  _prev: AgencyMaintenanceResult | null,
  formData: FormData,
): Promise<AgencyMaintenanceResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const sourceId = readText(formData, "source_agency_id");
  const targetId = readText(formData, "target_agency_id");
  const confirmed = readText(formData, "confirm") === "1";

  if (!sourceId || !targetId) {
    return { ok: false, error: "統合元と統合先を選択してください" };
  }

  const admin = getSupabaseAdmin();
  const dryRun = await dryRunAgencyMerge(admin, sourceId, targetId);

  if (dryRun.error) {
    return { ok: false, error: mapSupabaseErrorToJa(dryRun.error) };
  }

  if (dryRun.blockedByPaidData) {
    return {
      ok: false,
      dryRun,
      error: `${dryRun.sourceName} には支払い済みの報酬データがあるため統合できません（支払済明細 ${dryRun.paidRewardItemCount} 件 / 支払確定 ${dryRun.paidPayoutCount} 件）。支払履歴を壊さないため、個別にご相談ください。`,
    };
  }

  if (dryRun.collisions.length > 0) {
    return {
      ok: false,
      dryRun,
      error: `統合すると一意制約が衝突します（${dryRun.collisions
        .map((c) => `${c.table}: ${c.count} 件`)
        .join(" / ")}）。どちらを残すか・金額を合算するかを決めてから実行してください。`,
    };
  }

  // --- 1回目は DRY RUN だけ返す -----------------------------------------------
  if (!confirmed) {
    return {
      ok: true,
      dryRun,
      message: `DRY RUN: ${dryRun.sourceName} を ${dryRun.targetName} へ統合すると ${dryRun.reassignTotal} 件が付け替わります。内容を確認して「統合を実行」を押してください。`,
    };
  }

  // --- 2回目のみ実行 -----------------------------------------------------------
  const affectedCounts: Record<string, number> = {};
  let affectedTotal = 0;

  for (const ref of AGENCY_MERGE_TABLES) {
    const expected =
      dryRun.reassign.find((row) => row.key === referenceKey(ref))?.count ?? 0;
    if (expected === 0) continue;

    const { error } = await admin
      .from(ref.table)
      .update({ [ref.column]: targetId })
      .eq(ref.column, sourceId);

    if (error) {
      return {
        ok: false,
        dryRun,
        error: `${ref.table} の付け替えに失敗しました: ${mapSupabaseErrorToJa(error.message)}`,
      };
    }

    affectedCounts[referenceKey(ref)] = expected;
    affectedTotal += expected;
  }

  const logError = await writeMaintenanceLog({
    action: "merge",
    agencyId: sourceId,
    agencyName: dryRun.sourceName,
    targetAgencyId: targetId,
    targetAgencyName: dryRun.targetName,
    affectedCounts,
    affectedTotal,
    changedBy: auth.user?.id ?? null,
    changedByEmail: auth.user?.email ?? null,
  });

  revalidateAgencyViews();

  return {
    ok: true,
    dryRun,
    message: `${dryRun.sourceName} を ${dryRun.targetName} へ統合しました（${affectedTotal} 件を付け替え）。統合元の代理店は参照が無くなったので、必要であれば削除または無効化してください。${
      logError ? `（履歴の保存に失敗: ${logError}）` : ""
    }`,
  };
}

/**
 * 代理店の物理削除。参照が1件でもあれば拒否する。
 */
export async function deleteAgencyAction(
  _prev: AgencyMaintenanceResult | null,
  formData: FormData,
): Promise<AgencyMaintenanceResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const agencyId = readText(formData, "agency_id");
  const confirmed = readText(formData, "confirm") === "1";

  if (!agencyId) {
    return { ok: false, error: "代理店 ID が不正です" };
  }
  if (!confirmed) {
    return { ok: false, error: "確認にチェックしてから削除してください" };
  }

  const admin = getSupabaseAdmin();

  const { data: agency, error: loadError } = await admin
    .from("agencies")
    .select("id, name")
    .eq("id", agencyId)
    .maybeSingle();

  if (loadError) {
    return { ok: false, error: mapSupabaseErrorToJa(loadError.message) };
  }
  if (!agency) {
    return { ok: false, error: "代理店が見つかりません" };
  }

  /*
    削除直前にサーバー側でも参照を数え直す。
    agency_reward_items / agency_payouts は ON DELETE CASCADE のため、
    画面表示が古いまま削除されると報酬データが消える。
  */
  for (const ref of [...AGENCY_MERGE_TABLES]) {
    const { count, error } = await admin
      .from(ref.table)
      .select("*", { count: "exact", head: true })
      .eq(ref.column, agencyId);

    if (error) continue;

    if ((count ?? 0) > 0) {
      return {
        ok: false,
        error: `削除できません。「${ref.label}」が ${count} 件残っています。統合または無効化してください。`,
      };
    }
  }

  const { error } = await admin.from("agencies").delete().eq("id", agencyId);

  if (error) {
    return { ok: false, error: mapSupabaseErrorToJa(error.message) };
  }

  const logError = await writeMaintenanceLog({
    action: "delete",
    agencyId,
    agencyName: String(agency.name ?? ""),
    changedBy: auth.user?.id ?? null,
    changedByEmail: auth.user?.email ?? null,
  });

  revalidateAgencyViews();

  return {
    ok: true,
    message: `代理店「${agency.name}」を削除しました。${
      logError ? `（履歴の保存に失敗: ${logError}）` : ""
    }`,
  };
}

/**
 * 代理店の有効 / 無効切り替え。
 * 無効化しても過去データはそのまま残る（名称も履歴画面で確認できる）。
 */
export async function setAgencyActiveAction(
  _prev: AgencyMaintenanceResult | null,
  formData: FormData,
): Promise<AgencyMaintenanceResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const agencyId = readText(formData, "agency_id");
  const nextActive = readText(formData, "next_active") === "1";

  if (!agencyId) {
    return { ok: false, error: "代理店 ID が不正です" };
  }

  const { data: agency, error: loadError } = await auth.supabase
    .from("agencies")
    .select("id, name, is_active")
    .eq("id", agencyId)
    .maybeSingle();

  if (loadError) {
    return { ok: false, error: mapSupabaseErrorToJa(loadError.message) };
  }
  if (!agency) {
    return { ok: false, error: "代理店が見つかりません" };
  }

  const { error } = await auth.supabase
    .from("agencies")
    .update({ is_active: nextActive })
    .eq("id", agencyId);

  if (error) {
    return { ok: false, error: mapSupabaseErrorToJa(error.message) };
  }

  const logError = await writeMaintenanceLog({
    action: nextActive ? "activate" : "deactivate",
    agencyId,
    agencyName: String(agency.name ?? ""),
    changedBy: auth.user?.id ?? null,
    changedByEmail: auth.user?.email ?? null,
  });

  revalidateAgencyViews();

  return {
    ok: true,
    message: nextActive
      ? `代理店「${agency.name}」を有効にしました。`
      : `代理店「${agency.name}」を無効にしました。新規の代理店選択には表示されなくなりますが、過去の所属・報酬・履歴はそのまま残ります。${
          logError ? `（履歴の保存に失敗: ${logError}）` : ""
        }`,
  };
}
