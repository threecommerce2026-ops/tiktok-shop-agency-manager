import type { SupabaseClient } from "@supabase/supabase-js";

import { fetchAllFrom } from "@/lib/db/paged-select";
import { toAmount } from "@/lib/revenue/amount";
import {
  REFERRER_MERGE_TABLES,
  REFERRER_REFERENCE_TABLES,
  isWithinEditDistanceOne,
  normalizeReferrerBankKey,
  normalizeReferrerEmail,
  normalizeReferrerName,
  normalizeReferrerPhone,
  referrerReferenceKey,
} from "@/lib/referrals/referrer-references";

/*
  紹介者マスタ整理（統合 / 削除 / 無効化）用のデータ。

  ■ 方針
  ・重複候補は「表示するだけ」。名前が似ていても自動統合は絶対にしない
    （同姓同名がありうるため、同一人物かどうかは管理者が判断する）
  ・DRY RUN は読み取りのみ。DBは一切変更しない
  ・支払い済みの紹介報酬・支払レコードを持つ紹介者は通常統合を禁止する
  ・紹介コードはどちらも削除しない（/ref/コード の紹介リンクに使われているため）
*/

export type ReferrerReferenceCount = {
  key: string;
  label: string;
  table: string;
  column: string;
  count: number;
  onDelete: "cascade" | "set null" | "restrict" | "none";
  reassignOnMerge: boolean;
};

export type ReferrerMaintenanceRow = {
  id: string;
  /** 表示名（referrer_name。無ければ name） */
  name: string;
  /** referrers.name（referrer_name と異なる場合に表示する） */
  legacyName: string;
  referralCode: string | null;
  email: string | null;
  phone: string | null;
  lineId: string | null;
  bankLabel: string | null;
  isActive: boolean;
  createdAt: string;
  /** 紹介者ポータルのログインアカウントがあるか */
  hasLogin: boolean;

  references: ReferrerReferenceCount[];
  totalReferences: number;
  /** 統合時に付け替える件数（履歴のみの参照は除く） */
  reassignTotal: number;

  creatorCount: number;
  activeLinkCount: number;
  rewardItemCount: number;
  /** 対象明細の報酬合計（is_reward_target のみ） */
  rewardAmount: number;
  paidRewardItemCount: number;
  paidRewardAmount: number;
  unpaidRewardAmount: number;
  payoutCount: number;
  paidPayoutCount: number;

  /**
   * 過去に統合元として使われた紹介者か。
   * referrer_maintenance_logs の merge 履歴、または
   * referrer_code_aliases.source_referrer_id に現れるもの。
   * 統合の証跡と旧紹介コードの転送元なので物理削除を禁止する。
   */
  isMergedSource: boolean;

  /** すべての参照が0で、かつ統合元でなければ物理削除できる */
  canDelete: boolean;
  /** 支払い済みデータがある紹介者は通常統合を禁止する */
  mergeBlockedByPaidData: boolean;
};

/** 重複候補の検出理由 */
export type ReferrerDuplicateReason =
  | "name"
  | "name_similar"
  | "name_contains"
  | "email"
  | "phone"
  | "bank"
  | "line_id";

export const REFERRER_DUPLICATE_REASON_LABEL: Record<
  ReferrerDuplicateReason,
  string
> = {
  name: "氏名が一致（空白・全半角・記号・敬称・異体字の違いを無視）",
  name_similar: "氏名が1文字違い（例: 亮介 / 亮佑、卓也 / 卓矢）",
  name_contains: "片方の氏名がもう片方に含まれる（例: 連名表記・屋号付き）",
  email: "メールアドレスが一致",
  phone: "電話番号が一致",
  bank: "振込先口座が一致",
  line_id: "LINE ID が一致",
};

/*
  重複候補の確度。整理作業の順序を決めるためだけの分類で、
  どれも「候補」であることに変わりはない（自動統合はしない）。

    high   … 正規化して完全一致（空白 / 全半角 / 敬称 / 異体字だけの違い）
             連絡先・口座の一致もここに含める
    medium … 1文字違いなど表記がかなり近い
    low    … 包含・連名・屋号付き（別人の可能性が高い）
*/
export type ReferrerDuplicateConfidence = "high" | "medium" | "low";

export const REFERRER_DUPLICATE_CONFIDENCE_LABEL: Record<
  ReferrerDuplicateConfidence,
  string
> = {
  high: "A 高確度",
  medium: "B 要確認",
  low: "C 低確度",
};

export const REFERRER_DUPLICATE_CONFIDENCE_NOTE: Record<
  ReferrerDuplicateConfidence,
  string
> = {
  high: "空白・全半角・敬称・異体字だけの違い、または連絡先/口座の一致。同一人物の可能性が高い組み合わせです。",
  medium: "1文字違いなど表記が近いもの。別人（同姓の別名）が混ざるため、必ず紐付けクリエイターを確認してください。",
  low: "片方の氏名がもう片方に含まれるだけ（連名・屋号付きなど）。別人の可能性が高く、統合よりも名称整理が適切な場合があります。",
};

