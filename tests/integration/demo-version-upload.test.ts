import { join, resolve } from "node:path";
import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { beginUpload, finalizeUpload, stageFile, stagingKey, supabaseStagingStore, uploadErrorCode, type StagingStore } from "@/lib/admin/demo-version-upload";
import { supabasePackageStore, type PackageStore } from "@/lib/demo-version-package/import";
import { compCopyInput, readCommittedFacts } from "@/lib/demo-version-package/local-inputs";
import { buildPackage, type DemoVersionPackage } from "@/lib/demo-version-package/package";
import { SENDABLE_FACTS_PATH, SENDABLE_PAGE_DIR, SENDABLE_PROSPECT_ID, seedSendableShop } from "@/lib/demo-version-package/seed-sendable";
import { registerFactsPackAsAdmin } from "@/lib/sales/facts-store";
import { createUser, db, makeAdmin, resetSalesData, serviceClient, serviceRoleKey, signedInClient, supabaseUrl } from "./helpers";

// DEV-263i (Issue #263): 版を取り込む on the LOCAL stack — begin / put / finalize with the facts the owner registered in
// the facts store, the version visible to the admin, the copy gate waiting on the owner, the replay, and an unfinished
// upload never becoming a version. The fictional 環 only (example.com); no network, no model, nothing sent.
// With the local Storage API the private bucket itself is used; without it (CI: `-x storage-api`) an in-memory bucket.

const REPO = resolve(__dirname, "../..");
const ENV = { SALES_DEMO_VERSIONS_ENABLED: "true", SALES_DEMO_QUALITY_REVIEW_ENABLED: "true" };
const storageUp = await fetch(`${supabaseUrl}/storage/v1/bucket`, { headers: { Authorization: `Bearer ${serviceRoleKey}`, apikey: serviceRoleKey } })
  .then((r) => r.ok)
  .catch(() => false);

function memoryStore(): StagingStore {
  const objects = new Map<string, Uint8Array>();
  const base: PackageStore = {
    download: async (k) => objects.get(k) ?? null,
    upload: async (k, b) => {
      if (objects.has(k)) throw new Error("exists");
      objects.set(k, b);
    },
  };
  return { ...base, exists: async (k) => objects.has(k) };
}
const storeOf = (c: SupabaseClient): StagingStore => (storageUp ? supabaseStagingStore(c, supabasePackageStore(c)) : memoryStore());

const png = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: { r: Math.floor(Math.random() * 255), g: 90, b: 140 } } }).png().toBuffer();
async function upload(): Promise<{ pkg: DemoVersionPackage; packageJson: string; copyFiles: Map<string, Uint8Array> }> {
  const c = compCopyInput(join(REPO, SENDABLE_PAGE_DIR), join(REPO, SENDABLE_FACTS_PATH));
  const pkg = await buildPackage({ html: c.html, css: c.css, renders: { desktop_1440: new Uint8Array(await png(1440, 900)), mobile_390: new Uint8Array(await png(390, 900)) }, source: "test", copy: c.copy });
  const { files, copyFiles: cf, ...meta } = pkg;
  void files;
  return { pkg, packageJson: `${JSON.stringify(meta, null, 2)}\n`, copyFiles: new Map(Object.entries(cf!)) };
}
const versions = async (demoId: string) => (await db.query("select id, version_no, origin, status from public.sales_demo_versions where demo_id = $1 order by version_no", [demoId])).rows;
const errCode = (p: Promise<unknown>) => p.then(() => "no error", (e: unknown) => uploadErrorCode(e) ?? String(e));

let admin: SupabaseClient;
let demoId: string;
beforeEach(async () => {
  // resetSalesData clears the admins and the test users: a fresh owner each test
  await resetSalesData();
  await makeAdmin(await createUser("version-upload-admin@test.example.com"));
  admin = await signedInClient("version-upload-admin@test.example.com");
  const c = await db.connect();
  try {
    demoId = (await seedSendableShop(c, readCommittedFacts(REPO, SENDABLE_FACTS_PATH, { requireBase: false }))).demoId;
  } finally {
    c.release();
  }
});
afterAll(resetSalesData);

