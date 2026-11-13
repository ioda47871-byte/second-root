import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { artifactHostRefused } from "./lib/sales/artifact-host";

// Refreshes the Supabase session cookie for admin pages only. The public
// Second Root site and demos never go through the session code.
//
// DEV-196g (PR #267 L2, spec §6.8): host gating for the dedicated artifact
// origin. On the artifact host (SALES_DEMO_ARTIFACT_ORIGIN) every path but the
// share artifact route /demo-frame/p/… is the same plain 404 — no admin page, no
// share page, no API, no cookie. The matcher leaves out /demo-frame (the artifact
// routes never pass through the session proxy; they gate themselves) and Next's
// static assets. With SALES_DEMO_ARTIFACT_ORIGIN unset (today) this is a no-op.
// DEV-263e (PR #268 L1): robots.txt, favicon.ico, sitemap.xml and static-looking
// paths still go through the gate (404 on the artifact host); on the app host
// they skip only the session work (STATIC_PATH).

/** Well-known files and static files by extension: no session refresh for them (the host gate still applies). */
// (favicon.ico, robots.txt and sitemap.xml are covered by their extensions; DEV-263g dropped the unreachable names)
export const STATIC_PATH = /\.(?:svg|png|jpe?g|gif|webp|avif|ico|css|js|map|txt|xml|webmanifest|woff2?|ttf|otf)$/i;

function notFound(): NextResponse {
  return new NextResponse("Not Found", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
      "Content-Security-Policy": "default-src 'none'",
    },
  });
}

export async function proxy(request: NextRequest) {
  if (artifactHostRefused({ host: request.headers.get("host"), pathname: request.nextUrl.pathname, artifactOrigin: process.env.SALES_DEMO_ARTIFACT_ORIGIN })) return notFound();
  const path = request.nextUrl.pathname;
  if (path !== "/admin" && !path.startsWith("/admin/")) return NextResponse.next();
  // DEV-263e (PR #267 delta Low, PR #268 L1): well-known and static files need no session work (after the host gate)
  if (STATIC_PATH.test(path)) return NextResponse.next();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  let response = NextResponse.next({ request });
  if (!url || !anonKey) return response;

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        Object.entries(headers ?? {}).forEach(([key, value]) => response.headers.set(key, value));
      },
    },
  });
  await supabase.auth.getUser();
  return response;
}

export const config = {
  // every path except /demo-frame/… (and /demo-frame itself) and Next's static assets. Kept broad (PR #268 L1): the
  // artifact-host gate must see robots.txt, favicon.ico and static-looking paths too; only the session work skips them.
  matcher: ["/((?!demo-frame(?:/|$)|_next/static|_next/image).*)"],
};
