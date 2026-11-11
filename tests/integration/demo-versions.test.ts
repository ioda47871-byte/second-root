import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bundleSha256, sha256Hex, validateManifest, type ArtifactManifest } from "@/lib/sales/demo-version/manifest";
import { QUALITY_CHECKLIST_ITEMS } from "@/lib/sales/demo-version/quality";
import { AI_CONCEPT_ADMIN_LABEL } from "@/lib/sales/demo-version/ai-concept-rights";
import {
  anonClient,
  approve,
  approveAndMarkSent,
  candidate,
  createUser,
  db,
  makeAdmin,
  resetSalesData,
  rpc,
  serviceClient,
  serviceRoleKey,
  signedInClient,
  supabaseUrl,
  verifiedRun,
} from "./helpers";
import { storageStatus } from "../support/seed-demo-version";

// DEV-196c: demo versions, artifact hashes, image rights and the demo QUALITY
// approval (separate from the DEV-195 SEND approval), with versioned sharing
// disabled in the database. Fictional shops and example.com only.

let admin: SupabaseClient;
let outsider: SupabaseClient;
let adminId: string;

async function shop(c: Record<string, unknown> = candidate()) {
  const runId = randomUUID();
  await verifiedRun(runId, { c01: c });
  await rpc("sales_run_begin_persist", { p_run_id: runId });
  const r = await rpc<{ prospect_id: string; stage: string }>("sales_persist_candidate", { p_run_id: runId, p_key: "c01" });
  expect(r.stage).toBe("outreach_ready");
  await rpc("sales_run_finalize", { p_run_id: runId });
  const { rows } = await db.query(
    "select d.id as demo_id, o.id as outreach_id, d.public_token from public.sales_demos d join public.sales_outreaches o on o.prospect_id = d.prospect_id and o.kind = 'initial' where d.prospect_id = $1",
    [r.prospect_id],
  );
  return { prospectId: r.prospect_id, demoId: rows[0].demo_id as string, outreachId: rows[0].outreach_id as string, token: rows[0].public_token as string };
}

type Shop = Awaited<ReturnType<typeof shop>>;

const fileSha = (name: string, seed: string) => sha256Hex(`${seed}:${name}`);

/** A manifest as the server would hand it over (validated by DEV-196b). */
function manifest(seed: string, opts: { photos?: Array<{ name: string; sha256: string }>; renders?: string[] } = {}): ArtifactManifest {
  const renders = opts.renders ?? ["desktop_1440", "mobile_390"];
  const m = {
    version: 1 as const,
    files: [
      { name: "page/index.html", role: "html" as const, sha256: fileSha("html", seed), bytes: 2048, content_type: "text/html" as const },
      { name: "page/style.css", role: "css" as const, sha256: fileSha("css", seed), bytes: 1024, content_type: "text/css" as const },
      ...renders.map((r) => ({ name: `renders/${r}.webp`, role: "render" as const, sha256: fileSha(r, seed), bytes: 50_000, content_type: "image/webp" as const, width: r === "mobile_390" ? 390 : r === "tablet_768" ? 768 : 1440, height: 4000 })),
      ...(opts.photos ?? []).map((p) => ({ name: p.name, role: "photo" as const, sha256: p.sha256, bytes: 30_000, content_type: "image/webp" as const, width: 800, height: 600 })),
    ],
  };
  const checked = validateManifest(m);
  if (!checked.ok) throw new Error(`fixture manifest invalid: ${checked.codes.join(",")}`);
  return checked.manifest;
}

const ALL_OK = Object.fromEntries(QUALITY_CHECKLIST_ITEMS.map((k) => [k, "ok"]));

function aiConceptImage(sha256: string, confirmedBy: string, overrides: Record<string, unknown> = {}) {
  return {
    sha256, bytes: 30_000, width: 800, height: 600, format: "webp",
    record_schema: "ai_concept_rights_v0", source_kind: "ai_concept_internal", rights_status: "ai_concept_internal",
    depicts_real_shop: false, depicts_identifiable_person: false, depicts_real_product: false, depicts_real_interior: false, depicts_real_equipment: false,
    no_factual_impersonation_confirmed_at: new Date().toISOString(), no_factual_impersonation_confirmed_by: confirmedBy,
    allowed_uses: { edit: true, crop: true, commercial: false, public_web: false },
    // AiConceptProvenance (strict): a fictional generator / model id, never a real model name in the repository.
    provenance: { generator: "test-fixture", model: "test-model-0", generated_at: new Date().toISOString(), prompt_sha256: sha256Hex(`prompt:${AI_CONCEPT_ADMIN_LABEL}`), approval_id: "grant-test-0001", admin_preview_only: true },
    ...overrides,
  };
}

function ingestArgs(s: Shop, m: ArtifactManifest, over: Record<string, unknown> = {}) {
  return {
    p_demo_id: s.demoId,
    p_generation_job_id: `job-${randomUUID()}`,
    p_parent_version_id: null,
    p_origin: "worker_autogen",
    p_worker_commit: "abcdef1",
    p_direction_sha256: sha256Hex("direction"),
    p_bundle_sha256: bundleSha256(m),
    p_manifest: m,
    p_images: [],
    p_validator_result: { version: 1, ok: true, codes: [], validator_commit: "abcdef1", checked_at: new Date().toISOString() },
    p_worker_checks: { checkPrototype: "ok" },
    p_structure_descriptor: null,
    p_rights_summary: { version: 1, photos: 0, by_status: {}, earliest_expiry: null, label_required: false },
    ...over,
  };
}

const ingest = (args: Record<string, unknown>) => serviceClient().rpc("sales_ingest_demo_version", args);

async function newVersion(s: Shop, seed = randomUUID(), over: Record<string, unknown> = {}, mopts: Parameters<typeof manifest>[1] = {}) {
  const m = manifest(seed, mopts);
  const res = await ingest(ingestArgs(s, m, over));
  expect(res.error, res.error?.message).toBeNull();
  return { id: (res.data as { version_id: string }).version_id, manifest: m, seed, bundle: bundleSha256(m) };
}

const viewed = (seed: string, renders = ["desktop_1440", "mobile_390"]) => Object.fromEntries(renders.map((r) => [r, fileSha(r, seed)]));

const review = (client: SupabaseClient, v: { id: string; bundle: string; seed: string }, over: Record<string, unknown> = {}) =>
  client.rpc("sales_review_demo_version", {
    p_version_id: v.id, p_decision: "approved", p_checklist: ALL_OK, p_viewed_renders: viewed(v.seed), p_bundle_sha256: v.bundle, p_note: null, ...over,
  });

async function approveVersion(v: { id: string; bundle: string; seed: string }) {
  const r = await review(admin, v);
  expect(r.error, r.error?.message).toBeNull();
  return (r.data as { review_id: string }).review_id;
}

const versionRow = async (id: string) => (await db.query("select * from public.sales_demo_versions where id = $1", [id])).rows[0];
const demoRow = async (id: string) => (await db.query("select * from public.sales_demos where id = $1", [id])).rows[0];
const demoHash = async (demoId: string) => (await db.query("select public.sales_demo_version(d) as h from public.sales_demos d where d.id = $1", [demoId])).rows[0].h as string;
const legacyHash = async (demoId: string) =>
  (await db.query("select encode(sha256(convert_to(jsonb_build_array(d.public_token, d.template, d.content, d.design_status, d.design_profile)::text, 'UTF8')), 'hex') as h from public.sales_demos d where d.id = $1", [demoId])).rows[0].h as string;
const resolveShare = async (token: string) => (await db.query("select public.sales_resolve_demo_share($1) as r", [token])).rows[0].r as { mode: string; version_id?: string };

/**
 * A send_opened approval written straight into the table (as the database
 * owner): the only way to reach §9.5 states that the functions themselves can
 * no longer create while versioned sharing is disabled.
 */
