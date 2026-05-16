import { ReferrerPublicLayout } from "@/components/referrer/ReferrerPublicLayout";
import { ReferralLandingClient } from "@/app/ref/[referral_code]/ReferralLandingClient";
import { fetchPublicReferrerByCodeAction } from "@/app/actions/referrer-portal";
import { getOfficialLineUrl } from "@/lib/referrals/site-url";
import { normalizeReferralCode } from "@/lib/referrals/referral-code";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function ReferralLandingPage({
  params,
}: {
  params: Promise<{ referral_code: string }>;
}) {
  const { referral_code: rawCode } = await params;
  const referralCode = normalizeReferralCode(rawCode);
  const result = await fetchPublicReferrerByCodeAction(referralCode);
  if (!result.data) {
    notFound();
  }

  return (
    <ReferrerPublicLayout title="クリエイター登録" headerLinkHref={null}>
      <ReferralLandingClient
        referralCode={result.data.referralCode}
        officialLineUrl={getOfficialLineUrl()}
      />
    </ReferrerPublicLayout>
  );
}
