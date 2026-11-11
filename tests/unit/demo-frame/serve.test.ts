import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { demoFrameNotFound, serveDemoFrame, splitFramePath, type FrameFile, type FrameImage, type FrameRequest, type FrameStore, type FrameVersion } from "@/lib/demo-frame/serve";
import { artifactResponseHeaders } from "@/lib/sales/demo-version/csp";
import { sha256Hex } from "@/lib/sales/demo-version/manifest";
import { signViewToken } from "@/lib/sales/demo-version/view-token";
import { solidWebp } from "../../support/solid-webp";

// DEV-196d-2 (spec §6.4): every check of the admin artifact route, against an in-memory store. Every refusal must be
// byte-for-byte the same 404, and nothing may be read before the flag, the token and Sec-Fetch-Dest pass.

const NOW = new Date("2026-11-11T03:00:00Z"); // 12:00 JST
const KEY = randomBytes(32);
const KEY_TEXT = KEY.toString("base64");
const ENV = { SALES_DEMO_VERSIONS_ENABLED: "true", SALES_DEMO_VIEW_SIGNING_KEY: KEY_TEXT };
const ORIGIN = "http://127.0.0.1:3100";
const DEMO = "00000000-0000-4000-8000-0000000000d1";
const VID = "00000000-0000-4000-8000-0000000000a1";
const IMG = "00000000-0000-4000-8000-0000000000e1";

const HTML = new TextEncoder().encode('<!doctype html><html lang="ja"><head><link rel="stylesheet" href="style.css"></head><body><h1>架空の店</h1><img src="photos/hero-desktop.webp" alt=""></body></html>');
const CSS = new TextEncoder().encode("body{margin:0}");
const PHOTO = solidWebp(8, 6, [10, 20, 30, 255]);
const RENDER = solidWebp(14, 40, [200, 200, 200, 255]);

const OBJECTS: Record<string, Uint8Array> = {
  "page/index.html": HTML,
  "page/style.css": CSS,
  "page/photos/hero-desktop.webp": PHOTO,
  "renders/desktop_1440.webp": RENDER,
};

const fileOf = (path: string, role: string, content_type: string, bytes: Uint8Array, dims?: [number, number], image_id: string | null = null): FrameFile => ({
  path,
  role,
  sha256: sha256Hex(bytes),
  bytes: bytes.byteLength,
  content_type,
  width: dims?.[0] ?? null,
  height: dims?.[1] ?? null,
  image_id,
});

type World = { version: FrameVersion | null; files: FrameFile[]; images: FrameImage[]; objects: Record<string, Uint8Array>; throwOn?: keyof FrameStore };

function world(over: Partial<World> = {}): World {
  return {
    version: { id: VID, demo_id: DEMO, status: "draft", revoked_at: null, expires_at: "2027-01-01T00:00:00Z", storage_prefix: `v1/${DEMO}/${VID}/` },
    files: [
      fileOf("page/index.html", "html", "text/html", HTML),
      fileOf("page/style.css", "css", "text/css", CSS),
      fileOf("page/photos/hero-desktop.webp", "photo", "image/webp", PHOTO, [8, 6], IMG),
      fileOf("renders/desktop_1440.webp", "render", "image/webp", RENDER, [14, 40]),
    ],
    images: [{ id: IMG, sha256: sha256Hex(PHOTO), rights_status: "owner_provided_internal", rights_expiry: null, revoked_at: null }],
    objects: Object.fromEntries(Object.entries(OBJECTS).map(([k, v]) => [`v1/${DEMO}/${VID}/${k}`, v])),
    ...over,
  };
}

function storeFor(w: World, calls: string[]): FrameStore {
  const guard = (name: keyof FrameStore) => {
    calls.push(name);
    if (w.throwOn === name) throw new Error("boom");
  };
  return {
    async version(id) {
      guard("version");
      return w.version && w.version.id === id ? w.version : null;
    },
    async files() {
      guard("files");
      return w.files;
    },
    async images(ids) {
      guard("images");
      return w.images.filter((i) => ids.includes(i.id));
    },
    async object(key, max) {
      guard("object");
      const b = w.objects[key];
      return b && b.byteLength <= max ? b : null;
    },
  };
}

const token = (o: { scope?: "a" | "p"; versionId?: string; demoId?: string; now?: Date; key?: Uint8Array } = {}) =>
  signViewToken({ scope: o.scope ?? "a", versionId: o.versionId ?? VID, demoId: o.demoId ?? DEMO, now: o.now ?? NOW, key: o.key ?? KEY });

const DEST: Record<string, string | null> = { "index.html": "iframe", "style.css": "style", "photos/hero-desktop.webp": "image", "renders/desktop_1440.webp": "image" };

