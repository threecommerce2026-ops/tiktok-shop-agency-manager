import type { PaymentBatchDetail } from "@/lib/db/payment-queries";
import type { PaymentBatchStatus } from "@/lib/payments/payment-status";

/*
  代理店向け「代理店報酬 支払明細書」のビューモデル。

  ■ 報酬を再計算しない
  明細書の正は、承認済みの payment_batch と、その batch に実際に claim されている
  agency_reward_items だけ。現在のマスタや現在の分配率から過去の金額を作り直さない。
  画面（/payments/[batchId]）と同じ fetchPaymentBatchDetail を通し、
  明細書のために別クエリ・別計算式を持たない。

  ■ 代理店へ支払うのは代理店分配報酬だけ
  紹介制度報酬は代理店への支払対象外なので明細書に載せない。
  占有されている紹介報酬が1件でもあれば異常として出力を止める。

  ■ 端数
  「分配計算基準額 × 分配率」と実際の分配額には、TikTok 側の明細単位の丸めで
  差が出る。支払額は必ず reward の実額を使い、ここで掛け算して作らない。
*/

/** 正式な明細書として出せる状態。下書きは出さない */
export const STATEMENT_ISSUABLE_STATUSES: readonly PaymentBatchStatus[] = [
  "approved",
  "processing",
  "paid",
];

export function isStatementIssuableStatus(status: PaymentBatchStatus): boolean {
  return STATEMENT_ISSUABLE_STATUSES.includes(status);
}

export type AgencyStatementRejection = {
  reason:
    | "not_found"
    | "not_agency"
    | "status_not_issuable"
    | "amount_mismatch"
    | "referral_included"
    | "no_items";
  message: string;
};

export type AgencyStatement = {
  batchId: string;
  agencyName: string;
  cutoffMonth: string;
  status: PaymentBatchStatus;
  approvedAt: string | null;
  paidOn: string | null;
  /** 振込予定額。payment_batch のスナップショット */
  paymentAmount: number;
  /** 代理店分配報酬。claim 済み明細の実額合計 */
  agencyRewardAmount: number;
  itemCount: number;
  creators: PaymentBatchDetail["agencyBreakdown"]["creators"];
  /** 振込先が支払明細に固定済みか。口座番号そのものは載せない */
  bankRegistered: boolean;
};

export type AgencyStatementResult =
  | { ok: true; statement: AgencyStatement }
  | { ok: false; rejection: AgencyStatementRejection };

const yen = (value: number) => `¥${Math.round(value).toLocaleString("ja-JP")}`;

/**
 * 支払明細の詳細から明細書を組み立てる。
 * 出力してよい状態か、金額が整合しているかを先に確かめる。
 */
export function buildAgencyStatement(
  detail: PaymentBatchDetail,
): AgencyStatementResult {
  const batch = detail.batch;

  if (!batch) {
    return {
      ok: false,
      rejection: { reason: "not_found", message: "支払明細が見つかりません。" },
    };
  }

  if (batch.payeeKind !== "agency") {
    return {
      ok: false,
      rejection: {
        reason: "not_agency",
        message: "代理店向け支払明細書は、代理店の支払明細だけが対象です。",
      },
    };
  }

  /*
    下書きは正式な明細書として出さない。
    金額が変わり得る段階のものを代理店へ送ると根拠にならない。
  */
  if (!isStatementIssuableStatus(batch.status)) {
    return {
      ok: false,
      rejection: {
        reason: "status_not_issuable",
        message:
          batch.status === "draft"
            ? "下書きの支払明細は正式な明細書として出力できません。承認後に出力してください。"
            : "取消・失敗した支払明細は明細書として出力できません。",
      },
    };
  }

  if (detail.referralBreakdown.creators.length > 0) {
    return {
      ok: false,
      rejection: {
        reason: "referral_included",
        message:
          "この支払明細には紹介制度報酬が含まれています。代理店へ紹介制度報酬は支払わないため、明細書を出力できません。",
      },
    };
  }

  if (detail.agencyBreakdown.creators.length === 0) {
    return {
      ok: false,
      rejection: { reason: "no_items", message: "対象の明細がありません。" },
    };
  }

  /*
    金額整合性。
    支払明細のスナップショットと claim 済み明細の合計がずれていたら、
    どちらを代理店へ提示すべきか決められないので出力しない。
  */
  if (Math.abs(detail.agencyRewardAmount - batch.paymentAmount) > 0.005) {
    return {
      ok: false,
      rejection: {
        reason: "amount_mismatch",
        message: `金額整合性エラー：支払明細の金額 ${yen(
          batch.paymentAmount,
        )} と対象明細の合計 ${yen(detail.agencyRewardAmount)} が一致しません。`,
      },
    };
  }

  return {
    ok: true,
    statement: {
      batchId: batch.id,
      agencyName: batch.payeeName,
      cutoffMonth: batch.cutoffMonth,
      status: batch.status,
      approvedAt: batch.approvedAt,
      paidOn: batch.paidOn,
      paymentAmount: batch.paymentAmount,
      agencyRewardAmount: detail.agencyRewardAmount,
      itemCount: detail.agencyBreakdown.itemCount,
      creators: detail.agencyBreakdown.creators,
      bankRegistered: batch.bank != null,
    },
  };
}