async function forceOpenedApproval(s: Shop, pinVersion: string | null) {
  const { rows } = await db.query(
    `insert into public.sales_outreach_approvals (outreach_id, prospect_id, channel, recipient, body, draft_version, demo_token, demo_version,
       snapshot_sha256, approved_by, demo_version_id, demo_bundle_sha256, demo_quality_review_id, demo_share_eligible)
     select o.id, o.prospect_id, o.channel, p.instagram_handle, o.body || ' /demo/' || d.public_token, o.draft_version, d.public_token,
            public.sales_demo_version(d), encode(sha256(convert_to(o.id::text, 'UTF8')), 'hex'), $3,
            v.id, v.bundle_sha256, (select r.id from public.sales_demo_quality_reviews r where r.version_id = v.id and r.decision = 'approved' and r.state = 'active'),
            case when v.id is null then null else false end
       from public.sales_outreaches o join public.sales_prospects p on p.id = o.prospect_id join public.sales_demos d on d.prospect_id = p.id
       left join public.sales_demo_versions v on v.id = $2
      where o.id = $1
     returning id`,
    [s.outreachId, pinVersion, adminId],
  );
  const id = rows[0].id as string;
  await db.query("update public.sales_outreach_approvals set state = 'send_opened', opened_at = now(), last_opened_at = now(), opened_via = 'instagram_profile', open_count = 1 where id = $1", [id]);
  return id;
}

beforeAll(async () => {
  await resetSalesData();
  adminId = await createUser("demo-version-admin@test.example.com");
  await makeAdmin(adminId);
  await createUser("demo-version-outsider@test.example.com");
  admin = await signedInClient("demo-version-admin@test.example.com");
  outsider = await signedInClient("demo-version-outsider@test.example.com");
});
beforeEach(async () => {
  await db.query(
    "truncate public.sales_demo_quality_reviews, public.sales_demo_version_files, public.sales_demo_versions, public.sales_demo_images, public.sales_exclusions, public.sales_outreach_approvals, public.sales_outreach_draft_edits, public.sales_prospect_insights, public.sales_outreaches, public.sales_demos, public.sales_sources, public.sales_prospects, public.sales_agent_runs cascade",
  );
});
afterAll(resetSalesData);

describe("RLS and function grants", () => {
  it("only the admin reads versions, files, images and reviews; nobody writes them directly", async () => {
    const s = await shop();
    const photo = { name: "page/photos/hero-desktop.webp", sha256: sha256Hex(`photo-${randomUUID()}`) };
    const v = await newVersion(s, randomUUID(), { p_images: [aiConceptImage(photo.sha256, adminId)] }, { photos: [photo] });
    await approveVersion(v);
    for (const table of ["sales_demo_versions", "sales_demo_version_files", "sales_demo_images", "sales_demo_quality_reviews"]) {
      expect((await admin.from(table).select("*")).data?.length, table).toBeGreaterThan(0);
      expect((await outsider.from(table).select("*")).data ?? [], table).toEqual([]);
      expect((await anonClient().from(table).select("*")).error, table).not.toBeNull();
    }
    expect((await admin.from("sales_demo_versions").update({ status: "revoked" }).eq("id", v.id)).error?.code).toBe("42501");
    expect((await admin.from("sales_demo_quality_reviews").insert({ version_id: v.id })).error?.code).toBe("42501");
    expect((await admin.from("sales_demo_images").delete().eq("prospect_id", s.prospectId)).error?.code).toBe("42501");
    expect((await admin.from("sales_demo_version_files").delete().eq("version_id", v.id)).error?.code).toBe("42501");
  });

  it("admin RPCs refuse a non-admin, anon and the service role (no admin identity); the worker function is service-role only", async () => {
    const s = await shop();
    const v = await newVersion(s);
    const calls: Array<[string, Record<string, unknown>]> = [
      ["sales_review_demo_version", { p_version_id: v.id, p_decision: "approved", p_checklist: ALL_OK, p_viewed_renders: viewed(v.seed), p_bundle_sha256: v.bundle, p_note: null }],
      ["sales_withdraw_demo_quality_review", { p_review_id: randomUUID() }],
      ["sales_revoke_demo_version", { p_version_id: v.id, p_code: "TEST_REVOKE" }],
      ["sales_revoke_demo_image", { p_image_id: randomUUID(), p_code: "TEST_REVOKE" }],
    ];
    for (const [fn, args] of calls) {
      expect((await outsider.rpc(fn, args)).error?.code, fn).toBe("42501");
      expect((await anonClient().rpc(fn, args)).error?.code, fn).toBe("42501");
      // The generation worker's path (server with the service role key, no signed-in admin) cannot approve, revoke or withdraw.
      expect((await serviceClient().rpc(fn, args)).error?.code, fn).toBe("42501");
    }
    const args = ingestArgs(s, manifest(randomUUID()));
    expect((await admin.rpc("sales_ingest_demo_version", args)).error?.code).toBe("42501");
    expect((await anonClient().rpc("sales_ingest_demo_version", args)).error?.code).toBe("42501");
    for (const fn of ["sales_resolve_demo_share", "sales_demo_version_shareable", "sales_demo_versioned_sharing_enabled"]) {
      const a = fn === "sales_resolve_demo_share" ? { p_public_token: s.token } : fn === "sales_demo_version_shareable" ? { p_version_id: v.id } : {};
      expect((await admin.rpc(fn, a)).error?.code, fn).toBe("42501");
      expect((await anonClient().rpc(fn, a)).error?.code, fn).toBe("42501");
    }
    expect(await versionRow(v.id)).toMatchObject({ status: "draft", revoked_at: null });
  });
});

