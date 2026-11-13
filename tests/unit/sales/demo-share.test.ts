import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import nextConfig from "@/next.config";
import { artifactHostRefused } from "@/lib/sales/artifact-host";
import { resolveLegacyOnly, resolveShareOuter } from "@/lib/sales/demo-share";
import { shareOuterPageCsp } from "@/lib/sales/demo-version/csp";
import { APP_ORIGIN_ENV, ARTIFACT_ORIGIN_ENV, demoShareConfig, demoShareEnabled, DEMO_VERSIONS_ENABLED_ENV, SHARE_ENABLED_ENV, VIEW_SIGNING_KEY_ENV } from "@/lib/sales/demo-version/flags";
import { verifyViewToken } from "@/lib/sales/demo-version/view-token";

// DEV-196g: the share flag (strict, default off, needs the preview flag), the share config (fails closed), the share
// page's CSP rule (only with the flag on), and the share page's decision (the database's resolver; never a fallback).

const KEY = randomBytes(32);
const APP = "https://app.example.com";
const ART = "https://artifacts.example.com";
const ON = { SALES_DEMO_VERSIONS_ENABLED: "true", SALES_DEMO_SHARE_ENABLED: "true", SALES_DEMO_VIEW_SIGNING_KEY: KEY.toString("base64url"), SALES_DEMO_ARTIFACT_ORIGIN: ART, SALES_DEMO_APP_ORIGIN: APP };
const TOKEN = "t".repeat(43);
const DEMO = "00000000-0000-4000-8000-0000000000d1";
const VID = "00000000-0000-4000-8000-0000000000a1";
const NOW = new Date("2026-11-13T03:00:00Z");

describe("share flag and config", () => {
  it("the env names are the ones csp.ts reads", () => {
    expect([DEMO_VERSIONS_ENABLED_ENV, SHARE_ENABLED_ENV, ARTIFACT_ORIGIN_ENV, APP_ORIGIN_ENV, VIEW_SIGNING_KEY_ENV]).toEqual([
      "SALES_DEMO_VERSIONS_ENABLED", "SALES_DEMO_SHARE_ENABLED", "SALES_DEMO_ARTIFACT_ORIGIN", "SALES_DEMO_APP_ORIGIN", "SALES_DEMO_VIEW_SIGNING_KEY",
    ]);
  });
  it("strict \"true\", default off, and only with the preview flag", () => {
    expect(demoShareEnabled({})).toBe(false);
    for (const v of ["TRUE", "1", " true", "yes", ""]) expect(demoShareEnabled({ ...ON, SALES_DEMO_SHARE_ENABLED: v })).toBe(false);
    expect(demoShareEnabled({ ...ON, SALES_DEMO_VERSIONS_ENABLED: undefined })).toBe(false);
    expect(demoShareEnabled(ON)).toBe(true);
  });
  it("ready only with a key, a valid artifact origin and a valid, different app origin", () => {
    expect(demoShareConfig({})).toEqual({ enabled: false });
    const ready = demoShareConfig(ON);
    expect(ready).toMatchObject({ enabled: true, ready: true, artifactOrigin: ART, appOrigin: APP });
    for (const over of [{ SALES_DEMO_VIEW_SIGNING_KEY: undefined }, { SALES_DEMO_ARTIFACT_ORIGIN: undefined }, { SALES_DEMO_ARTIFACT_ORIGIN: "x" }, { SALES_DEMO_APP_ORIGIN: undefined }, { SALES_DEMO_APP_ORIGIN: ART }, { SALES_DEMO_APP_ORIGIN: "http://app.example.com" }]) {
      expect(demoShareConfig({ ...ON, ...over }), JSON.stringify(over)).toEqual({ enabled: true, ready: false });
    }
  });
});

