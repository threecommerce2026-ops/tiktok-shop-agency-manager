"use server";

import { revalidatePath } from "next/cache";

import { requireAdminAction } from "@/lib/db/admin-access";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { mapSupabaseErrorToJa } from "@/lib/supabase/error-ja";
import { REFERRER_MERGE_TABLES } from "@/lib/referrals/referrer-references";
import {
  dryRunReferrerMerge,
  type ReferrerMergeDryRunResult,
} from "@/lib/db/referrer-maintenance-queries";

/*
  紹介者マスタの整理（統合 / 削除 / 無効化）。

  ■ 安全装置
  ・統合は二段階確認（confirm=1 が無ければ DRY RUN だけを返す）
  ・DRY RUN の内容は実行直前にサーバー側で取り直して再判定する
    （画面が古いまま実行されるのを防ぐ）
  ・支払い済みの紹介報酬明細 / 支払レコードがある紹介者は統合禁止
  ・一意制約が衝突する場合は統合禁止
      referral_payouts (target_month, referrer_id)
      creator_referrals の同一クリエイター二重紐付け
  ・物理削除は付け替え対象の参照が全て0かつログイン無しのときだけ許可
    （creator_referrals / referral_reward_items / referral_payouts は
      ON DELETE CASCADE のため、参照があるまま削除すると報酬データが道連れで消える）
  ・統合元として使われた紹介者は物理削除を禁止する
    統合後は参照が0になるため一見「削除可能」に見えるが、
      - 統合の証跡（誰を誰に寄せたか）を referrer_id で追えなくなる
      - 旧紹介コードの転送元（referrer_code_aliases.source_referrer_id）が
        実体を失う
    ため、is_active=false のまま DB に残す。
    判定は isMergedSourceReferrer() に集約し、読めなかった場合は削除を拒否する。
  ・紹介コードはどちらも削除・変更しない
  ・履歴は referrer_maintenance_logs に記録する

  ■ 名称変更はここでは扱わない
  名称変更は app/actions/master-name-edit.ts の renameReferrerAction に一本化。

  ■ 実統合は必ず RPC（1トランザクション）
  merge_referrer() の中で
    安全チェック → 参照付け替え → 旧コードの alias 保存
    → 統合元の is_active=false → 統合履歴の保存
  までを行う。途中で失敗すれば全てロールバックされるため、
  「クリエイターだけ移って報酬明細が残る」ような中途半端な状態が本番に残らない。

  RPC は is_app_admin()（auth.uid() 依存）で権限を見るので、
  必ず auth.supabase（ログインユーザーのクライアント）から呼ぶこと。
  service role クライアントから呼ぶと権限エラーになる。

  ■ クリエイター紐付けの整合性
  creators.referred_by_referrer_id と creator_referrals.referrer_id は
  RPC 内の同一トランザクションで必ず両方付け替える。
  統合前後の不整合件数を比較し、増えていればロールバックする。

  ■ 旧紹介コード
  統合元の referral_code は削除しない。referrer_code_aliases に
  「旧コード → 統合先 referrer_id」として保存し、/ref/<旧コード> は
  統合先へ転送される（lib/referrals/resolve-referral-code.ts）。
*/

/** merge_referrer() の戻り値（jsonb） */
type MergeRpcResult = {
  affected_counts?: Record<string, number>;
  affected_total?: number;
  alias_rows?: number;
  source_deactivated?: boolean;
  link_mismatch_before?: number;
  link_mismatch_after?: number;
};

export type ReferrerMaintenanceResult =
  | { ok: true; message: string; dryRun?: ReferrerMergeDryRunResult }
  | { ok: false; error: string; dryRun?: ReferrerMergeDryRunResult };

const MIGRATION_HINT =
  "紹介者整理の履歴テーブルが未適用です。supabase/migrations/20260917180000_referrer_maintenance_logs.sql を適用してください。";