const REASON_CONFIDENCE: Record<ReferrerDuplicateReason, ReferrerDuplicateConfidence> = {
  name: "high",
  email: "high",
  phone: "high",
  bank: "high",
  line_id: "high",
  name_similar: "medium",
  name_contains: "low",
};

/** グループ内で最も確度の高い理由をそのグループの確度とする */
function confidenceOf(
  reasons: ReferrerDuplicateReason[],
): ReferrerDuplicateConfidence {
  if (reasons.some((reason) => REASON_CONFIDENCE[reason] === "high")) return "high";
  if (reasons.some((reason) => REASON_CONFIDENCE[reason] === "medium")) return "medium";
  return "low";
}

export type ReferrerDuplicateGroup = {
  key: string;
  reasons: ReferrerDuplicateReason[];
  confidence: ReferrerDuplicateConfidence;
  referrerIds: string[];
};

export type ReferrerMaintenanceLog = {
  id: string;
  action: "merge" | "delete" | "deactivate" | "activate";
  referrerId: string;
  referrerName: string;
  targetReferrerId: string | null;
  targetReferrerName: string | null;
  sourceReferralCode: string | null;
  keptReferralCode: string | null;
  affectedTotal: number;
  changedByEmail: string | null;
  createdAt: string;
};

/** 紹介者名の変更履歴（master_name_change_logs の referrer 分） */
export type ReferrerNameChangeLog = {
  id: string;
  referrerId: string;
  fromName: string | null;
  toName: string;
  changedByEmail: string | null;
  createdAt: string;
};

export type ReferrerMaintenanceTotals = {
  /** referrers の総数（統合元も残るので統合しても減らない） */
  total: number;
  activeCount: number;
  inactiveCount: number;
  duplicateGroupCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
};

export type ReferrerMaintenanceData = {
  rows: ReferrerMaintenanceRow[];
  duplicateGroups: ReferrerDuplicateGroup[];
  totals: ReferrerMaintenanceTotals;
  logs: ReferrerMaintenanceLog[];
  nameChangeLogs: ReferrerNameChangeLog[];
  /** 履歴テーブル未適用などの補足。rows の表示は止めない */
  notice: string | null;
  error: string | null;
};

type ReferrerRecord = {
  id: string;
  name: string | null;
  referrer_name: string | null;
  referral_code: string | null;
  email: string | null;
  phone: string | null;
  line_id: string | null;
  bank_name: string | null;
  bank_branch_name: string | null;
  bank_account_number: string | null;
  is_active: boolean | null;
  created_at: string | null;
  user_id: string | null;
};

function bump(map: Map<string, number>, key: string | null | undefined, by = 1) {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + by);
}

/**
 * 紹介者マスタ整理の一覧データ。
 * 件数は全件取得したうえでメモリ上で集計する（紹介者ごとの COUNT を避ける）。
 */