/** 2026-07 → 2026年7月末 */
export function formatStatementCutoffLabel(cutoffMonth: string): string {
  const [year, month] = String(cutoffMonth ?? "").split("-");
  if (!year || !month) return cutoffMonth;
  return `${year}年${Number(month)}月末`;
}

/** 2026-05 → 2026年5月 */
export function formatStatementMonthLabel(targetMonth: string): string {
  const [year, month] = String(targetMonth ?? "").split("-");
  if (!year || !month) return targetMonth;
  return `${year}年${Number(month)}月`;
}

/** 対象期間。単月なら1つだけ出す */
export function formatStatementPeriodLabel(
  startMonth: string,
  endMonth: string,
): string {
  const start = formatStatementMonthLabel(startMonth);
  const end = formatStatementMonthLabel(endMonth);
  return start === end ? start : `${start}〜${end}`;
}

/**
 * 分配率の表示。
 * 混在しているときは代表値（平均）を作らず「複数」と出す。
 */
export function formatStatementRate(ratePct: number | null): string {
  if (ratePct == null) return "複数";
  if (!Number.isFinite(ratePct) || ratePct <= 0) return "—";
  const rounded = Math.round(ratePct * 100) / 100;
  return `${rounded}%`;
}

/**
 * ファイル名に使える形へ整える。
 *
 * 代理店名はそのまま読めることを優先する。日本語・スペース・「!」など
 * ファイル名に使える文字は残し、使えない文字だけを置き換える。
 * 以前はスペースを "-" にしていたが、「BUZZ L!VE」が「BUZZ-L!VE」になり
 * 代理店側から見て自分の名前と一致しなくなるため、スペースは保つ。
 */
export function sanitizeStatementFileName(
  value: string,
  fallback = "支払明細",
): string {
  const cleaned = String(value ?? "")
    // ファイル名に使えない文字
    .replace(/[\\/:*?"<>|]/g, "-")
    // 制御文字は取り除く
    .replace(/[\u0000-\u001f\u007f]/g, "")
    // 連続する空白は1つにまとめる（改行やタブもここで空白になる）
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    // 先頭・末尾の "-" と "." は落とす（隠しファイル扱いを避ける）
    .replace(/^[-.\s]+|[-.\s]+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 80).trim() : fallback;
}

/*
  送付ファイルの名前。

  代理店は自社分だけを受け取るので、開いたときに
  「どこの」「いつの」「何か」がこの順で読めるようにする。
  対象月は payment_batch.cutoff_month を正とし、月の先頭ゼロは付けない。
*/

/**
 * 個別PDFの名前。拡張子は付けない。
 * 例: 2026-07 + LUMN → LUMN_2026年7月_代理店報酬支払明細
 */
export function statementFileBaseName(
  cutoffMonth: string,
  agencyName: string,
): string {
  const agency = sanitizeStatementFileName(agencyName, "代理店");
  const month = sanitizeStatementFileName(
    formatStatementMonthLabel(cutoffMonth),
    cutoffMonth,
  );
  return `${agency}_${month}_代理店報酬支払明細`;
}

/** ZIPの名前。例: 2026-07 → 2026年7月_代理店報酬支払明細.zip */
export function statementZipFileName(cutoffMonth: string): string {
  const month = sanitizeStatementFileName(
    formatStatementMonthLabel(cutoffMonth),
    cutoffMonth,
  );
  return `${month}_代理店報酬支払明細.zip`;
}
