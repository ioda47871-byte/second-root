import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import nextConfig from "@/next.config";
import { config as proxyConfig } from "@/proxy";

// DEV-196d-2 (spec §6.3・§6.8, SECURITY §12): the artifact route reads no cookie, logs nothing, never goes through
// the admin session proxy, gets no header rule from next.config.ts (no X-Frame-Options: it must load in an iframe),
// and the share scope `p` has no route of its own.

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

const ROUTE_FILES = [...filesUnder("app/demo-frame"), ...filesUnder("lib/demo-frame")];

describe("demo-frame guardrails", () => {
  it("has exactly the admin route, the catch-all 404 and the two library files", () => {
    expect(ROUTE_FILES.sort()).toEqual([
      "app/demo-frame/[[...rest]]/route.ts",
      "app/demo-frame/a/[token]/[...path]/route.ts",
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

  it("only the library reads the store; the environment is read only by the admin route, as an argument", () => {
    for (const f of ROUTE_FILES.filter((x) => x !== "app/demo-frame/a/[token]/[...path]/route.ts")) expect(readFileSync(f, "utf8"), f).not.toMatch(/process\.env/);
  });

  it("there is no share (scope p) route: the catch-all answers it with the same 404", () => {
    expect(ROUTE_FILES.some((f) => f.includes("/p/"))).toBe(false);
    expect(readFileSync("app/demo-frame/[[...rest]]/route.ts", "utf8")).not.toMatch(/serveDemoFrame|store/);
  });

  it("the session proxy never runs on /demo-frame", () => {
    expect(proxyConfig.matcher).toEqual(["/admin/:path*"]);
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
