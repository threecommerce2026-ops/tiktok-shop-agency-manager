"use server";

import { revalidatePath } from "next/cache";

import { requireAdminAction } from "@/lib/db/admin-access";
import { mapSupabaseErrorToJa } from "@/lib/supabase/error-ja";
import { isAccountManagementType } from "@/lib/creators/account-management-type";
import { linkCreatorToReferrer } from "@/lib/referrals/link-creator-referrer";
import {
  ASSIGNMENT_STATE_LABEL,
  assignmentStateForSelection,
  resolveAssignmentState,
} from "@/lib/creators/assignment-state";

/*
  クリエイターマスタの一括保存。

  ■ 保存対象
  ・所属代理店（現在所属）… 既存 RPC update_creator_assignment（creator_assignment_logs へ履歴）
  ・紹介者              … linkCreatorToReferrer（creators と creator_referrals を同時更新）
  ・区分                … creators.account_management_type（creator_master_change_logs へ履歴）

  ■ 確認状態
  画面の選択値には「未確認」「代理店なし / 紹介者なし」が含まれる。
  どちらも ID は NULL だが、
    未確認 → state = 'unconfirmed'
    なし   → state = 'none'
  として creators.agency_assignment_state / referrer_assignment_state に保存する。
  これで一度確認した人が翌日また「未設定」リストへ戻らない。

  ■ 触らないもの
  ・creator_monthly_agency_assignments（月別確定所属）
  ・agency_reward_items / referral_reward_items（報酬明細）
  マスタ編集だけで報酬を再生成しない。再集計は別操作のまま。
  確認状態は報酬計算に一切影響しない（none も unconfirmed も ID は NULL のまま）。
*/

export type CreatorMasterBulkResult =
  | {
      ok: true;
      message: string;
      agencyChanged: number;
      referrerChanged: number;
      typeChanged: number;
      creatorCount: number;
    }
  | { ok: false; error: string };

/** 画面で「代理店なし / 紹介者なし」を選んだときに送られるセンチネル */
const NONE_SENTINEL = "__none__";

type BulkChange = {
  creatorId: string;
  /** null = 変更しない / "" = 未確認 / NONE_SENTINEL = なし確認済 / それ以外 = ID */
  agencyId: string | null;
  referrerId: string | null;
  accountManagementType: string | null;
};

/**
 * 画面から送られる変更行。
 * "creatorId|agencyId|referrerId|type" 形式。
 * 値なしは空文字、変更なしの項目は "-" を送る。
 */
function parseChanges(formData: FormData): BulkChange[] {
  return formData
    .getAll("changes")
    .map((value) => String(value).split("|"))
    .filter((parts) => parts.length === 4)
    .map(([creatorId, agencyId, referrerId, type]) => ({
      creatorId: creatorId.trim(),
      agencyId: agencyId === "-" ? null : agencyId.trim() || "",
      referrerId: referrerId === "-" ? null : referrerId.trim() || "",
      accountManagementType: type === "-" ? null : type.trim(),
    }))
    .filter((change) => change.creatorId)
    .map((change) => ({
      ...change,
      // "" は「未設定にする」、null は「変更しない」
      agencyId: change.agencyId === null ? null : change.agencyId,
      referrerId: change.referrerId === null ? null : change.referrerId,
    }));
}

