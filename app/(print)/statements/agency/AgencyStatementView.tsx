"use client";

import Link from "next/link";

import { AgencyStatementDocument } from "@/components/payments/AgencyStatementDocument";
import type { AgencyStatement } from "@/lib/payments/agency-statement";
import {
  formatStatementCutoffLabel,
  statementFileBaseName,
} from "@/lib/payments/agency-statement";

/*
  支払明細書の表示と印刷。

  ■ PDFはブラウザの「PDFとして保存」で作る
  印刷ダイアログの保存先で PDF を選ぶ。外部ライブラリを入れないため、
  日本語が文字化けせず、画面に出している数値がそのまま PDF になる。

  ■ 複数代理店をまとめるとき
  ZIP で個別PDFを作るのではなく、1つの印刷ビューに代理店ぶんを並べ、
  代理店ごとに改ページして1つのPDF（複数ページ）にする。
  Vercel 上でZIPやサーバ側PDF生成に依存しないので、環境差で壊れない。
*/

function printNow() {
  window.print();
}

export function AgencyStatementView({
  statements,
  backHref,
  cutoffMonth,
  minimumPayoutYen,
  /** 出力できなかった支払明細。件数を隠さず理由ごと見せる */
  rejected,
}: {
  statements: AgencyStatement[];
  backHref: string;
  cutoffMonth: string | null;
  /** 最低支払額。サーバー側の設定値を受け取って注記に出す */
  minimumPayoutYen: number;
  rejected: { agencyName: string; message: string }[];
}) {
  const total = statements.reduce((sum, s) => sum + s.paymentAmount, 0);

  /*
    ファイル名の既定値はブラウザ側の印刷ダイアログが決める。
    document.title を使うブラウザが多いので、保存名の手がかりとして入れておく。
  */
  const suggestedName =
    statements.length === 1 && statements[0]
      ? statementFileBaseName(
          statements[0].cutoffMonth,
          statements[0].agencyName,
        )
      : cutoffMonth
        ? `${cutoffMonth}_代理店報酬支払明細書_${statements.length}件`
        : "代理店報酬支払明細書";

  return (
    <div className="stmt-root">
      <title>{suggestedName}</title>

      {/* ---------------- 操作（印刷時は出さない） ---------------- */}
      <div className="stmt-toolbar stmt-print-hidden">
        <div style={{ fontSize: 12, color: "#3f3f46" }}>
          <p style={{ margin: 0, fontWeight: 700, fontSize: 14 }}>
            代理店報酬 支払明細書
            {cutoffMonth
              ? `（${formatStatementCutoffLabel(cutoffMonth)}締め）`
              : ""}
          </p>
          <p style={{ margin: "4px 0 0" }}>
            {statements.length.toLocaleString("ja-JP")} 件 ／ 合計 ¥
            {Math.round(total).toLocaleString("ja-JP")}
            {statements.length > 1
              ? "　※代理店ごとにページが分かれます"
              : ""}
          </p>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <Link href={backHref} className="stmt-btn stmt-btn-plain">
            ← 戻る
          </Link>
          <button type="button" onClick={printNow} className="stmt-btn">
            印刷 / PDFとして保存
          </button>
        </div>
      </div>

      {rejected.length > 0 ? (
        <div
          className="stmt-error stmt-print-hidden"
          style={{ marginBottom: 16 }}
          role="status"
        >
          <p style={{ margin: 0, fontWeight: 700 }}>
            出力できなかった支払明細が {rejected.length} 件あります
          </p>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {rejected.map((item, index) => (
              <li key={`${item.agencyName}-${index}`}>
                {item.agencyName}：{item.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {statements.map((statement) => (
        <AgencyStatementDocument
          key={statement.batchId}
          statement={statement}
          minimumPayoutYen={minimumPayoutYen}
        />
      ))}
    </div>
  );
}