describe("worker path: unapproved drafts only", () => {
  it("records a draft with lineage, job id, worker commit and hashes computed by the database", async () => {
    const s = await shop();
    const first = await newVersion(s);
    const row = await versionRow(first.id);
    expect(row).toMatchObject({
      demo_id: s.demoId, version_no: 1, status: "draft", origin: "worker_autogen", worker_commit: "abcdef1",
      bundle_sha256: first.bundle, storage_prefix: `v1/${s.demoId}/${first.id}/`, share_eligible: false, total_bytes: 2048 + 1024 + 100_000,
    });
    // The bundle hash the database recomputes equals bundleSha256 (DEV-196b), and the facts hash is the demo's content.
    expect((await db.query("select public.sales_demo_bundle_sha256($1::jsonb) as h", [JSON.stringify(first.manifest)])).rows[0].h).toBe(first.bundle);
    expect((await db.query("select public.sales_demo_facts_sha256(d) as h from public.sales_demos d where d.id = $1", [s.demoId])).rows[0].h).toBe(row.facts_sha256);
    expect(new Date(row.expires_at).getTime() - Date.now()).toBeGreaterThan(59 * 86_400_000);
    const files = (await db.query("select path, role, sha256 from public.sales_demo_version_files where version_id = $1 order by path", [first.id])).rows;
    expect(files.map((f) => f.path)).toEqual(["page/index.html", "page/style.css", "renders/desktop_1440.webp", "renders/mobile_390.webp"]);
    const child = await newVersion(s, randomUUID(), { p_parent_version_id: first.id });
    expect(await versionRow(child.id)).toMatchObject({ version_no: 2, parent_version_id: first.id, status: "draft" });
  });

  it("is idempotent per generation job and refuses duplicates", async () => {
    const s = await shop();
    const m = manifest(randomUUID());
    const args = ingestArgs(s, m);
    const a = await ingest(args);
    const b = await ingest(args);
    expect(a.error).toBeNull();
    expect(b.data).toMatchObject({ version_id: (a.data as { version_id: string }).version_id, replayed: true });
    // Same job, another bundle → job_conflict; same bundle, another job → duplicate_bundle.
    const other = manifest(randomUUID());
    expect((await ingest({ ...args, p_manifest: other, p_bundle_sha256: bundleSha256(other) })).error?.message).toContain("job_conflict");
    expect((await ingest({ ...args, p_generation_job_id: `job-${randomUUID()}` })).error?.message).toContain("duplicate_bundle");
    expect((await db.query("select count(*)::int as n from public.sales_demo_versions where demo_id = $1", [s.demoId])).rows[0].n).toBe(1);
    // One upload in flight per demo (partial unique index), inside one transaction with each version's files.
    const client = await db.connect();
    try {
      await client.query("begin");
      const uploading = async () => {
        const m2 = manifest(randomUUID());
        const id = randomUUID();
        await client.query(
          `insert into public.sales_demo_versions (id, demo_id, version_no, origin, facts_sha256, bundle_sha256, manifest, storage_prefix, total_bytes, status, expires_at)
           select $1::uuid, d.id, (select coalesce(max(version_no), 0) + 1 from public.sales_demo_versions where demo_id = d.id), 'manual_import',
                  public.sales_demo_facts_sha256(d), $2, $3::jsonb, 'v1/' || d.id || '/' || $1::text || '/', $4, 'uploading', now() + interval '1 day'
           from public.sales_demos d where d.id = $5`,
          [id, bundleSha256(m2), JSON.stringify(m2), m2.files.reduce((n, f) => n + f.bytes, 0), s.demoId],
        );
      };
      await uploading();
      await expect(uploading()).rejects.toThrow(/sales_demo_versions_one_uploading/);
    } finally {
      await client.query("rollback");
      client.release();
    }
    expect((a.data as { version_id: string }).version_id).toBeTruthy();
  });

  it("refuses a bad manifest, a wrong bundle hash, a failed validator, foreign lineage and an unusable shop", async () => {
    const s = await shop();
    const other = await shop();
    const m = manifest(randomUUID());
    const extraKey = { ...m, files: m.files.map((f, i) => (i === 0 ? { ...f, owner: "x" } : f)) };
    expect((await ingest(ingestArgs(s, m, { p_manifest: extraKey }))).error?.message).toContain("invalid_manifest");
    expect((await ingest(ingestArgs(s, m, { p_manifest: { ...m, private: true } }))).error?.message).toContain("invalid_manifest");
    const badPath = { ...m, files: [...m.files, { name: "rights.private.json", role: "css", sha256: sha256Hex("p"), bytes: 10, content_type: "text/css" }] };
    expect((await ingest(ingestArgs(s, m, { p_manifest: badPath, p_bundle_sha256: (await db.query("select public.sales_demo_bundle_sha256($1::jsonb) as h", [JSON.stringify(badPath)])).rows[0].h }))).error?.message).toContain("invalid_manifest");
    expect((await ingest(ingestArgs(s, m, { p_bundle_sha256: sha256Hex("wrong") }))).error?.message).toContain("bundle_mismatch");
    expect((await ingest(ingestArgs(s, m, { p_validator_result: { version: 1, ok: false, codes: ["HTML_SCRIPT"] } }))).error?.message).toContain("validator_not_ok");
    const foreign = await newVersion(other);
    expect((await ingest(ingestArgs(s, m, { p_parent_version_id: foreign.id }))).error?.message).toContain("parent_other_demo");
    expect((await ingest(ingestArgs(s, m, { p_demo_id: randomUUID() }))).error?.code).toBe("P0002");
    await db.query("update public.sales_demos set disabled_at = now() where id = $1", [s.demoId]);
    expect((await ingest(ingestArgs(s, m))).error?.message).toContain("demo_disabled");
    await db.query("update public.sales_demos set disabled_at = null where id = $1", [s.demoId]);
    await db.query("update public.sales_prospects set do_not_contact = true, dnc_reason = 'explicit_refusal', dnc_set_at = now() where id = $1", [s.prospectId]);
    expect((await ingest(ingestArgs(s, m))).error?.message).toContain("do_not_contact");
    expect((await db.query("select count(*)::int as n from public.sales_demo_versions where demo_id = $1", [s.demoId])).rows[0].n).toBe(0);
  });

  it("refuses images without usable rights, of another shop, or an AI concept image that depicts something real", async () => {
    const s = await shop();
    const other = await shop();
    const photo = (seed: string) => ({ name: "page/photos/hero-desktop.webp", sha256: sha256Hex(`photo-${seed}`) });
    const p1 = photo(randomUUID());
    const m1 = manifest(randomUUID(), { photos: [p1] });
    // No record at all, or an 'unknown' one → the whole version is refused (§8.1).
    expect((await ingest(ingestArgs(s, m1))).error?.message).toContain("rights_unknown");
    expect((await ingest(ingestArgs(s, m1, { p_images: [aiConceptImage(p1.sha256, adminId, { rights_status: "unknown" })] }))).error?.message).toContain("rights_unknown");
    // The database derives the status (review round 1 M1): depicts_real_product / no owner confirmation /
    // incomplete provenance / public_web → 'unknown' → the whole version is refused.
    for (const over of [
      { depicts_real_product: true }, { depicts_real_shop: true }, { no_factual_impersonation_confirmed_at: null },
      { provenance: { generator: "x", model: "unknown", generated_at: new Date().toISOString(), prompt_sha256: sha256Hex("p"), approval_id: "grant-test-0001", admin_preview_only: true } },
      { allowed_uses: { edit: true, crop: true, commercial: true, public_web: true } },
    ]) {
      expect((await ingest(ingestArgs(s, m1, { p_images: [aiConceptImage(p1.sha256, adminId, over)] }))).error?.message, JSON.stringify(over)).toContain("rights_unknown");
    }
    // A provenance that is not an object does not even fit the table.
    expect((await ingest(ingestArgs(s, m1, { p_images: [aiConceptImage(p1.sha256, adminId, { provenance: null })] }))).error?.message).toContain("invalid_image");
    expect((await ingest(ingestArgs(s, m1, { p_images: [aiConceptImage(p1.sha256, randomUUID())] }))).error?.message).toContain("invalid_image");
    expect((await ingest(ingestArgs(s, m1, { p_images: [{ ...aiConceptImage(p1.sha256, adminId), model_raw: "x" }] }))).error?.message).toContain("invalid_image");
    // An image recorded for another shop is never used in this shop's version.
    await newVersion(other, randomUUID(), { p_images: [aiConceptImage(p1.sha256, adminId)] }, { photos: [p1] });
    expect((await ingest(ingestArgs(s, m1, { p_images: [aiConceptImage(p1.sha256, adminId)] }))).error?.message).toContain("image_other_shop");
    expect((await db.query("select count(*)::int as n from public.sales_demo_versions where demo_id = $1", [s.demoId])).rows[0].n).toBe(0);
  });

  it("review round 1 M1: a real shop's AI image is never ai_demo_internal, and a caller-supplied status is not trusted", async () => {
    const s = await shop();
    const p1 = { name: "page/photos/hero-desktop.webp", sha256: sha256Hex(`photo-${randomUUID()}`) };
    const m1 = manifest(randomUUID(), { photos: [p1] });
    // The fictional shops' AI demo kind, as the reviewer tried it (everything real depicted): refused at ingest…
    const aiDemo = {
      ...aiConceptImage(p1.sha256, adminId), record_schema: "photo_rights_v0", source_kind: "ai_generated_demo", rights_status: "ai_demo_internal",
      depicts_real_shop: true, depicts_identifiable_person: true, depicts_real_product: true, depicts_real_interior: true, depicts_real_equipment: true,
      no_factual_impersonation_confirmed_at: undefined, no_factual_impersonation_confirmed_by: undefined, provenance: undefined,
    };
    expect((await ingest(ingestArgs(s, m1, { p_images: [aiDemo] }))).error?.message).toContain("invalid_image");
    // …and by the table for any writer (database owner and service role).
    const direct = {
      prospect_id: s.prospectId, sha256: sha256Hex(randomUUID()), bytes: 10, width: 10, height: 10, format: "webp", record_schema: "photo_rights_v0",
      source_kind: "ai_generated_demo", rights_status: "ai_demo_internal", depicts_real_shop: true, depicts_identifiable_person: true,
      depicts_real_product: true, depicts_real_interior: true, depicts_real_equipment: true, allowed_uses: { edit: true, crop: true, commercial: true, public_web: false },
    };
    expect((await serviceClient().from("sales_demo_images").insert(direct)).error?.message).toContain("ai_demo_real_shop");
    expect((await serviceClient().from("sales_demo_images").insert({ ...direct, source_kind: "owner_provided" })).error?.message).toContain("ai_demo_real_shop");
    // A caller-supplied status is replaced by the derived one: an AI concept image claimed as share_cleared /
    // ai_share_approved is stored as ai_concept_internal, never shareable.
    const v = await newVersion(s, randomUUID(), { p_images: [aiConceptImage(p1.sha256, adminId, { rights_status: "share_cleared" })] }, { photos: [p1] });
    expect((await db.query("select i.rights_status, public.sales_demo_image_shareable(i) as share from public.sales_demo_images i where sha256 = $1", [p1.sha256])).rows[0]).toEqual({ rights_status: "ai_concept_internal", share: false });
    expect((await db.query("select public.sales_demo_version_rights_shareable($1) as r", [v.id])).rows[0].r).toBe(false);
    // A human photo claimed as share_cleared without the shop's written confirmation is internal; an expired one is refused.
    const human = (sha256: string, over: Record<string, unknown> = {}) => ({
      sha256, bytes: 30_000, width: 800, height: 600, format: "webp", record_schema: "photo_rights_v0", source_kind: "owner_provided", rights_status: "share_cleared",
      depicts_real_shop: true, depicts_identifiable_person: false, depicts_real_product: true, depicts_real_interior: false, depicts_real_equipment: false,
      allowed_uses: { edit: true, crop: true, commercial: true, public_web: true }, ...over,
    });
    const p2 = { name: "page/photos/hero-desktop.webp", sha256: sha256Hex(`photo-${randomUUID()}`) };
    await newVersion(s, randomUUID(), { p_images: [human(p2.sha256)] }, { photos: [p2] });
    expect((await db.query("select rights_status from public.sales_demo_images where sha256 = $1", [p2.sha256])).rows[0].rights_status).toBe("owner_provided_internal");
    const p3 = { name: "page/photos/hero-desktop.webp", sha256: sha256Hex(`photo-${randomUUID()}`) };
    const m3 = manifest(randomUUID(), { photos: [p3] });
    expect((await ingest(ingestArgs(s, m3, { p_images: [human(p3.sha256, { rights_expiry: "2020-01-01" })] }))).error?.message).toContain("rights_unknown");
  });

  it("the worker cannot approve: a direct write with the service role key is refused by the database", async () => {
    const s = await shop();
    const v = await newVersion(s);
    const svc = serviceClient();
    expect((await svc.from("sales_demo_versions").update({ status: "approved" }).eq("id", v.id)).error?.message).toContain("admin_identity_required");
    expect((await svc.from("sales_demo_versions").update({ share_eligible: true }).eq("id", v.id)).error).not.toBeNull();
    const row = await versionRow(v.id);
    const reviewInsert = await svc.from("sales_demo_quality_reviews").insert({
      version_id: v.id, demo_id: s.demoId, decision: "approved", checklist: ALL_OK, viewed_renders_sha256: viewed(v.seed),
      bundle_sha256: v.bundle, facts_sha256: row.facts_sha256, reviewed_by: adminId,
    });
    expect(reviewInsert.error?.message).toContain("admin_identity_required");
    expect((await svc.from("sales_demos").update({ approved_version_id: v.id }).eq("id", s.demoId)).error?.message).toContain("admin_identity_required");
    expect((await svc.from("sales_demo_versions").insert({ ...row, id: randomUUID(), version_no: 9, status: "approved" })).error?.message).toContain("demo_version_must_start_unapproved");
    expect(await versionRow(v.id)).toMatchObject({ status: "draft" });
    expect((await demoRow(s.demoId)).approved_version_id).toBeNull();
    expect((await db.query("select count(*)::int as n from public.sales_demo_quality_reviews")).rows[0].n).toBe(0);
  });
});

