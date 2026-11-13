import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { demoFrameNotFound, serveDemoFrame, type FrameFile, type FrameRequest, type FrameShare, type FrameStore } from "@/lib/demo-frame/serve";
import { artifactResponseHeaders } from "@/lib/sales/demo-version/csp";
import { sha256Hex } from "@/lib/sales/demo-version/manifest";
import { signViewToken } from "@/lib/sales/demo-version/view-token";
import { solidWebp } from "../../support/solid-webp";

// DEV-196g (spec §6.4・§6.7・§6.8): the share artifact route `/demo-frame/p/<token>/<path>` against an in-memory store.
// Served only with both flags, a complete share config, from the artifact origin, for the version the database's share
// decision names, with shareable rights (no photo today), never a render. Every refusal is the same 404.

const NOW = new Date("2026-11-13T03:00:00Z");
const KEY = randomBytes(32);
const APP = "http://127.0.0.1:3100";
const ART = "http://localhost:3100";
const ENV = { SALES_DEMO_VERSIONS_ENABLED: "true", SALES_DEMO_SHARE_ENABLED: "true", SALES_DEMO_VIEW_SIGNING_KEY: KEY.toString("base64"), SALES_DEMO_ARTIFACT_ORIGIN: ART, SALES_DEMO_APP_ORIGIN: APP };
const DEMO = "00000000-0000-4000-8000-0000000000d1";
const VID = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000a2";
const IMG = "00000000-0000-4000-8000-0000000000e1";

const HTML = new TextEncoder().encode('<!doctype html><html lang="ja"><head><link rel="stylesheet" href="style.css"></head><body><h1>架空の店</h1></body></html>');
const CSS = new TextEncoder().encode("body{margin:0}");
const RENDER = solidWebp(14, 40, [200, 200, 200, 255]);
const PHOTO = solidWebp(8, 6, [10, 20, 30, 255]);
const file = (path: string, role: string, content_type: string, b: Uint8Array, dims?: [number, number], image_id: string | null = null): FrameFile => ({
  path, role, sha256: sha256Hex(b), bytes: b.byteLength, content_type, width: dims?.[0] ?? null, height: dims?.[1] ?? null, image_id,
});
const FILES = [file("page/index.html", "html", "text/html", HTML), file("page/style.css", "css", "text/css", CSS), file("renders/desktop_1440.webp", "render", "image/webp", RENDER, [14, 40])];
const OBJECTS: Record<string, Uint8Array> = { "page/index.html": HTML, "page/style.css": CSS, "renders/desktop_1440.webp": RENDER, "page/photos/hero-desktop.webp": PHOTO };

type W = { status?: string; revoked?: string | null; disabled?: string | null; share?: FrameShare | null; files?: FrameFile[]; noShare?: boolean };

function store(w: W, calls: string[]): FrameStore {
  const s: FrameStore = {
    async version(id) {
      calls.push("version");
      return id === VID ? { id: VID, demo_id: DEMO, status: w.status ?? "draft", revoked_at: w.revoked ?? null, expires_at: "2026-01-01T00:00:00Z", storage_prefix: `v1/${DEMO}/${VID}/` } : null;
    },
    async demo() {
      calls.push("demo");
      return { id: DEMO, disabled_at: w.disabled ?? null };
    },
    async files() {
      calls.push("files");
      return w.files ?? FILES;
    },
    async images() {
      calls.push("images");
      return [{ id: IMG, sha256: sha256Hex(PHOTO), rights_status: "owner_provided_internal", rights_expiry: null, revoked_at: null }];
    },
    async object(key) {
      calls.push("object");
      return OBJECTS[key.slice(`v1/${DEMO}/${VID}/`.length)] ?? null;
    },
  };
  if (!w.noShare) s.share = async () => (calls.push("share"), w.share === undefined ? { mode: "version", version_id: VID } : w.share);
  return s;
}

const tok = (scope: "a" | "p" = "p", versionId = VID) => signViewToken({ scope, versionId, demoId: DEMO, now: NOW, key: KEY });
const DEST: Record<string, string> = { "index.html": "iframe", "style.css": "style", "renders/desktop_1440.webp": "image", "photos/hero-desktop.webp": "image" };
const req = (path: string, over: Partial<FrameRequest> & { t?: string } = {}): FrameRequest => ({
  method: "GET", pathname: `/demo-frame/p/${over.t ?? tok()}/${path}`, search: "", origin: ART, secFetchDest: DEST[path] ?? null, ...over,
});

async function serve(r: FrameRequest, o: { env?: Record<string, string | undefined>; w?: W } = {}) {
  const calls: string[] = [];
  let built = 0;
  const res = await serveDemoFrame(r, { env: o.env ?? ENV, now: NOW, store: () => (built++, store(o.w ?? {}, calls)) }, "p");
  return { res, calls, built };
}

const NOT_FOUND_HEADERS = [...demoFrameNotFound().headers.entries()].sort();
async function is404(res: Response, label = "") {
  expect(res.status, label).toBe(404);
  expect([...res.headers.entries()].sort(), label).toEqual(NOT_FOUND_HEADERS);
  expect(await res.text(), label).toBe("Not Found");
}