function request(urlPath: string, over: Partial<FrameRequest> & { tok?: string } = {}): FrameRequest {
  const tok = over.tok ?? token();
  return { method: "GET", pathname: `/demo-frame/a/${tok}/${urlPath}`, search: "", origin: ORIGIN, secFetchDest: DEST[urlPath] ?? null, ...over };
}

async function serve(req: FrameRequest, o: { env?: Record<string, string | undefined>; w?: World; now?: Date } = {}) {
  const calls: string[] = [];
  let built = 0;
  const res = await serveDemoFrame(req, {
    env: o.env ?? ENV,
    now: o.now ?? NOW,
    store: () => {
      built++;
      return storeFor(o.w ?? world(), calls);
    },
  });
  return { res, calls, built };
}

const NOT_FOUND = demoFrameNotFound();
const NOT_FOUND_HEADERS = [...NOT_FOUND.headers.entries()].sort();

async function expectUniform404(res: Response, label = "") {
  expect(res.status, label).toBe(404);
  expect([...res.headers.entries()].sort(), label).toEqual(NOT_FOUND_HEADERS);
  expect(await res.text(), label).toBe("Not Found");
}

describe("serveDemoFrame: what an admin preview may load", () => {
  it.each(Object.keys(DEST))("serves %s with the §6.7 headers and the exact bytes", async (urlPath) => {
    const req = request(urlPath);
    const { res } = await serve(req);
    expect(res.status).toBe(200);
    const tok = req.pathname.split("/")[3]!;
    const role = urlPath === "index.html" ? "html" : urlPath === "style.css" ? "css" : urlPath.startsWith("photos/") ? "photo" : "render";
    const contentType = role === "html" ? "text/html" : role === "css" ? "text/css" : "image/webp";
    const expected = artifactResponseHeaders({ role, contentType, scope: "a", servingOrigin: ORIGIN, appOrigin: ORIGIN, token: tok });
    expect(Object.fromEntries(res.headers.entries())).toEqual(Object.fromEntries(Object.entries(expected).map(([k, v]) => [k.toLowerCase(), v])));
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cross-origin-resource-policy")).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(OBJECTS[role === "html" ? "page/index.html" : role === "css" ? "page/style.css" : role === "photo" ? "page/photos/hero-desktop.webp" : "renders/desktop_1440.webp"]);
  });

  it("the HTML's CSP is sandboxed, script-free and names only this token's paths and the app as ancestor", async () => {
    const req = request("index.html");
    const csp = (await serve(req)).res.headers.get("content-security-policy")!;
    const tok = req.pathname.split("/")[3]!;
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toMatch(/; sandbox$/);
    expect(csp).toContain(`style-src ${ORIGIN}/demo-frame/a/${tok}/style.css`);
    expect(csp).toContain(`img-src ${ORIGIN}/demo-frame/a/${tok}/photos/`);
    expect(csp).toContain(`frame-ancestors ${ORIGIN}`);
  });

  it("an admin HTML request without Sec-Fetch-Dest is allowed (admin-only interim; the CSP sandbox backs it)", async () => {
    expect((await serve(request("index.html", { secFetchDest: null }))).res.status).toBe(200);
  });

  it("an approved or superseded version is served too", async () => {
    for (const status of ["approved", "superseded"]) {
      const w = world();
      w.version = { ...w.version!, status };
      expect((await serve(request("index.html"), { w })).res.status, status).toBe(200);
    }
  });
});

