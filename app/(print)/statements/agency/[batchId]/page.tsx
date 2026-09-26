import Link from "next/link";

import { AGENCY_PAYOUT_THRESHOLD_YEN } from "@/lib/payments/minimum-payout";

import { AgencyStatementView } from "@/app/(print)/statements/agency/AgencyStatementView";
import { loadAgencyStatement } from "@/app/(print)/statements/agency/load-statements";

/*
  代理店1社ぶんの支払明細書（親管理者専用）。

  金額の正は、承認済み payment_batch と、その batch に claim されている
  agency_reward_items だけ。ここで報酬を作り直さない。
*/
export const dynamic = "force-dynamic";

export default async function AgencyStatementPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const { batchId } = await params;
  const result = await loadAgencyStatement(batchId);
  const backHref = `/payments/${batchId}`;

  if (result.statements.length === 0) {
    return (
      <div className="stmt-root">
        <div className="stmt-error">
          <p style={{ margin: 0, fontWeight: 700 }}>
            支払明細書を出力できません
          </p>
          <p style={{ margin: "6px 0 0" }}>{result.error}</p>
          <p style={{ margin: "12px 0 0" }}>
            <Link href={backHref} style={{ color: "#991b1b" }}>
              ← 支払明細の詳細へ戻る
            </Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <AgencyStatementView
      statements={result.statements}
      rejected={result.rejected}
      backHref={backHref}
      cutoffMonth={result.statements[0]?.cutoffMonth ?? null}
      minimumPayoutYen={AGENCY_PAYOUT_THRESHOLD_YEN}
    />
  );
}
