import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizeReferralCode } from "@/lib/referrals/referral-code";

/*
  /ref/<referral_code> のコード解決を行う唯一の入口。

  ■ 解決順
    1. referrers.referral_code を検索し、有効（is_active）ならその紹介者
    2. 見つからない / 無効なら referrer_code_aliases を検索し、
       転送先（統合先）の紹介者が有効ならその紹介者
    3. どちらでも見つからなければ無効なリンク

  ■ なぜ「無効なら alias も見る」なのか
  紹介者を統合すると統合元の行は残したまま is_active=false にする
  （過去の報酬・支払履歴・名称変更履歴から名前を引けるようにするため）。
  そのため統合元の referral_code は referrers 側に「無効な行」として残り続ける。
  ステップ1で「見つかったが無効」を即エラーにすると alias まで到達できないので、
  「有効な紹介者が見つからなかった場合」を alias 検索の条件にしている。

  ■ 返す referrerId は必ず転送先
  alias 経由でも返すのは統合先の referrer_id。
  呼び出し側はこの ID をそのまま
  creators.referred_by_referrer_id と creator_referrals.referrer_id に保存する。
  alias 側に紐付けや報酬を作ってはいけない。
*/

export type ResolvedReferrer = {
  /** 紐付けに使う referrer_id。alias 経由でも必ず転送先（統合先） */
  id: string;
  name: string;
  /** 転送先が持つ正規の紹介コード */
  referralCode: string;
  /** アクセスに使われたコード（旧コードのこともある） */
  requestedCode: string;
  /** 旧コードからの転送だったか */
  viaAlias: boolean;
};

export type ResolveReferralCodeResult = {
  data: ResolvedReferrer | null;
  error: string | null;
};

type ReferrerRow = {
  id: string;
  referrer_name: string | null;
  name: string | null;
  referral_code: string | null;
  is_active: boolean | null;
};

const REFERRER_COLUMNS = "id, referrer_name, name, referral_code, is_active";

function toResolved(
  row: ReferrerRow,
  requestedCode: string,
  viaAlias: boolean,
): ResolvedReferrer | null {
  if (!row.id || !row.referral_code) return null;
  return {
    id: row.id,
    name: String(row.referrer_name ?? row.name ?? ""),
    referralCode: row.referral_code,
    requestedCode,
    viaAlias,
  };
}

/** alias テーブルが未適用でも紹介リンクを止めないための判定 */
function isMissingAliasTable(code: string | null | undefined): boolean {
  return code === "42P01" || code === "PGRST205" || code === "PGRST106";
}

export async function resolveActiveReferrerByCode(
  supabase: SupabaseClient,
  rawCode: string,
): Promise<ResolveReferralCodeResult> {
  const requestedCode = normalizeReferralCode(rawCode);
  if (!requestedCode) {
    return { data: null, error: "紹介コードが不正です" };
  }

  // --- 1. referrers.referral_code --------------------------------------------
  const direct = await supabase
    .from("referrers")
    .select(REFERRER_COLUMNS)
    .eq("referral_code", requestedCode)
    .maybeSingle();

  if (direct.error) {
    return { data: null, error: direct.error.message };
  }

  const directRow = direct.data as ReferrerRow | null;
  if (directRow?.id && directRow.is_active !== false) {
    return { data: toResolved(directRow, requestedCode, false), error: null };
  }

  // --- 2. referrer_code_aliases ----------------------------------------------
  const alias = await supabase
    .from("referrer_code_aliases")
    .select("referrer_id")
    .eq("code", requestedCode)
    .maybeSingle();

  if (alias.error) {
    if (isMissingAliasTable(alias.error.code)) {
      return { data: null, error: "紹介リンクが無効です" };
    }
    return { data: null, error: alias.error.message };
  }

  const targetId = (alias.data?.referrer_id as string | null) ?? null;
  if (!targetId) {
    return { data: null, error: "紹介リンクが無効です" };
  }

  // --- 3. 転送先が有効であることを確認する ------------------------------------
  const target = await supabase
    .from("referrers")
    .select(REFERRER_COLUMNS)
    .eq("id", targetId)
    .maybeSingle();

  if (target.error) {
    return { data: null, error: target.error.message };
  }

  const targetRow = target.data as ReferrerRow | null;
  if (!targetRow?.id || targetRow.is_active === false) {
    return { data: null, error: "紹介リンクが無効です" };
  }

  return { data: toResolved(targetRow, requestedCode, true), error: null };
}
