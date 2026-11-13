import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { compCopyInput } from "@/lib/demo-version-package/local-inputs";
import { buildPackage, type DemoVersionPackage } from "@/lib/demo-version-package/package";
import { sendableSeedContent, SENDABLE_FACTS_PATH, SENDABLE_PAGE_DIR } from "@/lib/demo-version-package/seed-sendable";
import { readFileSync } from "node:fs";

// DEV-263i (Issue #263): 版を取り込む — the owner's hosted import, without a database: the bounded body, the origin
// check, what begin checks without bytes, the staging put (types, sizes, sniffing, sha256, replay, no overwrite), the
// finalize refusals before any write (extra / missing parts, unstaged or tampered files, non-store facts, a v1
// package) and the route's flag / origin / admin order. importPackage itself is replaced by a spy here (its database
// path is the integration test's, tests/integration/demo-version-upload.test.ts). The fictional 環 only.

const REPO = resolve(__dirname, "../../..");
const PROSPECT = "5e2d0a63-7c1b-4f0e-9a6d-263a00000001";
const DEMO = "00000000-0000-4000-8000-0000000000d1";
const ENV = { SALES_DEMO_VERSIONS_ENABLED: "true", SALES_DEMO_QUALITY_REVIEW_ENABLED: "true" };
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const factsText = readFileSync(resolve(REPO, SENDABLE_FACTS_PATH), "utf8");

const importSpy = vi.hoisted(() => vi.fn(async (pkg: DemoVersionPackage, o: Record<string, unknown>) => ({
  versionId: "v-1",
  versionNo: 1,
  demoId: o.demoId,
  bundleSha256: pkg.bundleSha256,
  created: true,
  files: pkg.manifest.files.map((f) => ({ name: f.name, sha256: f.sha256, bytes: f.bytes, uploaded: true })),
  copy: { status: "checked" },
  storedCopy: null,
})));
const A = vi.hoisted(() => ({ state: { kind: "admin", session: { userId: "u", email: null } } as unknown }));
const serviceClient = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("service client must not be created");
  }),
);
vi.mock("@/lib/admin/auth", () => ({ getAdminState: vi.fn(async () => A.state) }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => serviceClient() }));
vi.mock("@/lib/demo-version-package/import", async (original) => ({ ...(await original<typeof import("@/lib/demo-version-package/import")>()), importPackage: importSpy }));
const up = await import("@/lib/admin/demo-version-upload");
const { PackageError } = await import("@/lib/demo-version-package/verify");

const S = { content: null as unknown, current: [] as unknown[], demoMissing: false };
function fakeClient() {
  return {
    from: (table: string) => {
      const b = {
        select: () => b,
        eq: () => b,
        order: () => b,
        limit: async () => ({ data: table === "sales_demo_facts_packs" ? S.current : [], error: null }),
        maybeSingle: async () => (table === "sales_demos" && !S.demoMissing ? { data: { id: DEMO, content: S.content }, error: null } : { data: null, error: null }),
      };
      return b;
    },
  } as never;
}
function memoryStore() {
  const objects = new Map<string, Uint8Array>();
  const uploads: string[] = [];
  return {
    objects,
    uploads,
    store: {
      download: async (k: string) => objects.get(k) ?? null,
      upload: async (k: string, b: Uint8Array) => {
        if (objects.has(k)) throw new Error("exists");
        uploads.push(k);
        objects.set(k, b);
      },
      exists: async (k: string) => objects.has(k),
    },
  };
}
const storedRow = (demoId = DEMO, text = factsText) => ({ id: "f1", seq: 1, demo_id: demoId, shop_id: "fictional-bicycle-repair-tamaki", facts_sha256: sha(text), facts_pack_text: text, recorded_at: "2026-11-13T00:00:00Z", recorded_via: "admin_session" });

const png = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 40, g: 90, b: 140 } } }).png().toBuffer();
let pkg: DemoVersionPackage;
let packageJson: string;
let copyFiles: Map<string, Uint8Array>;
beforeAll(async () => {
  const c = compCopyInput(join(REPO, SENDABLE_PAGE_DIR), join(REPO, SENDABLE_FACTS_PATH));
  pkg = await buildPackage({ html: c.html, css: c.css, renders: { desktop_1440: new Uint8Array(await png(1440, 900)), mobile_390: new Uint8Array(await png(390, 900)) }, source: "test", copy: c.copy });
  const { files, copyFiles: cf, ...meta } = pkg;
  void files;
  packageJson = `${JSON.stringify(meta, null, 2)}\n`;
  copyFiles = new Map(Object.entries(cf!));
});
beforeEach(() => {
  importSpy.mockClear();
  S.content = sendableSeedContent(new TextEncoder().encode(factsText));
  S.current = [storedRow()];
  S.demoMissing = false;
});