export async function fetchReferrerMaintenanceData(
  supabase: SupabaseClient,
): Promise<ReferrerMaintenanceData> {
  const empty: ReferrerMaintenanceData = {
    rows: [],
    duplicateGroups: [],
    totals: {
      total: 0,
      activeCount: 0,
      inactiveCount: 0,
      duplicateGroupCount: 0,
      highCount: 0,
      mediumCount: 0,
      lowCount: 0,
    },
    logs: [],
    nameChangeLogs: [],
    notice: null,
    error: null,
  };

  const [
    referrersResult,
    creatorsResult,
    linksResult,
    itemsResult,
    payoutsResult,
    nameLogsResult,
    mergeLogsResult,
    aliasSourcesResult,
  ] = await Promise.all([
    fetchAllFrom<ReferrerRecord>(
      supabase,
      "referrers",
      "id, name, referrer_name, referral_code, email, phone, line_id, bank_name, bank_branch_name, bank_account_number, is_active, created_at, user_id",
    ),
    fetchAllFrom<{ referred_by_referrer_id: string | null }>(
      supabase,
      "creators",
      "referred_by_referrer_id",
    ),
    fetchAllFrom<{ referrer_id: string; is_active: boolean | null }>(
      supabase,
      "creator_referrals",
      "referrer_id, is_active",
    ),
    fetchAllFrom<{
      referrer_id: string;
      reward_amount: number | string | null;
      is_paid: boolean | null;
      is_reward_target: boolean | null;
    }>(
      supabase,
      "referral_reward_items",
      "referrer_id, reward_amount, is_paid, is_reward_target",
    ),
    fetchAllFrom<{ referrer_id: string; status: string | null }>(
      supabase,
      "referral_payouts",
      "referrer_id, status",
    ),
    fetchAllFrom<{
      id: string;
      target_id: string;
      target_type: string | null;
      from_name: string | null;
      to_name: string | null;
      changed_by_email: string | null;
      created_at: string | null;
    }>(
      supabase,
      "master_name_change_logs",
      "id, target_id, target_type, from_name, to_name, changed_by_email, created_at",
    ),
    /*
      統合元として使われた referrer_id を集める。
      ここに載る紹介者は統合の証跡・旧紹介コードの転送元なので削除させない。
    */
    fetchAllFrom<{ id: string; referrer_id: string; action: string | null }>(
      supabase,
      "referrer_maintenance_logs",
      "id, referrer_id, action",
      (query) => query.eq("action", "merge"),
    ),
    fetchAllFrom<{ id: string; source_referrer_id: string | null }>(
      supabase,
      "referrer_code_aliases",
      "id, source_referrer_id",
    ),
  ]);

  if (referrersResult.error) {
    return { ...empty, error: referrersResult.error };
  }

  const creatorCount = new Map<string, number>();
  for (const row of creatorsResult.data) bump(creatorCount, row.referred_by_referrer_id);

  const linkCount = new Map<string, number>();
  const activeLinkCount = new Map<string, number>();
  for (const row of linksResult.data) {
    bump(linkCount, row.referrer_id);
    if (row.is_active !== false) bump(activeLinkCount, row.referrer_id);
  }

  const itemCount = new Map<string, number>();
  const rewardAmount = new Map<string, number>();
  const paidItemCount = new Map<string, number>();
  const paidAmount = new Map<string, number>();
  for (const row of itemsResult.data) {
    bump(itemCount, row.referrer_id);
    const amount = toAmount(row.reward_amount);
    if (row.is_reward_target !== false) bump(rewardAmount, row.referrer_id, amount);
    if (row.is_paid) {
      bump(paidItemCount, row.referrer_id);
      bump(paidAmount, row.referrer_id, amount);
    }
  }

  const payoutCount = new Map<string, number>();
  const paidPayoutCount = new Map<string, number>();
  for (const row of payoutsResult.data) {
    bump(payoutCount, row.referrer_id);
    if (row.status === "paid") bump(paidPayoutCount, row.referrer_id);
  }

  /*
    統合元として使われた紹介者の集合。
    テーブル未適用などで読めなかった場合は空集合になるが、
    実際の削除は deleteReferrerAction が同じ判定をやり直したうえで
    読めなければ削除を拒否する（フェイルクローズ）。
  */
  const mergedSourceIds = new Set<string>();
  for (const row of mergeLogsResult.data) mergedSourceIds.add(row.referrer_id);
  for (const row of aliasSourcesResult.data) {
    if (row.source_referrer_id) mergedSourceIds.add(row.source_referrer_id);
  }

  const nameLogCount = new Map<string, number>();
  for (const row of nameLogsResult.data) {
    if (row.target_type === "referrer") bump(nameLogCount, row.target_id);
  }

  const countFor = (key: string, id: string): number => {
    switch (key) {
      case "creators.referred_by_referrer_id":
        return creatorCount.get(id) ?? 0;
      case "creator_referrals.referrer_id":
        return linkCount.get(id) ?? 0;
      case "referral_reward_items.referrer_id":
        return itemCount.get(id) ?? 0;
      case "referral_payouts.referrer_id":
        return payoutCount.get(id) ?? 0;
      case "master_name_change_logs.target_id":
        return nameLogCount.get(id) ?? 0;
      default:
        return 0;
    }
  };

  const rows: ReferrerMaintenanceRow[] = referrersResult.data.map((referrer) => {
    const id = referrer.id;
    const references: ReferrerReferenceCount[] = REFERRER_REFERENCE_TABLES.map(
      (ref) => ({
        key: referrerReferenceKey(ref),
        label: ref.label,
        table: ref.table,
        column: ref.column,
        count: countFor(referrerReferenceKey(ref), id),
        onDelete: ref.onDelete,
        reassignOnMerge: ref.reassignOnMerge,
      }),
    );

    const reassignTotal = references
      .filter((ref) => ref.reassignOnMerge)
      .reduce((sum, ref) => sum + ref.count, 0);
    const hasLogin = Boolean(referrer.user_id);

    /*
      物理削除の可否には履歴（master_name_change_logs）を含めない。
      履歴は外部キーを持たず、削除しても壊れないため。
      ただしログインアカウントが残っている場合は削除させない。
    */
    const paidRewardItemCount = paidItemCount.get(id) ?? 0;
    const paidPayouts = paidPayoutCount.get(id) ?? 0;
    const totalRewardAmount = rewardAmount.get(id) ?? 0;
    const totalPaidAmount = paidAmount.get(id) ?? 0;

    return {
      id,
      name: String(referrer.referrer_name ?? referrer.name ?? ""),
      legacyName: String(referrer.name ?? ""),
      referralCode: referrer.referral_code ?? null,
      email: referrer.email ?? null,
      phone: referrer.phone ?? null,
      lineId: referrer.line_id ?? null,
      bankLabel: normalizeReferrerBankKey({
        bankName: referrer.bank_name,
        bankBranchName: referrer.bank_branch_name,
        bankAccountNumber: referrer.bank_account_number,
      }),
      isActive: referrer.is_active !== false,
      createdAt: String(referrer.created_at ?? ""),
      hasLogin,
      references,
      totalReferences: references.reduce((sum, ref) => sum + ref.count, 0),
      reassignTotal,
      creatorCount: creatorCount.get(id) ?? 0,
      activeLinkCount: activeLinkCount.get(id) ?? 0,
      rewardItemCount: itemCount.get(id) ?? 0,
      rewardAmount: Math.round(totalRewardAmount * 100) / 100,
      paidRewardItemCount,
      paidRewardAmount: Math.round(totalPaidAmount * 100) / 100,
      unpaidRewardAmount:
        Math.round((totalRewardAmount - totalPaidAmount) * 100) / 100,
      payoutCount: payoutCount.get(id) ?? 0,
      paidPayoutCount: paidPayouts,
      isMergedSource: mergedSourceIds.has(id),
      canDelete: reassignTotal === 0 && !hasLogin && !mergedSourceIds.has(id),
      mergeBlockedByPaidData: paidRewardItemCount > 0 || paidPayouts > 0,
    };
  });

  rows.sort((a, b) => a.name.localeCompare(b.name, "ja") || a.id.localeCompare(b.id));

  const { groups: duplicateGroups } = detectReferrerDuplicates(rows);

  // --- 履歴（テーブル未適用でも一覧は表示する）--------------------------------
  const { data: logs, error: logsError } = await supabase
    .from("referrer_maintenance_logs")
    .select(
      "id, action, referrer_id, referrer_name, target_referrer_id, target_referrer_name, source_referral_code, kept_referral_code, affected_total, changed_by_email, created_at",
    )
    .order("created_at", { ascending: false })
    .limit(50);

  const notice =
    logsError && (logsError.code === "42P01" || logsError.code === "PGRST205")
      ? "紹介者整理の履歴テーブルが未適用です。supabase/migrations/20260917180000_referrer_maintenance_logs.sql を適用してください（統合・削除・無効化の実行前に必要です）。"
      : logsError
        ? `履歴の取得に失敗しました: ${logsError.message}`
        : null;

  const nameChangeLogs: ReferrerNameChangeLog[] = nameLogsResult.data
    .filter((row) => row.target_type === "referrer")
    .map((row) => ({
      id: row.id,
      referrerId: row.target_id,
      fromName: row.from_name ?? null,
      toName: String(row.to_name ?? ""),
      changedByEmail: row.changed_by_email ?? null,
      createdAt: String(row.created_at ?? ""),
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 50);

  const activeCount = rows.filter((row) => row.isActive).length;

  return {
    rows,
    duplicateGroups,
    totals: {
      total: rows.length,
      activeCount,
      inactiveCount: rows.length - activeCount,
      duplicateGroupCount: duplicateGroups.length,
      highCount: duplicateGroups.filter((g) => g.confidence === "high").length,
      mediumCount: duplicateGroups.filter((g) => g.confidence === "medium").length,
      lowCount: duplicateGroups.filter((g) => g.confidence === "low").length,
    },
    nameChangeLogs,
    logs: (logs ?? []).map((row) => ({
      id: row.id as string,
      action: row.action as ReferrerMaintenanceLog["action"],
      referrerId: row.referrer_id as string,
      referrerName: String(row.referrer_name ?? ""),
      targetReferrerId: (row.target_referrer_id as string | null) ?? null,
      targetReferrerName: (row.target_referrer_name as string | null) ?? null,
      sourceReferralCode: (row.source_referral_code as string | null) ?? null,
      keptReferralCode: (row.kept_referral_code as string | null) ?? null,
      affectedTotal: Number(row.affected_total ?? 0),
      changedByEmail: (row.changed_by_email as string | null) ?? null,
      createdAt: String(row.created_at ?? ""),
    })),
    notice,
    error: null,
  };
}

/**
 * 重複「候補」の検出。
 *
 * 氏名・メール・電話・口座・LINE ID が一致するものをまとめて返すだけで、
 * 同一人物かどうかの判断はしない。自動統合には絶対に使わないこと。
 */
export function detectReferrerDuplicates(rows: ReferrerMaintenanceRow[]): {
  groups: ReferrerDuplicateGroup[];
} {
  // --- (1) 完全一致（正規化後）のグループ -------------------------------------
  const buckets = new Map<
    string,
    { reason: ReferrerDuplicateReason; ids: string[] }
  >();

  const add = (reason: ReferrerDuplicateReason, key: string | null, id: string) => {
    if (!key) return;
    const bucketKey = `${reason}:${key}`;
    const bucket = buckets.get(bucketKey) ?? { reason, ids: [] };
    bucket.ids.push(id);
    buckets.set(bucketKey, bucket);
  };

  const normalizedName = new Map<string, string>();

  /*
    統合すると統合元は is_active=false で残る。
    そのまま候補に出し続けると整理済みの組が延々と並ぶので、
    重複候補の検出対象は「有効な紹介者」だけにする。
    無効な紹介者は下の一覧表（状態フィルタ）から確認できる。
  */
  const candidates = rows.filter((row) => row.isActive);

  for (const row of candidates) {
    const key = normalizeReferrerName(row.name);
    if (key) normalizedName.set(row.id, key);
    add("name", key || null, row.id);
    add("email", normalizeReferrerEmail(row.email), row.id);
    add("phone", normalizeReferrerPhone(row.phone), row.id);
    add("bank", row.bankLabel, row.id);
    add("line_id", (row.lineId ?? "").trim().toLowerCase() || null, row.id);
  }

  /*
    同じ紹介者の組み合わせが複数の理由で重複した場合はまとめる。
    グループのキーは referrer_id をソートして連結したもの。
  */
  const merged = new Map<string, ReferrerDuplicateGroup>();

  const upsert = (ids: string[], reason: ReferrerDuplicateReason) => {
    const sorted = [...new Set(ids)].sort();
    if (sorted.length < 2) return;
    const key = sorted.join("|");
    const existing = merged.get(key);
    if (existing) {
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      existing.confidence = confidenceOf(existing.reasons);
      return;
    }
    merged.set(key, {
      key,
      reasons: [reason],
      confidence: confidenceOf([reason]),
      referrerIds: sorted,
    });
  };

  for (const bucket of buckets.values()) {
    upsert(bucket.ids, bucket.reason);
  }

  /*
    --- (2) 「似ている名前」の総当たり ---------------------------------------
    完全一致では拾えない揺れを候補として出す。

      編集距離1 … 望月亮介 / 望月亮佑、池田卓也 / 池田卓矢、堂珍利沙 / 堂珍利紗
      包含関係  … 萩森愛 / 萩森愛内田優希、坂本洸平 / 坂本洸平広島グルメゾン

    誤検出（長尾剛 / 長尾剛志 のような別人）も混ざるため、
    あくまで「目視確認すべき候補」であり自動統合には使わない。
    すでに完全一致グループで同居している組は重複表示しない。
  */
  const inSameExactGroup = (a: string, b: string): boolean => {
    for (const group of merged.values()) {
      if (
        group.reasons.includes("name") &&
        group.referrerIds.includes(a) &&
        group.referrerIds.includes(b)
      ) {
        return true;
      }
    }
    return false;
  };

  // normalizedName は有効な紹介者だけから作られているので総当たりも有効同士に限られる
  const entries = [...normalizedName.entries()];

  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const [idA, nameA] = entries[i];
      const [idB, nameB] = entries[j];
      if (nameA === nameB) continue;
      if (inSameExactGroup(idA, idB)) continue;

      if (isWithinEditDistanceOne(nameA, nameB)) {
        upsert([idA, idB], "name_similar");
        continue;
      }

      // 包含は短い方が2文字以上のときだけ（「岡」のような1文字は拾わない）
      const [shortName, longName] =
        nameA.length <= nameB.length ? [nameA, nameB] : [nameB, nameA];
      if (shortName.length >= 2 && longName.includes(shortName)) {
        upsert([idA, idB], "name_contains");
      }
    }
  }

  // A（高確度）→ B（要確認）→ C（低確度）の順。同じ確度なら人数が多い組を先に。
  const confidenceWeight: Record<ReferrerDuplicateConfidence, number> = {
    high: 0,
    medium: 1,
    low: 2,
  };

  const groups = [...merged.values()].sort(
    (a, b) =>
      confidenceWeight[a.confidence] - confidenceWeight[b.confidence] ||
      b.referrerIds.length - a.referrerIds.length ||
      a.key.localeCompare(b.key),
  );

  return { groups };
}

