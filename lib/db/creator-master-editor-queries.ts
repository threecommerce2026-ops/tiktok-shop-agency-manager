import type { SupabaseClient } from "@supabase/supabase-js";

import { fetchAllFrom } from "@/lib/db/paged-select";
import { formatCreatorTiktokIdLabel } from "@/lib/creators/referral-registration";
import {
  normalizeAccountManagementType,
  type AccountManagementType,
} from "@/lib/creators/account-management-type";
import type { AgencyAssignmentState } from "@/lib/agency/agency-assignment";
import {
  resolveAssignmentState,
  type AssignmentState,
} from "@/lib/creators/assignment-state";

/*
  クリエイターマスタ一括編集ボードのデータ。

  1行 = クリエイター1名。
  編集対象は 所属代理店 / 紹介者 / 区分 の3つ。

  ・報酬金額はここでは扱わない（発生有無のフラグのみ）
  ・月別所属の状態は参照のみ。この画面では変更しない
*/

/** 月別所属の状態（このクリエイターに月別確定が存在するか） */
export type CreatorMonthlyAssignmentSummary =
  | "has_monthly"
  | "current_only"
  | "unset";

export type CreatorMasterEditorRow = {
  id: string;
  tiktokId: string;
  tiktokIdLabel: string;
  creatorName: string;
  agencyId: string | null;
  agencyName: string | null;
  /** 代理店の確認状態（ID から導出した実効値） */
  agencyState: AssignmentState;
  referrerId: string | null;
  referrerName: string | null;
  referrerCode: string | null;
  /** 紹介者の確認状態（ID から導出した実効値） */
  referrerState: AssignmentState;
  accountManagementType: AccountManagementType;
  /**
   * creators.commission_rate。
   * 現在の代理店報酬計算（TikTok の AP 実額）には使用していないマスタ設定値。
   * CAP の AK（agency_split_rate）とは別物。
   */
  legacyAgencyShareRate: number;
  officialLineRegistered: boolean;
  registrationStatus: string | null;
  createdAt: string;
  /** 月別所属の状態 */
  monthlyAssignmentState: CreatorMonthlyAssignmentSummary;
  confirmedMonths: string[];
  /** 代理店報酬が発生しているか */
  hasAgencyReward: boolean;
  /** 紹介者報酬が発生しているか */
  hasReferralReward: boolean;
};

export type CreatorMasterEditorData = {
  rows: CreatorMasterEditorRow[];
  agencies: Array<{ id: string; name: string; creatorCount: number; isActive: boolean }>;
  referrers: Array<{
    id: string;
    name: string;
    code: string | null;
    creatorCount: number;
    isActive: boolean;
  }>;
  totals: {
    creatorCount: number;
    /** 代理店: 未確認 / なし確認済 / 設定済み */
    agencyUnconfirmed: number;
    agencyNone: number;
    agencyAssigned: number;
    /** 紹介者: 未確認 / なし確認済 / 設定済み */
    referrerUnconfirmed: number;
    referrerNone: number;
    referrerAssigned: number;
    monthlyConfirmedCount: number;
  };
  error: string | null;
};

