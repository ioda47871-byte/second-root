import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PoolClient } from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyLocalHoshigamaPatch, assertNoOtherAiDemoRows, assertS0SeedRow, readHoshigamaPatchSql } from "@/lib/demo-version-package/local-hoshigama-patch";
import { readRinPatchSql } from "@/lib/demo-version-package/local-rin-patch";
import { buildPackage, type DemoVersionPackage } from "@/lib/demo-version-package/package";
import { RIN_PROSPECT_ID, seedRinShop, type FactsPack } from "@/lib/demo-version-package/seed-rin";
import { S0_FACTS_PATH, S0_PROSPECT_ID, seedS0Shop } from "@/lib/demo-version-package/seed-s0";
import { prepareSwap, readOriginals, readSwapPage } from "@/lib/demo-version-package/swap-package";
import { setLocalTestRecipients } from "../support/local-test-recipients";
import { cleanupDirs, fixture } from "../support/rin-swap-fixture";
import { createUser, db, makeAdmin, resetSalesData, setFactsCliRegistration } from "./helpers";

// DEV-139 (owner approval 2026-11-18: localhost only, the fictional test shop only, no Staging / Production): the
// LOCAL-ONLY patch for the fictional ほし窯's AI demo photos (scripts/sales/demo-version/local-hoshigama-ai-photos.sql) on
// CI's OWN throwaway local stack — never an owner's database. Every patch application happens inside a transaction that
// is rolled back, so the shared schema is restored for the other files. Proves: with the patch, the ほし窯 S0 prospect
// accepts an ai_demo_internal photo version through the real ingest, and it is not shareable (share_eligible false, no
// shareable image, versioned sharing off); without the patch, for any other prospect (a real shop, a look-alike, 輪), or
// once the S0 row loses a marker, it is refused. The photo package is a synthetic AI demo package (rin-swap-fixture's
// tiny generated pictures) — the database checks the prospect and the image records, not the page.

const REPO = resolve(__dirname, "../..");
const S0 = new Uint8Array(readFileSync(resolve(REPO, S0_FACTS_PATH)));
const RIN_PACK = JSON.parse(readFileSync(resolve(REPO, "design-library/research/quality-pipeline/poc/bicycle/facts-pack.json"), "utf8")) as FactsPack;
const png = (width: number, height: number, c: number) => sharp({ create: { width, height, channels: 3, background: { r: c, g: 90, b: 40 } } }).png().toBuffer();
const provenance = { generator: "fixture generator", model: "fixture-gen", generated_at: "2026-11-18T10:00:00+09:00", prompt_sha256: "b".repeat(64), approval_id: "fixture-approval-01", admin_preview_only: true };
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
const constraintDef = async (c: { query: PoolClient["query"] } = db) => (await c.query("select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'sales_demo_images_real_shop_no_ai_demo'")).rows[0].d as string;
const withTx = async (f: (c: PoolClient) => Promise<void>) => {
  const c = await db.connect();
  try {
    await c.query("begin");
    await f(c);
  } finally {
    await c.query("rollback");
    c.release();
  }
};

let s0DemoId: string;
let photoPkg: DemoVersionPackage;

beforeAll(async () => {
  await resetSalesData();
  await setFactsCliRegistration(false);
  // the S0 seed refuses while the test-recipient switch is on (it keeps send approval refused for the fictional shop)
  await setLocalTestRecipients(false);
  const adminId = await createUser("hoshigama-patch-admin@test.example.com");
  await makeAdmin(adminId);
  const c = await db.connect();
  try {
    const { record } = await seedS0Shop(c, { factsPack: S0, adminId });
    s0DemoId = record.rows.sales_demos[0]!;
  } finally {
    c.release();
  }
  const f = await fixture();
  const p = await prepareSwap({ page: readSwapPage(f.page), rights: f.rights, depictions: f.depictions, summary: f.summary, originals: readOriginals(f.originals), forbiddenSha256: new Set(), now: "2026-11-11" });
  const c0 = Math.floor(Math.random() * 200);
  photoPkg = await buildPackage({ html: p.html, css: p.css, renders: { desktop_1440: await png(1440, 900, c0), mobile_390: await png(390, 844, c0 + 3) }, photos: p.photos, images: p.images, source: "swap-copy" });
}, 120_000);
afterAll(async () => {
  cleanupDirs();
  await setFactsCliRegistration(false);
  await resetSalesData();
  await setLocalTestRecipients(true);
});

