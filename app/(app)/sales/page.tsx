import { redirect } from "next/navigation";

/*
  売上一覧は「売上・報酬 › 売上」タブに統合した。
  旧URLはブックマーク対応のためリダイレクトとして残す。
*/
export default async function SalesRedirectPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const params = await searchParams;
  const month =
    params.month && /^\d{4}-\d{2}$/.test(params.month) ? params.month : null;

  redirect(month ? `/revenue?tab=sales&month=${month}` : "/revenue?tab=sales");
}
