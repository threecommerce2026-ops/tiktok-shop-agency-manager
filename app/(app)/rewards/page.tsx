import { redirect } from "next/navigation";

/*
  代理店報酬一覧は「売上・報酬 › 代理店報酬」タブに統合した。
  旧URLはブックマーク対応のためリダイレクトとして残す。
*/
export default async function RewardsRedirectPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const params = await searchParams;
  const month =
    params.month && /^\d{4}-\d{2}$/.test(params.month) ? params.month : null;

  redirect(month ? `/revenue?tab=agency&month=${month}` : "/revenue?tab=agency");
}
