import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_VERSIONS_BUCKET, importPackage, supabasePackageStore, type PackageStore } from "@/lib/demo-version-package/import";
import { buildPackage, type DemoVersionPackage } from "@/lib/demo-version-package/package";
import { assertRinSeedRow, readRinPatchSql } from "@/lib/demo-version-package/local-rin-patch";
import { RIN_PROSPECT_ID, RIN_REGISTRY_ADDRESS, seedRinShop, type FactsPack } from "@/lib/demo-version-package/seed-rin";
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

  it("DEV-196q: structure findings are checked before anything is written, then stored with the version (replay on re-run)", async () => {
    const fresh = await buildPackage({ html: readFileSync(`${RIN}/index.html`, "utf8"), css: readFileSync(`${RIN}/style.css`, "utf8"), renders: { desktop_1440: await png(1440, 1200, 11), mobile_390: await png(390, 1200, 12) }, source: RIN });
    const store = memoryStore();
    await expect(importPackage(fresh, { client: serviceClient(), store, demoId: shop.demoId, structureFindings: { source: "observation_report", findings: [{ code: "PASS" }], siblingsCompared: 0 } })).rejects.toThrow("STRUCTURE_FINDINGS_INVALID");
    expect((await db.query("select count(*)::int as n from public.sales_demo_versions where bundle_sha256 = $1", [fresh.bundleSha256])).rows[0].n).toBe(0);
    expect(store.objects.size).toBe(0);
    const findings = { source: "observation_report", findings: [{ code: "ASPECTS_UNKNOWN", aspects: ["transitions"] }], siblingsCompared: 0 };
    const r = await importPackage(fresh, { client: serviceClient(), store, demoId: shop.demoId, structureFindings: findings });
    const row = (await db.query("select findings, source, siblings_compared from public.sales_demo_structure_findings where version_id = $1", [r.versionId])).rows[0];
    expect(row).toEqual({ findings: findings.findings, source: "observation_report", siblings_compared: 0 });
    await expect(importPackage(fresh, { client: serviceClient(), store, demoId: shop.demoId, structureFindings: findings })).resolves.toMatchObject({ versionId: r.versionId, created: false });
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

// DEV-196s (owner decision 2026-11-12): 輪's AI demo photos with the LOCAL-ONLY patch
// (scripts/sales/demo-version/local-rin-ai-photos.sql). The patch is applied inside a transaction that is always
// ROLLED BACK, so the shared schema never changes (the existing tests that pin today's refusal keep passing). Inside:
// the real ingest takes 輪's photo package; a real shop and a fictional-looking other prospect are refused; each
// derivation branch; nothing is shareable; immutability and revocation still hold.
describe("DEV-196s: 輪's AI demo photos with the local-only patch (applied in a rolled-back transaction)", () => {
  afterAll(cleanupDirs);
  const provenance = { generator: "fixture generator", model: "fixture-gen", generated_at: "2026-11-06T20:10:51+09:00", prompt_sha256: "a".repeat(64), approval_id: "fixture-approval-01", admin_preview_only: true };
  const image = (prospectId: string, o: Record<string, unknown> = {}) => ({
    prospect_id: prospectId, sha256: randomBytes(32).toString("hex"), bytes: 100, width: 10, height: 10, format: "webp", record_schema: "photo_rights_v0",
    source_kind: "ai_generated_demo", rights_status: "ai_demo_internal", depicts_real_shop: false, depicts_identifiable_person: false, depicts_real_product: false,
    depicts_real_interior: false, depicts_real_equipment: false, allowed_uses: JSON.stringify({ edit: true, crop: true, commercial: true, public_web: false }),
    rights_expiry: null, provenance: JSON.stringify(provenance), ...o,
  });
  const insert = (c: PoolClient, row: Record<string, unknown>) => {
    const keys = Object.keys(row);
    return c.query<{ id: string; rights_status: string }>(`insert into public.sales_demo_images (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning id, rights_status`, keys.map((k) => row[k]));
  };
  /** runs f in a savepoint; returns the error message (the transaction goes on) or throws when nothing was refused */
  const refused = async (c: PoolClient, f: () => Promise<unknown>): Promise<string> => {
    await c.query("savepoint s");
    try {
      await f();
    } catch (e) {
      await c.query("rollback to savepoint s");
      return (e as Error).message;
    }
    await c.query("release savepoint s");
    throw new Error("not refused");
  };
  const ingest = (c: PoolClient, pkg: DemoVersionPackage, demoId: string) =>
    c.query<{ r: { version_id: string; status: string } }>(
      "select public.sales_ingest_demo_version($1::uuid, $2, null, 'manual_import', null, null, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, null, $8::jsonb) as r",
      [demoId, `manual-import-${pkg.bundleSha256.slice(0, 48)}`, pkg.bundleSha256, JSON.stringify(pkg.manifest), JSON.stringify(pkg.images), JSON.stringify(pkg.validatorResult), JSON.stringify(pkg.workerChecks), JSON.stringify(pkg.rightsSummary)],
    );
  const constraintDef = async () => (await db.query("select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'sales_demo_images_real_shop_no_ai_demo'")).rows[0].d as string;

  it("輪 is accepted through the real ingest; others are refused; each branch; nothing shareable; the schema is restored", async () => {
    const f = await fixture();
    const p = await prepareSwap({ page: readSwapPage(f.page), rights: f.rights, depictions: f.depictions, summary: f.summary, originals: readOriginals(f.originals), forbiddenSha256: new Set(), now: "2026-11-11" });
    const c0 = Math.floor(Math.random() * 200);
    const photoPkg = await buildPackage({ html: p.html, css: p.css, renders: { desktop_1440: await png(1440, 900, c0), mobile_390: await png(390, 844, c0 + 3) }, photos: p.photos, images: p.images, source: "swap-copy" });
    const before = await constraintDef();
    expect(before).not.toContain(RIN_PROSPECT_ID);

    const c = await db.connect();
    try {
      await c.query("begin");
      // without the patch, today's schema refuses the photo package (the shared rule)
      expect(await refused(c, () => ingest(c, photoPkg, shop.demoId))).toMatch(/invalid_image/);
      await assertRinSeedRow(c, pack);
      await c.query(readRinPatchSql(process.cwd()));
      // inside this transaction the check is row-local (another connection would wait on the table lock until rollback)
      expect((await c.query("select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'sales_demo_images_real_shop_no_ai_demo'")).rows[0].d).toContain(RIN_PROSPECT_ID);

      // 輪: the real ingest takes the whole photo package
      const r = (await ingest(c, photoPkg, shop.demoId)).rows[0]!.r;
      expect(r.status).toBe("draft");
      const imgs = (await c.query("select i.rights_status, public.sales_demo_image_shareable(i) as shareable, public.sales_demo_image_previewable(i) as previewable from public.sales_demo_images i join public.sales_demo_version_files f on f.image_id = i.id where f.version_id = $1", [r.version_id])).rows;
      expect(imgs).toHaveLength(15);
      for (const i of imgs) expect(i).toEqual({ rights_status: "ai_demo_internal", shareable: false, previewable: true });
      const v = (await c.query("select share_eligible, status from public.sales_demo_versions where id = $1", [r.version_id])).rows[0];
      expect(v).toEqual({ share_eligible: false, status: "draft" });
      expect((await c.query("select public.sales_demo_versioned_sharing_enabled() as on")).rows[0].on).toBe(false);

      // a real shop is refused
      const real = (await c.query("insert into public.sales_prospects (name, normalized_name, address, normalized_address, category, website_status) values ('テストのパン屋', 'テストのパン屋', '愛知県名古屋市中区テスト1-1', '愛知県名古屋市中区テスト1-1', 'bakery', 'not_found') returning id")).rows[0].id as string;
      expect(await refused(c, () => insert(c, image(real)))).toMatch(/ai_demo_real_shop/);
      // another fictional-looking prospect (no contact, a 輪-like name) is refused: only the one id
      const lookalike = (await c.query("insert into public.sales_prospects (name, normalized_name, address, normalized_address, category, website_status) values ('架空自転車修理 輪2', '架空自転車修理 輪2', $1, $1, 'bakery', 'not_found') returning id", [`${RIN_REGISTRY_ADDRESS}2`])).rows[0].id as string;
      expect(await refused(c, () => insert(c, image(lookalike)))).toMatch(/ai_demo_real_shop/);
      // 輪 itself, once its row loses a marker (a contact channel), is refused
      expect(
        await refused(c, async () => {
          await c.query("update public.sales_prospects set public_email = 'rin@test.example.com' where id = $1", [RIN_PROSPECT_ID]);
          await insert(c, image(RIN_PROSPECT_ID));
        }),
      ).toMatch(/ai_demo_real_shop/);
      // ai_demo_internal on another source kind is refused, even for 輪
      expect(await refused(c, () => insert(c, image(RIN_PROSPECT_ID, { source_kind: "owner_provided" })))).toMatch(/ai_demo_real_shop/);

      // each derivation branch (輪)
      const status = async (o: Record<string, unknown>) => (await insert(c, image(RIN_PROSPECT_ID, o))).rows[0]!.rights_status;
      expect(await status({})).toBe("ai_demo_internal");
      expect(await status({ rights_status: "unknown" })).toBe("unknown");
      for (const k of ["depicts_real_shop", "depicts_identifiable_person", "depicts_real_product", "depicts_real_interior", "depicts_real_equipment"]) expect(await status({ [k]: true }), k).toBe("unknown");
      expect(await status({ provenance: JSON.stringify({ ...provenance, model: "unknown" }) })).toBe("unknown");
      expect(await status({ provenance: null })).toBe("unknown");
      expect(await status({ allowed_uses: JSON.stringify({ edit: true, crop: true, commercial: true, public_web: true }) })).toBe("unknown");
      expect(await status({ rights_expiry: "2020-01-01" })).toBe("expired");

      // immutability and revocation still hold
      const one = (await insert(c, image(RIN_PROSPECT_ID))).rows[0]!;
      expect(await refused(c, () => c.query("update public.sales_demo_images set width = 11 where id = $1", [one.id]))).toMatch(/demo_image_immutable/);
      expect(await refused(c, () => c.query("update public.sales_demo_images set rights_status = 'share_cleared' where id = $1", [one.id]))).toMatch(/demo_image_rights_upgrade_forbidden|sales_demo_images_/);
      await c.query("update public.sales_demo_images set rights_status = 'revoked', revoked_at = now(), revoke_code = 'TEST_REVOKE' where id = $1", [one.id]);
      expect(await refused(c, () => c.query("update public.sales_demo_images set revoke_code = 'OTHER_CODE' where id = $1", [one.id]))).toMatch(/demo_image_revoked_final/);
      expect((await c.query("select public.sales_demo_image_shareable(i) as s from public.sales_demo_images i where id = $1", [one.id])).rows[0].s).toBe(false);
    } finally {
      await c.query("rollback");
      c.release();
    }
    // rolled back: the shared schema and the data are as before
    expect(await constraintDef()).toBe(before);
    expect((await db.query("select count(*)::int as n from public.sales_demo_versions where bundle_sha256 = $1", [photoPkg.bundleSha256])).rows[0].n).toBe(0);
    expect((await db.query("select public_email from public.sales_prospects where id = $1", [RIN_PROSPECT_ID])).rows[0].public_email).toBeNull();
  }, 120_000);
});

describe("DEV-196s: the local patch's command refuses a 輪 row without its markers", () => {
  it("RIN_SEED_MARKERS once the row has a contact channel (checked in a rolled-back transaction)", async () => {
    const c = await db.connect();
    try {
      await c.query("begin");
      await assertRinSeedRow(c, pack);
      await c.query("update public.sales_prospects set public_email = 'rin@test.example.com' where id = $1", [RIN_PROSPECT_ID]);
      await expect(assertRinSeedRow(c, pack)).rejects.toThrow("RIN_SEED_MARKERS");
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});