describe("serveDemoFrame: every refusal is the same 404", () => {
  it("the 404 itself: no-store, nosniff, noindex, no referrer, no content to run", async () => {
    await expectUniform404(demoFrameNotFound());
    expect(NOT_FOUND.headers.get("cache-control")).toBe("private, no-store");
    expect(NOT_FOUND.headers.get("content-security-policy")).toBe("default-src 'none'");
    expect(NOT_FOUND.headers.get("x-robots-tag")).toContain("noindex");
  });

  it("flag off (anything but exactly \"true\"): 404 and nothing is read", async () => {
    for (const flag of [undefined, "", "TRUE", "1", " true", "true "]) {
      const { res, built, calls } = await serve(request("index.html"), { env: { ...ENV, SALES_DEMO_VERSIONS_ENABLED: flag } });
      await expectUniform404(res, String(flag));
      expect(built).toBe(0);
      expect(calls).toEqual([]);
    }
  });

  it("no or malformed signing key, or a configured artifact origin (not served until DEV-196g): 404, nothing read", async () => {
    for (const env of [
      { SALES_DEMO_VERSIONS_ENABLED: "true" },
      { ...ENV, SALES_DEMO_VIEW_SIGNING_KEY: "short" },
      { ...ENV, SALES_DEMO_VIEW_SIGNING_KEY: `${KEY_TEXT}\n` },
      { ...ENV, SALES_DEMO_ARTIFACT_ORIGIN: "https://artifacts.example.com" },
      { ...ENV, SALES_DEMO_ARTIFACT_ORIGIN: "" },
      { ...ENV, SALES_DEMO_ARTIFACT_ORIGIN: "not an origin" },
    ]) {
      const { res, built } = await serve(request("index.html"), { env });
      await expectUniform404(res, JSON.stringify(Object.keys(env)));
      expect(built).toBe(0);
    }
  });

  it("other methods, a query string and an origin that may not serve: 404", async () => {
    for (const method of ["POST", "PUT", "DELETE", "HEAD", "OPTIONS"]) await expectUniform404((await serve(request("index.html", { method }))).res, method);
    for (const search of ["?", "?x=1", "?token=abc"]) await expectUniform404((await serve(request("index.html", { search }))).res, search);
    for (const origin of ["http://evil.example", "null", "", "http://127.0.0.1:3100/x"]) await expectUniform404((await serve(request("index.html", { origin }))).res, origin);
  });

  it("paths outside the §5.2 table: encoded, traversal, page/ prefix, unknown names, missing parts → 404, nothing read", async () => {
    const tok = token();
    const paths = [
      `/demo-frame/a/${tok}/page/index.html`,
      `/demo-frame/a/${tok}/../index.html`,
      `/demo-frame/a/${tok}/photos/../style.css`,
      `/demo-frame/a/${tok}/index%2ehtml`,
      `/demo-frame/a/${tok}/photos%2Fhero-desktop.webp`,
      `/demo-frame/a/${tok}/Index.html`,
      `/demo-frame/a/${tok}/style.css/`,
      `/demo-frame/a/${tok}/photos/hero.svg`,
      `/demo-frame/a/${tok}/renders/desktop_1440.png`,
      `/demo-frame/a/${tok}/manifest.json`,
      `/demo-frame/a/${tok}/`,
      `/demo-frame/a/${tok}`,
      `/demo-frame/a//index.html`,
      `/demo-frame/p/${tok}/index.html`,
      `/demo-frame/a/${tok}/index.html\\..`,
    ];
    for (const pathname of paths) {
      const { res, built } = await serve(request("index.html", { pathname }));
      await expectUniform404(res, pathname);
      expect(built, pathname).toBe(0);
    }
  });

  it("tokens: another key, expired, scope p, another version or demo, malformed → 404", async () => {
    const cases: Array<[string, string, World?]> = [
      ["other key", token({ key: randomBytes(32) })],
      ["expired", token({ now: new Date(NOW.getTime() - 16 * 60_000) })],
      ["scope p", token({ scope: "p" })],
      ["other version", token({ versionId: "00000000-0000-4000-8000-0000000000a2" })],
      ["other demo", token({ demoId: "00000000-0000-4000-8000-0000000000d2" })],
      ["malformed", "abc.def"],
      ["tampered", token().replace(/.$/, (c) => (c === "A" ? "B" : "A"))],
    ];
    for (const [label, tok] of cases) await expectUniform404((await serve(request("index.html", { tok }))).res, label);
    // nothing is read for a token that does not verify
    expect((await serve(request("index.html", { tok: token({ key: randomBytes(32) }) }))).built).toBe(0);
  });

  it("Sec-Fetch-Dest must match the role (checked before any read)", async () => {
    const wrong: Array<[string, string | null]> = [
      ["style.css", null],
      ["style.css", "document"],
      ["style.css", "image"],
      ["photos/hero-desktop.webp", null],
      ["photos/hero-desktop.webp", "document"],
      ["renders/desktop_1440.webp", "iframe"],
      ["index.html", "document"],
      ["index.html", "image"],
      ["index.html", "script"],
    ];
    for (const [p, secFetchDest] of wrong) {
      const { res, built } = await serve(request(p, { secFetchDest }));
      await expectUniform404(res, `${p} ${secFetchDest}`);
      expect(built).toBe(0);
    }
  });

  it("the version: missing, other demo, revoked, expired, not previewable, unreadable, wrong storage prefix → 404", async () => {
    const v = world().version!;
    const variants: Array<[string, FrameVersion | null]> = [
      ["missing", null],
      ["other demo", { ...v, demo_id: "00000000-0000-4000-8000-0000000000d2" }],
      ["revoked", { ...v, revoked_at: "2026-11-10T00:00:00Z", status: "revoked" }],
      ["revoked_at only", { ...v, revoked_at: "2026-11-10T00:00:00Z" }],
      ["expired now", { ...v, expires_at: NOW.toISOString() }],
      ["unreadable expiry", { ...v, expires_at: "soon" }],
      ...["uploading", "rejected", "revoked", "expired", "nonsense"].map((status): [string, FrameVersion] => [status, { ...v, status }]),
      ["prefix", { ...v, storage_prefix: `v1/${DEMO}/other/` }],
    ];
    for (const [label, version] of variants) await expectUniform404((await serve(request("index.html"), { w: world({ version }) })).res, label);
  });

  it("the file must be in the version's manifest with the role and type its name implies", async () => {
    const w = world();
    await expectUniform404((await serve(request("style.css"), { w: { ...w, files: w.files.filter((f) => f.path !== "page/style.css") } })).res, "absent");
    await expectUniform404((await serve(request("style.css"), { w: { ...w, files: w.files.map((f) => (f.path === "page/style.css" ? { ...f, role: "html" } : f)) } })).res, "role");
    await expectUniform404((await serve(request("photos/hero-desktop.webp"), { w: { ...w, files: w.files.map((f) => (f.role === "photo" ? { ...f, content_type: "image/jpeg" } : f)) } })).res, "type");
  });

  it("photo rights fail closed: one unusable image hides every file of the version", async () => {
    const img = world().images[0]!;
    const variants: Array<[string, Partial<World>]> = [
      ["image row missing", { images: [] }],
      ["revoked", { images: [{ ...img, revoked_at: "2026-11-10T00:00:00Z", rights_status: "revoked" }] }],
      ["unknown", { images: [{ ...img, rights_status: "unknown" }] }],
      ["unrecognised", { images: [{ ...img, rights_status: "made_up" }] }],
      ["expired before today (JST)", { images: [{ ...img, rights_expiry: "2026-11-10" }] }],
      ["sha256 differs from the file", { images: [{ ...img, sha256: sha256Hex("other") }] }],
      ["photo without image id", { files: world().files.map((f) => (f.role === "photo" ? { ...f, image_id: null } : f)) }],
    ];
    for (const [label, over] of variants) {
      for (const p of Object.keys(DEST)) await expectUniform404((await serve(request(p), { w: world(over) })).res, `${label} ${p}`);
    }
    // rights expiring today (JST) still allow the preview
    expect((await serve(request("index.html"), { w: world({ images: [{ ...img, rights_expiry: "2026-11-11" }] }) })).res.status).toBe(200);
  });

  it("the stored bytes must be exactly the manifest's: missing, tampered, resized, not UTF-8, metadata → 404", async () => {
    const key = (n: string) => `v1/${DEMO}/${VID}/${n}`;
    const objects = world().objects;
    const variants: Array<[string, string, Record<string, Uint8Array>]> = [
      ["missing", "index.html", { ...objects, [key("page/index.html")]: undefined as unknown as Uint8Array }],
      ["tampered html", "index.html", { ...objects, [key("page/index.html")]: new TextEncoder().encode("<!doctype html><script>x</script>".padEnd(HTML.byteLength, " ")) }],
      ["css not utf-8", "style.css", { ...objects, [key("page/style.css")]: new Uint8Array(CSS.byteLength).fill(0xff) }],
      ["other photo", "photos/hero-desktop.webp", { ...objects, [key("page/photos/hero-desktop.webp")]: solidWebp(8, 6, [11, 20, 30, 255]) }],
      ["larger", "renders/desktop_1440.webp", { ...objects, [key("renders/desktop_1440.webp")]: new Uint8Array([...RENDER, 0]) }],
    ];
    for (const [label, p, o] of variants) await expectUniform404((await serve(request(p), { w: world({ objects: o }) })).res, label);
  });

  it("a store that throws at any step answers the same 404", async () => {
    for (const throwOn of ["version", "files", "images", "object"] as const) {
      for (const p of Object.keys(DEST)) await expectUniform404((await serve(request(p), { w: world({ throwOn }) })).res, `${throwOn} ${p}`);
    }
  });
});

describe("splitFramePath", () => {
  it("takes the token and the rest from the raw path only", () => {
    expect(splitFramePath("/demo-frame/a/tok/index.html")).toEqual({ token: "tok", urlPath: "index.html" });
    expect(splitFramePath("/demo-frame/a/tok/photos/x-desktop.webp")).toEqual({ token: "tok", urlPath: "photos/x-desktop.webp" });
    for (const p of ["/demo-frame/p/tok/index.html", "/demo-frame/a/tok", "/demo-frame/a//index.html", "/demo/a/tok/index.html", `/demo-frame/a/${"x".repeat(700)}/i`]) expect(splitFramePath(p), p).toBeNull();
  });
});