describe("DEV-139: ほし窯's AI demo photos with the local-only patch (applied in a rolled-back transaction)", () => {
  it("the S0 prospect takes the photo version through the real ingest only with the patch; nothing shareable; the schema is restored", async () => {
    const before = await constraintDef();
    expect(before).not.toContain(S0_PROSPECT_ID);
    expect(photoPkg.images.length).toBeGreaterThan(0);
    for (const i of photoPkg.images) expect(i).toMatchObject({ source_kind: "ai_generated_demo", rights_status: "ai_demo_internal", allowed_uses: { public_web: false } });
    await withTx(async (c) => {
      // without the patch, today's schema refuses the photo package (the shared rule)
      expect(await refused(c, () => ingest(c, photoPkg, s0DemoId))).toMatch(/invalid_image/);
      expect(await refused(c, () => insert(c, image(S0_PROSPECT_ID)))).toMatch(/ai_demo_real_shop/);
      await assertS0SeedRow(c, S0);
      await assertNoOtherAiDemoRows(c);
      await c.query(readHoshigamaPatchSql(REPO));
      expect(await constraintDef(c)).toContain(S0_PROSPECT_ID);

      // ほし窯 S0: the real ingest takes the whole photo package, as a draft, admin preview only
      const r = (await ingest(c, photoPkg, s0DemoId)).rows[0]!.r;
      expect(r.status).toBe("draft");
      const imgs = (await c.query("select i.prospect_id, i.rights_status, public.sales_demo_image_shareable(i) as shareable, public.sales_demo_image_previewable(i) as previewable from public.sales_demo_images i join public.sales_demo_version_files f on f.image_id = i.id where f.version_id = $1", [r.version_id])).rows;
      expect(imgs).toHaveLength(photoPkg.images.length);
      for (const i of imgs) expect(i).toEqual({ prospect_id: S0_PROSPECT_ID, rights_status: "ai_demo_internal", shareable: false, previewable: true });
      expect((await c.query("select share_eligible, status from public.sales_demo_versions where id = $1", [r.version_id])).rows[0]).toEqual({ share_eligible: false, status: "draft" });
      expect((await c.query("select approved_version_id from public.sales_demos where id = $1", [s0DemoId])).rows[0].approved_version_id).toBeNull();
      expect((await c.query("select public.sales_demo_versioned_sharing_enabled() as on")).rows[0].on).toBe(false);
      expect((await c.query("select count(*)::int as n from public.sales_outreach_approvals where prospect_id = $1", [S0_PROSPECT_ID])).rows[0].n).toBe(0);

      // a real shop is refused
      const real = (await c.query("insert into public.sales_prospects (name, normalized_name, address, normalized_address, category, website_status) values ('テストのパン屋', 'テストのパン屋', '愛知県名古屋市中区テスト1-1', '愛知県名古屋市中区テスト1-1', 'bakery', 'not_found') returning id")).rows[0].id as string;
      expect(await refused(c, () => insert(c, image(real)))).toMatch(/ai_demo_real_shop/);
      // a look-alike fictional prospect (an S0-like name and address, no contact) is refused: only the one id
      const lookalike = (await c.query("insert into public.sales_prospects (name, normalized_name, address, normalized_address, category, website_status) values ('架空パン店 ほし窯2', '架空ぱん店ほし窯2', '名古屋市瑞穂区架空町四丁目2-7', '愛知県名古屋市瑞穂区架空町4-2-7', 'bakery', 'not_found') returning id")).rows[0].id as string;
      expect(await refused(c, () => insert(c, image(lookalike)))).toMatch(/ai_demo_real_shop/);
      // 輪's id is refused too: this patch is S0-only (it replaces 輪's local patch)
      expect(await refused(c, () => insert(c, image(RIN_PROSPECT_ID)))).toMatch(/ai_demo_real_shop/);

      // the S0 row, once it loses a marker, is refused (each in its own savepoint, so the row is restored after)
      const markerChanges: Array<[string, string, unknown[]]> = [
        ["an email off the example domain", "update public.sales_prospects set public_email = 'info@s0-bakery.example.org' where id = $1", [S0_PROSPECT_ID]],
        ["a website off the example domain", "update public.sales_prospects set website_url = 'https://s0-bakery.example.net/', website_domain = 's0-bakery.example.net' where id = $1", [S0_PROSPECT_ID]],
        ["an Instagram account", "update public.sales_prospects set instagram_url = 'https://www.instagram.com/s0_bakery_test/', instagram_handle = 's0_bakery_test' where id = $1", [S0_PROSPECT_ID]],
        ["another name", "update public.sales_prospects set name = '架空パン店 ほし窯（改）' where id = $1", [S0_PROSPECT_ID]],
        ["another address", "update public.sales_prospects set address = '名古屋市瑞穂区架空町四丁目2-8', normalized_address = '愛知県名古屋市瑞穂区架空町4-2-8' where id = $1", [S0_PROSPECT_ID]],
        ["a source off the example domain", "insert into public.sales_sources (prospect_id, field, value, source_url, source_type, verified_at) values ($1, 'phone', '052-000-0000', 'https://maps.example.org/x', 'map_listing', now())", [S0_PROSPECT_ID]],
      ];
      for (const [label, sql, params] of markerChanges) {
        const msg = await refused(c, async () => {
          await c.query(sql, params);
          await insert(c, image(S0_PROSPECT_ID));
        });
        expect(msg, label).toMatch(/ai_demo_real_shop/);
      }
      // the apply command's own guard says the same, and refuses while another prospect's AI demo row exists
      await c.query("savepoint m");
      await c.query("update public.sales_prospects set public_email = 'info@s0-bakery.example.org' where id = $1", [S0_PROSPECT_ID]);
      await expect(assertS0SeedRow(c, S0)).rejects.toThrow("S0_SEED_MARKERS");
      await c.query("rollback to savepoint m");
      await assertS0SeedRow(c, S0);

      // ai_demo_internal on another source kind is refused, even for S0
      expect(await refused(c, () => insert(c, image(S0_PROSPECT_ID, { source_kind: "owner_provided" })))).toMatch(/ai_demo_real_shop/);
      // each derivation branch (S0)
      const status = async (o: Record<string, unknown>) => (await insert(c, image(S0_PROSPECT_ID, o))).rows[0]!.rights_status;
      expect(await status({})).toBe("ai_demo_internal");
      expect(await status({ rights_status: "unknown" })).toBe("unknown");
      for (const k of ["depicts_real_shop", "depicts_identifiable_person", "depicts_real_product", "depicts_real_interior", "depicts_real_equipment"]) expect(await status({ [k]: true }), k).toBe("unknown");
      expect(await status({ provenance: null })).toBe("unknown");
      expect(await status({ allowed_uses: JSON.stringify({ edit: true, crop: true, commercial: true, public_web: true }) })).toBe("unknown");
      // immutability still holds
      const one = (await insert(c, image(S0_PROSPECT_ID))).rows[0]!;
      expect(await refused(c, () => c.query("update public.sales_demo_images set width = 11 where id = $1", [one.id]))).toMatch(/demo_image_immutable/);
      expect(await refused(c, () => c.query("update public.sales_demo_images set rights_status = 'share_cleared' where id = $1", [one.id]))).toMatch(/demo_image_rights_upgrade_forbidden|sales_demo_images_/);
    });
    // rolled back: the shared schema and the data are as before
    expect(await constraintDef()).toBe(before);
    expect((await db.query("select count(*)::int as n from public.sales_demo_versions where bundle_sha256 = $1", [photoPkg.bundleSha256])).rows[0].n).toBe(0);
    expect((await db.query("select count(*)::int as n from public.sales_demo_images where prospect_id = $1", [S0_PROSPECT_ID])).rows[0].n).toBe(0);
  }, 120_000);

  it("the apply step refuses while another prospect's AI demo picture exists (輪's, after 輪's patch), writing nothing", async () => {
    await seedRinShop(db, RIN_PACK);
    await withTx(async (c) => {
      await c.query(readRinPatchSql(REPO));
      await insert(c, image(RIN_PROSPECT_ID));
      await expect(assertNoOtherAiDemoRows(c)).rejects.toThrow("OTHER_AI_DEMO_ROWS_PRESENT");
      // applyLocalHoshigamaPatch opens its own transaction; inside this one a savepoint shows the check itself refuses too
      await c.query("savepoint h");
      await expect(c.query(readHoshigamaPatchSql(REPO))).rejects.toThrow(/sales_demo_images_real_shop_no_ai_demo|violated/);
      await c.query("rollback to savepoint h");
      expect(await constraintDef(c)).toContain(RIN_PROSPECT_ID);
    });
    expect(await constraintDef()).not.toContain(RIN_PROSPECT_ID);
  }, 60_000);

  it("applyLocalHoshigamaPatch (the command's transaction) refuses another shop's facts and leaves the schema unchanged", async () => {
    const before = await constraintDef();
    const c = await db.connect();
    try {
      // the S0 seed's facts are required: another pack is not the S0 shop
      await expect(applyLocalHoshigamaPatch(c, new TextEncoder().encode(JSON.stringify(RIN_PACK)), readHoshigamaPatchSql(REPO))).rejects.toThrow("S0_FACTS_NOT_S0_SHOP");
    } finally {
      c.release();
    }
    expect(await constraintDef()).toBe(before);
  });
});
