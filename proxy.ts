import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

// Keeps staff Supabase sessions fresh (rotating the auth cookies) before staff
// pages render. Server Components can't write cookies, so this is where token
// refresh happens. Attendee and screen routes don't need it and skip it.
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
        },
      },
    },
  );

  // Validates the token and refreshes it if needed. Role/venue access is checked
  // in the pages (and enforced by RLS); here we only bounce signed-out visitors.
  const { data } = await supabase.auth.getClaims();
  const { pathname, search } = request.nextUrl;
  // /login and invite links work signed out (the invite page signs people in).
  if (!data?.claims && pathname !== "/login" && !pathname.startsWith("/join/")) {
    const login = new URL("/login", request.url);
    login.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(login);
  }

  return response;
}

export const config = {
  matcher: ["/dj/:path*", "/mc/:path*", "/club/:path*", "/admin/:path*", "/login", "/join/:path*"],
};