// ============================================================================
// DRY RUN
// ============================================================================

export type ReferrerMergeCollision = {
  table: string;
  description: string;
  count: number;
  samples: string[];
};

export type ReferrerMergeReassign = {
  key: string;
  label: string;
  count: number;
};

export type ReferrerMergeSideSummary = {
  id: string;
  name: string;
  referralCode: string | null;
  isActive: boolean;
  hasLogin: boolean;
  creatorCount: number;
  linkCount: number;
  activeLinkCount: number;
  rewardItemCount: number;
  rewardAmount: number;
  paidRewardItemCount: number;
  paidRewardAmount: number;
  unpaidRewardAmount: number;
  payoutCount: number;
  paidPayoutCount: number;
  paidPayoutAmount: number;
  unpaidPayoutAmount: number;
  nameChangeLogCount: number;
};

/** 統合時に作られる「旧コード → 統合先」の転送設定 */
export type ReferrerAliasPlan = {
  /** 統合元の紹介コード。これが転送元になる */
  sourceCode: string | null;
  /** 統合後も運用を続ける統合先のコード */
  keptCode: string | null;
  /** 統合元を指していた既存 alias（連鎖統合で統合先へ付け替わる） */
  inheritedCodes: string[];
  /** alias テーブルが未適用なら転送を作れない */
  aliasTableReady: boolean;
};

