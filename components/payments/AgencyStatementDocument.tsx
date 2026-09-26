import { INVOICE_ISSUER } from "@/lib/billing/issuer";
import {
  formatStatementCutoffLabel,
  formatStatementMonthLabel,
  formatStatementPeriodLabel,
  formatStatementRate,
  type AgencyStatement,
} from "@/lib/payments/agency-statement";

/*
  代理店報酬 支払明細書（1代理店ぶん）。

  ■ PDF について
  外部のPDFライブラリは使わず、ブラウザの「PDFとして保存」を使う。
  seller-billing の請求書と同じ方針:
    ・日本語フォントの埋め込みが不要で文字化けしない
    ・画面に出している数値をそのまま印刷するため、
      画面金額とPDF金額が必ず一致する（別経路で再計算しない）

  ■ 印刷CSSを自前で持つ理由
  この明細書は globals.css の @media print に依存しない。
  依存すると、共通CSSを触った瞬間にすべての帳票のレイアウトが変わる。
  帳票ごとに必要な体裁（A4・改ページ・単独表示）をこのファイル内で完結させる。

  ■ 載せないもの
  ・紹介制度報酬（代理店への支払対象外）
  ・口座番号（BankAccountView は下4桁以外を伏せた値しか持たない）
  ・消費税 / 源泉徴収 / 請求書番号 … システムに正式情報がないため出さない
*/

/** A4 / 改ページ / 画面と印刷で共通の体裁。共通CSSに依存しない */
export const STATEMENT_PRINT_STYLES = `
.stmt-root {
  background: #f4f4f5;
  color: #18181b;
  min-height: 100vh;
  padding: 24px 16px 64px;
  font-family: "Hiragino Kaku Gothic ProN", "Hiragino Sans", "Yu Gothic",
    "Noto Sans JP", system-ui, sans-serif;
}
.stmt-toolbar {
  max-width: 820px;
  margin: 0 auto 16px;
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
}
.stmt-sheet {
  max-width: 820px;
  margin: 0 auto 24px;
  background: #ffffff;
  color: #18181b;
  padding: 40px;
  border: 1px solid #d4d4d8;
  border-radius: 12px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
}
.stmt-sheet:last-of-type { margin-bottom: 0; }

.stmt-title {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 0.24em;
  text-align: center;
  margin: 0;
}
.stmt-subtitle {
  margin: 6px 0 0;
  text-align: center;
  font-size: 11px;
  color: #52525b;
}
.stmt-meta {
  margin-top: 28px;
  display: flex;
  flex-wrap: wrap;
  gap: 24px;
  justify-content: space-between;
}
.stmt-meta-block { font-size: 11px; line-height: 1.8; }
.stmt-payee-name {
  font-size: 16px;
  font-weight: 700;
  border-bottom: 1px solid #18181b;
  padding-bottom: 4px;
  display: inline-block;
  min-width: 220px;
}
.stmt-label {
  font-size: 10px;
  color: #71717a;
  letter-spacing: 0.08em;
}
.stmt-total {
  margin-top: 24px;
  border: 1px solid #18181b;
  padding: 14px 18px;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
}
.stmt-total-amount {
  font-size: 24px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.stmt-section-title {
  margin: 28px 0 8px;
  font-size: 12px;
  font-weight: 700;
  border-left: 3px solid #18181b;
  padding-left: 8px;
}
.stmt-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 10.5px;
}
.stmt-table th,
.stmt-table td {
  border: 1px solid #d4d4d8;
  padding: 6px 8px;
  text-align: left;
  vertical-align: top;
}
.stmt-table th {
  background: #f4f4f5;
  font-weight: 600;
  white-space: nowrap;
  font-size: 10px;
  color: #3f3f46;
}
.stmt-num {
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.stmt-month-row td { background: #fafafa; color: #52525b; }
.stmt-month-name { padding-left: 22px !important; }
.stmt-total-row td {
  background: #f4f4f5;
  font-weight: 700;
  border-top: 2px solid #18181b;
}
.stmt-notes {
  margin-top: 24px;
  font-size: 10px;
  line-height: 1.9;
  color: #52525b;
}
.stmt-notes ul { margin: 6px 0 0; padding-left: 18px; }
.stmt-footer {
  margin-top: 28px;
  padding-top: 12px;
  border-top: 1px solid #e4e4e7;
  font-size: 9.5px;
  color: #71717a;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: space-between;
}
.stmt-btn {
  min-height: 40px;
  padding: 0 18px;
  border-radius: 8px;
  border: 1px solid #18181b;
  background: #18181b;
  color: #ffffff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.stmt-btn-plain {
  background: #ffffff;
  color: #18181b;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
}
.stmt-error {
  max-width: 820px;
  margin: 0 auto;
  border: 1px solid #dc2626;
  background: #fef2f2;
  color: #991b1b;
  border-radius: 12px;
  padding: 20px 24px;
  font-size: 13px;
  line-height: 1.8;
}

@media print {
  /* 画面用の余白と枠を落とし、帳票だけを紙に出す */
  html, body { background: #ffffff !important; }
  .stmt-root { background: #ffffff; padding: 0; min-height: 0; }
  .stmt-print-hidden { display: none !important; }
  .stmt-sheet {
    max-width: none;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: 0;
    box-shadow: none;
    /* 代理店ごとに必ずページを分ける */
    break-after: page;
    page-break-after: always;
  }
  .stmt-sheet:last-of-type {
    break-after: auto;
    page-break-after: auto;
  }
  /* 1クリエイターの行と月内訳が紙をまたいで割れないようにする */
  .stmt-creator-rows {
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .stmt-table { font-size: 9.5px; }
  .stmt-table thead { display: table-header-group; }
  @page { size: A4 portrait; margin: 14mm; }
}
`;