export async function saveCreatorMasterBulkAction(
  _prev: CreatorMasterBulkResult | null,
  formData: FormData,
): Promise<CreatorMasterBulkResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const supabase = auth.supabase;
  const user = auth.user;
  const changes = parseChanges(formData);

  if (changes.length === 0) {
    return { ok: false, error: "保存する変更がありません" };
  }

  const creatorIds = changes.map((change) => change.creatorId);

  const { data: currentRows, error: loadError } = await supabase
    .from("creators")
    .select(
      "id, agency_id, referred_by_referrer_id, account_management_type, commission_rate, registration_status, tiktok_id, agency_assignment_state, referrer_assignment_state",
    )
    .in("id", creatorIds);

  if (loadError) {
    return { ok: false, error: mapSupabaseErrorToJa(loadError.message) };
  }

  const currentById = new Map(
    (currentRows ?? []).map((row) => [row.id as string, row]),
  );

  let agencyChanged = 0;
  let referrerChanged = 0;
  let typeChanged = 0;
  const touchedCreators = new Set<string>();

  for (const change of changes) {
    const current = currentById.get(change.creatorId);
    if (!current) {
      return { ok: false, error: `クリエイターが見つかりません（${change.creatorId}）` };
    }

    // --- 所属代理店（現在所属）。月別確定所属は変更しない -----------------------
    if (change.agencyId !== null) {
      const isNone = change.agencyId === NONE_SENTINEL;
      const selectedAgencyId =
        isNone || change.agencyId === "" ? null : change.agencyId;
      const { id: nextAgencyId, state: nextAgencyState } =
        assignmentStateForSelection(selectedAgencyId, isNone);

      const fromAgencyId = (current.agency_id as string | null) ?? null;
      const fromAgencyState = resolveAssignmentState(
        fromAgencyId,
        current.agency_assignment_state,
      );

      // ID と確認状態、どちらかが変わったら保存する
      if (nextAgencyId !== fromAgencyId || nextAgencyState !== fromAgencyState) {
        /*
          所属代理店の変更は既存 RPC を通す（creator_assignment_logs へ履歴が残る）。
          RPC は確認状態を知らないので、ID が実際に変わったときだけ呼ぶ。
        */
        if (nextAgencyId !== fromAgencyId) {
          const { error } = await supabase.rpc("update_creator_assignment", {
            p_creator_id: change.creatorId,
            p_agency_id: nextAgencyId,
            p_commission_rate: Number(current.commission_rate ?? 0),
            p_registration_status:
              (current.registration_status as string | null) ?? "pending",
            p_tiktok_id: String(current.tiktok_id ?? ""),
            p_changed_by: user?.id ?? null,
            p_changed_by_email: user?.email ?? null,
          });

          if (error) {
            return { ok: false, error: mapSupabaseErrorToJa(error.message) };
          }
        }

        // 確認状態は RPC の対象外なので別途保存する
        if (nextAgencyState !== fromAgencyState) {
          const { error: stateError } = await supabase
            .from("creators")
            .update({
              agency_assignment_state: nextAgencyState,
              updated_at: new Date().toISOString(),
            })
            .eq("id", change.creatorId);

          if (stateError) {
            return { ok: false, error: mapSupabaseErrorToJa(stateError.message) };
          }

          // 状態の遷移も既存の履歴テーブルへ残す
          await supabase.from("creator_master_change_logs").insert({
            creator_id: change.creatorId,
            field: "agency_assignment_state",
            from_value: `${fromAgencyState}（${ASSIGNMENT_STATE_LABEL[fromAgencyState]}）`,
            to_value: `${nextAgencyState}（${ASSIGNMENT_STATE_LABEL[nextAgencyState]}）`,
            changed_by: user?.id ?? null,
            changed_by_email: user?.email ?? null,
          });
        }

        agencyChanged += 1;
        touchedCreators.add(change.creatorId);
      }
    }

    // --- 区分 -------------------------------------------------------------------
    if (change.accountManagementType !== null) {
      if (!isAccountManagementType(change.accountManagementType)) {
        return { ok: false, error: "区分の値が不正です" };
      }

      const fromType = String(current.account_management_type ?? "standard");

      if (change.accountManagementType !== fromType) {
        const { error } = await supabase
          .from("creators")
          .update({
            account_management_type: change.accountManagementType,
            updated_at: new Date().toISOString(),
          })
          .eq("id", change.creatorId);

        if (error) {
          return { ok: false, error: mapSupabaseErrorToJa(error.message) };
        }

        await supabase.from("creator_master_change_logs").insert({
          creator_id: change.creatorId,
          field: "account_management_type",
          from_value: fromType,
          to_value: change.accountManagementType,
          changed_by: user?.id ?? null,
          changed_by_email: user?.email ?? null,
        });

        typeChanged += 1;
        touchedCreators.add(change.creatorId);
      }
    }

    // --- 紹介者（creators と creator_referrals を必ず同時に更新）-----------------
    if (change.referrerId !== null) {
      const isNone = change.referrerId === NONE_SENTINEL;
      const selectedReferrerId =
        isNone || change.referrerId === "" ? null : change.referrerId;
      const { id: nextReferrerId, state: nextReferrerState } =
        assignmentStateForSelection(selectedReferrerId, isNone);

      const fromReferrerId =
        (current.referred_by_referrer_id as string | null) ?? null;
      const fromReferrerState = resolveAssignmentState(
        fromReferrerId,
        current.referrer_assignment_state,
      );

      if (nextReferrerId !== fromReferrerId || nextReferrerState !== fromReferrerState) {
        /*
          紹介者は linkCreatorToReferrer が唯一の入口。
          creators.referred_by_referrer_id と creator_referrals を必ず同時に更新し、
          確認状態もこの中で一緒に書く（Single Source of Truth を壊さない）。
        */
        const linked = await linkCreatorToReferrer(supabase, {
          creatorId: change.creatorId,
          referrerId: nextReferrerId,
          assignmentState: nextReferrerState,
        });

        if (!linked.ok) {
          return { ok: false, error: mapSupabaseErrorToJa(linked.error) };
        }

        if (nextReferrerId !== fromReferrerId) {
          await supabase.from("creator_master_change_logs").insert({
            creator_id: change.creatorId,
            field: "referrer",
            from_value: fromReferrerId,
            to_value: nextReferrerId,
            changed_by: user?.id ?? null,
            changed_by_email: user?.email ?? null,
          });
        }

        if (nextReferrerState !== fromReferrerState) {
          await supabase.from("creator_master_change_logs").insert({
            creator_id: change.creatorId,
            field: "referrer_assignment_state",
            from_value: `${fromReferrerState}（${ASSIGNMENT_STATE_LABEL[fromReferrerState]}）`,
            to_value: `${nextReferrerState}（${ASSIGNMENT_STATE_LABEL[nextReferrerState]}）`,
            changed_by: user?.id ?? null,
            changed_by_email: user?.email ?? null,
          });
        }

        referrerChanged += 1;
        touchedCreators.add(change.creatorId);
      }
    }
  }

  if (touchedCreators.size === 0) {
    return { ok: false, error: "変更内容がありませんでした（すべて現在値と同じです）" };
  }

  revalidatePath("/admin/creator-master-editor");
  revalidatePath("/creators");
  revalidatePath("/revenue");
  revalidatePath("/admin/monthly-agency-assignments");

  return {
    ok: true,
    message: `${touchedCreators.size} 名のマスタを更新しました（代理店 ${agencyChanged} 件 / 紹介者 ${referrerChanged} 件 / 区分 ${typeChanged} 件）。報酬明細は変更していません。月別所属の確定と再集計は別操作で行ってください。`,
    agencyChanged,
    referrerChanged,
    typeChanged,
    creatorCount: touchedCreators.size,
  };
}
