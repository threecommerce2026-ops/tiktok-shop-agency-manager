import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function updateSession(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    return NextResponse.next({ request });
  }

  let supabaseResponse = NextResponse.next({
    request,
  });

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value),
        );
        supabaseResponse = NextResponse.next({
          request,
        });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options),
        );
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;

  if (pathname === "/projects" || pathname.startsWith("/projects/")) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  const referrerProtected =
    pathname === "/referrer/dashboard" || pathname.startsWith("/referrer/dashboard/");

  if (!user && referrerProtected) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/referrer/login";
    redirectUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(redirectUrl);
  }

  if (user && pathname === "/referrer/login") {
    const redirectUrl = request.nextUrl.clone();
    const nextPath = redirectUrl.searchParams.get("next");
    redirectUrl.pathname =
      nextPath && nextPath.startsWith("/referrer/") ? nextPath : "/referrer/dashboard";
    redirectUrl.searchParams.delete("next");
    return NextResponse.redirect(redirectUrl);
  }

  const appProtected =
    pathname.startsWith("/dashboard") ||
    pathname.startsWith("/creators") ||
    pathname.startsWith("/rewards") ||
    pathname.startsWith("/sales-upload") ||
    pathname.startsWith("/csv-logs") ||
    pathname.startsWith("/admin") ||
    pathname.startsWith("/sync-jobs") ||
    pathname.startsWith("/notifications") ||
    pathname === "/sales" ||
    pathname.startsWith("/sales/");

  if (!user && appProtected) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/login";
    redirectUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(redirectUrl);
  }

  if (user && pathname === "/login") {
    const redirectUrl = request.nextUrl.clone();
    const nextPath = redirectUrl.searchParams.get("next");
    if (
      nextPath &&
      nextPath.startsWith("/") &&
      !nextPath.startsWith("//")
    ) {
      redirectUrl.pathname = nextPath;
    } else {
      redirectUrl.pathname = "/dashboard";
    }
    redirectUrl.searchParams.delete("next");
    return NextResponse.redirect(redirectUrl);
  }

  return supabaseResponse;
}
