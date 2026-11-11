import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { demoFrameNotFound, serveDemoFrame, type FrameRequest } from "@/lib/demo-frame/serve";
import { supabaseFrameStore } from "@/lib/demo-frame/store";
import { signViewToken } from "@/lib/sales/demo-version/view-token";
import { DEMO_VERSIONS_BUCKET, seedDemoVersion, storageStatus, type SeededVersion } from "../support/seed-demo-version";
import { createUser, db, makeAdmin, serviceClient, signedInClient } from "./helpers";

// DEV-196d-2 (spec §6.4): the admin artifact route's decisions against the LOCAL Supabase stack (database + private
// bucket), with the flag on only inside this test process. Fictional shops and example.com only.
//
// The database checks (revoked, rights, flag off) run everywhere. The checks that read objects need the storage API,
// which CI does not start (`-x storage-api`); they skip there and run on a local stack with storage.

const KEY = randomBytes(32);
const ENV = { SALES_DEMO_VERSIONS_ENABLED: "true", SALES_DEMO_VIEW_SIGNING_KEY: KEY.toString("base64url") };
const ORIGIN = "http://127.0.0.1:3100";
const DEST: Record<string, string> = { "index.html": "iframe", "style.css": "style", "photos/hero-desktop.webp": "image", "renders/desktop_1440.webp": "image", "renders/mobile_390.webp": "image" };
const NAME: Record<string, string> = {
  "index.html": "page/index.html",
  "style.css": "page/style.css",
  "photos/hero-desktop.webp": "page/photos/hero-desktop.webp",
  "renders/desktop_1440.webp": "renders/desktop_1440.webp",
  "renders/mobile_390.webp": "renders/mobile_390.webp",
};

const svc = serviceClient();
const storage = await storageStatus();
const storageUp = storage.available;
// Skipped ONLY when the storage service is not running (CI: `-x storage-api`); any other storage error fails the file.
const STORAGE_SKIP = storage.available ? "" : ` [skipped: ${storage.reason}]`;
let admin: SupabaseClient;
const prospects: string[] = [];

async function seed(): Promise<SeededVersion> {
  const s = await seedDemoVersion(db, svc);
  prospects.push(s.prospectId);
  return s;
}

function req(s: SeededVersion, urlPath: string, over: Partial<FrameRequest> = {}): FrameRequest {
  const token = signViewToken({ scope: "a", versionId: s.versionId, demoId: s.demoId, now: new Date(), key: KEY });
  return { method: "GET", pathname: `/demo-frame/a/${token}/${urlPath}`, search: "", origin: ORIGIN, secFetchDest: DEST[urlPath] ?? null, ...over };
}

const serve = (r: FrameRequest, env: Record<string, string | undefined> = ENV) => serveDemoFrame(r, { env, now: new Date(), store: () => supabaseFrameStore(svc) });

/**
 * The real database reads with the object read replaced IN THIS TEST by the seeded bytes (review of #247 L1): the
 * revocation, rights and disabled-demo checks then run against the database in CI too, where there is no storage API
 * — a 200 first proves the 404 afterwards comes from the database check, not from a missing object.
 */
const serveDbOnly = (s: SeededVersion, r: FrameRequest) =>
  serveDemoFrame(r, {
    env: ENV,
    now: new Date(),
    store: () => ({ ...supabaseFrameStore(svc), object: async (key: string) => (key.startsWith(s.prefix) ? s.objects[key.slice(s.prefix.length)] ?? null : null) }),
  });
const NOT_FOUND = [...demoFrameNotFound().headers.entries()].sort();

async function expect404(res: Response, label = "") {
  expect(res.status, label).toBe(404);
  expect([...res.headers.entries()].sort(), label).toEqual(NOT_FOUND);
  expect(await res.text(), label).toBe("Not Found");
}

beforeAll(async () => {
  const email = `demo-frame-admin-${randomBytes(4).toString("hex")}@test.example.com`;
  const id = await createUser(email);
  await makeAdmin(id);
  admin = await signedInClient(email);
});
afterAll(async () => {
  if (prospects.length) {
    // versions and their rows are kept by the database's own rules (restrict); only clear this file's prospects' objects
    if (storageUp) {
      const { rows } = await db.query("select storage_prefix from public.sales_demo_versions v join public.sales_demos d on d.id = v.demo_id where d.prospect_id = any($1::uuid[])", [prospects]);
      for (const r of rows) {
        const names = Object.values(NAME).map((n) => `${r.storage_prefix}${n}`);
        await svc.storage.from(DEMO_VERSIONS_BUCKET).remove(names);
      }
    }
  }
});

