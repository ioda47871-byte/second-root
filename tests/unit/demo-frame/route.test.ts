import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FrameFile, FrameStore } from "@/lib/demo-frame/serve";
import { sha256Hex } from "@/lib/sales/demo-version/manifest";
import { signViewToken } from "@/lib/sales/demo-version/view-token";
import { solidWebp } from "../../support/solid-webp";

// DEV-196d-2 (review of #247): the e2e checks that need the storage API (opaque origin, no script, no cookie, zero
// external requests) skip in CI, which starts Supabase without it. These tests run everywhere and pin what makes
// those properties hold: the exact security headers of the REAL route handlers, with the store module replaced by a
// stub HERE (vi.mock) — the production route has no test path and no runtime switch.

const KEY = randomBytes(32);
const ORIGIN = "http://127.0.0.1:3100";
const DEMO = "00000000-0000-4000-8000-0000000000d1";
const VID = "00000000-0000-4000-8000-0000000000a1";
const IMG = "00000000-0000-4000-8000-0000000000e1";
const HTML = new TextEncoder().encode('<!doctype html><html lang="ja"><head><link rel="stylesheet" href="style.css"></head><body><h1>架空の店</h1><img src="photos/hero-desktop.webp" alt=""></body></html>');
const CSS = new TextEncoder().encode("body{margin:0}");
const PHOTO = solidWebp(8, 6, [1, 2, 3, 255]);
const OBJECTS: Record<string, Uint8Array> = { "page/index.html": HTML, "page/style.css": CSS, "page/photos/hero-desktop.webp": PHOTO };
const file = (path: string, role: string, content_type: string, b: Uint8Array, dims: [number, number] | null = null, image_id: string | null = null): FrameFile => ({
  path, role, sha256: sha256Hex(b), bytes: b.byteLength, content_type, width: dims?.[0] ?? null, height: dims?.[1] ?? null, image_id,
});

const storeCalls: string[] = [];
let built = 0;
const stub: FrameStore = {
  async version(id) {
    storeCalls.push("version");
    return id === VID ? { id: VID, demo_id: DEMO, status: "draft", revoked_at: null, expires_at: "2099-01-01T00:00:00Z", storage_prefix: `v1/${DEMO}/${VID}/` } : null;
  },
  async demo(id) {
    storeCalls.push("demo");
    return id === DEMO ? { id: DEMO, disabled_at: null } : null;
  },
  async files() {
    storeCalls.push("files");
    return [file("page/index.html", "html", "text/html", HTML), file("page/style.css", "css", "text/css", CSS), file("page/photos/hero-desktop.webp", "photo", "image/webp", PHOTO, [8, 6], IMG)];
  },
  async images() {
    storeCalls.push("images");
    return [{ id: IMG, sha256: sha256Hex(PHOTO), rights_status: "owner_provided_internal", rights_expiry: null, revoked_at: null }];
  },
  async object(key) {
    storeCalls.push("object");
    return OBJECTS[key.slice(`v1/${DEMO}/${VID}/`.length)] ?? null;
  },
};
vi.mock("@/lib/demo-frame/store", () => ({
  supabaseFrameStore: () => {
    built++;
    return stub;
  },
}));

const { GET, POST, HEAD } = await import("@/app/demo-frame/a/[token]/[...path]/route");
const rest = await import("@/app/demo-frame/[[...rest]]/route");

const tok = (scope: "a" | "p" = "a") => signViewToken({ scope, versionId: VID, demoId: DEMO, now: new Date(), key: KEY });
const call = (url: string, headers: Record<string, string> = {}) =>
  GET(new NextRequest(url, { headers: { host: new URL(url).host, ...headers } }));

beforeEach(() => {
  vi.stubEnv("SALES_DEMO_VERSIONS_ENABLED", "true");
  vi.stubEnv("SALES_DEMO_VIEW_SIGNING_KEY", KEY.toString("base64url"));
  vi.stubEnv("SALES_DEMO_ARTIFACT_ORIGIN", undefined as unknown as string);
  storeCalls.length = 0;
  built = 0;
});
afterEach(() => vi.unstubAllEnvs());

/** The CSP as directive → source list. */
const directives = (csp: string) => new Map(csp.split(";").map((d) => d.trim().split(/\s+/)).map(([name, ...sources]) => [name!, sources]));