const MERGE_MIGRATION_HINT =
  "紹介者統合の仕組みが未適用です。次の3つを適用してください: " +
  "20260917180000_referrer_maintenance_logs.sql / " +
  "20260917190000_referrer_code_aliases.sql / " +
  "20260917200000_merge_referrer_rpc.sql";

/*
  merge_referrer() が返す独自 SQLSTATE を日本語にする。
  何が起きたか分からないまま再実行されるのを防ぐため、必ず原因を出す。
*/
function mapMergeRpcError(error: {
  code?: string | null;
  message?: string | null;
}): string {
  const message = error.message ?? "統合に失敗しました";
  switch (error.code) {
    case "RF001":
      return `${message}。支払履歴を壊さない進め方は画面下部の案内を参照してください。`;
    case "RF002":
    case "RF003":
      return `統合すると報酬明細が衝突します。${message}`;
    case "RF004":
      return message;
    case "RF005":
      return `${message}。DBは統合前の状態に戻っています。`;
    case "42501":
      return "紹介者の統合は親管理者のみ実行できます";
    case "42883":
    case "PGRST202":
      return MERGE_MIGRATION_HINT;
    default:
      return mapSupabaseErrorToJa(message);
  }
}

function readText(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function isMissingTable(code: string | null | undefined): boolean {
  return code === "42P01" || code === "PGRST205";
}

/**
 * 統合元として使われた紹介者かどうか。
 *
 * 判定材料は2つ。どちらかに載っていれば統合元とみなす。
 *   referrer_maintenance_logs … action='merge' の referrer_id（統合元）
 *   referrer_code_aliases     … source_referrer_id（旧紹介コードの転送元）
 *
 * 確認できなかった場合（テーブル未適用・通信エラー）は
 * blocked=true を返してフェイルクローズする。
 * 「分からないから消してよい」にすると統合の証跡を失うため。
 */
async function isMergedSourceReferrer(
  admin: ReturnType<typeof getSupabaseAdmin>,
  referrerId: string,
): Promise<{ blocked: boolean; reason: string | null }> {
  const [mergeLog, alias] = await Promise.all([
    admin
      .from("referrer_maintenance_logs")
      .select("id", { count: "exact", head: true })
      .eq("action", "merge")
      .eq("referrer_id", referrerId),
    admin
      .from("referrer_code_aliases")
      .select("id", { count: "exact", head: true })
      .eq("source_referrer_id", referrerId),
  ]);

  for (const [label, result] of [
    ["統合履歴", mergeLog],
    ["旧紹介コードの転送設定", alias],
  ] as const) {
    if (result.error) {
      return {
        blocked: true,
        reason: `${label}を確認できなかったため、安全のため削除を中止しました（${
          isMissingTable(result.error.code)
            ? "テーブルが未適用です"
            : mapSupabaseErrorToJa(result.error.message)
        }）。`,
      };
    }
  }

  if ((mergeLog.count ?? 0) > 0 || (alias.count ?? 0) > 0) {
    return {
      blocked: true,
      reason:
        "この紹介者は過去に統合元として使われているため削除できません。統合の証跡と旧紹介コードの転送元を保持する必要があるので、is_active=false（無効）のまま残してください。",
    };
  }

  return { blocked: false, reason: null };
}

function revalidateReferrerViews() {
  revalidatePath("/admin/referrers");
  revalidatePath("/admin/creator-referrals");
  revalidatePath("/admin/creator-master-editor");
  revalidatePath("/creators");
  revalidatePath("/revenue");
  revalidatePath("/referrer/dashboard");
}

async function writeMaintenanceLog(params: {
  action: "merge" | "delete" | "deactivate" | "activate";
  referrerId: string;
  referrerName: string;
  targetReferrerId?: string | null;
  targetReferrerName?: string | null;
  sourceReferralCode?: string | null;
  keptReferralCode?: string | null;
  affectedCounts?: Record<string, number>;
  affectedTotal?: number;
  changedBy: string | null;
  changedByEmail: string | null;
}): Promise<string | null> {
  const { error } = await getSupabaseAdmin()
    .from("referrer_maintenance_logs")
    .insert({
      action: params.action,
      referrer_id: params.referrerId,
      referrer_name: params.referrerName,
      target_referrer_id: params.targetReferrerId ?? null,
      target_referrer_name: params.targetReferrerName ?? null,
      source_referral_code: params.sourceReferralCode ?? null,
      kept_referral_code: params.keptReferralCode ?? null,
      affected_counts: params.affectedCounts ?? {},
      affected_total: params.affectedTotal ?? 0,
      changed_by: params.changedBy,
      changed_by_email: params.changedByEmail,
    });

  if (error && isMissingTable(error.code)) return MIGRATION_HINT;
  return error ? error.message : null;
}

/**
 * 紹介者の統合。
 *
 * 1回目（confirm なし）: DRY RUN のみを返す。DBは一切変更しない。
 * 2回目（confirm=1）  : DRY RUN を取り直して再判定したうえで referrer_id を付け替える。
 */
export async function mergeReferrerAction(
  _prev: ReferrerMaintenanceResult | null,
  formData: FormData,
): Promise<ReferrerMaintenanceResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const sourceId = readText(formData, "source_referrer_id");
  const targetId = readText(formData, "target_referrer_id");
  const confirmed = readText(formData, "confirm") === "1";

  if (!sourceId || !targetId) {
    return { ok: false, error: "統合元と統合先を選択してください" };
  }

  const admin = getSupabaseAdmin();
  const dryRun = await dryRunReferrerMerge(admin, sourceId, targetId);

  if (dryRun.error) {
    return { ok: false, error: mapSupabaseErrorToJa(dryRun.error) };
  }

  if (dryRun.blockedByPaidData) {
    return {
      ok: false,
      dryRun,
      error: `「${dryRun.source.name}」には支払い済みの紹介報酬データがあるため、通常の統合はできません（支払済明細 ${dryRun.source.paidRewardItemCount} 件 / 支払確定 ${dryRun.source.paidPayoutCount} 件）。支払履歴を壊さない進め方は画面下部の案内を参照してください。`,
    };
  }

  if (dryRun.collisions.length > 0) {
    return {
      ok: false,
      dryRun,
      error: `統合すると報酬明細が衝突します（${dryRun.collisions
        .map((collision) => `${collision.table}: ${collision.count} 件`)
        .join(
          " / ",
        )}）。合算・削除・再計算は自動で行いません。どちらを残すか決めてから実行してください。`,
    };
  }

  // --- 1回目は DRY RUN だけ返す -----------------------------------------------
  if (!confirmed) {
    return {
      ok: true,
      dryRun,
      message: `DRY RUN: 「${dryRun.source.name}」を「${dryRun.target.name}」へ統合すると ${dryRun.reassignTotal} 件が付け替わります。内容を確認して「② 統合を実行する」を押してください。この時点ではDBは変更していません。`,
    };
  }

  // --- 2回目のみ実行（1トランザクションの RPC）---------------------------------
  /*
    ここから先は merge_referrer() の中で完結する。
    JS 側で UPDATE を並べると途中失敗で中途半端な状態が残るため、
    付け替え・alias 保存・無効化・履歴保存を全てサーバー関数に閉じる。

    RPC は is_app_admin()（auth.uid() 依存）で権限判定するので、
    service role ではなくログインユーザーのクライアントから呼ぶ。
  */
  const { data: rpcData, error: rpcError } = await auth.supabase.rpc(
    "merge_referrer",
    {
      p_source_referrer_id: sourceId,
      p_target_referrer_id: targetId,
      p_changed_by: auth.user?.id ?? null,
      p_changed_by_email: auth.user?.email ?? null,
    },
  );

  if (rpcError) {
    return { ok: false, dryRun, error: mapMergeRpcError(rpcError) };
  }

  const result = (rpcData ?? {}) as MergeRpcResult;
  const affectedTotal = Number(result.affected_total ?? 0);
  const aliasRows = Number(result.alias_rows ?? 0);

  revalidateReferrerViews();

  return {
    ok: true,
    dryRun,
    message: [
      `「${dryRun.source.name}」を「${dryRun.target.name}」へ統合しました（${affectedTotal} 件を付け替え）。`,
      dryRun.source.referralCode
        ? `旧紹介コード ${dryRun.source.referralCode} は統合先へ転送されるよう登録しました（alias ${aliasRows} 件）。/ref/${dryRun.source.referralCode} からの登録は統合先「${dryRun.target.name}」に紐付きます。`
        : "統合元に紹介コードはありませんでした。",
      `統合元は is_active=false（無効）にしました。行は残っているので、過去の紹介報酬・支払履歴・統合履歴・名称変更履歴から名前を引けます。`,
      "統合後は「売上・報酬 › 紹介者報酬」で再集計してください。",
    ].join(""),
  };
}