describe("review round 1 L4 / L5: the rules hold for every writer", () => {
  /** A version row as a direct writer would send it (the service role, bypassing sales_ingest_demo_version). */
  async function directRow(s: Shop, m: ArtifactManifest, over: Record<string, unknown> = {}) {
    const id = randomUUID();
    const facts = (await db.query("select public.sales_demo_facts_sha256(d) as h from public.sales_demos d where d.id = $1", [s.demoId])).rows[0].h;
    return {
      id, demo_id: s.demoId, version_no: 50, origin: "manual_import", facts_sha256: facts, bundle_sha256: bundleSha256(m), manifest: m,
      storage_prefix: `v1/${s.demoId}/${id}/`, total_bytes: m.files.reduce((n, f) => n + f.bytes, 0), status: "draft",
      validator_result: { ok: true }, expires_at: new Date(Date.now() + 86_400_000).toISOString(), ...over,
    };
  }

  it("a direct insert must carry the manifest's bundle hash, its size, the demo's facts hash and a ≤ 60-day retention, and all its files", async () => {
    const s = await shop();
    const svc = serviceClient();
    const m = manifest(randomUUID());
    expect((await svc.from("sales_demo_versions").insert(await directRow(s, m, { bundle_sha256: sha256Hex("forged") }))).error?.message).toContain("bundle_mismatch");
    expect((await svc.from("sales_demo_versions").insert(await directRow(s, m, { facts_sha256: sha256Hex("caller facts") }))).error?.message).toContain("facts_mismatch");
    expect((await svc.from("sales_demo_versions").insert(await directRow(s, m, { total_bytes: 1 }))).error?.message).toContain("invalid_manifest");
    expect((await svc.from("sales_demo_versions").insert(await directRow(s, m, { manifest: { ...m, extra: 1 } }))).error?.message).toContain("invalid_manifest");
    expect((await svc.from("sales_demo_versions").insert(await directRow(s, m, { expires_at: new Date(Date.now() + 90 * 86_400_000).toISOString() }))).error?.message).toContain("invalid_expiry");
    // A version committed without its files is refused at commit (deferred constraint trigger).
    expect((await svc.from("sales_demo_versions").insert(await directRow(s, m))).error?.message).toContain("version_files_incomplete");
    // A file that is not an entry of the manifest is refused.
    const client = await db.connect();
    try {
      await client.query("begin");
      const row = await directRow(s, m);
      await client.query(
        `insert into public.sales_demo_versions (id, demo_id, version_no, origin, facts_sha256, bundle_sha256, manifest, storage_prefix, total_bytes, status, validator_result, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11::jsonb, $12)`,
        [row.id, row.demo_id, row.version_no, row.origin, row.facts_sha256, row.bundle_sha256, JSON.stringify(m), row.storage_prefix, row.total_bytes, row.status, JSON.stringify(row.validator_result), row.expires_at],
      );
      await expect(
        client.query("insert into public.sales_demo_version_files (version_id, path, role, sha256, bytes, content_type) values ($1, 'page/index.html', 'html', repeat('9', 64), 2048, 'text/html')", [row.id]),
      ).rejects.toThrow(/file_not_in_manifest/);
    } finally {
      await client.query("rollback");
      client.release();
    }
    expect((await db.query("select count(*)::int as n from public.sales_demo_versions where demo_id = $1", [s.demoId])).rows[0].n).toBe(0);
  });

  it("no API role deletes or truncates the history; the retention is never extended for an unsent version", async () => {
    const s = await shop();
    const v = await newVersion(s);
    const svc = serviceClient();
    expect((await svc.from("sales_demo_versions").delete().eq("id", v.id)).error?.code).toBe("42501");
    expect((await svc.from("sales_demo_version_files").delete().eq("version_id", v.id)).error?.code).toBe("42501");
    for (const table of ["sales_demo_versions", "sales_demo_version_files", "sales_demo_images", "sales_demo_quality_reviews"]) {
      for (const role of ["service_role", "authenticated"]) {
        const client = await db.connect();
        try {
          await client.query("begin");
          await client.query(`set local role ${role}`);
          await expect(client.query(`truncate public.${table}`), `${role} ${table}`).rejects.toThrow(/permission denied/);
        } finally {
          await client.query("rollback");
          client.release();
        }
      }
    }
    expect((await svc.from("sales_demo_versions").update({ expires_at: new Date(Date.now() + 120 * 86_400_000).toISOString() }).eq("id", v.id)).error?.message).toContain("demo_version_expiry_extension_forbidden");
    expect(await versionRow(v.id)).toMatchObject({ status: "draft" });
  });

  it("while a send screen is open, direct writes that change what a send shows answer approval_open", async () => {
    const s = await shop();
    const v = await newVersion(s);
    const reviewId = await approveVersion(v);
    await forceOpenedApproval(s, null);
    const svc = serviceClient();
    expect((await svc.from("sales_demo_versions").update({ status: "draft" }).eq("id", v.id)).error?.message).toContain("approval_open");
    expect((await svc.from("sales_demo_versions").update({ status: "revoked", revoked_at: new Date().toISOString(), revoked_by: adminId, revoke_code: "DIRECT" }).eq("id", v.id)).error?.message).toContain("approval_open");
    expect((await svc.from("sales_demo_quality_reviews").update({ state: "invalidated", invalidated_at: new Date().toISOString(), invalidated_reason: "rights_changed" }).eq("id", reviewId)).error?.message).toContain("approval_open");
    expect((await svc.from("sales_demos").update({ approved_version_id: null }).eq("id", s.demoId)).error?.message).toContain("approval_open");
    expect(await versionRow(v.id)).toMatchObject({ status: "approved", revoked_at: null });
    expect((await demoRow(s.demoId)).approved_version_id).toBe(v.id);
    expect((await db.query("select state from public.sales_demo_quality_reviews where id = $1", [reviewId])).rows[0].state).toBe("active");
  });

  it("L5: a byte-identical bundle is never recorded for another shop", async () => {
    const a = await shop();
    const b = await shop();
    const m = manifest(randomUUID());
    expect((await ingest(ingestArgs(a, m))).error).toBeNull();
    const res = await ingest(ingestArgs(b, m));
    expect(res.error?.message).toContain("bundle_reused_across_shops");
    expect((await serviceClient().from("sales_demo_versions").insert(await directRow(b, m))).error?.message).toContain("bundle_reused_across_shops");
    expect((await db.query("select count(*)::int as n from public.sales_demo_versions where demo_id = $1", [b.demoId])).rows[0].n).toBe(0);
  });
});