export type ReferrerMergeDryRunResult = {
  source: ReferrerMergeSideSummary;
  target: ReferrerMergeSideSummary;
  reassign: ReferrerMergeReassign[];
  reassignTotal: number;
  collisions: ReferrerMergeCollision[];
  warnings: string[];
  aliasPlan: ReferrerAliasPlan;
  blockedByPaidData: boolean;
  canMerge: boolean;
  error: string | null;
};

type RewardItemRow = {
  referrer_id: string;
  creator_id: string;
  target_month: string | null;
  reward_year: string | null;
  source_row_key: string | null;
  reward_amount: number | string | null;
  is_paid: boolean | null;
  is_reward_target: boolean | null;
};

type PayoutRow = {
  referrer_id: string;
  target_month: string;
  reward_year: string | null;
  status: string | null;
  total_reward_amount: number | string | null;
};

type LinkRow = {
  id: string;
  referrer_id: string;
  creator_id: string;
  is_active: boolean | null;
  start_month: string | null;
  end_month: string | null;
};

function summarizeSide(params: {
  referrer: ReferrerRecord;
  creatorCount: number;
  links: LinkRow[];
  items: RewardItemRow[];
  payouts: PayoutRow[];
  nameChangeLogCount: number;
}): ReferrerMergeSideSummary {
  const { referrer, links, items, payouts } = params;

  let rewardAmount = 0;
  let paidRewardAmount = 0;
  let paidRewardItemCount = 0;
  for (const item of items) {
    const amount = toAmount(item.reward_amount);
    if (item.is_reward_target !== false) rewardAmount += amount;
    if (item.is_paid) {
      paidRewardItemCount += 1;
      paidRewardAmount += amount;
    }
  }

  let paidPayoutAmount = 0;
  let unpaidPayoutAmount = 0;
  let paidPayoutCount = 0;
  for (const payout of payouts) {
    const amount = toAmount(payout.total_reward_amount);
    if (payout.status === "paid") {
      paidPayoutCount += 1;
      paidPayoutAmount += amount;
    } else {
      unpaidPayoutAmount += amount;
    }
  }

  const round = (value: number) => Math.round(value * 100) / 100;

  return {
    id: referrer.id,
    name: String(referrer.referrer_name ?? referrer.name ?? ""),
    referralCode: referrer.referral_code ?? null,
    isActive: referrer.is_active !== false,
    hasLogin: Boolean(referrer.user_id),
    creatorCount: params.creatorCount,
    linkCount: links.length,
    activeLinkCount: links.filter((link) => link.is_active !== false).length,
    rewardItemCount: items.length,
    rewardAmount: round(rewardAmount),
    paidRewardItemCount,
    paidRewardAmount: round(paidRewardAmount),
    unpaidRewardAmount: round(rewardAmount - paidRewardAmount),
    payoutCount: payouts.length,
    paidPayoutCount,
    paidPayoutAmount: round(paidPayoutAmount),
    unpaidPayoutAmount: round(unpaidPayoutAmount),
    nameChangeLogCount: params.nameChangeLogCount,
  };
}

