import { redirect } from "next/navigation";

import { fetchPaymentBatchDetail, fetchPaymentOverview } from "@/lib/db/payment-queries";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import {
  buildAgencyStatement,
  isStatementIssuableStatus,
  type AgencyStatement,
} from "@/lib/payments/agency-statement";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/*
  明細書の読み込み。

  ■ admin only
  batch ID を知っているだけでは取得できない。ログイン済みかつ親管理者だけ。
  帳票には代理店名・クリエイター名・金額が並ぶため、URL を共有されても
  第三者が開けない状態を保つ。

  ■ 報酬を再計算しない
  画面と同じ fetchPaymentBatchDetail / fetchPaymentOverview だけを使う。
  明細書のための専用クエリや専用計算はここにも書かない。
*/

/** 親管理者でなければ止める。戻り値は service role クライアント */
async function requireAdmin(nextPath: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect(`/login?next=${encodeURIComponent(nextPath)}`);

  const appUser = await resolveAppUserContext(supabase, user);
  if (!isAdminRole(appUser.data.role)) redirect("/dashboard");

  return getSupabaseAdmin();
}

export type StatementLoadResult = {
  statements: AgencyStatement[];
  /** 出力を拒否した支払明細。件数を黙って減らさず理由を持ち帰る */
  rejected: { agencyName: string; message: string }[];
  error: string | null;
};

/** 支払明細1件ぶん */
export async function loadAgencyStatement(
  batchId: string,
): Promise<StatementLoadResult> {
  const admin = await requireAdmin(`/statements/agency/${batchId}`);
  const detail = await fetchPaymentBatchDetail(admin, batchId);

  if (detail.error) {
    return { statements: [], rejected: [], error: detail.error };
  }

  const built = buildAgencyStatement(detail);

  if (!built.ok) {
    return {
      statements: [],
      rejected: [
        {
          agencyName: detail.batch?.payeeName ?? "（不明）",
          message: built.rejection.message,
        },
      ],
      error: built.rejection.message,
    };
  }

  return { statements: [built.statement], rejected: [], error: null };
}

/**
 * 締め対象月ぶんをまとめて。
 * 承認済み以降の代理店支払明細だけを対象にする。
 */
export async function loadAgencyStatementsForCutoff(
  cutoffMonth: string,
): Promise<StatementLoadResult> {
  const admin = await requireAdmin(
    `/statements/agency?cutoff=${encodeURIComponent(cutoffMonth)}`,
  );

  const overview = await fetchPaymentOverview(admin, { cutoffMonth });

  if (overview.error) {
    return { statements: [], rejected: [], error: overview.error };
  }

  const targets = overview.batches
    .filter(
      (batch) =>
        batch.payeeKind === "agency" &&
        batch.cutoffMonth === cutoffMonth &&
        isStatementIssuableStatus(batch.status),
    )
    // 金額の大きい順。画面の並びと合わせる
    .sort((a, b) => b.paymentAmount - a.paymentAmount);

  if (targets.length === 0) {
    return {
      statements: [],
      rejected: [],
      error: `${cutoffMonth} 締めの承認済み代理店支払明細がありません。承認後に出力してください。`,
    };
  }

  const statements: AgencyStatement[] = [];
  const rejected: { agencyName: string; message: string }[] = [];

  /*
    1件ずつ確かめる。1件でも整合しないものがあれば、
    その代理店だけ出力から外して理由を見せる（黙って落とさない）。
  */
  for (const batch of targets) {
    const detail = await fetchPaymentBatchDetail(admin, batch.id);

    if (detail.error) {
      rejected.push({ agencyName: batch.payeeName, message: detail.error });
      continue;
    }

    const built = buildAgencyStatement(detail);

    if (built.ok) statements.push(built.statement);
    else rejected.push({ agencyName: batch.payeeName, message: built.rejection.message });
  }

  return {
    statements,
    rejected,
    error:
      statements.length === 0
        ? "出力できる支払明細がありませんでした。"
        : null,
  };
}