describe("immutability and append-only history", () => {
  it("a version's content, hashes and files never change; nothing is deleted", async () => {
    const s = await shop();
    const v = await newVersion(s);
    for (const set of ["bundle_sha256 = repeat('0', 64)", "facts_sha256 = repeat('1', 64)", "manifest = '{}'::jsonb", "storage_prefix = 'x'", "parent_version_id = null, version_no = 7", "validator_result = '{\"ok\": true}'::jsonb", "generation_job_id = 'job-other'"]) {
      await expect(db.query(`update public.sales_demo_versions set ${set} where id = $1`, [v.id]), set).rejects.toThrow(/demo_version_content_immutable|constraint/);
    }
    await expect(db.query("delete from public.sales_demo_versions where id = $1", [v.id])).rejects.toThrow(/demo_version_delete_forbidden/);
    await expect(db.query("update public.sales_demo_version_files set sha256 = repeat('2', 64) where version_id = $1", [v.id])).rejects.toThrow(/demo_version_files_immutable/);
    await expect(db.query("delete from public.sales_demo_version_files where version_id = $1", [v.id])).rejects.toThrow(/demo_version_files_immutable/);
    await expect(
      db.query("insert into public.sales_demo_version_files (version_id, path, role, sha256, bytes, content_type, width, height) values ($1, 'renders/tablet_768.webp', 'render', repeat('3', 64), 10, 'image/webp', 768, 900)", [v.id]),
    ).rejects.toThrow(/demo_version_files_immutable/);
    // A revoked version is final.
    expect((await admin.rpc("sales_revoke_demo_version", { p_version_id: v.id, p_code: "TEST_REVOKE" })).error).toBeNull();
    await expect(db.query("update public.sales_demo_versions set status = 'draft', revoked_at = null, revoked_by = null, revoke_code = null where id = $1", [v.id])).rejects.toThrow(/demo_version_final/);
  });

  it("reviews are append-only: the snapshot never changes, the state only moves forward, nothing is deleted", async () => {
    const s = await shop();
    const v = await newVersion(s);
    const reviewId = await approveVersion(v);
    await expect(db.query("update public.sales_demo_quality_reviews set note = 'changed' where id = $1", [reviewId])).rejects.toThrow(/quality_review_immutable/);
    await expect(db.query("update public.sales_demo_quality_reviews set bundle_sha256 = repeat('0', 64) where id = $1", [reviewId])).rejects.toThrow(/quality_review_immutable/);
    await expect(db.query("delete from public.sales_demo_quality_reviews where id = $1", [reviewId])).rejects.toThrow(/quality_review_delete_forbidden/);
    // Withdrawing needs an admin identity (the database owner has none).
    await expect(db.query("update public.sales_demo_quality_reviews set state = 'withdrawn', withdrawn_at = now(), withdrawn_by = $2 where id = $1", [reviewId, adminId])).rejects.toThrow(/admin_identity_required/);
    expect((await admin.rpc("sales_withdraw_demo_quality_review", { p_review_id: reviewId })).error).toBeNull();
    await expect(db.query("update public.sales_demo_quality_reviews set state = 'active', withdrawn_at = null, withdrawn_by = null where id = $1", [reviewId])).rejects.toThrow(/quality_review_final/);
    expect((await admin.rpc("sales_withdraw_demo_quality_review", { p_review_id: reviewId })).data).toMatchObject({ replayed: true });
  });

  it("an image's measured values and records never change, rights never upgrade, and AI images can never be share_cleared", async () => {
    const s = await shop();
    const p = { name: "page/photos/hero-desktop.webp", sha256: sha256Hex(`photo-${randomUUID()}`) };
    await newVersion(s, randomUUID(), { p_images: [aiConceptImage(p.sha256, adminId)] }, { photos: [p] });
    const { rows } = await db.query("select id from public.sales_demo_images where sha256 = $1", [p.sha256]);
    const id = rows[0].id;
    await expect(db.query("update public.sales_demo_images set depicts_real_product = true where id = $1", [id])).rejects.toThrow(/demo_image_immutable/);
    await expect(db.query("update public.sales_demo_images set provenance = '{}'::jsonb where id = $1", [id])).rejects.toThrow(/demo_image_immutable/);
    await expect(db.query("update public.sales_demo_images set rights_status = 'share_cleared' where id = $1", [id])).rejects.toThrow(/demo_image_rights_upgrade_forbidden|sales_demo_images_/);
    await expect(db.query("update public.sales_demo_images set owner_ai_share_decision_at = now() where id = $1", [id])).rejects.toThrow();
    await expect(db.query("delete from public.sales_demo_images where id = $1", [id])).rejects.toThrow(/demo_image_delete_forbidden/);
    // Even inserted directly, an AI image cannot be share_cleared or ai_share_approved (table checks).
    for (const status of ["share_cleared", "ai_share_approved", "owner_provided_internal"]) {
      await expect(
        db.query(
          `insert into public.sales_demo_images (prospect_id, sha256, bytes, width, height, format, record_schema, source_kind, rights_status,
             depicts_real_shop, depicts_identifiable_person, depicts_real_product, depicts_real_interior, depicts_real_equipment, allowed_uses)
           values ($1, $2, 10, 10, 10, 'webp', 'photo_rights_v0', 'ai_generated_demo', $3, false, false, false, false, false,
                   '{"edit": true, "crop": true, "commercial": true, "public_web": true}')`,
          [s.prospectId, sha256Hex(randomUUID()), status],
        ),
        status,
      ).rejects.toThrow(/ai_demo_real_shop|sales_demo_images_/);
    }
  });
});