describe("the store reads only what the route needs (service role)", () => {
  it("reads the version, its files and the photo's rights row", async () => {
    const s = await seed();
    const store = supabaseFrameStore(svc);
    expect(await store.version(s.versionId)).toMatchObject({ id: s.versionId, demo_id: s.demoId, status: "draft", revoked_at: null, storage_prefix: s.prefix });
    expect((await store.files(s.versionId)).map((f) => f.path).sort()).toEqual(Object.keys(s.objects).sort());
    expect(await store.images([s.imageId])).toEqual([expect.objectContaining({ id: s.imageId, rights_status: "owner_provided_internal", revoked_at: null })]);
    expect(await store.demo(s.demoId)).toEqual({ id: s.demoId, disabled_at: null });
    expect(await store.version("00000000-0000-4000-8000-000000000000")).toBeNull();
    expect(await store.images([])).toEqual([]);
  });
});

describe("serveDemoFrame against the local stack", () => {
  it("flag off: the same 404 for a valid token on a real version", async () => {
    const s = await seed();
    for (const flag of [undefined, "false", "TRUE"]) await expect404(await serve(req(s, "index.html"), { ...ENV, SALES_DEMO_VERSIONS_ENABLED: flag }), String(flag));
  });

  it.skipIf(!storageUp)(`serves every file of a draft version, byte for byte, from the private bucket${STORAGE_SKIP}`, async () => {
    const s = await seed();
    expect(s.uploaded).toBe(true);
    for (const urlPath of Object.keys(DEST)) {
      const res = await serve(req(s, urlPath));
      expect(res.status, urlPath).toBe(200);
      expect(new Uint8Array(await res.arrayBuffer()), urlPath).toEqual(s.objects[NAME[urlPath]!]);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("x-frame-options")).toBeNull();
    }
  });

  it("a revoked version: served before, 404 for every file from the next request on (database check, runs in CI)", async () => {
    const s = await seed();
    for (const urlPath of Object.keys(DEST)) expect((await serveDbOnly(s, req(s, urlPath))).status, urlPath).toBe(200);
    const r = await admin.rpc("sales_revoke_demo_version", { p_version_id: s.versionId, p_code: "QUALITY_PROBLEM" });
    expect(r.error, r.error?.message).toBeNull();
    for (const urlPath of Object.keys(DEST)) await expect404(await serveDbOnly(s, req(s, urlPath)), urlPath);
  });

  it("revoking the version's photo: served before, then every file of the version is 404 (rights fail closed, runs in CI)", async () => {
    const s = await seed();
    for (const urlPath of Object.keys(DEST)) expect((await serveDbOnly(s, req(s, urlPath))).status, urlPath).toBe(200);
    const r = await admin.rpc("sales_revoke_demo_image", { p_image_id: s.imageId, p_code: "RIGHTS_COMPLAINT" });
    expect(r.error, r.error?.message).toBeNull();
    for (const urlPath of Object.keys(DEST)) await expect404(await serveDbOnly(s, req(s, urlPath)), urlPath);
  });

  it("review round 1 L3: a disabled demo (admin or DNC) is 404 in the admin preview too (runs in CI)", async () => {
    const s = await seed();
    expect((await serveDbOnly(s, req(s, "index.html"))).status).toBe(200);
    await db.query("update public.sales_demos set disabled_at = now() where id = $1", [s.demoId]);
    for (const urlPath of Object.keys(DEST)) await expect404(await serveDbOnly(s, req(s, urlPath)), urlPath);
  });

  it.skipIf(!storageUp)(`an object replaced or removed in the bucket is 404 (the bytes are checked against the manifest)${STORAGE_SKIP}`, async () => {
    const s = await seed();
    const bucket = svc.storage.from(DEMO_VERSIONS_BUCKET);
    const html = s.objects["page/index.html"]!;
    const swapped = new TextEncoder().encode("<!doctype html><script>alert(1)</script>".padEnd(html.byteLength, " "));
    expect((await bucket.upload(`${s.prefix}page/index.html`, swapped, { contentType: "text/html", upsert: true })).error).toBeNull();
    await expect404(await serve(req(s, "index.html")), "swapped");
    expect((await bucket.remove([`${s.prefix}page/style.css`])).error).toBeNull();
    await expect404(await serve(req(s, "style.css")), "removed");
    // the untouched files are still served
    expect((await serve(req(s, "photos/hero-desktop.webp"))).status).toBe(200);
  });

  it("a token for one version never reaches another version's files", async () => {
    const a = await seed();
    const b = await seed();
    const mixed = signViewToken({ scope: "a", versionId: b.versionId, demoId: a.demoId, now: new Date(), key: KEY });
    expect((await serveDbOnly(a, req(a, "index.html"))).status).toBe(200);
    await expect404(await serveDbOnly(a, { ...req(a, "index.html"), pathname: `/demo-frame/a/${mixed}/index.html` }));
  });
});
