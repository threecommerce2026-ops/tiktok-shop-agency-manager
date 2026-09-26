import Link from "next/link";

import { AgencyStatementView } from "@/app/(print)/statements/agency/AgencyStatementView";
import { loadAgencyStatementsForCutoff } from "@/app/(print)/statements/agency/load-statements";
import { CUTOFF_MONTH_PATTERN, defaultCutoffMonth } from "@/lib/payments/cutoff-month";

/*
  締め対象月ぶんの支払明細書をまとめて出す（親管理者専用）。

  代理店ごとに改ページするため、1回の「PDFとして保存」で
  複数ページの1ファイルになる。ZIP生成やサーバ側PDF生成に依存しない。
*/
export const dynamic = "force-dynamic";

export default async function AgencyStatementsPage({
  searchParams,
}: {
  searchParams: Promise<{ cutoff?: string }>;
}) {
  const { cutoff } = await searchParams;

  /*
    不正な締め月は安全な値へ勝手に丸めない。
    未指定のときだけ既定（JST基準の前月）を使う。
  */
  const requested = typeof cutoff === "string" ? cutoff.trim() : "";
  const cutoffMonth = requested === "" ? defaultCutoffMonth() : requested;
  const backHref = `/payments?cutoff=${encodeURIComponent(cutoffMonth)}`;

  if (!CUTOFF_MONTH_PATTERN.test(cutoffMonth)) {
    return (
      <div className="stmt-root">
        <div className="stmt-error">
          <p style={{ margin: 0, fontWeight: 700 }}>締め対象月が不正です</p>
          <p style={{ margin: "6px 0 0" }}>
            「{cutoffMonth}」は YYYY-MM の形式ではありません。
            支払管理の画面から締め対象月を選び直してください。
          </p>
          <p style={{ margin: "12px 0 0" }}>
            <Link href="/payments" style={{ color: "#991b1b" }}>
              ← 支払管理へ戻る
            </Link>
          </p>
        </div>
      </div>
    );
  }

  const result = await loadAgencyStatementsForCutoff(cutoffMonth);

  if (result.statements.length === 0) {
    return (
      <div className="stmt-root">
        <div className="stmt-error">
          <p style={{ margin: 0, fontWeight: 700 }}>
            支払明細書を出力できません
          </p>
          <p style={{ margin: "6px 0 0" }}>{result.error}</p>
          {result.rejected.length > 0 ? (
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {result.rejected.map((item, index) => (
                <li key={`${item.agencyName}-${index}`}>
                  {item.agencyName}：{item.message}
                </li>
              ))}
            </ul>
          ) : null}
          <p style={{ margin: "12px 0 0" }}>
            <Link href={backHref} style={{ color: "#991b1b" }}>
              ← 支払管理へ戻る
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
      cutoffMonth={cutoffMonth}
    />
  );
}