describe("the share page's CSP rule (next.config.ts, build time)", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("flag off: no rule, the share page's headers stay exactly today's", async () => {
    expect(shareOuterPageCsp({})).toBeNull();
    expect(shareOuterPageCsp({ ...ON, SALES_DEMO_SHARE_ENABLED: "false" })).toBeNull();
    const rules = await nextConfig.headers!();
    expect(rules.filter((r) => r.source === "/demo/:path*")).toHaveLength(1);
  });
  it("flag on: frames only the artifact origin, never framed; misconfigured: frames nothing", async () => {
    expect(shareOuterPageCsp(ON)).toBe(`frame-ancestors 'none'; frame-src ${ART}`);
    expect(shareOuterPageCsp({ ...ON, SALES_DEMO_ARTIFACT_ORIGIN: undefined })).toBe("frame-ancestors 'none'; frame-src 'none'");
    expect(shareOuterPageCsp({ ...ON, SALES_DEMO_APP_ORIGIN: ART })).toBe("frame-ancestors 'none'; frame-src 'none'");
    for (const [k, v] of Object.entries(ON)) vi.stubEnv(k, v);
    const rules = await nextConfig.headers!();
    const demo = rules.filter((r) => r.source === "/demo/:path*");
    expect(demo).toHaveLength(2);
    // the second rule wins for the same key, and changes only the CSP (X-Frame-Options DENY etc. stay from the first)
    expect(demo[1]!.headers).toEqual([{ key: "Content-Security-Policy", value: `frame-ancestors 'none'; frame-src ${ART}` }]);
    expect(demo[0]!.headers.find((h) => h.key === "X-Frame-Options")?.value).toBe("DENY");
    expect(rules.indexOf(demo[1]!)).toBe(rules.indexOf(demo[0]!) + 1);
  });
});

type Rpc = { data: unknown; error: unknown };
function client(o: { rpc?: Rpc | (() => never); demo?: Rpc }) {
  const calls: string[] = [];
  return {
    calls,
    db: {
      rpc: async (fn: string, args: unknown) => {
        calls.push(`rpc:${fn}:${JSON.stringify(args)}`);
        if (typeof o.rpc === "function") return o.rpc();
        return o.rpc ?? { data: { mode: "none" }, error: null };
      },
      from: (t: string) => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => (calls.push(`from:${t}`), o.demo ?? { data: { id: DEMO, content: { name: "架空の焼き菓子店" } }, error: null }) }) }),
      }),
    } as never,
  };
}

describe("resolveShareOuter (the database decides; never a fallback)", () => {
  it("version: a 30-minute scope-p token for exactly that version, framed from the artifact origin", async () => {
    const c = client({ rpc: { data: { mode: "version", version_id: VID }, error: null } });
    const r = await resolveShareOuter(c.db, TOKEN, { env: ON, now: NOW });
    if (r.kind !== "version") throw new Error(r.kind);
    expect(r.shopName).toBe("架空の焼き菓子店");
    const m = new RegExp(`^${ART}/demo-frame/p/([^/]+)/index\\.html$`).exec(r.frameSrc);
    expect(m).not.toBeNull();
    const v = verifyViewToken({ token: m![1]!, pathScope: "p", now: NOW, key: KEY });
    expect(v).toMatchObject({ ok: true, payload: { scope: "p", version_id: VID, demo_id: DEMO } });
    if (v.ok) expect(v.payload.exp - Math.floor(NOW.getTime() / 1000)).toBe(30 * 60);
    expect(c.calls[0]).toBe(`rpc:sales_resolve_demo_share:${JSON.stringify({ p_public_token: TOKEN })}`);
  });
  it("legacy stays the React demo; none, errors, odd answers and a malformed token are not found", async () => {
    expect(await resolveShareOuter(client({ rpc: { data: { mode: "legacy" }, error: null } }).db, TOKEN, { env: ON, now: NOW })).toEqual({ kind: "legacy" });
    for (const rpc of [{ data: { mode: "none" }, error: null }, { data: null, error: { message: "x" } }, { data: { mode: "version" }, error: null }, { data: { mode: "version", version_id: "x" }, error: null }, { data: { mode: "latest" }, error: null }]) {
      expect(await resolveShareOuter(client({ rpc }).db, TOKEN, { env: ON, now: NOW }), JSON.stringify(rpc)).toEqual({ kind: "not_found" });
    }
    expect(await resolveShareOuter(client({ rpc: () => { throw new Error("boom"); } }).db, TOKEN, { env: ON, now: NOW })).toEqual({ kind: "not_found" });
    const c = client({});
    expect(await resolveShareOuter(c.db, "short", { env: ON, now: NOW })).toEqual({ kind: "not_found" });
    expect(c.calls).toEqual([]);
  });
  it("a version with the share settings incomplete is not found — never the React demo instead", async () => {
    const rpc = { data: { mode: "version", version_id: VID }, error: null };
    expect(await resolveShareOuter(client({ rpc }).db, TOKEN, { env: { ...ON, SALES_DEMO_APP_ORIGIN: undefined }, now: NOW })).toEqual({ kind: "not_found" });
    expect(await resolveShareOuter(client({ rpc, demo: { data: null, error: null } }).db, TOKEN, { env: ON, now: NOW })).toEqual({ kind: "not_found" });
    expect(await resolveShareOuter(client({ rpc, demo: { data: { id: DEMO, content: {} }, error: null } }).db, TOKEN, { env: ON, now: NOW })).toEqual({ kind: "not_found" });
  });
  it("flag off: a stray call reads nothing", async () => {
    const c = client({});
    expect(await resolveShareOuter(c.db, TOKEN, { env: {}, now: NOW })).toEqual({ kind: "legacy" });
    expect(c.calls).toEqual([]);
  });
});

