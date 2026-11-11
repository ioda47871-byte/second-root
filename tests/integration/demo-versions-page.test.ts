import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { buildCompare } from "@/lib/admin/demo-compare";
import { demoVersionsPageExists, loadDemoVersionsPage } from "@/lib/admin/demo-versions";
import type { FrameStore } from "@/lib/demo-frame/serve";
import { DEMO_VERSIONS_BUCKET, seedDemoVersion, storageStatus, type SeededVersion } from "../support/seed-demo-version";
import { createUser, db, makeAdmin, serviceClient, signedInClient } from "./helpers";

// DEV-196d-3: the read-only page's loader against the LOCAL stack — rows through the admin's own session (RLS), the
// current facts hash through the service role (computed field), view tokens only for previewable versions. Runs in
// CI (no object is read). Fictional shop and example.com only.

const ENV = { SALES_DEMO_VERSIONS_ENABLED: "true", SALES_DEMO_VIEW_SIGNING_KEY: randomBytes(32).toString("base64url") };
let admin: SupabaseClient;
let outsider: SupabaseClient;

beforeAll(async () => {
  const n = randomBytes(4).toString("hex");
  const a = await createUser(`demo-page-admin-${n}@test.example.com`);
  await makeAdmin(a);
  await createUser(`demo-page-outsider-${n}@test.example.com`);
  admin = await signedInClient(`demo-page-admin-${n}@test.example.com`);
  outsider = await signedInClient(`demo-page-outsider-${n}@test.example.com`);
});

describe("loadDemoVersionsPage (local stack)", () => {
  it("reads the version through RLS, the facts hash through the service role, and signs a token for it", async () => {
    const s = await seedDemoVersion(db, serviceClient(), { upload: false });
    const r = await loadDemoVersionsPage(s.prospectId, { env: ENV, now: new Date(), client: admin as never });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    const v = r.view.versions[0]!;
    expect(v.id).toBe(s.versionId);
    expect(v.facts).toBe("same"); // the service-role computed field agrees with the hash stored at ingest
    expect(v.renders.map((x) => x.viewport)).toEqual(["desktop_1440", "mobile_390"]);
    expect(v.images).toEqual([expect.objectContaining({ rightsStatus: "owner_provided_internal", previewable: true })]);
    expect(Object.keys(r.tokens)).toEqual([s.versionId]);
    expect(r.view.sendStop).toBeNull();
    expect(await demoVersionsPageExists(s.prospectId, { env: ENV, client: admin as never })).toBe(true);
  });

  it("changed facts show as changed; a disabled demo gets no token", async () => {
    const s = await seedDemoVersion(db, serviceClient(), { upload: false });
    await db.query("update public.sales_demos set content = content || '{\"hours\": \"9:00〜18:00\"}'::jsonb where id = $1", [s.demoId]);
    let r = await loadDemoVersionsPage(s.prospectId, { env: ENV, now: new Date(), client: admin as never });
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.view.versions[0]!.facts).toBe("changed");
    await db.query("update public.sales_demos set disabled_at = now() where id = $1", [s.demoId]);
    r = await loadDemoVersionsPage(s.prospectId, { env: ENV, now: new Date(), client: admin as never });
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.tokens).toEqual({});
    expect(r.demoDisabled).toBe(true);
  });

  it("a signed-in non-admin sees nothing (RLS): not found; the flag off is not found without a query", async () => {
    const s = await seedDemoVersion(db, serviceClient(), { upload: false });
    expect(await loadDemoVersionsPage(s.prospectId, { env: ENV, now: new Date(), client: outsider as never })).toEqual({ kind: "not_found" });
    expect(await demoVersionsPageExists(s.prospectId, { env: ENV, client: outsider as never })).toBe(false);
    expect(await loadDemoVersionsPage(s.prospectId, { env: {}, now: new Date(), client: admin as never })).toEqual({ kind: "not_found" });
  });
});

// DEV-196d-4: the compare page's data from the real rows. The objects are injected in the first test (runs in CI);
// the second reads the real private bucket and is skipped ONLY when the storage service is not running.
const storage = await storageStatus();
const html = (line: string) => `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1>架空の店</h1><p>${line}</p></body></html>`;

async function twoVersions(upload: boolean) {
  const v1 = await seedDemoVersion(db, serviceClient(), { html: html("一つ目の文"), upload });
  const v2 = await seedDemoVersion(db, serviceClient(), { html: html("二つ目の文"), upload, into: { prospectId: v1.prospectId, demoId: v1.demoId, parentVersionId: v1.versionId } });
  return { v1, v2 };
}
const injected = (vs: SeededVersion[]): (() => FrameStore) => () => ({
  version: async () => null,
  demo: async () => null,
  files: async () => [],
  images: async () => [],
  object: async (key) => vs.find((v) => key.startsWith(v.prefix))?.objects[key.slice(vs.find((v) => key.startsWith(v.prefix))!.prefix.length)] ?? null,
});

describe("buildCompare (local stack)", () => {
  it("the candidate against its parent from the real rows; the text diff from bytes checked against the manifest", async () => {
    const { v1, v2 } = await twoVersions(false);
    const page = await loadDemoVersionsPage(v1.prospectId, { env: ENV, now: new Date(), client: admin as never });
    if (page.kind !== "ok") throw new Error(page.kind);
    const r = await buildCompare(page, { a: null, b: null }, { store: injected([v1, v2]) });
    if (r.kind !== "ok") throw new Error(r.kind);
    expect([r.a.id, r.b.id]).toEqual([v1.versionId, v2.versionId]);
    expect(r.meta.factsChanged).toBe(false);
    expect(r.files.entries.find((e) => e.name === "page/index.html")?.change).toBe("changed");
    if (r.copy.kind !== "ok" || !r.copy.result.ok) throw new Error("copy");
    expect(r.copy.result.ops.filter((o) => o.op !== "same").map((o) => `${o.op}:${o.text}`).sort()).toEqual(["add:二つ目の文", "del:一つ目の文"]);
  });

  it.skipIf(!storage.available)(`reads the two pages from the private bucket${storage.available ? "" : ` [skipped: ${storage.available === false ? storage.reason : ""}]`}`, async () => {
    const { v1, v2 } = await twoVersions(true);
    const page = await loadDemoVersionsPage(v1.prospectId, { env: ENV, now: new Date(), client: admin as never });
    if (page.kind !== "ok") throw new Error(page.kind);
    const r = await buildCompare(page, { a: null, b: null });
    expect(r.kind === "ok" && r.copy.kind).toBe("ok");
    await serviceClient().storage.from(DEMO_VERSIONS_BUCKET).remove([v1, v2].flatMap((v) => Object.keys(v.objects).map((n) => `${v.prefix}${n}`)));
  });
});