/** Stages every page file of the package through stageFile. */
async function stageAll(store: ReturnType<typeof memoryStore>["store"]) {
  for (const f of pkg.manifest.files) await up.stageFile({ env: ENV, store, contentType: f.content_type, expectedSha256: f.sha256, bytes: pkg.files[f.name]! });
}
async function code(p: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    return up.uploadErrorCode(e) ?? `unexpected:${String(e)}`;
  }
  return "no error";
}

describe("readBoundedBody", () => {
  it("reads a body within the limit and refuses a declared or streamed body over it", async () => {
    expect([...(await up.readBoundedBody(new Request("http://x/", { method: "POST", body: "abc" }), 3))]).toEqual([97, 98, 99]);
    expect(await code(up.readBoundedBody(new Request("http://x/", { method: "POST", body: "abcd" }), 3))).toBe("BODY_TOO_LARGE");
    const stream = new ReadableStream({ start: (c) => (c.enqueue(new Uint8Array(4)), c.enqueue(new Uint8Array(4)), c.close()) });
    expect(await code(up.readBoundedBody(new Request("http://x/", { method: "POST", body: stream, duplex: "half" } as RequestInit), 6))).toBe("BODY_TOO_LARGE");
    expect(await code(up.readBoundedBody(new Request("http://x/", { method: "POST", body: "a", headers: { "content-length": "99999999999999" } }), 6))).toBe("BODY_TOO_LARGE");
  });
});