describe("版を取り込む (begin / put / finalize)", () => {
  it("needs the owner's registered facts; then the version is a draft the admin sees, and the copy gate waits on the owner", async () => {
    const svc = serviceClient();
    const store = storeOf(svc);
    const u = await upload();
    // no registered facts → refused at begin and at finalize, nothing written
    expect(await errCode(beginUpload({ env: ENV, client: svc, store, prospectId: SENDABLE_PROSPECT_ID, packageJson: u.packageJson }))).toBe("FACTS_STORE_EMPTY");
    // the owner registers the facts pack on the admin screen (own session)
    await registerFactsPackAsAdmin(admin as never, { demoId, factsPack: new TextDecoder().decode(readCommittedFacts(REPO, SENDABLE_FACTS_PATH, { requireBase: false })) });

    const begin = await beginUpload({ env: ENV, client: svc, store, prospectId: SENDABLE_PROSPECT_ID, packageJson: u.packageJson });
    expect(begin.demoId).toBe(demoId);
    const todo = begin.pageFiles.filter((f) => !f.staged);
    expect(todo.length).toBeGreaterThanOrEqual(2);
    for (const f of todo) expect(await stageFile({ env: ENV, store, contentType: f.contentType, expectedSha256: f.sha256, bytes: u.pkg.files[f.name]! })).toMatchObject({ sha256: f.sha256 });
    expect(await versions(demoId)).toEqual([]);

    const r = await finalizeUpload({ env: ENV, client: svc, store, prospectId: SENDABLE_PROSPECT_ID, packageJson: u.packageJson, copyFiles: u.copyFiles });
    expect(r).toMatchObject({ versionNo: 1, created: true, bundleSha256: u.pkg.bundleSha256, copyStatus: "checked", files: u.pkg.manifest.files.length });
    expect(await versions(demoId)).toEqual([{ id: r.versionId, version_no: 1, origin: "manual_import", status: "draft" }]);
    // the admin sees the version through their own session (RLS), never approved by the import
    const seen = await admin.from("sales_demo_versions").select("id, version_no").eq("demo_id", demoId);
    expect(seen.error).toBeNull();
    expect(seen.data).toEqual([{ id: r.versionId, version_no: 1 }]);
    expect((await db.query("select approved_version_id from public.sales_demos where id = $1", [demoId])).rows[0].approved_version_id).toBeNull();
    expect((await db.query("select count(*)::int as n from public.sales_demo_quality_reviews")).rows[0].n).toBe(0);
    // the copy review is stored from the facts path and the send gate waits on the owner's confirmation
    const q = (await db.query("select count(c.review_id)::int as n from public.sales_demo_version_copy_links l left join public.sales_demo_copy_facts_checks c on c.review_id = l.review_id where l.version_id = $1", [r.versionId])).rows;
    expect(q).toEqual([{ n: 1 }]);
    expect((await db.query("select public.sales_copy_send_block($1) as c", [r.versionId])).rows[0].c).toBe("demo_copy_owner_confirmation_missing");
    // every file is in the private bucket at the version's prefix, byte for byte
    for (const f of u.pkg.manifest.files) {
      const b = await store.download(`v1/${demoId}/${r.versionId}/${f.name}`);
      expect(b && Buffer.from(b).equals(Buffer.from(u.pkg.files[f.name]!))).toBe(true);
    }

    // a replay (the same package again) is the same version; staged files say so at begin
    expect((await beginUpload({ env: ENV, client: svc, store, prospectId: SENDABLE_PROSPECT_ID, packageJson: u.packageJson })).pageFiles.every((f) => f.staged)).toBe(true);
    expect(await finalizeUpload({ env: ENV, client: svc, store, prospectId: SENDABLE_PROSPECT_ID, packageJson: u.packageJson, copyFiles: u.copyFiles })).toMatchObject({ versionId: r.versionId, created: false });
    expect((await versions(demoId)).length).toBe(1);
  });

  it("an unfinished upload never becomes a version; finishing it later does", async () => {
    const svc = serviceClient();
    const store = storeOf(svc);
    await registerFactsPackAsAdmin(admin as never, { demoId, factsPack: new TextDecoder().decode(readCommittedFacts(REPO, SENDABLE_FACTS_PATH, { requireBase: false })) });
    const u = await upload();
    const render = u.pkg.manifest.files.find((f) => f.role === "render")!;
    for (const f of u.pkg.manifest.files) if (f.name !== render.name) await stageFile({ env: ENV, store, contentType: f.content_type, expectedSha256: f.sha256, bytes: u.pkg.files[f.name]! });
    expect(await errCode(finalizeUpload({ env: ENV, client: svc, store, prospectId: SENDABLE_PROSPECT_ID, packageJson: u.packageJson, copyFiles: u.copyFiles }))).toBe("FILE_NOT_STAGED");
    expect(await versions(demoId)).toEqual([]);
    expect((await db.query("select count(*)::int as n from public.sales_demo_copy_reviews")).rows[0].n).toBe(0);
    expect(await store.exists(stagingKey(render.sha256))).toBe(false);
    await stageFile({ env: ENV, store, contentType: render.content_type, expectedSha256: render.sha256, bytes: u.pkg.files[render.name]! });
    expect(await finalizeUpload({ env: ENV, client: svc, store, prospectId: SENDABLE_PROSPECT_ID, packageJson: u.packageJson, copyFiles: u.copyFiles })).toMatchObject({ versionNo: 1, created: true });
  });

  it.skipIf(!storageUp)("staging is the private bucket: a signed-in admin cannot read or write a staged object directly", async () => {
    const svc = serviceClient();
    const store = storeOf(svc);
    const css = new TextEncoder().encode(`body{color:#${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0")}}`);
    const { sha256 } = await stageFile({ env: ENV, store, contentType: "text/css", expectedSha256: (await import("node:crypto")).createHash("sha256").update(css).digest("hex"), bytes: css });
    const read = await admin.storage.from("sales-demo-versions").download(stagingKey(sha256));
    expect(read.data).toBeNull();
    const write = await admin.storage.from("sales-demo-versions").upload(`staging/${"0".repeat(64)}`, css, { contentType: "text/css" });
    expect(write.error).not.toBeNull();
  });
});
