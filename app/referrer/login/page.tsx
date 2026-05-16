import { ReferrerPublicLayout } from "@/components/referrer/ReferrerPublicLayout";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { ReferrerLoginForm } from "./ReferrerLoginForm";

export const dynamic = "force-dynamic";

export default async function ReferrerLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const params = await searchParams;

  if (user) {
    const nextPath = params.next?.trim();
    redirect(nextPath && nextPath.startsWith("/") ? nextPath : "/referrer/dashboard");
  }

  return (
    <ReferrerPublicLayout
      title="紹介者ログイン"
      description="メールアドレスとパスワードでログイン"
      headerLinkHref="/referrer/register"
      headerLinkLabel="新規登録"
    >
      <Suspense fallback={<div className="mx-auto h-96 max-w-md animate-pulse rounded-2xl bg-white/[0.04] px-4" />}>
        <ReferrerLoginForm />
      </Suspense>
    </ReferrerPublicLayout>
  );
}
