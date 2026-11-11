import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_VERSIONS_BUCKET, importPackage, supabasePackageStore, type PackageStore } from "@/lib/demo-version-package/import";
import { buildPackage, type DemoVersionPackage } from "@/lib/demo-version-package/package";
import { RIN_PROSPECT_ID, seedRinShop, type FactsPack } from "@/lib/demo-version-package/seed-rin";
import { prepareSwap, readOriginals, readSwapPage } from "@/lib/demo-version-package/swap-package";
import { cleanupDirs, fixture } from "../support/rin-swap-fixture";
import { storageStatus } from "../support/seed-demo-version";
import { db, serviceClient } from "./helpers";

// DEV-196r (option C): importing SR-001「輪」 as a demo version into the LOCAL stack through the existing
// sales_ingest_demo_version (manual_import), idempotently. The database part runs in CI with an in-memory store; the
// real private bucket is used only where the storage service is running.

const RIN = "design-library/research/quality-pipeline/poc/bicycle/fidelity/d1-v9";
const pack = JSON.parse(readFileSync("design-library/research/quality-pipeline/poc/bicycle/facts-pack.json", "utf8")) as FactsPack;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const png = (width: number, height: number, c: number) => sharp({ create: { width, height, channels: 3, background: { r: c, g: 120, b: 60 } } }).png().toBuffer();

function memoryStore(): PackageStore & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async download(key) {
      return objects.get(key) ?? null;
    },
    async upload(key, bytes) {
      if (objects.has(key)) throw new Error("exists");
      objects.set(key, bytes);
    },
  };
}

let pkg: DemoVersionPackage;
let shop: { prospectId: string; demoId: string };

beforeAll(async () => {
  // the fictional 輪 shop (the seed is idempotent)
  const seeded = await seedRinShop(db, pack);
  shop = seeded;
  // a bundle unique to this run (renders differ by colour), on the real 輪 page
  const c = Math.floor(Math.random() * 200);
  pkg = await buildPackage({ html: readFileSync(`${RIN}/index.html`, "utf8"), css: readFileSync(`${RIN}/style.css`, "utf8"), renders: { desktop_1440: await png(1440, 5352, c), mobile_390: await png(390, 5586, c + 1) }, source: RIN });
});

describe("the fictional 輪 shop", () => {
  it("is seeded idempotently with SR-001's facts as the demo content", async () => {
    const again = await seedRinShop(db, pack);
    expect(again).toEqual({ ...shop, created: false });
    // DEV-196s: the fixed id
    expect(shop.prospectId).toBe(RIN_PROSPECT_ID);
    const d = (await db.query("select content, template, expires_at from public.sales_demos where id = $1", [shop.demoId])).rows[0];
    expect(d.content).toMatchObject({ name: "架空自転車修理 輪", category: "bicycle_repair", facts_pack: "fictional-bicycle-repair-wa" });
    expect(d.expires_at).toBeNull();
    // review of #255 L2: no contact at all — nothing can ever be sent to it; no outreach
    const p = (await db.query("select instagram_url, instagram_handle, public_email, recommended_channel, website_url from public.sales_prospects where id = $1", [shop.prospectId])).rows[0];
    expect(p).toEqual({ instagram_url: null, instagram_handle: null, public_email: null, recommended_channel: null, website_url: null });
    expect((await db.query("select count(*)::int as n from public.sales_outreaches where prospect_id = $1", [shop.prospectId])).rows[0].n).toBe(0);
  });
});