describe("scope p: what a shared demo's frame may load", () => {
  it.each(["index.html", "style.css"])("serves %s from the artifact origin with frame-ancestors naming the app, noindex, no-store, sandbox", async (path) => {
    const r = req(path);
    const { res, calls } = await serve(r);
    expect(res.status).toBe(200);
    const t = r.pathname.split("/")[3]!;
    const role = path === "index.html" ? "html" : "css";
    const expected = artifactResponseHeaders({ role, contentType: role === "html" ? "text/html" : "text/css", scope: "p", servingOrigin: ART, appOrigin: APP, token: t });
    expect(Object.fromEntries(res.headers.entries())).toEqual(Object.fromEntries(Object.entries(expected).map(([k, v]) => [k.toLowerCase(), v])));
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    if (role === "html") {
      const csp = res.headers.get("content-security-policy")!;
      expect(csp).toContain(`frame-ancestors ${APP}`);
      expect(csp).toContain("sandbox");
      expect(csp).toContain("script-src 'none'");
      expect(csp).toContain(`style-src ${ART}/demo-frame/p/${t}/style.css`);
    }
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(calls).toContain("share");
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(path === "index.html" ? HTML : CSS))).toBe(true);
  });

  it("a draft or superseded pinned version is still the one served (the sent pin decides, not the quality state)", async () => {
    for (const status of ["draft", "approved", "superseded"]) expect((await serve(req("index.html"), { w: { status } })).res.status).toBe(200);
  });
});

describe("scope p: every refusal is the same 404", () => {
  it("flags off (either one), or the share config incomplete / wrong: nothing read", async () => {
    for (const env of [
      {},
      { ...ENV, SALES_DEMO_SHARE_ENABLED: undefined },
      { ...ENV, SALES_DEMO_SHARE_ENABLED: "TRUE" },
      { ...ENV, SALES_DEMO_VERSIONS_ENABLED: undefined },
      { ...ENV, SALES_DEMO_VIEW_SIGNING_KEY: undefined },
      { ...ENV, SALES_DEMO_ARTIFACT_ORIGIN: undefined },
      { ...ENV, SALES_DEMO_ARTIFACT_ORIGIN: "not an origin" },
      { ...ENV, SALES_DEMO_APP_ORIGIN: undefined },
      { ...ENV, SALES_DEMO_APP_ORIGIN: ART },
    ]) {
      const { res, built } = await serve(req("index.html"), { env });
      await is404(res, JSON.stringify(env));
      expect(built).toBe(0);
    }
  });

  it("the app origin never serves scope p; an admin (a) token is not a share token; renders are never shared", async () => {
    await is404((await serve(req("index.html", { origin: APP }))).res, "app origin");
    await is404((await serve(req("index.html", { t: tok("a") }))).res, "scope a token");
    const r = await serve(req("renders/desktop_1440.webp"));
    await is404(r.res, "render");
    expect(r.built).toBe(0);
  });

  it("the HTML only inside an iframe (no direct navigation without the outer notice)", async () => {
    for (const d of [null, "document", "image"]) await is404((await serve(req("index.html", { secFetchDest: d }))).res, String(d));
  });

  it("the database does not name exactly this version: none / legacy / another version / unreadable / no reader", async () => {
    for (const share of [{ mode: "none" }, { mode: "legacy" }, { mode: "version", version_id: OTHER }, null]) await is404((await serve(req("index.html"), { w: { share } })).res, JSON.stringify(share));
    await is404((await serve(req("index.html"), { w: { noShare: true } })).res, "no share reader");
  });

  it("revoked, expired / rejected / uploading status, a disabled demo, or a token for another version", async () => {
    await is404((await serve(req("index.html"), { w: { revoked: "2026-11-12T00:00:00Z", status: "revoked" } })).res, "revoked");
    for (const status of ["expired", "rejected", "uploading", "bogus"]) {
      // the database's resolver would not name them either; even if it did, the row's own state refuses (except via the resolver)
      const r = await serve(req("index.html"), { w: { status, share: { mode: "none" } } });
      await is404(r.res, status);
    }
    await is404((await serve(req("index.html"), { w: { disabled: "2026-11-12T00:00:00Z" } })).res, "disabled");
    await is404((await serve(req("index.html", { t: tok("p", OTHER) }))).res, "other version");
  });

  it("a version with any photo is not shared (photos are not shareable yet, MVP_SPEC §7; AI images never)", async () => {
    const files = [...FILES, file("page/photos/hero-desktop.webp", "photo", "image/webp", PHOTO, [8, 6], IMG)];
    await is404((await serve(req("index.html"), { w: { files } })).res, "html of a version with a photo");
    await is404((await serve(req("photos/hero-desktop.webp"), { w: { files } })).res, "the photo");
  });

  it("a query string or another method", async () => {
    await is404((await serve(req("index.html", { search: "?x=1" }))).res);
    await is404((await serve(req("index.html", { method: "POST" }))).res);
  });
});
