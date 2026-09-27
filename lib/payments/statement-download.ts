import { fetchPaymentBatchDetail, fetchPaymentOverview } from "@/lib/db/payment-queries";
import { isAdminRole, resolveAppUserContext } from "@/lib/db/user-context";
import {
  buildAgencyStatement,
  isStatementIssuableStatus,
  statementFileBaseName,
  statementZipFileName,
  type AgencyStatement,
} from "@/lib/payments/agency-statement";
import { AGENCY_PAYOUT_THRESHOLD_YEN } from "@/lib/payments/minimum-payout";
import { renderAgencyStatementPdf } from "@/lib/pdf/agency-statement-pdf";
import { createZip, uniqueZipName } from "@/lib/pdf/zip";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/*
  支払明細書のダウンロード（PDF / ZIP）。

  ■ admin only
  batch ID を知っているだけでは取得できない。ログイン済みかつ親管理者だけ。
  画面表示の経路（app/(print)/statements/agency）と同じ判定を使う。

  ■ 報酬を再計算しない
  画面と同じ fetchPaymentBatchDetail / buildAgencyStatement を通す。
  PDF のための別クエリ・別計算式を持たない。

  ■ 出す前に必ず確かめる
  承認済み以降か / 代理店の明細か / 金額が claim 済み明細の合計と一致するか /
  紹介制度報酬が混ざっていないか。1つでも欠ければ生成しない。
*/

export type DownloadDenied = {
  status: 401 | 403 | 404 | 409;
  message: string;
};

export type StatementFile = {
  fileName: string;
  bytes: Uint8Array;
  agencyName: string;
  paymentAmount: number;
  pageCount: number;
};

/** 親管理者か確かめる。通れば service role クライアントを返す */
async function authorize(): Promise<
  { ok: true; admin: ReturnType<typeof getSupabaseAdmin> } | { ok: false; denied: DownloadDenied }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return {
      ok: false,
      denied: { status: 401, message: "ログインが必要です。" },
    };
  }

  const appUser = await resolveAppUserContext(supabase, user);
  if (!isAdminRole(appUser.data.role)) {
    return {
      ok: false,
      denied: { status: 403, message: "この操作は親管理者のみ実行できます。" },
    };
  }

  return { ok: true, admin: getSupabaseAdmin() };
}

async function renderOne(
  statement: AgencyStatement,
  fileName: string,
): Promise<StatementFile> {
  const { bytes, report } = await renderAgencyStatementPdf(
    statement,
    AGENCY_PAYOUT_THRESHOLD_YEN,
  );
  return {
    fileName,
    bytes,
    agencyName: statement.agencyName,
    paymentAmount: statement.paymentAmount,
    pageCount: report.pageCount,
  };
}

/** 支払明細1件ぶんのPDF */
export async function buildAgencyStatementPdf(
  batchId: string,
): Promise<{ ok: true; file: StatementFile } | { ok: false; denied: DownloadDenied }> {
  const auth = await authorize();
  if (!auth.ok) return { ok: false, denied: auth.denied };

  const detail = await fetchPaymentBatchDetail(auth.admin, batchId);
  if (detail.error) {
    return { ok: false, denied: { status: 409, message: detail.error } };
  }
  if (!detail.batch) {
    return { ok: false, denied: { status: 404, message: "支払明細が見つかりません。" } };
  }

  const built = buildAgencyStatement(detail);
  if (!built.ok) {
    /*
      下書き・取消は「まだ/もう出せない」状態。存在はしているので 409 で返す。
      404 にすると、EMI が URL を間違えたのか状態のせいなのか分からなくなる。
    */
    return { ok: false, denied: { status: 409, message: built.rejection.message } };
  }

  const statement = built.statement;
  const file = await renderOne(
    statement,
    `${statementFileBaseName(statement.cutoffMonth, statement.agencyName)}.pdf`,
  );
  return { ok: true, file };
}

export type StatementZip = {
  fileName: string;
  bytes: Uint8Array;
  files: StatementFile[];
  /** 出力できなかった支払明細。件数を黙って減らさない */
  rejected: { agencyName: string; message: string }[];
  totalAmount: number;
};

/** 締め対象月ぶんを代理店ごとのPDFにして1つのZIPへ */
export async function buildAgencyStatementZip(
  cutoffMonth: string,
): Promise<{ ok: true; zip: StatementZip } | { ok: false; denied: DownloadDenied }> {
  const auth = await authorize();
  if (!auth.ok) return { ok: false, denied: auth.denied };

  const overview = await fetchPaymentOverview(auth.admin, { cutoffMonth });
  if (overview.error) {
    return { ok: false, denied: { status: 409, message: overview.error } };
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
      ok: false,
      denied: {
        status: 404,
        message: `${cutoffMonth} 締めの承認済み代理店支払明細がありません。承認後に出力してください。`,
      },
    };
  }

  const files: StatementFile[] = [];
  const rejected: { agencyName: string; message: string }[] = [];
  const usedNames = new Set<string>();

  for (const batch of targets) {
    const detail = await fetchPaymentBatchDetail(auth.admin, batch.id);
    if (detail.error) {
      rejected.push({ agencyName: batch.payeeName, message: detail.error });
      continue;
    }

    const built = buildAgencyStatement(detail);
    if (!built.ok) {
      rejected.push({ agencyName: batch.payeeName, message: built.rejection.message });
      continue;
    }

    /*
      同名の代理店があってもZIP内で上書きしない。
      2件目以降へ _2 / _3 を付ける。
    */
    const fileName = uniqueZipName(
      usedNames,
      statementFileBaseName(built.statement.cutoffMonth, built.statement.agencyName),
      ".pdf",
    );
    files.push(await renderOne(built.statement, fileName));
  }

  if (files.length === 0) {
    return {
      ok: false,
      denied: {
        status: 409,
        message:
          rejected.length > 0
            ? `出力できる支払明細がありませんでした（${rejected[0].message}）`
            : "出力できる支払明細がありませんでした。",
      },
    };
  }

  /*
    ZIP内の日時は締め月の月初に固定する。
    生成時刻を入れると、同じ内容でも押すたびにZIPのバイト列が変わり、
    「前に配ったものと同じか」を確かめられなくなる。
  */
  const modifiedAt = new Date(`${cutoffMonth}-01T00:00:00Z`);
  const bytes = createZip(
    files.map((file) => ({ name: file.fileName, data: file.bytes })),
    modifiedAt,
  );

  return {
    ok: true,
    zip: {
      fileName: statementZipFileName(cutoffMonth),
      bytes,
      files,
      rejected,
      totalAmount:
        Math.round(files.reduce((sum, f) => sum + f.paymentAmount, 0) * 100) / 100,
    },
  };
}

/**
 * Content-Disposition の値。
 * 日本語ファイル名は filename* (RFC 5987) で渡し、
 * 古い実装向けに ASCII だけの filename も併記する。
 */
export function contentDisposition(fileName: string): string {
  const asciiFallback = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(
    fileName,
  )}`;
}
