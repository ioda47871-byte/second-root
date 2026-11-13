import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bundleSha256, sha256Hex, validateManifest, type ArtifactManifest } from "@/lib/sales/demo-version/manifest";
import { loadStructureAdvice, precheckStructureFindings, recordStructureFindings } from "@/lib/sales/structure-findings/store";
import { anonClient, candidate, createUser, db, makeAdmin, resetSalesData, rpc, serviceClient, signedInClient, verifiedRun } from "./helpers";

// DEV-196q: the stored structure findings of a version — insert-only, strict shape (server and database), siblings
// must be other shops' versions, admins read through RLS, anon and other users see nothing. Advice only: nothing
// here is read by a guard. Fictional shops and example.com only.

let admin: SupabaseClient;
let outsider: SupabaseClient;
let adminId: string;

async function shop(c: Record<string, unknown> = candidate()) {
  const runId = randomUUID();
  await verifiedRun(runId, { c01: c });
  await rpc("sales_run_begin_persist", { p_run_id: runId });
  const r = await rpc<{ prospect_id: string }>("sales_persist_candidate", { p_run_id: runId, p_key: "c01" });
  await rpc("sales_run_finalize", { p_run_id: runId });
  const { rows } = await db.query("select id from public.sales_demos where prospect_id = $1", [r.prospect_id]);
  return rows[0].id as string;
}

function manifest(seed: string): ArtifactManifest {
  const f = (name: string) => sha256Hex(`${seed}:${name}`);
  const checked = validateManifest({
    version: 1,
    files: [
      { name: "page/index.html", role: "html", sha256: f("html"), bytes: 2048, content_type: "text/html" },
      { name: "page/style.css", role: "css", sha256: f("css"), bytes: 1024, content_type: "text/css" },
      { name: "renders/desktop_1440.webp", role: "render", sha256: f("d"), bytes: 50_000, content_type: "image/webp", width: 1440, height: 4000 },
      { name: "renders/mobile_390.webp", role: "render", sha256: f("m"), bytes: 50_000, content_type: "image/webp", width: 390, height: 4000 },
    ],
  });
  if (!checked.ok) throw new Error(checked.codes.join(","));
  return checked.manifest;
}

async function newVersion(demoId: string) {
  const m = manifest(randomUUID());
  const res = await serviceClient().rpc("sales_ingest_demo_version", {
    p_demo_id: demoId, p_generation_job_id: `job-${randomUUID()}`, p_parent_version_id: null, p_origin: "worker_autogen", p_worker_commit: "abcdef1",
    p_direction_sha256: sha256Hex("direction"), p_bundle_sha256: bundleSha256(m), p_manifest: m, p_images: [],
    p_validator_result: { version: 1, ok: true, codes: [], validator_commit: "abcdef1", checked_at: new Date().toISOString() },
    p_worker_checks: { checkPrototype: "ok" }, p_structure_descriptor: null,
    p_rights_summary: { version: 1, photos: 0, by_status: {}, earliest_expiry: null, label_required: false },
  });
  expect(res.error, res.error?.message).toBeNull();
  return (res.data as { version_id: string }).version_id;
}

/** Sets a version's status as the database owner (triggers off): a fixture shortcut for states the flow reaches elsewhere. */
async function forceStatus(id: string, status: string) {
  await db.query("alter table public.sales_demo_versions disable trigger user");
  try {
    await db.query("update public.sales_demo_versions set status = $2 where id = $1", [id, status]);
  } finally {
    await db.query("alter table public.sales_demo_versions enable trigger user");
  }
}

const input = (findings: unknown[], siblingsCompared = 0) => ({ source: "observation_report", findings, siblingsCompared });

beforeAll(async () => {
  const adminEmail = `dev196q-admin-${randomUUID()}@example.com`;
  adminId = await createUser(adminEmail);
  admin = await signedInClient(adminEmail);
  const outsiderEmail = `dev196q-outsider-${randomUUID()}@example.com`;
  await createUser(outsiderEmail);
  outsider = await signedInClient(outsiderEmail);
});
beforeEach(async () => {
  await resetSalesData();
  await makeAdmin(adminId);
});
afterAll(async () => {
  await resetSalesData();
});