const yen = (value: number) =>
  `¥${Math.round(value).toLocaleString("ja-JP")}`;

/** 小数を持つ基準額・GMVは実額のまま2桁で出す（丸めて根拠を変えない） */
const exact = (value: number) =>
  `¥${value.toLocaleString("ja-JP", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

function jstDate(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleDateString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

export function AgencyStatementDocument({
  statement,
  /*
    最低支払額。サーバー側の設定値をそのまま受け取る。
    帳票側で 1000 を書かない（画面・claim・承認と同じ値を使う）。
  */
  minimumPayoutYen,
}: {
  statement: AgencyStatement;
  minimumPayoutYen: number;
}) {
  const issueDate = jstDate(statement.approvedAt);
  const periodLabel = formatStatementPeriodLabel(
    statement.creators.reduce(
      (min, c) => (c.periodStartMonth < min ? c.periodStartMonth : min),
      statement.creators[0]?.periodStartMonth ?? statement.cutoffMonth,
    ),
    statement.creators.reduce(
      (max, c) => (c.periodEndMonth > max ? c.periodEndMonth : max),
      statement.creators[0]?.periodEndMonth ?? statement.cutoffMonth,
    ),
  );

  return (
    <article className="stmt-sheet">
      <h1 className="stmt-title">代理店報酬 支払明細書</h1>
      <p className="stmt-subtitle">
        {formatStatementCutoffLabel(statement.cutoffMonth)}締め ／ 対象期間{" "}
        {periodLabel}
      </p>

      {/* ---------------- 宛先と発行元 ---------------- */}
      <div className="stmt-meta">
        <div className="stmt-meta-block">
          <p className="stmt-label">代理店名</p>
          <p className="stmt-payee-name">{statement.agencyName} 御中</p>
          <p style={{ marginTop: 10 }}>
            下記のとおり、代理店分配報酬をお支払いいたします。
          </p>
        </div>

        <div className="stmt-meta-block" style={{ textAlign: "right" }}>
          <p className="stmt-label">発行日</p>
          <p>{issueDate}</p>
          <p style={{ marginTop: 10, fontWeight: 700, fontSize: 13 }}>
            {INVOICE_ISSUER.companyName}
          </p>
          <p>
            {INVOICE_ISSUER.postalCode} {INVOICE_ISSUER.address}
          </p>
          <p>TEL {INVOICE_ISSUER.tel}</p>
          <p>登録番号 {INVOICE_ISSUER.registrationNumber}</p>
        </div>
      </div>

      {/* ---------------- 支払金額 ---------------- */}
      <div className="stmt-total">
        <span style={{ fontSize: 12, fontWeight: 700 }}>お支払金額</span>
        <span className="stmt-total-amount">
          {yen(statement.paymentAmount)}
        </span>
      </div>

      {/* ---------------- 内訳 ---------------- */}
      <h2 className="stmt-section-title">
        内訳（クリエイター別 ／ 対象 {statement.itemCount.toLocaleString("ja-JP")} 明細）
      </h2>

      <table className="stmt-table">
        <thead>
          <tr>
            <th>クリエイター</th>
            <th>対象期間</th>
            <th className="stmt-num">成果報酬GMV（参考）</th>
            <th className="stmt-num">分配計算基準額</th>
            <th className="stmt-num">分配率</th>
            <th className="stmt-num">代理店分配報酬</th>
          </tr>
        </thead>

        {statement.creators.map((creator) => (
          <tbody className="stmt-creator-rows" key={creator.creatorId}>
            <tr>
              <td>
                <span style={{ fontWeight: 600 }}>{creator.creatorName}</span>
                {creator.tiktokId ? (
                  <span style={{ color: "#71717a" }}> @{creator.tiktokId}</span>
                ) : null}
              </td>
              <td style={{ whiteSpace: "nowrap" }}>
                {formatStatementPeriodLabel(
                  creator.periodStartMonth,
                  creator.periodEndMonth,
                )}
              </td>
              <td className="stmt-num">{exact(creator.gmv)}</td>
              <td className="stmt-num">{exact(creator.baseAmount)}</td>
              <td className="stmt-num">{formatStatementRate(creator.ratePct)}</td>
              <td className="stmt-num" style={{ fontWeight: 600 }}>
                {exact(creator.rewardAmount)}
              </td>
            </tr>

            {/* 月が複数あるときだけ月内訳を出す。単月なら上の行と同じ内容になる */}
            {creator.months.length > 1
              ? creator.months.map((month) => (
                  <tr
                    className="stmt-month-row"
                    key={`${creator.creatorId}-${month.targetMonth}`}
                  >
                    <td className="stmt-month-name">
                      {formatStatementMonthLabel(month.targetMonth)}
                    </td>
                    <td>{month.itemCount.toLocaleString("ja-JP")} 明細</td>
                    <td className="stmt-num">{exact(month.gmv)}</td>
                    <td className="stmt-num">{exact(month.baseAmount)}</td>
                    <td className="stmt-num">
                      {formatStatementRate(
                        month.hasMixedRate ? null : month.ratePct,
                      )}
                    </td>
                    <td className="stmt-num">{exact(month.rewardAmount)}</td>
                  </tr>
                ))
              : null}
          </tbody>
        ))}

        <tfoot>
          <tr className="stmt-total-row">
            <td colSpan={5}>合計（代理店分配報酬）</td>
            <td className="stmt-num">{yen(statement.agencyRewardAmount)}</td>
          </tr>
        </tfoot>
      </table>

      {/* ---------------- 振込先 ---------------- */}
      <h2 className="stmt-section-title">お振込先</h2>
      <p style={{ fontSize: 10.5, color: "#52525b", margin: 0 }}>
        {statement.bankRegistered
          ? "ご登録いただいている口座へお振り込みいたします。口座情報の詳細は本書には記載しておりません。"
          : "お振込先が未登録です。口座情報をご連絡ください。"}
      </p>

      {/* ---------------- 注記 ---------------- */}
      <div className="stmt-notes">
        <p style={{ margin: 0, fontWeight: 600, color: "#3f3f46" }}>ご確認事項</p>
        <ul>
          <li>
            本明細書の金額は、TikTok Shop から確定した実績値に基づいています。
            成果報酬GMVは参考値で、分配報酬の計算基準ではありません。
          </li>
          <li>
            代理店分配報酬は、TikTok Shop 側で明細単位に算出された分配額の合計です。
            「分配計算基準額 × 分配率」と一致しない場合がありますが、
            これは明細単位の端数処理によるもので、実際のお支払額は上記合計のとおりです。
          </li>
          <li>
            紹介制度報酬は代理店へのお支払対象ではないため、本明細書には含まれません。
          </li>
          <li>
            最低支払額は ¥{minimumPayoutYen.toLocaleString("ja-JP")} です。
            締め時点の未払残高が ¥{minimumPayoutYen.toLocaleString("ja-JP")}
            未満の場合、その分は消さずに翌月以降へ繰り越してお支払いします。
          </li>
          <li>
            本明細書に関するお問い合わせは、上記発行元までご連絡ください。
          </li>
        </ul>
      </div>

      <div className="stmt-footer">
        <span>{INVOICE_ISSUER.companyName}</span>
        <span>支払明細番号 {statement.batchId}</span>
      </div>
    </article>
  );
}
