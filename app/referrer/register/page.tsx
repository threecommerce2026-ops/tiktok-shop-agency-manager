import { ReferrerPublicLayout } from "@/components/referrer/ReferrerPublicLayout";
import { ReferrerRegisterClient } from "@/app/referrer/register/ReferrerRegisterClient";

export const dynamic = "force-dynamic";

export default function ReferrerRegisterPage() {
  return (
    <ReferrerPublicLayout
      title="紹介者登録"
      description="登録後に専用の紹介リンクが発行されます"
      headerLinkHref="/referrer/login"
      headerLinkLabel="ログイン"
    >
      <ReferrerRegisterClient />
    </ReferrerPublicLayout>
  );
}