describe("importPackage (local stack)", () => {
  it("ingests once as manual_import, uploads and re-verifies every file; a re-run replays (no second version)", async () => {
    const store = memoryStore();
    const first = await importPackage(pkg, { client: serviceClient(), store, demoId: shop.demoId });
    expect(first.created).toBe(true);
    expect(first.files.every((f) => f.uploaded)).toBe(true);
    const v = (await db.query("select origin, status, bundle_sha256, worker_checks, generation_job_id, storage_prefix from public.sales_demo_versions where id = $1", [first.versionId])).rows[0];
    expect(v).toMatchObject({ origin: "manual_import", status: "draft", bundle_sha256: pkg.bundleSha256, generation_job_id: `manual-import-${pkg.bundleSha256.slice(0, 48)}` });
    expect(v.worker_checks.originals.desktop_1440).toMatchObject({ width: 1440, height: 5352, scaled: true });
    const files = (await db.query("select path, sha256, width, height from public.sales_demo_version_files where version_id = $1 order by path", [first.versionId])).rows;
    expect(files.find((f) => f.path === "renders/desktop_1440.webp")).toMatchObject({ width: 1102, height: 4096 });
    for (const f of pkg.manifest.files) expect(sha(store.objects.get(`${v.storage_prefix}${f.name}`)!)).toBe(f.sha256);

    const again = await importPackage(pkg, { client: serviceClient(), store, demoId: shop.demoId });
    expect(again).toMatchObject({ versionId: first.versionId, created: false });
    expect(again.files.every((f) => !f.uploaded)).toBe(true); // verified, not uploaded twice
    expect((await db.query("select count(*)::int as n from public.sales_demo_versions where demo_id = $1 and bundle_sha256 = $2", [shop.demoId, pkg.bundleSha256])).rows[0].n).toBe(1);
  });

  it("a stored object that differs from the manifest is refused (never overwritten)", async () => {
    const store = memoryStore();
    const r = await importPackage(pkg, { client: serviceClient(), store, demoId: shop.demoId });
    const v = (await db.query("select storage_prefix from public.sales_demo_versions where id = $1", [r.versionId])).rows[0];
    store.objects.set(`${v.storage_prefix}page/style.css`, new TextEncoder().encode("body{}"));
    await expect(importPackage(pkg, { client: serviceClient(), store, demoId: shop.demoId })).rejects.toThrow("STORED_OBJECT_DIFFERS");
  });

  it("the same bundle already ingested under another job (duplicate_bundle): the existing version is used", async () => {
    const other = await buildPackage({ html: readFileSync(`${RIN}/index.html`, "utf8"), css: readFileSync(`${RIN}/style.css`, "utf8"), renders: { desktop_1440: await png(1440, 1000, 7), mobile_390: await png(390, 1000, 8) }, source: RIN });
    const direct = await serviceClient().rpc("sales_ingest_demo_version", {
      p_demo_id: shop.demoId, p_generation_job_id: "another-job-for-the-same-bundle", p_parent_version_id: null, p_origin: "manual_import", p_worker_commit: null,
      p_direction_sha256: null, p_bundle_sha256: other.bundleSha256, p_manifest: other.manifest, p_images: [], p_validator_result: other.validatorResult,
      p_worker_checks: other.workerChecks, p_structure_descriptor: null, p_rights_summary: other.rightsSummary,
    });
    expect(direct.error, direct.error?.message).toBeNull();
    const r = await importPackage(other, { client: serviceClient(), store: memoryStore(), demoId: shop.demoId });
    expect(r).toMatchObject({ versionId: (direct.data as { version_id: string }).version_id, created: false });
    expect((await db.query("select count(*)::int as n from public.sales_demo_versions where bundle_sha256 = $1", [other.bundleSha256])).rows[0].n).toBe(1);
  });
});

const storage = await storageStatus();
describe("the real private bucket", () => {
  it.skipIf(!storage.available)(`uploads, re-downloads and verifies sha256 and size${storage.available ? "" : ` [skipped: ${storage.available === false ? storage.reason : ""}]`}`, async () => {
    const c = Math.floor(Math.random() * 200);
    const own = await buildPackage({ html: readFileSync(`${RIN}/index.html`, "utf8"), css: readFileSync(`${RIN}/style.css`, "utf8"), renders: { desktop_1440: await png(1440, 1100, c), mobile_390: await png(390, 1300, c + 2) }, source: RIN });
    const store = supabasePackageStore(serviceClient());
    const r = await importPackage(own, { client: serviceClient(), store, demoId: shop.demoId });
    expect(r.files.every((f) => f.uploaded)).toBe(true);
    const again = await importPackage(own, { client: serviceClient(), store, demoId: shop.demoId });
    expect(again.files.every((f) => !f.uploaded)).toBe(true);
    const prefix = `v1/${shop.demoId}/${r.versionId}/`;
    await serviceClient().storage.from(DEMO_VERSIONS_BUCKET).remove(own.manifest.files.map((f) => `${prefix}${f.name}`));
  });
});

// DEV-196s: a package with 輪's AI demo photos (synthetic fixture). The database rule that would accept these pictures for
// the fictional 輪 only is PENDING the owner's decision (the table check sales_demo_images_real_shop_no_ai_demo and the
// insert trigger's ai_demo_real_shop refuse every ai_generated_demo row today). Until then the ingest refuses it, and
// nothing is written: no image, no version, no upload.
describe("DEV-196s: 輪's AI demo photos against today's database (DB part pending the owner's decision)", () => {
  afterAll(cleanupDirs);
  it("the ingest refuses the photo package (invalid_image); no image row, no version, no upload", async () => {
    const f = await fixture();
    const p = await prepareSwap({ page: readSwapPage(f.page), rights: f.rights, depictions: f.depictions, summary: f.summary, originals: readOriginals(f.originals), forbiddenSha256: new Set(), now: "2026-11-11" });
    const c = Math.floor(Math.random() * 200);
    const photoPkg = await buildPackage({ html: p.html, css: p.css, renders: { desktop_1440: await png(1440, 900, c), mobile_390: await png(390, 844, c + 3) }, photos: p.photos, images: p.images, source: "swap-copy" });
    const store = memoryStore();
    await expect(importPackage(photoPkg, { client: serviceClient(), store, demoId: shop.demoId })).rejects.toThrow("INGEST_REFUSED: invalid_image");
    expect(store.objects.size).toBe(0);
    expect((await db.query("select count(*)::int as n from public.sales_demo_versions where bundle_sha256 = $1", [photoPkg.bundleSha256])).rows[0].n).toBe(0);
    expect((await db.query("select count(*)::int as n from public.sales_demo_images where sha256 = any($1)", [p.images.map((i) => i.sha256)])).rows[0].n).toBe(0);
  });
});
