import {
  buildAgencyStatementPdf,
  contentDisposition,
} from "@/lib/payments/statement-download";

/*
  代理店1社ぶんの支払明細書PDFをダウンロードする（親管理者専用）。

  batch ID を知っているだけでは取得できない。
  報酬はここで計算し直さない。承認済み payment_batch と、
  その batch に claim 済みの agency_reward_items だけが正。
*/
export const dynamic = "force-dynamic";
// フォントの読み込みとPDF生成に Node の API を使う
export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ batchId: string }> },
) {
  const { batchId } = await params;
  const result = await buildAgencyStatementPdf(batchId);

  if (!result.ok) {
    return Response.json(
      { error: result.denied.message },
      { status: result.denied.status },
    );
  }

  const { file } = result;
  return new Response(new Uint8Array(file.bytes), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-length": String(file.bytes.length),
      "content-disposition": contentDisposition(file.fileName),
      // 金額を含む帳票なので中間キャッシュへ残さない
      "cache-control": "no-store, private",
    },
  });
}