/**
 * 紹介者統合の DRY RUN。読み取りのみで、DBは一切変更しない。
 *
 * ■ 一意制約の実地調査結果（本番スキーマ）
 *   referral_reward_items
 *     UNIQUE (source_row_key)        ← referrer_id を含まない。
 *                                      source_row_key は全体で一意なので、
 *                                      referrer_id を付け替えても衝突しない。
 *     他に referrer_id を含む一意制約は無し。
 *   referral_payouts
 *     UNIQUE (target_month, referrer_id)  ← ここが唯一の衝突点。
 *                                      同じ対象月の支払レコードが両方にあると
 *                                      単純 UPDATE は一意制約違反になる。
 *   creator_referrals
 *     一意制約なし。ただし同じクリエイターが統合元・統合先の両方に
 *     ぶら下がっていると、統合後に同一 (creator_id, referrer_id) が
 *     2行できてしまい報酬計算の前提が壊れるため、衝突として扱う。
 */
export async function dryRunReferrerMerge(
  supabase: SupabaseClient,
  sourceId: string,
  targetId: string,
): Promise<ReferrerMergeDryRunResult> {
  const emptySide = (id: string): ReferrerMergeSideSummary => ({
    id,
    name: "",
    referralCode: null,
    isActive: true,
    hasLogin: false,
    creatorCount: 0,
    linkCount: 0,
    activeLinkCount: 0,
    rewardItemCount: 0,
    rewardAmount: 0,
    paidRewardItemCount: 0,
    paidRewardAmount: 0,
    unpaidRewardAmount: 0,
    payoutCount: 0,
    paidPayoutCount: 0,
    paidPayoutAmount: 0,
    unpaidPayoutAmount: 0,
    nameChangeLogCount: 0,
  });

  const base: ReferrerMergeDryRunResult = {
    source: emptySide(sourceId),
    target: emptySide(targetId),
    reassign: [],
    reassignTotal: 0,
    collisions: [],
    warnings: [],
    aliasPlan: {
      sourceCode: null,
      keptCode: null,
      inheritedCodes: [],
      aliasTableReady: false,
    },
    blockedByPaidData: false,
    canMerge: false,
    error: null,
  };

  if (!sourceId || !targetId) {
    return { ...base, error: "統合元と統合先を選択してください" };
  }
  if (sourceId === targetId) {
    return { ...base, error: "統合元と統合先が同じ紹介者です" };
  }

  const ids = [sourceId, targetId];

  const [referrersResult, creatorsResult, linksResult, itemsResult, payoutsResult, nameLogsResult] =
    await Promise.all([
      supabase
        .from("referrers")
        .select(
          "id, name, referrer_name, referral_code, email, phone, line_id, bank_name, bank_branch_name, bank_account_number, is_active, created_at, user_id",
        )
        .in("id", ids),
      fetchAllFrom<{ id: string; referred_by_referrer_id: string | null }>(
        supabase,
        "creators",
        "id, referred_by_referrer_id",
        (query) => query.in("referred_by_referrer_id", ids),
      ),
      fetchAllFrom<LinkRow>(
        supabase,
        "creator_referrals",
        "id, referrer_id, creator_id, is_active, start_month, end_month",
        (query) => query.in("referrer_id", ids),
      ),
      fetchAllFrom<RewardItemRow>(
        supabase,
        "referral_reward_items",
        "referrer_id, creator_id, target_month, reward_year, source_row_key, reward_amount, is_paid, is_reward_target",
        (query) => query.in("referrer_id", ids),
      ),
      fetchAllFrom<PayoutRow>(
        supabase,
        "referral_payouts",
        "id, referrer_id, target_month, reward_year, status, total_reward_amount",
        (query) => query.in("referrer_id", ids),
      ),
      fetchAllFrom<{ target_id: string; target_type: string | null }>(
        supabase,
        "master_name_change_logs",
        "target_id, target_type",
        (query) => query.in("target_id", ids),
      ),
    ]);

  if (referrersResult.error) {
    return { ...base, error: referrersResult.error.message };
  }

  const sourceRecord = (referrersResult.data ?? []).find(
    (row) => row.id === sourceId,
  ) as ReferrerRecord | undefined;
  const targetRecord = (referrersResult.data ?? []).find(
    (row) => row.id === targetId,
  ) as ReferrerRecord | undefined;

  if (!sourceRecord || !targetRecord) {
    return { ...base, error: "紹介者が見つかりません" };
  }

  const bySide = <T extends { referrer_id: string }>(rows: T[], id: string) =>
    rows.filter((row) => row.referrer_id === id);

  const nameLogCountFor = (id: string) =>
    nameLogsResult.data.filter(
      (row) => row.target_id === id && row.target_type === "referrer",
    ).length;

  const sourceCreators = creatorsResult.data.filter(
    (row) => row.referred_by_referrer_id === sourceId,
  );
  const targetCreators = creatorsResult.data.filter(
    (row) => row.referred_by_referrer_id === targetId,
  );

  const source = summarizeSide({
      referrer: sourceRecord,
      creatorCount: sourceCreators.length,
      links: bySide(linksResult.data, sourceId),
      items: bySide(itemsResult.data, sourceId),
      payouts: bySide(payoutsResult.data, sourceId),
      nameChangeLogCount: nameLogCountFor(sourceId),
  });
  const target = summarizeSide({
      referrer: targetRecord,
      creatorCount: targetCreators.length,
      links: bySide(linksResult.data, targetId),
      items: bySide(itemsResult.data, targetId),
      payouts: bySide(payoutsResult.data, targetId),
      nameChangeLogCount: nameLogCountFor(targetId),
  });

  // --- 付け替え件数 ------------------------------------------------------------
  const reassignCount = (key: string): number => {
    switch (key) {
      case "creators.referred_by_referrer_id":
        return source.creatorCount;
      case "creator_referrals.referrer_id":
        return source.linkCount;
      case "referral_reward_items.referrer_id":
        return source.rewardItemCount;
      case "referral_payouts.referrer_id":
        return source.payoutCount;
      default:
        return 0;
    }
  };

  const reassign: ReferrerMergeReassign[] = REFERRER_MERGE_TABLES.map((ref) => ({
    key: referrerReferenceKey(ref),
    label: ref.label,
    count: reassignCount(referrerReferenceKey(ref)),
  }));
  const reassignTotal = reassign.reduce((sum, row) => sum + row.count, 0);

  // --- 衝突チェック ------------------------------------------------------------
  const collisions: ReferrerMergeCollision[] = [];

  // (1) referral_payouts (target_month, referrer_id) の一意制約
  const targetPayoutMonths = new Set(
    bySide(payoutsResult.data, targetId).map((row) => row.target_month),
  );
  const collidingMonths = bySide(payoutsResult.data, sourceId)
    .map((row) => row.target_month)
    .filter((month) => targetPayoutMonths.has(month))
    .sort();

  if (collidingMonths.length > 0) {
    collisions.push({
      table: "referral_payouts",
      description:
        "同じ対象月の紹介者支払レコードが統合元・統合先の両方にあります（target_month + referrer_id が一意）。合算・削除・どちらを残すかは自動判断できません。",
      count: collidingMonths.length,
      samples: collidingMonths.slice(0, 12),
    });
  }

  // (2) creator_referrals: 同一クリエイターが両方にぶら下がっている
  const targetLinkCreators = new Set(
    bySide(linksResult.data, targetId).map((row) => row.creator_id),
  );
  const collidingCreators = bySide(linksResult.data, sourceId)
    .map((row) => row.creator_id)
    .filter((creatorId) => targetLinkCreators.has(creatorId));

  if (collidingCreators.length > 0) {
    collisions.push({
      table: "creator_referrals",
      description:
        "同じクリエイターが統合元・統合先の両方に紹介リンクを持っています。単純に付け替えると同一クリエイターの紹介リンクが二重になり、料率・期間・生涯上限の判定が壊れます。どちらの期間を残すかを決めてから実行してください。",
      count: collidingCreators.length,
      samples: collidingCreators.slice(0, 12),
    });
  }

  // (3) referral_reward_items は source_row_key 単独の一意制約なので衝突しない。
  //     ただし同一クリエイター・同一月の明細が両方にある場合は取り込み経緯が
  //     ねじれている可能性があるため、警告として知らせる。
  const warnings: string[] = [];

  const targetItemKeys = new Set(
    bySide(itemsResult.data, targetId).map(
      (row) => `${row.creator_id}:${row.target_month ?? ""}`,
    ),
  );
  const overlappingItems = bySide(itemsResult.data, sourceId).filter((row) =>
    targetItemKeys.has(`${row.creator_id}:${row.target_month ?? ""}`),
  );

  if (overlappingItems.length > 0) {
    warnings.push(
      `同一クリエイター・同一対象月の紹介報酬明細が両方に ${overlappingItems.length} 件あります。source_row_key が一意のため統合自体は成立しますが、年間累計（reward_year 単位の1,000円しきい値）の判定が統合後に変わります。統合後は「売上・報酬 › 紹介者報酬」で再集計してください。`,
    );
  }

  if (source.hasLogin && target.hasLogin) {
    warnings.push(
      "統合元・統合先の両方に紹介者ポータルのログインアカウント（referrers.user_id）があります。統合ではログインは引き継がれません。統合元のログインは統合後どのデータも参照できなくなります。",
    );
  } else if (source.hasLogin) {
    warnings.push(
      "統合元に紹介者ポータルのログインアカウントがあります。統合ではログインは引き継がれないため、統合後は統合先のアカウントで運用してください。",
    );
  }

  // --- 旧紹介コードの転送（alias）計画 ----------------------------------------
  /*
    統合元は統合後に is_active=false になるため、
    /ref/<統合元コード> をそのままにすると死んでしまう。
    旧コードは referrer_code_aliases に「→ 統合先」として登録し、
    既存の紹介リンクからの登録が統合先へ届くようにする。
  */
  const aliasResult = await supabase
    .from("referrer_code_aliases")
    .select("code, referrer_id")
    .eq("referrer_id", sourceId);

  const aliasTableReady = !(
    aliasResult.error &&
    (aliasResult.error.code === "42P01" || aliasResult.error.code === "PGRST205")
  );

  const aliasPlan: ReferrerAliasPlan = {
    sourceCode: source.referralCode,
    keptCode: target.referralCode,
    inheritedCodes: (aliasResult.data ?? []).map((row) => String(row.code)),
    aliasTableReady,
  };

  if (!aliasTableReady) {
    warnings.push(
      "referrer_code_aliases が未適用のため、旧紹介コードの転送を作成できません。supabase/migrations/20260917190000_referrer_code_aliases.sql を適用してください。",
    );
  } else if (source.referralCode) {
    warnings.push(
      `紹介コードはどちらも削除しません。統合元 ${source.referralCode} は referrer_code_aliases に登録され、/ref/${source.referralCode} からの新規登録は統合先「${target.name}」に紐付きます。統合先の正規コードは ${
        target.referralCode ?? "（なし）"
      } のままです。`,
    );
  }

  if (aliasPlan.inheritedCodes.length > 0) {
    warnings.push(
      `統合元を転送先にしていた旧コード ${aliasPlan.inheritedCodes.join(
        ", ",
      )} も、まとめて統合先へ付け替わります（連鎖統合）。`,
    );
  }

  if (!target.isActive) {
    warnings.push(
      `統合先「${target.name}」は現在「無効」です。統合後に有効化が必要か確認してください。`,
    );
  }

  const blockedByPaidData =
    source.paidRewardItemCount > 0 || source.paidPayoutCount > 0;

  return {
    source,
    target,
    reassign,
    reassignTotal,
    collisions,
    warnings,
    aliasPlan,
    blockedByPaidData,
    // alias テーブルが無いと旧リンクが死ぬので、未適用のうちは統合させない
    canMerge: !blockedByPaidData && collisions.length === 0 && aliasTableReady,
    error: null,
  };
}