/**
 * 紹介者の物理削除。付け替え対象の参照が1件でもあれば拒否する。
 */
export async function deleteReferrerAction(
  _prev: ReferrerMaintenanceResult | null,
  formData: FormData,
): Promise<ReferrerMaintenanceResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const referrerId = readText(formData, "referrer_id");
  const confirmed = readText(formData, "confirm") === "1";

  if (!referrerId) {
    return { ok: false, error: "紹介者 ID が不正です" };
  }
  if (!confirmed) {
    return { ok: false, error: "確認にチェックしてから削除してください" };
  }

  const admin = getSupabaseAdmin();

  const { data: referrer, error: loadError } = await admin
    .from("referrers")
    .select("id, referrer_name, name, referral_code, user_id")
    .eq("id", referrerId)
    .maybeSingle();

  if (loadError) {
    return { ok: false, error: mapSupabaseErrorToJa(loadError.message) };
  }
  if (!referrer) {
    return { ok: false, error: "紹介者が見つかりません" };
  }

  if (referrer.user_id) {
    return {
      ok: false,
      error:
        "この紹介者には紹介者ポータルのログインアカウントが紐付いています。物理削除ではなく無効化を使ってください。",
    };
  }

  /*
    統合元だった紹介者は削除禁止。
    統合直後は参照が0になるため下の参照チェックは通ってしまうので、
    参照を数える前にここで止める。
  */
  const mergedSource = await isMergedSourceReferrer(admin, referrerId);
  if (mergedSource.blocked) {
    return { ok: false, error: mergedSource.reason ?? "削除できません" };
  }

  /*
    削除直前にサーバー側でも参照を数え直す。
    creator_referrals / referral_reward_items / referral_payouts は
    ON DELETE CASCADE のため、画面表示が古いまま削除されると報酬データが消える。
  */
  for (const ref of REFERRER_MERGE_TABLES) {
    const { count, error } = await admin
      .from(ref.table)
      .select("*", { count: "exact", head: true })
      .eq(ref.column, referrerId);

    if (error) {
      return {
        ok: false,
        error: `参照件数の確認に失敗したため削除を中止しました（${ref.table}）: ${mapSupabaseErrorToJa(
          error.message,
        )}`,
      };
    }

    if ((count ?? 0) > 0) {
      return {
        ok: false,
        error: `削除できません。「${ref.label}」が ${count} 件残っています。統合または無効化してください。`,
      };
    }
  }

  const { error } = await admin.from("referrers").delete().eq("id", referrerId);

  if (error) {
    return { ok: false, error: mapSupabaseErrorToJa(error.message) };
  }

  const name = String(referrer.referrer_name ?? referrer.name ?? "");
  const logError = await writeMaintenanceLog({
    action: "delete",
    referrerId,
    referrerName: name,
    sourceReferralCode: (referrer.referral_code as string | null) ?? null,
    changedBy: auth.user?.id ?? null,
    changedByEmail: auth.user?.email ?? null,
  });

  revalidateReferrerViews();

  return {
    ok: true,
    message: `紹介者「${name}」を削除しました。紹介コード ${
      referrer.referral_code ?? "（なし）"
    } の /ref/ リンクは今後 404 になります。${
      logError ? `（履歴の保存に失敗: ${logError}）` : ""
    }`,
  };
}