describe("PR #267 M1: resolveLegacyOnly (the share flag off — React only for legacy)", () => {
  const db = (r: { data?: unknown; error?: { code?: string; message: string } | null } | (() => never)) =>
    ({ rpc: async () => (typeof r === "function" ? r() : { data: r.data ?? null, error: r.error ?? null }) }) as never;
  it("legacy → true; version / none / errors / a malformed token → false", async () => {
    expect(await resolveLegacyOnly(db({ data: { mode: "legacy" } }), TOKEN)).toBe(true);
    for (const data of [{ mode: "version", version_id: VID }, { mode: "none" }, null, { mode: "other" }]) expect(await resolveLegacyOnly(db({ data }), TOKEN), JSON.stringify(data)).toBe(false);
    expect(await resolveLegacyOnly(db({ error: { code: "XX000", message: "boom" } }), TOKEN)).toBe(false);
    expect(await resolveLegacyOnly(db(() => { throw new Error("boom"); }), TOKEN)).toBe(false);
    expect(await resolveLegacyOnly(db({ data: { mode: "legacy" } }), "short")).toBe(false);
  });
  it("a database without the resolver (version migrations not applied: no version can exist) keeps the React demo", async () => {
    expect(await resolveLegacyOnly(db({ error: { code: "PGRST202", message: "Could not find the function public.sales_resolve_demo_share(p_public_token) in the schema cache" } }), TOKEN)).toBe(true);
    expect(await resolveLegacyOnly(db({ error: { code: "42883", message: "function public.sales_resolve_demo_share(p_public_token => text) does not exist" } }), TOKEN)).toBe(true);
  });
  it("DEV-263e: 42883 for anything else (a helper or operator missing inside the resolver) is not found, never React", async () => {
    for (const message of ["function public.sales_demo_version_shareable(uuid) does not exist", "operator does not exist: uuid = text", "function not found", ""]) {
      expect(await resolveLegacyOnly(db({ error: { code: "42883", message } }), TOKEN), message).toBe(false);
    }
    for (const code of ["PGRST203", "PGRST116", "42501", "P0001", undefined]) expect(await resolveLegacyOnly(db({ error: { code, message: "sales_resolve_demo_share(" } }), TOKEN), String(code)).toBe(false);
  });
  it("PR #268 L3: PGRST202 counts only when its message names sales_resolve_demo_share(", async () => {
    for (const message of ["Could not find the function public.sales_other_function(p_x) in the schema cache", "function not found", ""]) {
      expect(await resolveLegacyOnly(db({ error: { code: "PGRST202", message } }), TOKEN), message).toBe(false);
    }
  });
});

describe("PR #267 L2: artifactHostRefused (the proxy's host gate)", () => {
  it("on the artifact host only /demo-frame/p/… passes", () => {
    for (const p of ["/", "/admin", "/admin/sales", `/demo/${TOKEN}`, "/api/internal/x", "/demo-frame/a/t/index.html"]) {
      expect(artifactHostRefused({ host: "artifacts.example.com", pathname: p, artifactOrigin: ART }), p).toBe(true);
    }
    expect(artifactHostRefused({ host: "ARTIFACTS.example.com", pathname: "/admin", artifactOrigin: ART })).toBe(true);
    expect(artifactHostRefused({ host: "artifacts.example.com", pathname: "/demo-frame/p/t/index.html", artifactOrigin: ART })).toBe(false);
  });
  it("no-op on the app host, without a host header, and with the artifact origin unset or malformed", () => {
    expect(artifactHostRefused({ host: "app.example.com", pathname: "/admin", artifactOrigin: ART })).toBe(false);
    expect(artifactHostRefused({ host: null, pathname: "/admin", artifactOrigin: ART })).toBe(false);
    expect(artifactHostRefused({ host: "artifacts.example.com", pathname: "/admin", artifactOrigin: undefined })).toBe(false);
    expect(artifactHostRefused({ host: "artifacts.example.com", pathname: "/admin", artifactOrigin: "artifacts.example.com" })).toBe(false);
    expect(artifactHostRefused({ host: "localhost:3121", pathname: "/", artifactOrigin: "http://localhost:3121" })).toBe(true);
    expect(artifactHostRefused({ host: "127.0.0.1:3121", pathname: "/", artifactOrigin: "http://localhost:3121" })).toBe(false);
  });
});
