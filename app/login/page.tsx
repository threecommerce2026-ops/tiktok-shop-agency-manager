import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { LoginForm } from "./login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next: nextPath } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    if (
      nextPath &&
      nextPath.startsWith("/") &&
      !nextPath.startsWith("//")
    ) {
      redirect(nextPath);
    }
    redirect("/dashboard");
  }

  return (
    <div className="flex min-h-full flex-col items-center justify-center px-4 py-12">
      <Suspense
        fallback={
          <div className="h-96 w-full max-w-md animate-pulse rounded-2xl bg-white/[0.04]" />
        }
      >
        <LoginForm />
      </Suspense>
    </div>
  );
}