/**
 * 紹介者の有効 / 無効切り替え。
 *
 * 無効化しても過去データはそのまま残る（報酬・支払履歴・クリエイター履歴で名前は表示される）。
 * ただし /ref/コード の紹介リンクは無効になり、新規クリエイター登録を受け付けなくなる。
 */
export async function setReferrerActiveAction(
  _prev: ReferrerMaintenanceResult | null,
  formData: FormData,
): Promise<ReferrerMaintenanceResult> {
  const auth = await requireAdminAction();
  if (!auth.ok) return { ok: false, error: auth.error };

  const referrerId = readText(formData, "referrer_id");
  const nextActive = readText(formData, "next_active") === "1";

  if (!referrerId) {
    return { ok: false, error: "紹介者 ID が不正です" };
  }

  const { data: referrer, error: loadError } = await auth.supabase
    .from("referrers")
    .select("id, referrer_name, name, referral_code, is_active")
    .eq("id", referrerId)
    .maybeSingle();

  if (loadError) {
    return { ok: false, error: mapSupabaseErrorToJa(loadError.message) };
  }
  if (!referrer) {
    return { ok: false, error: "紹介者が見つかりません" };
  }

  /*
    再有効化の注意:
    統合で無効化した紹介者の referral_code は referrer_code_aliases に
    「旧コード → 統合先」として登録されている。
    紹介コードの解決は「有効な referrers が優先、無ければ alias」なので、
    この紹介者を再び有効にすると /ref/<コード> が統合先ではなく
    この紹介者へ戻る。意図しない巻き戻しを防ぐため警告を出す。
  */
  let aliasWarning = "";
  if (nextActive && referrer.referral_code) {
    const { data: alias } = await getSupabaseAdmin()
      .from("referrer_code_aliases")
      .select("referrer_id")
      .eq("code", referrer.referral_code)
      .maybeSingle();

    if (alias?.referrer_id && alias.referrer_id !== referrerId) {
      aliasWarning =
        `【注意】紹介コード ${referrer.referral_code} は統合により別の紹介者へ転送設定されています。` +
        "有効化したことで /ref/ からの新規登録がこの紹介者へ戻ります。転送を続けたい場合は再度無効化してください。";
    }
  }

  const { error } = await auth.supabase
    .from("referrers")
    .update({ is_active: nextActive })
    .eq("id", referrerId);

  if (error) {
    return { ok: false, error: mapSupabaseErrorToJa(error.message) };
  }

  const name = String(referrer.referrer_name ?? referrer.name ?? "");
  const logError = await writeMaintenanceLog({
    action: nextActive ? "activate" : "deactivate",
    referrerId,
    referrerName: name,
    sourceReferralCode: (referrer.referral_code as string | null) ?? null,
    changedBy: auth.user?.id ?? null,
    changedByEmail: auth.user?.email ?? null,
  });

  revalidateReferrerViews();

  return {
    ok: true,
    message: nextActive
      ? `紹介者「${name}」を有効にしました。紹介リンク /ref/${
          referrer.referral_code ?? ""
        } も再び使えます。${aliasWarning}`
      : `紹介者「${name}」を無効にしました。新規の紹介者選択と紹介リンク /ref/${
          referrer.referral_code ?? ""
        } からの新規登録は受け付けなくなります（統合で無効化した場合は、旧コードが referrer_code_aliases 経由で統合先へ転送されます）。過去の紹介報酬・支払履歴・クリエイター履歴・名称変更履歴はそのまま残り、名前も表示されます。${
          logError ? `（履歴の保存に失敗: ${logError}）` : ""
        }`,
  };
}