describe("quality review (separate from the send approval)", () => {
  it("approves with every item ok and both renders viewed; records the note trimmed; points the demo at the version", async () => {
    const s = await shop();
    const v = await newVersion(s);
    const res = await review(admin, v, { p_note: "  PC と SP の両方を確認。  " });
    expect(res.error).toBeNull();
    expect(res.data).toMatchObject({ version_id: v.id, status: "approved", replayed: false });
    const r = (await db.query("select * from public.sales_demo_quality_reviews where version_id = $1", [v.id])).rows[0];
    expect(r).toMatchObject({ decision: "approved", state: "active", reviewed_by: adminId, bundle_sha256: v.bundle, note: "PC と SP の両方を確認。", viewed_renders_sha256: viewed(v.seed) });
    expect(await versionRow(v.id)).toMatchObject({ status: "approved" });
    expect((await demoRow(s.demoId)).approved_version_id).toBe(v.id);
    expect((await review(admin, v)).data).toMatchObject({ replayed: true });
    // No send approval was created or changed by the quality approval.
    expect((await db.query("select count(*)::int as n from public.sales_outreach_approvals")).rows[0].n).toBe(0);
  });

  it("validates the note: empty is null; URL, email, over 500 characters are refused before anything is written", async () => {
    const s = await shop();
    const v = await newVersion(s);
    for (const note of [
      "詳しくは https://example.com", "www.example.com を参照", "info@example.com に連絡", "長".repeat(501),
      // review round 1 L3: bare domains, full-width forms (NFKC), other schemes
      "example.com/x を参照", "参考 example.com", "ｈｔｔｐｓ：／／ｅｘａｍｐｌｅ", "ｅｘａｍｐｌｅ．ｃｏｍ を見る", "info＠example．com", "ftp://x", "shop.example.jp:8080 で",
    ]) {
      expect((await review(admin, v, { p_decision: "changes_requested", p_note: note })).error?.message, note).toContain("invalid_note");
    }
    expect((await db.query("select count(*)::int as n from public.sales_demo_quality_reviews")).rows[0].n).toBe(0);
    expect((await review(admin, v, { p_decision: "changes_requested", p_note: "   ", p_checklist: { ...ALL_OK, not_a_copy: "ng" } })).error).toBeNull();
    // Ordinary notes with numbers and dots still pass.
    expect((await review(admin, v, { p_decision: "changes_requested", p_note: "版 1.2 の SP390 で見出しが 2 行。PC1440 は可。", p_checklist: { ...ALL_OK, not_a_copy: "ng" } })).error).toBeNull();
    expect((await db.query("select note, decision from public.sales_demo_quality_reviews where version_id = $1 order by reviewed_at, note nulls first", [v.id])).rows).toEqual([
      { note: null, decision: "changes_requested" },
      { note: "版 1.2 の SP390 で見出しが 2 行。PC1440 は可。", decision: "changes_requested" },
    ]);
    expect(await versionRow(v.id)).toMatchObject({ status: "draft" });
  });

  it("ties 'viewed both renders' to the version's render files", async () => {
    const s = await shop();
    const v = await newVersion(s);
    expect((await review(admin, v, { p_viewed_renders: { desktop_1440: fileSha("desktop_1440", v.seed) } })).error?.message).toContain("render_not_viewed");
    expect((await review(admin, v, { p_viewed_renders: { ...viewed(v.seed), mobile_390: sha256Hex("other") } })).error?.message).toContain("render_not_viewed");
    expect((await review(admin, v, { p_viewed_renders: { ...viewed(v.seed), tablet_768: sha256Hex("tablet") } })).error?.message).toContain("render_not_viewed");
    expect((await review(admin, v, { p_viewed_renders: { ...viewed(v.seed), desktop: sha256Hex("x") } })).error?.message).toContain("invalid_renders");
    expect((await review(admin, v, { p_decision: "rejected", p_viewed_renders: { mobile_390: sha256Hex("forged") } })).error?.message).toContain("render_not_viewed");
    // A version without the SP390 render cannot be approved; one with a tablet render needs it viewed too.
    const noMobile = await newVersion(s, randomUUID(), {}, { renders: ["desktop_1440"] });
    expect((await review(admin, noMobile, { p_viewed_renders: viewed(noMobile.seed, ["desktop_1440"]) })).error?.message).toContain("render_missing");
    const tablet = await newVersion(s, randomUUID(), {}, { renders: ["desktop_1440", "tablet_768", "mobile_390"] });
    expect((await review(admin, tablet)).error?.message).toContain("render_not_viewed");
    expect((await review(admin, tablet, { p_viewed_renders: viewed(tablet.seed, ["desktop_1440", "tablet_768", "mobile_390"]) })).error).toBeNull();
    expect((await db.query("select count(*)::int as n from public.sales_demo_quality_reviews where version_id = $1", [v.id])).rows[0].n).toBe(0);
  });

  it("refuses an ng item, a bad checklist, stale content, changed facts, a failed validator and a disabled demo", async () => {
    const s = await shop();
    const v = await newVersion(s);
    expect((await review(admin, v, { p_checklist: { ...ALL_OK, shop_specific_structure: "ng" } })).error?.message).toContain("checklist_has_ng");
    expect((await review(admin, v, { p_checklist: { ...ALL_OK, extra: "ok" } })).error?.message).toContain("invalid_checklist");
    expect((await review(admin, v, { p_checklist: { identity_lock: "ok" } })).error?.message).toContain("invalid_checklist");
    expect((await review(admin, v, { p_bundle_sha256: sha256Hex("other") })).error?.message).toContain("stale_version");
    expect((await review(admin, v, { p_decision: "maybe" })).error?.message).toContain("invalid_decision");
    await db.query("update public.sales_demos set content = content || '{\"hours\": \"10-18\"}'::jsonb where id = $1", [s.demoId]);
    expect((await review(admin, v)).error?.message).toContain("demo_facts_changed");
    expect(await versionRow(v.id)).toMatchObject({ status: "draft" });
  });

  it("approving another version supersedes the first; at most one active approval per demo", async () => {
    const s = await shop();
    const a = await newVersion(s);
    const b = await newVersion(s, randomUUID(), { p_parent_version_id: a.id });
    const ra = await approveVersion(a);
    const rb = await approveVersion(b);
    expect(await versionRow(a.id)).toMatchObject({ status: "superseded" });
    expect(await versionRow(b.id)).toMatchObject({ status: "approved" });
    expect((await db.query("select state, invalidated_reason from public.sales_demo_quality_reviews where id = $1", [ra])).rows[0]).toEqual({ state: "invalidated", invalidated_reason: "superseded_by_newer_approval" });
    expect((await db.query("select state from public.sales_demo_quality_reviews where id = $1", [rb])).rows[0].state).toBe("active");
    expect((await demoRow(s.demoId)).approved_version_id).toBe(b.id);
    // Re-approving the superseded version is allowed and supersedes b.
    expect((await review(admin, a)).error).toBeNull();
    expect((await db.query("select count(*)::int as n from public.sales_demo_quality_reviews where demo_id = $1 and decision = 'approved' and state = 'active'", [s.demoId])).rows[0].n).toBe(1);
  });
});

