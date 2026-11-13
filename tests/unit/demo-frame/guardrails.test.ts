import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import nextConfig from "@/next.config";
import { NextRequest } from "next/server";
import { config as proxyConfig, proxy, STATIC_PATH } from "@/proxy";

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
    expect(proxyConfig.matcher).toEqual(["/((?!demo-frame(?:/|$)|_next/static|_next/image).*)"]);
    const re = new RegExp(`^${proxyConfig.matcher[0]}$`);
    for (const p of ["/demo-frame", "/demo-frame/a/t/index.html", "/demo-frame/p/t/index.html", "/_next/static/x.js"]) expect(re.test(p), p).toBe(false);
    // PR #268 L1: the matcher stays broad — well-known and static-looking paths still reach the artifact-host gate
    for (const p of ["/", "/admin", "/admin/sales", "/demo/abc", "/api/internal/x", "/demo-framex", "/robots.txt", "/favicon.ico", "/x.js", "/admin/x.png"]) expect(re.test(p), p).toBe(true);
    // only the session work skips static paths
    for (const p of ["/favicon.ico", "/robots.txt", "/sitemap.xml", "/admin/x.png", "/admin/a.js", "/admin/fonts/x.woff2"]) expect(STATIC_PATH.test(p), p).toBe(true);
    for (const p of ["/admin", "/admin/sales", "/admin/sales/demos/x", "/robots.txtx", "/admin/x.pngx"]) expect(STATIC_PATH.test(p), p).toBe(false);
    // the session code still runs only for /admin (exactly, not /administrator)
    const src = readFileSync("proxy.ts", "utf8");
    expect(src).toMatch(/if \(path !== "\/admin" && !path\.startsWith\("\/admin\/"\)\) return NextResponse\.next\(\);/);
  });

  it("PR #268 L1: on the artifact host, static-looking paths are 404 like everything but /demo-frame/p/", async () => {
    const prev = process.env.SALES_DEMO_ARTIFACT_ORIGIN;
    process.env.SALES_DEMO_ARTIFACT_ORIGIN = "https://artifacts.example.com";
    try {
      const at = (host: string, p: string) => proxy(new NextRequest(`https://${host}${p}`, { headers: { host } }));
      for (const p of ["/robots.txt", "/x.js", "/admin/x.png", "/favicon.ico", "/sitemap.xml", "/admin"]) expect((await at("artifacts.example.com", p)).status, p).toBe(404);
      expect((await at("artifacts.example.com", "/demo-frame/p/t/index.html")).status).toBe(200);
      // the app host: static files pass straight through (no session work)
      const r = await at("app.example.com", "/robots.txt");
      expect(r.status).toBe(200);
      expect(r.headers.get("x-middleware-next")).toBe("1");
    } finally {
      if (prev === undefined) delete process.env.SALES_DEMO_ARTIFACT_ORIGIN;
      else process.env.SALES_DEMO_ARTIFACT_ORIGIN = prev;
    }
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
