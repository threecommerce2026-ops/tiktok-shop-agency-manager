import { redirect } from "next/navigation";

/*
  紹介者報酬の支払い管理は「売上・報酬 › 紹介者報酬」タブに統合した。
  旧URLはブックマーク対応のためリダイレクトとして残す。
*/
export default function ReferralPayoutsRedirectPage() {
  redirect("/revenue?tab=referral");
}