describe("§9.3 demo_version hash and the DEV-195 send approval", () => {
  it("a demo without an approved version keeps exactly the legacy hash, even with draft versions; approval changes it; withdraw restores it", async () => {
    const s = await shop();
    const legacy = await legacyHash(s.demoId);
    expect(await demoHash(s.demoId)).toBe(legacy);
    const v = await newVersion(s);
    expect(await demoHash(s.demoId)).toBe(legacy);
    // A legacy send approval made now stays current across a draft version.
    const approval = await approve(admin, s.outreachId);
    expect(approval.error).toBeNull();
    expect((await db.query("select demo_version, demo_version_id from public.sales_outreach_approvals where id = $1", [(approval.data as { approval_id: string }).approval_id])).rows[0]).toEqual({ demo_version: legacy, demo_version_id: null });
    const reviewId = await approveVersion(v);
    expect(await demoHash(s.demoId)).not.toBe(legacy);
    // The approval made against the React demo no longer matches what would be sent.
    const opened = await admin.rpc("sales_mark_send_opened", { p_approval_id: (approval.data as { approval_id: string }).approval_id, p_via: "instagram_profile", p_design_enabled: false });
    expect(opened.error?.message).toMatch(/stale_snapshot|demo_not_shareable/);
    expect((await admin.rpc("sales_withdraw_demo_quality_review", { p_review_id: reviewId })).error).toBeNull();
    expect(await demoHash(s.demoId)).toBe(legacy);
    expect(await versionRow(v.id)).toMatchObject({ status: "draft" });
  });

  it("an unapproved (draft) version never changes the send: the React demo is approved and sent as before", async () => {
    const s = await shop();
    await newVersion(s);
    const res = await approveAndMarkSent(admin, s.outreachId);
    expect(res.error).toBeNull();
    expect((await db.query("select demo_version_id, demo_unavailable_after_open, state from public.sales_outreach_approvals where outreach_id = $1", [s.outreachId])).rows[0]).toEqual({ demo_version_id: null, demo_unavailable_after_open: null, state: "sent" });
    expect(await resolveShare(s.token)).toEqual({ mode: "legacy" });
  });

  it("with an approved version, a send approval is refused while versioned sharing is disabled (demo_not_shareable)", async () => {
    const s = await shop();
    const v = await newVersion(s);
    await approveVersion(v);
    expect((await approve(admin, s.outreachId)).error?.message).toContain("demo_not_shareable");
    expect((await db.query("select count(*)::int as n from public.sales_outreach_approvals")).rows[0].n).toBe(0);
  });

  it("re-derives the version, quality and facts at the guard instead of trusting stored state", async () => {
    const s = await shop();
    const v = await newVersion(s);
    const reviewId = await approveVersion(v);
    await db.query("update public.sales_demo_quality_reviews set state = 'invalidated', invalidated_at = now(), invalidated_reason = 'rights_changed' where id = $1", [reviewId]);
    expect((await approve(admin, s.outreachId)).error?.message).toContain("demo_quality_not_approved");
    await db.query("update public.sales_demo_versions set expires_at = now() - interval '1 minute' where id = $1", [v.id]);
    expect((await approve(admin, s.outreachId)).error?.message).toContain("demo_version_unavailable");
    // The retention cannot be extended again for an unsent version (review round 1 L4).
    await expect(db.query("update public.sales_demo_versions set expires_at = now() + interval '1 day' where id = $1", [v.id])).rejects.toThrow(/demo_version_expiry_extension_forbidden/);
    const s2 = await shop();
    const v2 = await newVersion(s2);
    await approveVersion(v2);
    await db.query("update public.sales_demos set content = content || '{\"hours\": \"10-18\"}'::jsonb where id = $1", [s2.demoId]);
    expect((await approve(admin, s2.outreachId)).error?.message).toContain("demo_facts_changed");
    // The guard helper itself, for the record.
    expect((await db.query("select public.sales_demo_version_send_block(d) as c from public.sales_demos d where d.id = $1", [s2.demoId])).rows[0].c).toBe("demo_facts_changed");
  });
});

describe("§9.5 send_opened", () => {
  it("every hash-changing operation answers approval_open and writes nothing", async () => {
    const s = await shop();
    const photo = { name: "page/photos/hero-desktop.webp", sha256: sha256Hex(`photo-${randomUUID()}`) };
    const a = await newVersion(s, randomUUID(), { p_images: [aiConceptImage(photo.sha256, adminId)] }, { photos: [photo] });
    const b = await newVersion(s);
    const reviewId = await approveVersion(a);
    await forceOpenedApproval(s, null);
    expect((await review(admin, b)).error?.message).toContain("approval_open");
    expect((await admin.rpc("sales_withdraw_demo_quality_review", { p_review_id: reviewId })).error?.message).toContain("approval_open");
    expect((await admin.rpc("sales_revoke_demo_version", { p_version_id: a.id, p_code: "RIGHTS_COMPLAINT" })).error?.message).toContain("approval_open");
    const imageId = (await db.query("select id from public.sales_demo_images where sha256 = $1", [photo.sha256])).rows[0].id;
    expect((await admin.rpc("sales_revoke_demo_image", { p_image_id: imageId, p_code: "RIGHTS_COMPLAINT" })).error?.message).toContain("approval_open");
    expect(await versionRow(a.id)).toMatchObject({ status: "approved", revoked_at: null });
    expect(await versionRow(b.id)).toMatchObject({ status: "draft" });
    expect((await demoRow(s.demoId)).approved_version_id).toBe(a.id);
    expect((await db.query("select revoked_at from public.sales_demo_images where id = $1", [imageId])).rows[0].revoked_at).toBeNull();
  });

  it("a send confirmed from send_opened is recorded with demo_unavailable_after_open, and the share URL shows nothing (no fallback)", async () => {
    const s = await shop();
    const v = await newVersion(s);
    await approveVersion(v);
    const approvalId = await forceOpenedApproval(s, v.id);
    const res = await admin.rpc("sales_mark_sent", { p_outreach_id: s.outreachId, p_approval_id: approvalId, p_design_enabled: false });
    expect(res.error, res.error?.message).toBeNull();
    expect(res.data).toMatchObject({ status: "sent", demo_unavailable_after_open: "not_shareable", replayed: false });
    expect((await db.query("select state, demo_version_id, demo_unavailable_after_open from public.sales_outreach_approvals where id = $1", [approvalId])).rows[0]).toEqual({ state: "sent", demo_version_id: v.id, demo_unavailable_after_open: "not_shareable" });
    // Kept for the admin about 30 days after the 30-day share period.
    expect(new Date((await versionRow(v.id)).expires_at).getTime() - Date.now()).toBeGreaterThan(59 * 86_400_000);
    expect(await resolveShare(s.token)).toEqual({ mode: "none" });
    // Revoked afterwards: still nothing, never the React demo or another version.
    expect((await admin.rpc("sales_revoke_demo_version", { p_version_id: v.id, p_code: "RIGHTS_COMPLAINT" })).error).toBeNull();
    await newVersion(s).catch(() => undefined);
    expect(await resolveShare(s.token)).toEqual({ mode: "none" });
    // A finished approval keeps its record.
    await expect(db.query("update public.sales_outreach_approvals set demo_unavailable_after_open = null where id = $1", [approvalId])).rejects.toThrow(/approval_final_immutable/);
  });

  it("an expired pinned version is recorded as version_expired, not refused", async () => {
    const s = await shop();
    const v = await newVersion(s);
    await approveVersion(v);
    const approvalId = await forceOpenedApproval(s, v.id);
    await db.query("update public.sales_demo_versions set expires_at = now() - interval '1 minute' where id = $1", [v.id]);
    const res = await admin.rpc("sales_mark_sent", { p_outreach_id: s.outreachId, p_approval_id: approvalId, p_design_enabled: false });
    expect(res.error, res.error?.message).toBeNull();
    expect(res.data).toMatchObject({ status: "sent", demo_unavailable_after_open: "version_expired" });
  });

  it("an approval cannot pin a version inconsistently (wrong bundle or no active quality approval)", async () => {
    const s = await shop();
    const v = await newVersion(s);
    await expect(forceOpenedApproval(s, v.id)).rejects.toThrow(/approval_demo_pin_mismatch|sales_outreach_approvals_demo_pin/);
  });
});

describe("share resolution: versioned sharing disabled, legacy React demo unchanged", () => {
  it("legacy sent demo → legacy; unsent / disabled / expired → none; versions are never shareable", async () => {
    const sent = await shop();
    expect((await approveAndMarkSent(admin, sent.outreachId)).error).toBeNull();
    expect(await resolveShare(sent.token)).toEqual({ mode: "legacy" });
    const unsent = await shop();
    expect(await resolveShare(unsent.token)).toEqual({ mode: "none" });
    expect(await resolveShare("x".repeat(43))).toEqual({ mode: "none" });
    await db.query("update public.sales_demos set disabled_at = now() where id = $1", [sent.demoId]);
    expect(await resolveShare(sent.token)).toEqual({ mode: "none" });
    const flags = (await db.query("select public.sales_demo_versioned_sharing_enabled() as s, public.sales_demo_share_photos_enabled() as p")).rows[0];
    expect(flags).toEqual({ s: false, p: false });
    const v = await newVersion(unsent);
    expect((await db.query("select public.sales_demo_version_shareable($1) as s, public.sales_demo_version_rights_shareable($1) as r", [v.id])).rows[0]).toEqual({ s: false, r: true });
  });

  it("ai_concept_internal: preview and quality approval are possible, sharing never", async () => {
    const s = await shop();
    const photo = { name: "page/photos/hero-desktop.webp", sha256: sha256Hex(`photo-${randomUUID()}`) };
    const v = await newVersion(s, randomUUID(), { p_images: [aiConceptImage(photo.sha256, adminId)] }, { photos: [photo] });
    const img = (await db.query("select i.*, public.sales_demo_image_previewable(i) as preview, public.sales_demo_image_shareable(i) as share from public.sales_demo_images i where sha256 = $1", [photo.sha256])).rows[0];
    expect(img).toMatchObject({ rights_status: "ai_concept_internal", preview: true, share: false });
    expect((await db.query("select public.sales_demo_version_rights_shareable($1) as r", [v.id])).rows[0].r).toBe(false);
    await approveVersion(v);
    expect((await approve(admin, s.outreachId)).error?.message).toContain("demo_not_shareable");
    await expect(db.query("update public.sales_demo_versions set share_eligible = true where id = $1", [v.id])).rejects.toThrow(/share_eligible/);
  });
});