/**
 * 統合後の整合性チェック（読み取りのみ）。
 *
 * creators.referred_by_referrer_id と creator_referrals の有効行がずれていないかを見る。
 * ずれていた場合は統合処理の不具合なので、必ず管理者へ知らせる。
 */
export async function verifyReferrerLinkConsistency(
  supabase: SupabaseClient,
  referrerId: string,
): Promise<{ mismatchCount: number; error: string | null }> {
  const [creatorsResult, linksResult] = await Promise.all([
    fetchAllFrom<{ id: string; referred_by_referrer_id: string | null }>(
      supabase,
      "creators",
      "id, referred_by_referrer_id",
      (query) => query.eq("referred_by_referrer_id", referrerId),
    ),
    fetchAllFrom<LinkRow>(
      supabase,
      "creator_referrals",
      "id, referrer_id, creator_id, is_active, start_month, end_month",
      (query) => query.eq("referrer_id", referrerId).eq("is_active", true),
    ),
  ]);

  const error = creatorsResult.error ?? linksResult.error;
  if (error) return { mismatchCount: 0, error };

  const linkedCreators = new Set(linksResult.data.map((row) => row.creator_id));
  const mismatchCount = creatorsResult.data.filter(
    (row) => !linkedCreators.has(row.id),
  ).length;

  return { mismatchCount, error: null };
}