describe("sameOriginRequest (CSRF)", () => {
  const h = (o: Record<string, string>) => new Headers(o);
  it("only a same-origin request with an Origin header", () => {
    expect(up.sameOriginRequest(h({ origin: "https://app.example.com", host: "app.example.com", "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(up.sameOriginRequest(h({ origin: "https://app.example.com", host: "internal:3000", "x-forwarded-host": "app.example.com" }))).toBe(true);
    expect(up.sameOriginRequest(h({ host: "app.example.com" }))).toBe(false);
    expect(up.sameOriginRequest(h({ origin: "https://evil.example.net", host: "app.example.com" }))).toBe(false);
    expect(up.sameOriginRequest(h({ origin: "null", host: "app.example.com" }))).toBe(false);
    expect(up.sameOriginRequest(h({ origin: "https://app.example.com", host: "app.example.com", "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(up.sameOriginRequest(h({ origin: "javascript://app.example.com", host: "app.example.com" }))).toBe(false);
  });
});

describe("begin", () => {
  it("checks the package without bytes and the demo's stored facts; writes nothing; says what is staged", async () => {
    const m = memoryStore();
    const r = await up.beginUpload({ env: ENV, client: fakeClient(), store: m.store, prospectId: PROSPECT, packageJson });
    expect(r).toMatchObject({ bundleSha256: pkg.bundleSha256, demoId: DEMO });
    expect(r.pageFiles.map((f) => f.name)).toEqual(pkg.manifest.files.map((f) => f.name));
    expect(r.pageFiles.every((f) => !f.staged)).toBe(true);
    expect(r.copyFiles.map((f) => f.name).sort()).toEqual([...copyFiles.keys()].sort());
    expect(m.uploads).toEqual([]);
    await stageAll(m.store);
    expect((await up.beginUpload({ env: ENV, client: fakeClient(), store: m.store, prospectId: PROSPECT, packageJson })).pageFiles.every((f) => f.staged)).toBe(true);
  });

  it("flags off → FEATURE_DISABLED before anything is read", async () => {
    const m = memoryStore();
    const client = { from: vi.fn() } as never;
    for (const env of [{}, { SALES_DEMO_VERSIONS_ENABLED: "true" }, { SALES_DEMO_QUALITY_REVIEW_ENABLED: "true" }, { ...ENV, SALES_DEMO_QUALITY_REVIEW_ENABLED: "TRUE" }]) {
      expect(await code(up.beginUpload({ env, client, store: m.store, prospectId: PROSPECT, packageJson }))).toBe("FEATURE_DISABLED");
      expect(await code(up.stageFile({ env, store: m.store, contentType: "text/css", expectedSha256: sha("a{}"), bytes: new TextEncoder().encode("a{}") }))).toBe("FEATURE_DISABLED");
      expect(await code(up.finalizeUpload({ env, client, store: m.store, prospectId: PROSPECT, packageJson, copyFiles }))).toBe("FEATURE_DISABLED");
    }
    expect((client as unknown as { from: ReturnType<typeof vi.fn> }).from).not.toHaveBeenCalled();
  });

  it("refuses a v1 package, a broken manifest, a mismatched bundle, a bad copy manifest (path traversal), and too large", async () => {
    const meta = JSON.parse(packageJson) as Record<string, unknown>;
    const begin = (m: unknown) => code(up.beginUpload({ env: ENV, client: fakeClient(), store: memoryStore().store, prospectId: PROSPECT, packageJson: typeof m === "string" ? m : JSON.stringify(m) }));
    expect(await begin({ ...meta, format: "sales_demo_version_package_v1" })).toBe("PACKAGE_NOT_REVIEWED");
    expect(await begin({ ...meta, format: "zip" })).toBe("PACKAGE_FORMAT");
    expect(await begin("not json")).toBe("PACKAGE_UNREADABLE");
    expect(await begin("[]")).toBe("PACKAGE_UNREADABLE");
    expect(await begin({ ...meta, bundleSha256: "0".repeat(64) })).toBe("BUNDLE_MISMATCH");
    const manifest = meta.manifest as { files: { name: string }[] };
    expect(await begin({ ...meta, manifest: { ...manifest, files: manifest.files.map((f, i) => (i === 0 ? { ...f, name: "../index.html" } : f)) } })).toBe("MANIFEST_INVALID");
    const copy = meta.copy as { files: { name: string }[] };
    expect(await begin({ ...meta, copy: { ...copy, files: copy.files.map((f, i) => (i === 0 ? { ...f, name: "copy/../../etc/passwd" } : f)) } })).toBe("COPY_INVALID");
    expect(await begin({ ...meta, validatorResult: { ...(meta.validatorResult as object), ok: false } })).toBe("VALIDATOR_NOT_OK");
    expect(await begin({ ...meta, rightsSummary: { version: 1, photos: 1, by_status: {}, earliest_expiry: null, label_required: false } })).toBe("RIGHTS_SUMMARY_MISMATCH");
    expect(await begin(`${packageJson}${" ".repeat(up.UPLOAD_LIMITS.packageJsonBytes)}`)).toBe("BODY_TOO_LARGE");
    // copy files that would not fit in one finalize request are refused up front (stricter than the package's own limit)
    const MiB = 1024 * 1024;
    const big = [
      ...copy.files.map((f) => ({ ...f, bytes: MiB })),
      { name: "copy/rounds/0/copy.json", role: "prior_copy_record", sha256: "a".repeat(64), bytes: MiB },
      { name: "copy/rounds/0/review.json", role: "prior_review", sha256: "b".repeat(64), bytes: MiB },
    ];
    expect(await begin({ ...meta, copy: { ...copy, files: big } })).toBe("COPY_TOO_LARGE_FOR_UPLOAD");
  });

  it("facts only from the facts store: none, another demo's, or a demo not derived from them → refused", async () => {
    const begin = () => code(up.beginUpload({ env: ENV, client: fakeClient(), store: memoryStore().store, prospectId: PROSPECT, packageJson }));
    S.current = [];
    expect(await begin()).toBe("FACTS_STORE_EMPTY");
    S.current = [storedRow("00000000-0000-4000-8000-0000000000d2")];
    expect(await begin()).toBe("FACTS_STORE_OTHER_DEMO");
    S.current = [storedRow(DEMO, `${JSON.stringify(JSON.parse(factsText))}\n`)];
    expect(await begin()).toBe("TRUSTED_FACTS_SHA_MISMATCH");
    S.current = [storedRow()];
    S.content = { ...(S.content as object), hours: "9:00〜18:00" };
    expect(await begin()).toBe("TRUSTED_FACTS_CONTENT_MISMATCH");
    S.demoMissing = true;
    expect(await begin()).toBe("DEMO_NOT_FOUND");
    expect(await code(up.beginUpload({ env: ENV, client: fakeClient(), store: memoryStore().store, prospectId: "not-a-uuid", packageJson }))).toBe("INVALID_INPUT");
  });
});

describe("put (staging)", () => {
  const css = new TextEncoder().encode("body{color:#123}");
  it("stages content-addressed; the same bytes replay; never overwrites", async () => {
    const m = memoryStore();
    expect(await up.stageFile({ env: ENV, store: m.store, contentType: "text/css", expectedSha256: sha(css), bytes: css })).toEqual({ sha256: sha(css), bytes: css.byteLength, replayed: false });
    expect(await up.stageFile({ env: ENV, store: m.store, contentType: "text/css; charset=utf-8", expectedSha256: sha(css), bytes: css })).toMatchObject({ replayed: true });
    expect(m.uploads).toEqual([up.stagingKey(sha(css))]);
    m.objects.set(up.stagingKey(sha(css)), new TextEncoder().encode("tampered"));
    expect(await code(up.stageFile({ env: ENV, store: m.store, contentType: "text/css", expectedSha256: sha(css), bytes: css }))).toBe("STAGED_OBJECT_DIFFERS");
  });

  it("refuses a mismatched sha256, a disallowed type, an empty or too large file, and bytes that are not their type (archives included)", async () => {
    const s = memoryStore().store;
    const put = (contentType: string, bytes: Uint8Array, expected = sha(bytes)) => code(up.stageFile({ env: ENV, store: s, contentType, expectedSha256: expected, bytes }));
    expect(await put("text/css", css, sha("other"))).toBe("HASH_MISMATCH");
    expect(await put("text/css", css, "ABC")).toBe("INVALID_INPUT");
    expect(await put("application/zip", css)).toBe("CONTENT_TYPE_NOT_ALLOWED");
    expect(await put("image/png", css)).toBe("CONTENT_TYPE_NOT_ALLOWED");
    expect(await put("application/json", css)).toBe("CONTENT_TYPE_NOT_ALLOWED");
    expect(await put("text/css", new Uint8Array(0))).toBe("FILE_TOO_LARGE");
    expect(await put("image/webp", new Uint8Array(up.UPLOAD_LIMITS.putBytes + 1))).toBe("FILE_TOO_LARGE");
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const gzip = new Uint8Array([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0xff, 0x01, 0x02]);
    for (const t of ["image/webp", "image/jpeg", "text/html", "text/css"]) {
      expect(await put(t, zip)).toBe("FILE_FORMAT_MISMATCH");
      expect(await put(t, gzip)).toBe("FILE_FORMAT_MISMATCH");
    }
    expect(await put("text/html", new Uint8Array(400 * 1024).fill(0x61))).toBe("FILE_FORMAT_MISMATCH");
  });
});

describe("finalize", () => {
  it("re-reads every staged file, runs the package checks, and imports with the facts from the store only", async () => {
    const m = memoryStore();
    await stageAll(m.store);
    const r = await up.finalizeUpload({ env: ENV, client: fakeClient(), store: m.store, prospectId: PROSPECT, packageJson, copyFiles });
    expect(r).toMatchObject({ versionId: "v-1", versionNo: 1, created: true, bundleSha256: pkg.bundleSha256, copyStatus: "checked" });
    expect(importSpy).toHaveBeenCalledTimes(1);
    const [given, o] = importSpy.mock.calls[0]!;
    expect(o).toMatchObject({ demoId: DEMO, factsFromStore: true });
    expect(o).not.toHaveProperty("trustedFactsPack");
    expect(given.bundleSha256).toBe(pkg.bundleSha256);
    expect(Object.keys(given.files).sort()).toEqual(Object.keys(pkg.files).sort());
    expect(Object.keys(given.copyFiles!).sort()).toEqual([...copyFiles.keys()].sort());
  });

  it("refuses before importing: an unstaged file, a tampered staged file, an extra or missing copy part, a changed copy file", async () => {
    const fin = (store: ReturnType<typeof memoryStore>["store"], cf: ReadonlyMap<string, Uint8Array> = copyFiles) => code(up.finalizeUpload({ env: ENV, client: fakeClient(), store, prospectId: PROSPECT, packageJson, copyFiles: cf }));
    expect(await fin(memoryStore().store)).toBe("FILE_NOT_STAGED");
    const m = memoryStore();
    await stageAll(m.store);
    // a staged object whose bytes are not its key's (written around stageFile) is caught by the re-hash
    const html = pkg.manifest.files.find((f) => f.role === "html")!;
    m.objects.set(up.stagingKey(html.sha256), new TextEncoder().encode("<!doctype html><title>x</title>"));
    expect(await fin(m.store)).toBe("FILE_CHECK_FAILED");
    const ok = memoryStore();
    await stageAll(ok.store);
    expect(await fin(ok.store, new Map([...copyFiles, ["../../package.json", new Uint8Array(1)]]))).toBe("COPY_PART_NOT_IN_MANIFEST");
    expect(await fin(ok.store, new Map([...copyFiles, ["copy/rounds/0/review.json", new Uint8Array(1)]]))).toBe("COPY_PART_NOT_IN_MANIFEST");
    const missing = new Map(copyFiles);
    missing.delete("copy/review.json");
    expect(await fin(ok.store, missing)).toBe("COPY_INVALID");
    const changed = new Map(copyFiles);
    const rec = changed.get("copy/copy.json")!;
    changed.set("copy/copy.json", new Uint8Array(rec).map((b, i) => (i === rec.length - 2 ? (b === 0x20 ? 0x0a : 0x20) : b)));
    expect(await fin(ok.store, changed)).toBe("COPY_INVALID");
    S.current = [];
    expect(await fin(ok.store)).toBe("FACTS_STORE_EMPTY");
    expect(importSpy).not.toHaveBeenCalled();
  });

  it("the copy check is the server's: a package whose copy names other facts than the store's is refused by the copy check", async () => {
    // the same package with its facts pack replaced in the copy manifest: refused on the bytes, nothing imported
    const meta = JSON.parse(packageJson) as { copy: { files: { name: string; sha256: string; bytes: number }[] } };
    const other = new TextEncoder().encode(`${JSON.stringify(JSON.parse(factsText))}\n`);
    meta.copy.files = meta.copy.files.map((f) => (f.name === "copy/facts-pack.json" ? { ...f, sha256: sha(other), bytes: other.byteLength } : f));
    const m = memoryStore();
    await stageAll(m.store);
    const err = await up.finalizeUpload({ env: ENV, client: fakeClient(), store: m.store, prospectId: PROSPECT, packageJson: JSON.stringify(meta), copyFiles: new Map([...copyFiles, ["copy/facts-pack.json", other]]) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PackageError);
    expect((err as InstanceType<typeof PackageError>).code).toBe("COPY_INVALID");
    expect(importSpy).not.toHaveBeenCalled();
  });
});

describe("the route: flags, origin, admin, then the step", () => {
  const call = async (env: Record<string, string>, headers: Record<string, string> = { origin: "http://app.test", host: "app.test" }, step = "begin") => {
    const old = { ...process.env };
    Object.assign(process.env, { SALES_DEMO_VERSIONS_ENABLED: "", SALES_DEMO_QUALITY_REVIEW_ENABLED: "" }, env);
    try {
      const { POST } = await import("@/app/admin/sales/demos/[prospectId]/import/route");
      const { NextRequest } = await import("next/server");
      const req = new NextRequest(`http://app.test/admin/sales/demos/${PROSPECT}/import?step=${step}`, { method: "POST", body: packageJson, headers: { "content-type": "application/json", ...headers } });
      return await POST(req, { params: Promise.resolve({ prospectId: PROSPECT }) } as never);
    } finally {
      process.env = old;
    }
  };
  it("preview flag off → 404; review flag off → 403; cross-site → 403; anonymous → 401; non-admin → 404; never the service client", async () => {
    expect((await call({})).status).toBe(404);
    expect((await call({ SALES_DEMO_VERSIONS_ENABLED: "true" })).status).toBe(403);
    expect(await (await call(ENV, { origin: "https://evil.example.net", host: "app.test" })).json()).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect((await call(ENV, { host: "app.test" })).status).toBe(403);
    A.state = { kind: "anonymous" };
    expect((await call(ENV)).status).toBe(401);
    A.state = { kind: "forbidden", email: null };
    expect((await call(ENV)).status).toBe(404);
    A.state = { kind: "admin", session: { userId: "u", email: null } };
    expect((await call(ENV, undefined, "unpack")).status).toBe(400);
    expect(serviceClient).not.toHaveBeenCalled();
  });
});