describe("revocation", () => {
  it("revoking a version invalidates its approval, clears the demo pointer and restores the legacy hash; it is final", async () => {
    const s = await shop();
    const v = await newVersion(s);
    const reviewId = await approveVersion(v);
    expect((await admin.rpc("sales_revoke_demo_version", { p_version_id: v.id, p_code: "bad" })).error?.message).toContain("invalid_code");
    const res = await admin.rpc("sales_revoke_demo_version", { p_version_id: v.id, p_code: "FACT_ERROR" });
    expect(res.error).toBeNull();
    expect(await versionRow(v.id)).toMatchObject({ status: "revoked", revoke_code: "FACT_ERROR", revoked_by: adminId });
    expect((await db.query("select state, invalidated_reason from public.sales_demo_quality_reviews where id = $1", [reviewId])).rows[0]).toEqual({ state: "invalidated", invalidated_reason: "version_revoked" });
    expect((await demoRow(s.demoId)).approved_version_id).toBeNull();
    expect(await demoHash(s.demoId)).toBe(await legacyHash(s.demoId));
    expect((await admin.rpc("sales_revoke_demo_version", { p_version_id: v.id, p_code: "FACT_ERROR" })).data).toMatchObject({ replayed: true });
    expect((await review(admin, v)).error?.message).toContain("version_not_reviewable");
  });

  it("revoking an image sends every version using it back to draft and invalidates their approvals (rights_changed)", async () => {
    const s = await shop();
    const photo = { name: "page/photos/hero-desktop.webp", sha256: sha256Hex(`photo-${randomUUID()}`) };
    const v = await newVersion(s, randomUUID(), { p_images: [aiConceptImage(photo.sha256, adminId)] }, { photos: [photo] });
    const reviewId = await approveVersion(v);
    const imageId = (await db.query("select id from public.sales_demo_images where sha256 = $1", [photo.sha256])).rows[0].id;
    expect((await admin.rpc("sales_revoke_demo_image", { p_image_id: imageId, p_code: "RIGHTS_COMPLAINT" })).error).toBeNull();
    expect((await db.query("select rights_status, revoke_code from public.sales_demo_images where id = $1", [imageId])).rows[0]).toEqual({ rights_status: "revoked", revoke_code: "RIGHTS_COMPLAINT" });
    expect(await versionRow(v.id)).toMatchObject({ status: "draft" });
    expect((await db.query("select state, invalidated_reason from public.sales_demo_quality_reviews where id = $1", [reviewId])).rows[0]).toEqual({ state: "invalidated", invalidated_reason: "rights_changed" });
    expect((await demoRow(s.demoId)).approved_version_id).toBeNull();
    expect((await review(admin, v)).error?.message).toContain("rights_not_previewable");
    await expect(db.query("update public.sales_demo_images set rights_status = 'expired' where id = $1", [imageId])).rejects.toThrow(/demo_image_revoked_final/);
  });
});

describe("foreign keys", () => {
  it("versions keep their demo (and shop) from being deleted; files need a version; reviews need a version", async () => {
    const s = await shop();
    await newVersion(s);
    await expect(db.query("delete from public.sales_prospects where id = $1", [s.prospectId])).rejects.toThrow(/foreign key/);
    await expect(
      db.query("insert into public.sales_demo_version_files (version_id, path, role, sha256, bytes, content_type) values ($1, 'page/index.html', 'html', repeat('a', 64), 1, 'text/html')", [randomUUID()]),
    ).rejects.toThrow(/demo_version_files_immutable|foreign key/);
    await expect(db.query("update public.sales_demos set approved_version_id = $2 where id = $1", [s.demoId, randomUUID()])).rejects.toThrow(/admin_identity_required|foreign key/);
  });
});

// Whether the local storage API is running, decided narrowly by storageStatus (DEV-196o): only "not running" skips —
// a missing or public bucket or any other error fails the file, and with SR_REQUIRE_STORAGE=1 (CI) so does "not running".
const storage = await storageStatus(supabaseUrl, serviceRoleKey);
const storageUp = storage.available;

// Spec §5 / T4. DB-level assertions run everywhere (a local stack started with
// `-x storage-api` may have the storage schema without the API); the Storage API
// test needs the storage service, which CI runs (DEV-196o).
describe("Storage (private bucket, service role only)", () => {
  it("no storage policy lets anon or signed-in users at the bucket (DB level, runs in CI)", async () => {
    const { rows: has } = await db.query("select to_regclass('storage.objects') is not null as objects, to_regclass('storage.buckets') is not null as buckets");
    if (has[0].objects) {
      const { rows } = await db.query(
        "select policyname from pg_policies where schemaname = 'storage' and (roles && array['anon', 'authenticated', 'public']::name[] or qual ilike '%sales-demo-versions%' or with_check ilike '%sales-demo-versions%')",
      );
      expect(rows).toEqual([]);
    }
    if (has[0].buckets) {
      // If the bucket exists in this database, it is private.
      const { rows } = await db.query("select public from storage.buckets where id = 'sales-demo-versions'");
      expect(rows.every((r) => r.public === false)).toBe(true);
      // No public bucket at all.
      expect((await db.query("select id from storage.buckets where public")).rows).toEqual([]);
    }
  });

  // Storage-dependent only: skipped when the storage API is not running (never in CI: SR_REQUIRE_STORAGE=1).
  it.skipIf(!storageUp)(`the bucket is private with the spec's limits; anon / signed-in users cannot read or write; the service role can${storage.available ? "" : ` [skipped: ${storage.reason}]`}`, async () => {
    const svc = serviceClient();
    const { data: bucket, error } = await svc.storage.getBucket("sales-demo-versions");
    expect(error).toBeNull();
    expect(bucket).toMatchObject({ public: false, file_size_limit: 4 * 1024 * 1024 });
    expect([...(bucket?.allowed_mime_types ?? [])].sort()).toEqual(["image/jpeg", "image/webp", "text/css", "text/html"]);
    const key = `v1/${randomUUID()}/${randomUUID()}/page/index.html`;
    expect((await svc.storage.from("sales-demo-versions").upload(key, new Blob(["<p>t</p>"], { type: "text/html" }), { contentType: "text/html" })).error).toBeNull();
    expect((await svc.storage.from("sales-demo-versions").download(key)).error).toBeNull();
    for (const client of [anonClient(), outsider, admin]) {
      expect((await client.storage.from("sales-demo-versions").download(key)).data).toBeNull();
      expect((await client.storage.from("sales-demo-versions").upload(`${key}.x.html`, new Blob(["x"], { type: "text/html" }), { contentType: "text/html" })).error).not.toBeNull();
      expect((await client.storage.from("sales-demo-versions").list(key.split("/").slice(0, 3).join("/"))).data ?? []).toEqual([]);
    }
    // Not a public bucket: the public URL serves nothing.
    expect((await fetch(svc.storage.from("sales-demo-versions").getPublicUrl(key).data.publicUrl)).ok).toBe(false);
    // PNG and SVG are not accepted.
    for (const [name, type] of [["renders/x.png", "image/png"], ["photos/x.svg", "image/svg+xml"]]) {
      expect((await svc.storage.from("sales-demo-versions").upload(`v1/t/${randomUUID()}/${name}`, new Blob(["x"], { type }), { contentType: type })).error, type).not.toBeNull();
    }
    await svc.storage.from("sales-demo-versions").remove([key]);
  });
});
