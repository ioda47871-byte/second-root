import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import nextConfig from "@/next.config";
import { config as proxyConfig } from "@/proxy";

// DEV-196d-2 (spec §6.3・§6.8, SECURITY §12): the artifact route reads no cookie, logs nothing, never goes through
// the admin session proxy, gets no header rule from next.config.ts (no X-Frame-Options: it must load in an iframe),
// and (DEV-196g) the share scope `p` has exactly one route, which runs the same library decision with scope "p".

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

const ROUTE_FILES = [...filesUnder("app/demo-frame"), ...filesUnder("lib/demo-frame")];

describe("demo-frame guardrails", () => {
  it("has exactly the admin route, the share route (DEV-196g), the catch-all 404 and the two library files", () => {
    expect(ROUTE_FILES.sort()).toEqual([
      "app/demo-frame/[[...rest]]/route.ts",
      "app/demo-frame/a/[token]/[...path]/route.ts",
      "app/demo-frame/p/[token]/[...path]/route.ts",
      "lib/demo-frame/serve.ts",
      "lib/demo-frame/store.ts",
    ]);
  });

  it.each(ROUTE_FILES)("%s reads no cookie or session, logs nothing and holds no Storage URL", (f) => {
    const src = readFileSync(f, "utf8");
    expect(src).not.toMatch(/\bcookies\s*\(|\.cookies\b|next\/headers|getUser|getSession|auth\./);
    expect(src).not.toMatch(/console\.|logger|process\.stdout|process\.stderr/);
    expect(src).not.toMatch(/createSignedUrl|getPublicUrl|\/storage\/v1/);
    expect(src).not.toMatch(/dangerouslySetInnerHTML|srcdoc/);
  });

  it("only the library reads the store; the environment is read only by the two artifact routes, as an argument", () => {
    const routes = ["app/demo-frame/a/[token]/[...path]/route.ts", "app/demo-frame/p/[token]/[...path]/route.ts"];
    for (const f of ROUTE_FILES.filter((x) => !routes.includes(x))) expect(readFileSync(f, "utf8"), f).not.toMatch(/process\.env/);
  });

  it("DEV-196g: the share route runs the library's decision with scope \"p\" (and the admin route with the default \"a\"); the catch-all serves nothing", () => {
    const p = readFileSync("app/demo-frame/p/[token]/[...path]/route.ts", "utf8");
    expect(p).toMatch(/serveDemoFrame\(/);
    expect(p).toMatch(/\n\s*"p",\n\s*\);/);
    expect(readFileSync("app/demo-frame/a/[token]/[...path]/route.ts", "utf8")).not.toMatch(/"p"/);
    expect(readFileSync("app/demo-frame/[[...rest]]/route.ts", "utf8")).not.toMatch(/serveDemoFrame|store/);
  });

  it("the proxy never runs on /demo-frame (DEV-196g: it now runs elsewhere for the artifact-host gate; sessions only on /admin)", () => {
    expect(proxyConfig.matcher).toEqual([
      "/((?!demo-frame(?:/|$)|_next/static|_next/image|favicon\\.ico$|robots\\.txt$|sitemap\\.xml$|.*\\.(?:svg|png|jpe?g|gif|webp|avif|ico|css|js|map|txt|xml|webmanifest|woff2?|ttf|otf)$).*)",
    ]);
    const re = new RegExp(`^${proxyConfig.matcher[0]}$`);
    for (const p of ["/demo-frame", "/demo-frame/a/t/index.html", "/demo-frame/p/t/index.html", "/_next/static/x.js"]) expect(re.test(p), p).toBe(false);
    // DEV-263e (PR #267 delta Low): well-known files and public static files skip the proxy
    for (const p of ["/favicon.ico", "/robots.txt", "/sitemap.xml", "/images/a.png", "/og.jpg", "/fonts/x.woff2", "/site.webmanifest"]) expect(re.test(p), p).toBe(false);
    for (const p of ["/", "/admin", "/admin/sales", "/demo/abc", "/api/internal/x", "/demo-framex", "/robots.txtx", "/favicon.icox", "/admin/sales/demos/x"]) expect(re.test(p), p).toBe(true);
    // the session code still runs only for /admin (exactly, not /administrator)
    const src = readFileSync("proxy.ts", "utf8");
    expect(src).toMatch(/if \(path !== "\/admin" && !path\.startsWith\("\/admin\/"\)\) return NextResponse\.next\(\);/);
  });

  it("no next.config.ts header rule applies to /demo-frame (in particular no X-Frame-Options DENY)", async () => {
    const rules = await nextConfig.headers!();
    for (const r of rules) {
      // every rule is "/prefix/:path*"; a rule applies to /demo-frame only if its prefix is /demo-frame or a parent
      const m = /^(\/[a-z0-9-/]+?)\/:path\*$/.exec(r.source);
      expect(m, r.source).not.toBeNull();
      const prefix = m![1]!;
      expect("/demo-frame/a/x/index.html".startsWith(`${prefix}/`), r.source).toBe(false);
      expect(prefix === "/demo-frame", r.source).toBe(false);
    }
  });
});
