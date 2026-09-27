import {
  buildAgencyStatementZip,
  contentDisposition,
} from "@/lib/payments/statement-download";
import { CUTOFF_MONTH_PATTERN, defaultCutoffMonth } from "@/lib/payments/cutoff-month";

/*
  締め対象月ぶんの支払明細書を、代理店ごとのPDFにしてZIPで返す（親管理者専用）。

  各代理店へ自社分だけを送れるように、1社1PDFで分けて入れる。
  まとめた1つのPDFにはしない。
*/
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const requested = new URL(request.url).searchParams.get("cutoff")?.trim() ?? "";

  /*
    不正な締め月は安全な値へ勝手に丸めない。
    未指定のときだけ既定（JST基準の前月）を使う。
  */
  const cutoffMonth = requested === "" ? defaultCutoffMonth() : requested;

  if (!CUTOFF_MONTH_PATTERN.test(cutoffMonth)) {
    return Response.json(
      {
        error: `締め対象月が不正です（${cutoffMonth}）。YYYY-MM の形式で指定してください。`,
      },
      { status: 400 },
    );
  }

  const result = await buildAgencyStatementZip(cutoffMonth);

  if (!result.ok) {
    return Response.json(
      { error: result.denied.message },
      { status: result.denied.status },
    );
  }

  const { zip } = result;
  return new Response(new Uint8Array(zip.bytes), {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "content-length": String(zip.bytes.length),
      "content-disposition": contentDisposition(zip.fileName),
      "cache-control": "no-store, private",
      // 画面側で件数と除外理由を出せるようにする
      "x-statement-count": String(zip.files.length),
      "x-statement-total": String(zip.totalAmount),
      "x-statement-rejected": String(zip.rejected.length),
    },
  });
}