export async function fetchCreatorMasterEditorData(
  supabase: SupabaseClient,
): Promise<CreatorMasterEditorData> {
  const empty: CreatorMasterEditorData = {
    rows: [],
    agencies: [],
    referrers: [],
    totals: {
      creatorCount: 0,
      agencyUnconfirmed: 0,
      agencyNone: 0,
      agencyAssigned: 0,
      referrerUnconfirmed: 0,
      referrerNone: 0,
      referrerAssigned: 0,
      monthlyConfirmedCount: 0,
    },
    error: null,
  };

  const [
    creatorsResult,
    agenciesResult,
    referrersResult,
    monthlyResult,
    agencyItemsResult,
    referralItemsResult,
  ] = await Promise.all([
    fetchAllFrom<Record<string, unknown>>(
      supabase,
      "creators",
      "id, creator_name, tiktok_id, agency_id, referred_by_referrer_id, account_management_type, commission_rate, official_line_registered, registration_status, created_at, agency_assignment_state, referrer_assignment_state",
    ),
    supabase.from("agencies").select("id, name, is_active").order("name"),
    supabase
      .from("referrers")
      .select("id, name, referrer_name, referral_code, is_active")
      .order("referrer_name"),
    fetchAllFrom<{ creator_id: string; target_month: string; agency_id: string | null }>(
      supabase,
      "creator_monthly_agency_assignments",
      "creator_id, target_month, agency_id",
    ),
    fetchAllFrom<{ creator_id: string }>(
      supabase,
      "agency_reward_items",
      "creator_id",
    ),
    fetchAllFrom<{ creator_id: string }>(
      supabase,
      "referral_reward_items",
      "creator_id",
    ),
  ]);

  const error =
    creatorsResult.error ??
    agenciesResult.error?.message ??
    referrersResult.error?.message ??
    monthlyResult.error ??
    null;

  if (error) {
    return { ...empty, error };
  }

  const agencyNameById = new Map<string, string>();
  for (const agency of agenciesResult.data ?? []) {
    agencyNameById.set(agency.id as string, String(agency.name ?? ""));
  }

  const referrerById = new Map<string, { name: string; code: string | null }>();
  for (const referrer of referrersResult.data ?? []) {
    referrerById.set(referrer.id as string, {
      name: String(referrer.referrer_name ?? referrer.name ?? ""),
      code: (referrer.referral_code as string | null) ?? null,
    });
  }

  const monthsByCreator = new Map<string, string[]>();
  for (const row of monthlyResult.data) {
    if (!row.agency_id) continue;
    const list = monthsByCreator.get(row.creator_id) ?? [];
    list.push(row.target_month);
    monthsByCreator.set(row.creator_id, list);
  }

  // agency_reward_items / referral_reward_items が未作成でも画面は動かす
  const agencyRewardCreators = new Set(
    agencyItemsResult.error ? [] : agencyItemsResult.data.map((row) => row.creator_id),
  );
  const referralRewardCreators = new Set(
    referralItemsResult.error
      ? []
      : referralItemsResult.data.map((row) => row.creator_id),
  );

  const agencyCreatorCount = new Map<string, number>();
  const referrerCreatorCount = new Map<string, number>();

  const rows: CreatorMasterEditorRow[] = creatorsResult.data.map((creator) => {
    const id = creator.id as string;
    const agencyId = (creator.agency_id as string | null) ?? null;
    const referrerId = (creator.referred_by_referrer_id as string | null) ?? null;
    const tiktokId = String(creator.tiktok_id ?? "");
    const confirmedMonths = (monthsByCreator.get(id) ?? []).sort();

    if (agencyId) {
      agencyCreatorCount.set(agencyId, (agencyCreatorCount.get(agencyId) ?? 0) + 1);
    }
    if (referrerId) {
      referrerCreatorCount.set(
        referrerId,
        (referrerCreatorCount.get(referrerId) ?? 0) + 1,
      );
    }

    const referrer = referrerId ? referrerById.get(referrerId) ?? null : null;

    return {
      id,
      tiktokId,
      tiktokIdLabel: formatCreatorTiktokIdLabel(tiktokId),
      creatorName: String(creator.creator_name ?? "—"),
      agencyId,
      agencyName: agencyId ? agencyNameById.get(agencyId) ?? null : null,
      agencyState: resolveAssignmentState(agencyId, creator.agency_assignment_state),
      referrerId,
      referrerName: referrer?.name ?? null,
      referrerCode: referrer?.code ?? null,
      referrerState: resolveAssignmentState(
        referrerId,
        creator.referrer_assignment_state,
      ),
      accountManagementType: normalizeAccountManagementType(
        creator.account_management_type,
      ),
      legacyAgencyShareRate: Number(creator.commission_rate ?? 0),
      officialLineRegistered: Boolean(creator.official_line_registered),
      registrationStatus: (creator.registration_status as string | null) ?? null,
      createdAt: String(creator.created_at ?? ""),
      monthlyAssignmentState:
        confirmedMonths.length > 0
          ? "has_monthly"
          : agencyId
            ? "current_only"
            : "unset",
      confirmedMonths,
      hasAgencyReward: agencyRewardCreators.has(id),
      hasReferralReward: referralRewardCreators.has(id),
    };
  });

  rows.sort(
    (a, b) =>
      a.creatorName.localeCompare(b.creatorName, "ja") ||
      a.tiktokId.localeCompare(b.tiktokId),
  );

  return {
    rows,
    agencies: (agenciesResult.data ?? []).map((row) => ({
      id: row.id as string,
      name: String(row.name ?? ""),
      creatorCount: agencyCreatorCount.get(row.id as string) ?? 0,
      // 無効代理店は選択肢から隠すが、現在値の名称解決には必要なので取得はする
      isActive: row.is_active !== false,
    })),
    referrers: (referrersResult.data ?? []).map((row) => ({
      id: row.id as string,
      name: String(row.referrer_name ?? row.name ?? ""),
      code: (row.referral_code as string | null) ?? null,
      creatorCount: referrerCreatorCount.get(row.id as string) ?? 0,
      // 無効紹介者も現在値の名称解決に必要なので取得はする（新規選択からは除外）
      isActive: row.is_active !== false,
    })),
    totals: {
      creatorCount: rows.length,
      agencyUnconfirmed: rows.filter((row) => row.agencyState === "unconfirmed").length,
      agencyNone: rows.filter((row) => row.agencyState === "none").length,
      agencyAssigned: rows.filter((row) => row.agencyState === "assigned").length,
      referrerUnconfirmed: rows.filter((row) => row.referrerState === "unconfirmed")
        .length,
      referrerNone: rows.filter((row) => row.referrerState === "none").length,
      referrerAssigned: rows.filter((row) => row.referrerState === "assigned").length,
      monthlyConfirmedCount: rows.filter(
        (row) => row.monthlyAssignmentState === "has_monthly",
      ).length,
    },
    error: null,
  };
}

export type { AgencyAssignmentState };