describe("sales_demo_structure_findings (DEV-196q)", () => {
  it("records once, replays the same findings, refuses different ones; admins read the advice", async () => {
    const demo = await shop();
    const other = await shop();
    const sibling = await newVersion(other);
    await forceStatus(sibling, "approved");
    const v = await newVersion(demo);
    const findings = [
      { code: "GENERIC_SKELETON", reasons: ["hero:split_copy_media", "flow:stacked_bands"] },
      { code: "SIBLINGS_SAME_SKELETON", sibling, similarity: 0.7 },
      { code: "ASPECTS_UNKNOWN", aspects: ["transitions"] },
    ];
    expect(await recordStructureFindings(serviceClient(), v, input(findings, 1))).toEqual({ versionId: v, replayed: false });
    expect(await recordStructureFindings(serviceClient(), v, input(findings, 1))).toEqual({ versionId: v, replayed: true });
    await expect(recordStructureFindings(serviceClient(), v, input([], 1))).rejects.toThrow("STRUCTURE_FINDINGS_REFUSED:structure_findings_exist");

    const advice = await loadStructureAdvice(admin, v);
    expect(advice.kind).toBe("stored");
    if (advice.kind === "stored") {
      expect(advice.blocking).toBe(false);
      expect(advice.warnings.map((w) => w.code)).toEqual(["GENERIC_SKELETON", "SAME_SKELETON_AS_OTHER_SHOP", "ASPECTS_UNKNOWN"]);
    }
    expect(await loadStructureAdvice(admin, await newVersion(demo))).toEqual({ kind: "not_stored" });
    // non-admins see nothing (RLS); anon has no privilege at all
    expect((await outsider.from("sales_demo_structure_findings").select("version_id")).data).toEqual([]);
    expect((await anonClient().from("sales_demo_structure_findings").select("version_id")).error).not.toBeNull();
  });

  it("the database refuses a bad shape, a sibling of the same shop, an update, a delete and a non-service caller", async () => {
    const demo = await shop();
    const v = await newVersion(demo);
    const sameShop = await newVersion(demo);
    const call = (client: SupabaseClient, findings: unknown) =>
      client.rpc("sales_record_structure_findings", { p_version_id: v, p_findings: findings, p_siblings_compared: 0, p_source: "observation_report" });
    expect((await call(serviceClient(), [{ code: "PASS" }])).error?.message).toMatch(/invalid_structure_findings/);
    expect((await call(serviceClient(), [{ code: "GENERIC_SKELETON", reasons: ["Free text"] }])).error?.message).toMatch(/invalid_structure_findings/);
    expect((await call(serviceClient(), [{ code: "TOO_CLOSE_TO_REFERENCE", reference: "CP-001", similarity: 2 }])).error?.message).toMatch(/invalid_structure_findings/);
    expect((await call(serviceClient(), [{ code: "SIBLINGS_SAME_SKELETON", sibling: sameShop, similarity: 0.9 }])).error?.message).toMatch(/structure_findings_sibling_invalid/);
    // PR #265 review L2: another shop's version that is not approved / superseded is not a sibling
    const otherDraft = await newVersion(await shop());
    expect((await call(serviceClient(), [{ code: "SIBLINGS_SAME_SKELETON", sibling: otherDraft, similarity: 0.9 }])).error?.message).toMatch(/structure_findings_sibling_invalid/);
    expect((await call(admin, [])).error).not.toBeNull();
    expect((await call(outsider, [])).error).not.toBeNull();
    expect((await call(serviceClient(), [{ code: "TOO_CLOSE_TO_REFERENCE", reference: "CP-001", similarity: 0.8 }])).error).toBeNull();
    await expect(db.query("update public.sales_demo_structure_findings set siblings_compared = 3 where version_id = $1", [v])).rejects.toThrow(/structure_findings_immutable/);
    await expect(db.query("delete from public.sales_demo_structure_findings where version_id = $1", [v])).rejects.toThrow(/structure_findings_immutable/);
    const grants = await db.query("select privilege_type from information_schema.role_table_grants where table_name = 'sales_demo_structure_findings' and grantee = 'service_role' order by 1");
    expect(grants.rows.map((r) => r.privilege_type)).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });

  it("a version that is not live (rejected) cannot get findings", async () => {
    const demo = await shop();
    const v = await newVersion(demo);
    await forceStatus(v, "rejected");
    await expect(recordStructureFindings(serviceClient(), v, input([]))).rejects.toThrow("structure_findings_version_unavailable");
  });

  it("PR #265 delta review: the importer's pre-check looks at the bundle's non-rejected version and refuses a replay onto one that is not live", async () => {
    const demo = await shop();
    const v = await newVersion(demo);
    const bundle = (await db.query("select bundle_sha256 from public.sales_demo_versions where id = $1", [v])).rows[0].bundle_sha256 as string;
    await expect(precheckStructureFindings(serviceClient(), { demoId: demo, bundleSha256: bundle, raw: input([]) })).resolves.toBeUndefined();
    for (const status of ["expired", "uploading"]) {
      await forceStatus(v, status);
      await expect(precheckStructureFindings(serviceClient(), { demoId: demo, bundleSha256: bundle, raw: input([]) }), status).rejects.toThrow("STRUCTURE_FINDINGS_VERSION_UNAVAILABLE");
    }
    // a rejected row with the same bundle is not the one a replay would use: nothing to check against
    await forceStatus(v, "rejected");
    await expect(precheckStructureFindings(serviceClient(), { demoId: demo, bundleSha256: bundle, raw: input([]) })).resolves.toBeUndefined();
  });
});