describe("the real route handler, HTML response (what keeps the framed page opaque, script-free and offline)", () => {
  it("CSP: sandbox without any allow-*, nothing allowed by default, no script / connect / frame / form, only this token's files", async () => {
    const t = tok();
    const res = await call(`${ORIGIN}/demo-frame/a/${t}/index.html`, { "sec-fetch-dest": "iframe" });
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy")!;
    const d = directives(csp);
    // sandbox with no tokens: opaque origin, no scripts, no forms, no popups, no top navigation
    expect(d.get("sandbox")).toEqual([]);
    expect(csp).not.toMatch(/allow-/);
    expect(d.get("default-src")).toEqual(["'none'"]);
    for (const k of ["script-src", "connect-src", "frame-src", "child-src", "worker-src", "object-src", "media-src", "font-src", "manifest-src", "form-action", "base-uri", "prefetch-src"]) {
      expect(d.get(k), k).toEqual(["'none'"]);
    }
    const base = `${ORIGIN}/demo-frame/a/${t}/`;
    expect(d.get("style-src")).toEqual([`${base}style.css`]);
    expect(d.get("img-src")).toEqual([`${base}photos/`]);
    expect(d.get("frame-ancestors")).toEqual([ORIGIN]);
    // zero external requests: no directive names any host but this token's paths (or the app as the only ancestor)
    for (const [name, sources] of d) {
      for (const s of sources) {
        expect(s === "'none'" || s.startsWith(base) || (name === "frame-ancestors" && s === ORIGIN), `${name} ${s}`).toBe(true);
      }
    }
  });

  it("no cookie is set, framing is not denied by X-Frame-Options, and the other §6.7 headers are exact", async () => {
    const res = await call(`${ORIGIN}/demo-frame/a/${tok()}/index.html`, { "sec-fetch-dest": "iframe", cookie: "sb-127-auth-token=secret-session-value" });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("cross-origin-resource-policy")).toBeNull();
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
    expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    const pp = res.headers.get("permissions-policy")!.split(", ");
    for (const f of ["camera=()", "microphone=()", "geolocation=()", "payment=()", "usb=()", "clipboard-read=()", "fullscreen=()"]) expect(pp, f).toContain(f);
    expect(pp.every((x) => /^[a-z-]+=\(\)$/.test(x))).toBe(true);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(HTML);
  });

  it("the request's cookie changes nothing: the response is the same with or without it", async () => {
    const url = `${ORIGIN}/demo-frame/a/${tok()}/index.html`;
    const a = await call(url, { "sec-fetch-dest": "iframe", cookie: "sb-127-auth-token=secret-session-value" });
    const b = await call(url, { "sec-fetch-dest": "iframe" });
    expect([...a.headers.entries()]).toEqual([...b.headers.entries()]);
    expect(await a.text()).toBe(await b.text());
  });

  it("the CSP names the host the browser used (Host), not the server's configured hostname", async () => {
    const t = tok();
    const res = await GET(new NextRequest(`http://localhost:3100/demo-frame/a/${t}/index.html`, { headers: { host: "127.0.0.1:3100", "sec-fetch-dest": "iframe" } }));
    expect(directives(res.headers.get("content-security-policy")!).get("frame-ancestors")).toEqual(["http://127.0.0.1:3100"]);
  });
});

describe("the real route handler, CSS and image responses", () => {
  it.each([
    ["style.css", "style", "text/css; charset=utf-8"],
    ["photos/hero-desktop.webp", "image", "image/webp"],
  ])("%s: default-src 'none', nosniff, no cookie, no-store", async (p, dest, type) => {
    const res = await call(`${ORIGIN}/demo-frame/a/${tok()}/${p}`, { "sec-fetch-dest": dest });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'");
    expect(res.headers.get("content-type")).toBe(type);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

describe("the real route handlers, refusals", () => {
  it("flag off: 404 and the store is never built", async () => {
    vi.stubEnv("SALES_DEMO_VERSIONS_ENABLED", "false");
    const res = await call(`${ORIGIN}/demo-frame/a/${tok()}/index.html`, { "sec-fetch-dest": "iframe" });
    expect(res.status).toBe(404);
    expect(built).toBe(0);
    expect(storeCalls).toEqual([]);
  });

  it("DEV-196g: the artifact origin never serves scope a, and a malformed one serves nothing — 404, nothing read", async () => {
    vi.stubEnv("SALES_DEMO_ARTIFACT_ORIGIN", ORIGIN);
    expect((await call(`${ORIGIN}/demo-frame/a/${tok()}/index.html`, { "sec-fetch-dest": "iframe" })).status).toBe(404);
    vi.stubEnv("SALES_DEMO_ARTIFACT_ORIGIN", "not an origin");
    expect((await call(`${ORIGIN}/demo-frame/a/${tok()}/index.html`, { "sec-fetch-dest": "iframe" })).status).toBe(404);
    expect(built).toBe(0);
  });

  it("other methods and the catch-all (scope p, anything else) are the same 404 as a refused GET", async () => {
    const refused = await call(`${ORIGIN}/demo-frame/a/${tok()}/index.html`, { "sec-fetch-dest": "document" });
    const shape = async (r: Response) => ({ status: r.status, headers: [...r.headers.entries()].sort(), body: await r.text() });
    const want = await shape(refused);
    expect(want.status).toBe(404);
    for (const r of [await POST(), await HEAD(), await rest.GET(), await rest.POST()]) expect(await shape(r)).toEqual(want);
    expect(built).toBe(0);
  });
});
