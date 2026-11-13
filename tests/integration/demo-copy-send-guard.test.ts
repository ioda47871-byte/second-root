import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PoolClient } from "pg";
import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeCopyFiles } from "@/lib/demo-version-package/copy";
import { importPackage, type PackageStore } from "@/lib/demo-version-package/import";
import { buildPackage, PACKAGE_FORMAT_COPY, type DemoVersionPackage } from "@/lib/demo-version-package/package";
import { loadVersionCopyGate, OUTREACH_DEMO_SELECT, outreachCopyGate } from "@/lib/sales/copy-review/store";
import { bundleSha256, sha256Hex, validateManifest, type ArtifactManifest } from "@/lib/sales/demo-version/manifest";
import { QUALITY_CHECKLIST_ITEMS } from "@/lib/sales/demo-version/quality";
import { auditReviseChain, candidateOf, cleanRound0, failingRound0, failingRound1, json, otherRound0, ownerReviseChain, sameFactsOtherLane, type Round } from "../support/copy-review-fixture";
import { anonClient, approve, candidate, createUser, db, makeAdmin, nameFactsInContent, registerFacts, resetSalesData, rpc, serviceClient, signedInClient, verifiedRun } from "./helpers";

// DEV-199e (Issue #258 decision ①): the copy review store, the owner's copy confirmation and the copy send guard of a
// demo version, on the LOCAL stack. Fictional / made-up shops and example.com only; no network, no model, no real send.
// The made-up real-shop sample ("パン店 見本") is imported into test prospects; nothing touches 輪 (SR-001).

const MIGRATION = "supabase/migrations/20261113000000_sales_demo_copy_send_guard.sql";
const ALL_OK = Object.fromEntries(QUALITY_CHECKLIST_ITEMS.map((k) => [k, "ok"]));
const COPY_TABLES = ["sales_demo_copy_reviews", "sales_demo_copy_facts_checks", "sales_demo_version_copy_links", "sales_demo_copy_owner_decisions"];

let admin: SupabaseClient;
let outsider: SupabaseClient;
let adminId: string;

async function shop() {
  const runId = randomUUID();
  await verifiedRun(runId, { c01: candidate() });
  await rpc("sales_run_begin_persist", { p_run_id: runId });
  const r = await rpc<{ prospect_id: string; stage: string }>("sales_persist_candidate", { p_run_id: runId, p_key: "c01" });
  await rpc("sales_run_finalize", { p_run_id: runId });
  const { rows } = await db.query(
    "select d.id as demo_id, o.id as outreach_id from public.sales_demos d join public.sales_outreaches o on o.prospect_id = d.prospect_id and o.kind = 'initial' where d.prospect_id = $1",
    [r.prospect_id],
  );
  return { prospectId: r.prospect_id, demoId: rows[0].demo_id as string, outreachId: rows[0].outreach_id as string };
}
type Shop = Awaited<ReturnType<typeof shop>>;

function memoryStore(): PackageStore {
  const objects = new Map<string, Uint8Array>();
  return { download: async (k) => objects.get(k) ?? null, upload: async (k, b) => void objects.set(k, b) };
}

const png = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: Math.floor(Math.random() * 255), g: Math.floor(Math.random() * 255), b: Math.floor(Math.random() * 255) } } }).png().toBuffer();

/** A v2 package of this round (and its earlier rounds), with renders unique to the call (a new bundle each time). */
async function pkgOf(r: Round, earlier: Round[] = []): Promise<DemoVersionPackage> {
  return buildPackage({
    html: String(r.files.pageHtml),
    css: String(r.files.pageCss),
    renders: { desktop_1440: new Uint8Array(await png(1440, 900)), mobile_390: new Uint8Array(await png(390, 900)) },
    source: "test",
    copy: { factsPack: r.files.factsPack, copyRecord: r.files.copyRecord, review: json(r.review), rounds: earlier.map((e) => ({ copyRecord: e.files.copyRecord, pageHtml: e.files.pageHtml, pageCss: e.files.pageCss, review: json(e.review) })) },
  });
}

/**
 * A v2 package whose copy buildPackage would refuse (a failed review): the page is built alone and the copy files are
 * attached with the builder's own makeCopyFiles, as a generator could hand it over. importPackage checks it again.
 */
async function rawPkgOf(r: Round, earlier: Round[] = []): Promise<DemoVersionPackage> {
  const page = await buildPackage({ html: String(r.files.pageHtml), css: String(r.files.pageCss), renders: { desktop_1440: new Uint8Array(await png(1440, 900)), mobile_390: new Uint8Array(await png(390, 900)) }, source: "test" });
  const copy = makeCopyFiles({ factsPack: r.files.factsPack, copyRecord: r.files.copyRecord, review: json(r.review), rounds: earlier.map((e) => ({ copyRecord: e.files.copyRecord, pageHtml: e.files.pageHtml, pageCss: e.files.pageCss, review: json(e.review) })) }, page.bundleSha256);
  return { ...page, format: PACKAGE_FORMAT_COPY, ...copy };
}

const versionCount = async (s: Shop) => (await db.query("select count(*)::int as n from public.sales_demo_versions where demo_id = $1", [s.demoId])).rows[0].n as number;

/**
 * importPackage as the local operator; `trusted`: the facts pack from the facts path — DEV-263f: registered in the facts
 * store first (as the admin), then read from the store.
 */
const importRound = async (s: Shop, pkg: DemoVersionPackage, r: Round, trusted = true) => {
  // the demo was derived from this pack (its content names it) whether or not the import reads the facts store
  await nameFactsInContent(s.demoId, r.files.factsPack);
  if (trusted) await registerFacts(s.demoId, r.files.factsPack, adminId);
  return importPackage(pkg, { client: serviceClient(), store: memoryStore(), demoId: s.demoId, factsFromStore: trusted });
};

async function approveQuality(versionId: string) {
  const v = (await db.query("select bundle_sha256 from public.sales_demo_versions where id = $1", [versionId])).rows[0];
  const files = (await db.query("select path, sha256 from public.sales_demo_version_files where version_id = $1 and role = 'render'", [versionId])).rows;
  const viewed = Object.fromEntries(files.map((f) => [String(f.path).replace(/^renders\/(.*)\.webp$/, "$1"), f.sha256]));
  const res = await admin.rpc("sales_review_demo_version", { p_version_id: versionId, p_decision: "approved", p_checklist: ALL_OK, p_viewed_renders: viewed, p_bundle_sha256: v.bundle_sha256, p_note: null });
  expect(res.error, res.error?.message).toBeNull();
}

const reviewRow = async (id: string) => (await db.query("select * from public.sales_demo_copy_reviews where id = $1", [id])).rows[0];

async function decide(client: SupabaseClient, versionId: string, reviewId: string, decision: "approve" | "revise" | "reject", over: Record<string, unknown> = {}) {
  const q = await reviewRow(reviewId);
  return client.rpc("sales_decide_copy_review", {
    p_version_id: versionId, p_review_id: reviewId, p_decision: decision, p_review_sha256: q.review_sha256, p_facts_sha256: q.facts_sha256,
    p_copy_sha256: q.copy_sha256, p_page_html_sha256: q.page_html_sha256, p_page_css_sha256: q.page_css_sha256, p_note: null, ...over,
  });
}

const copyBlock = async (versionId: string) => (await db.query("select public.sales_copy_send_block($1) as c", [versionId])).rows[0].c as string | null;
const sendBlockOn = async (c: PoolClient | typeof db, demoId: string) => (await c.query("select public.sales_demo_version_send_block(d) as c from public.sales_demos d where d.id = $1", [demoId])).rows[0].c as string | null;

/** Runs f with versioned sharing switched on INSIDE a transaction that is always rolled back (the schema never changes). */
async function withSharingOn<T>(f: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query("begin");
    await c.query("create or replace function public.sales_demo_versioned_sharing_enabled() returns boolean language sql immutable set search_path = '' as $$ select true $$");
    return await f(c);
  } finally {
    await c.query("rollback");
    c.release();
  }
}

const recordDirect = async (s: Shop, r: Round, o: { versionId?: string | null; gate?: string[]; facts?: boolean } = {}) => {
  const c = candidateOf(r);
  // DEV-263f: a facts-path check needs the review's facts pack to be the shop's current stored one
  await nameFactsInContent(s.demoId, c.factsPack);
  if (o.facts ?? true) await registerFacts(s.demoId, c.factsPack, adminId);
  return serviceClient().rpc("sales_record_copy_review", {
    p_demo_id: s.demoId, p_version_id: o.versionId ?? null, p_review: c.review, p_copy_record: c.copyRecord, p_facts_pack: c.factsPack,
    p_page_html: c.pageHtml, p_page_css: c.pageCss, p_gate_blockers: o.gate ?? ["OWNER_APPROVAL_MISSING"], p_facts_from_facts_path: o.facts ?? true,
  });
};

beforeAll(async () => {
  await resetSalesData();
  adminId = await createUser("copy-guard-admin@test.example.com");
  await makeAdmin(adminId);
  await createUser("copy-guard-outsider@test.example.com");
  admin = await signedInClient("copy-guard-admin@test.example.com");
  outsider = await signedInClient("copy-guard-outsider@test.example.com");
});
beforeEach(async () => {
  await db.query(
    `truncate ${COPY_TABLES.map((t) => `public.${t}`).join(", ")}, public.sales_demo_quality_reviews, public.sales_demo_version_files, public.sales_demo_versions, public.sales_demo_images, public.sales_exclusions, public.sales_outreach_approvals, public.sales_outreach_draft_edits, public.sales_prospect_insights, public.sales_outreaches, public.sales_demos, public.sales_sources, public.sales_prospects, public.sales_agent_runs cascade`,
  );
});
afterAll(resetSalesData);

describe("happy path: imported, stored, quality approved, owner confirmed", () => {
  it("the copy gate passes only after the owner's approval; the versioned send still stops at demo_not_shareable while sharing is off", async () => {
    const s = await shop();
    const r0 = cleanRound0();
    const res = await importRound(s, await pkgOf(r0), r0);
    expect(res.storedCopy).toMatchObject({ round: 0, replayed: false, copy_verdict: "approve_candidate", next_step: "owner_review", facts_from_facts_path: true, linked_version_id: res.versionId });
    const q = await reviewRow(res.storedCopy!.review_id);
    expect(q).toMatchObject({ prospect_id: s.prospectId, lane: "real_shop_proposal", round: 0, verdict: "hold", copy_verdict: "approve_candidate", gate_blockers: ["OWNER_APPROVAL_MISSING"], auditor_version: "copy_quality_rules_v1" });
    expect([q.facts_sha256, q.copy_sha256, q.page_html_sha256, q.page_css_sha256]).toEqual([sha256Hex(String(r0.files.factsPack)), sha256Hex(String(r0.files.copyRecord)), sha256Hex(String(r0.files.pageHtml)), sha256Hex(String(r0.files.pageCss))]);
    expect(q.review_sha256).toBe(sha256Hex(json(r0.review)));
    expect(q.facts_content_sha256).toBe(r0.review.facts_content_sha256);

    expect(await copyBlock(res.versionId)).toBe("demo_copy_owner_confirmation_missing");
    await approveQuality(res.versionId);
    expect(await sendBlockOn(db, s.demoId)).toBe("demo_not_shareable");
    expect(await withSharingOn((c) => sendBlockOn(c, s.demoId))).toBe("demo_copy_owner_confirmation_missing");
    expect(await outreachCopyGate(admin, s.outreachId)).toMatchObject({ legacy: false, ok: false, code: "demo_copy_owner_confirmation_missing" });

    const d = await decide(admin, res.versionId, q.id, "approve");
    expect(d.error, d.error?.message).toBeNull();
    const row = (await db.query("select * from public.sales_demo_copy_owner_decisions where review_id = $1", [q.id])).rows[0];
    expect(row).toMatchObject({ version_id: res.versionId, decision: "approve", decided_by: adminId, review_sha256: q.review_sha256, copy_sha256: q.copy_sha256 });
    expect(await copyBlock(res.versionId)).toBeNull();
    expect(await withSharingOn((c) => sendBlockOn(c, s.demoId))).toBeNull();
    // the server re-runs the audit on the stored bytes, with the admin's own (RLS) reads
    expect(await loadVersionCopyGate(admin, res.versionId)).toEqual({ ok: true });
    expect(await outreachCopyGate(admin, s.outreachId)).toEqual({ legacy: false, ok: true });
    // sharing is still off: the send approval is refused with today's reason
    expect((await approve(admin, s.outreachId)).error?.message).toContain("demo_not_shareable");
  });
});

describe("each refusal of the copy send guard (database and server agree)", () => {
  it("no stored review: a version imported without copy, or ingested directly", async () => {
    const s = await shop();
    const plain = await buildPackage({ html: String(cleanRound0().files.pageHtml), css: String(cleanRound0().files.pageCss), renders: { desktop_1440: new Uint8Array(await png(1440, 900)), mobile_390: new Uint8Array(await png(390, 900)) }, source: "test" });
    const res = await importPackage(plain, { client: serviceClient(), store: memoryStore(), demoId: s.demoId });
    expect(res.copy.status).toBe("copy_unreviewed");
    expect(res.storedCopy).toBeNull();
    expect(await copyBlock(res.versionId)).toBe("demo_copy_review_missing");
    await approveQuality(res.versionId);
    expect(await withSharingOn((c) => sendBlockOn(c, s.demoId))).toBe("demo_copy_review_missing");
    expect(await loadVersionCopyGate(admin, res.versionId)).toMatchObject({ ok: false, code: "demo_copy_review_missing" });
  });

  it("facts not from the facts path: stored but never confirmable; a later import with the facts path adds the evidence (no trap)", async () => {
    const s = await shop();
    const r0 = cleanRound0();
    const pkg = await pkgOf(r0);
    const res = await importRound(s, pkg, r0, false);
    expect(res.storedCopy).toMatchObject({ facts_from_facts_path: false });
    expect(await copyBlock(res.versionId)).toBe("demo_copy_facts_not_from_facts_path");
    expect((await decide(admin, res.versionId, res.storedCopy!.review_id, "approve")).error?.message).toContain("copy_facts_not_from_facts_path");
    expect(await loadVersionCopyGate(admin, res.versionId)).toMatchObject({ ok: false, code: "demo_copy_facts_not_from_facts_path" });
    // the same package again, now with the facts pack from the facts path: a replay that records the check only
    const again = await importRound(s, pkg, r0, true);
    expect(again.storedCopy).toMatchObject({ review_id: res.storedCopy!.review_id, replayed: true, facts_from_facts_path: true });
    expect(await copyBlock(res.versionId)).toBe("demo_copy_owner_confirmation_missing");
  });

  it("not passed: a round asking for a revision (and the owner cannot approve it)", async () => {
    const s = await shop();
    const [r0] = auditReviseChain();
    const res = await importRound(s, await pkgOf(r0), r0);
    expect(res.storedCopy).toMatchObject({ copy_verdict: "revise", next_step: "revise" });
    expect(await copyBlock(res.versionId)).toBe("demo_copy_review_not_passed");
    expect((await decide(admin, res.versionId, res.storedCopy!.review_id, "approve")).error?.message).toContain("copy_review_not_at_owner_review");
  });

  it("stale: a later round followed; a review cannot be linked to a version whose files differ", async () => {
    const s = await shop();
    const [r0, r1] = auditReviseChain();
    const v0 = await importRound(s, await pkgOf(r0), r0);
    const v1 = await importRound(s, await pkgOf(r1, [r0]), r1);
    expect(v1.storedCopy).toMatchObject({ round: 1, previous_review_id: v0.storedCopy!.review_id, copy_verdict: "approve_candidate" });
    expect(await copyBlock(v0.versionId)).toBe("demo_copy_review_stale");
    expect(await copyBlock(v1.versionId)).toBe("demo_copy_owner_confirmation_missing");
    // stale-after-file-change: the round-1 review does not describe v0's files
    const link = await serviceClient().from("sales_demo_version_copy_links").insert({ version_id: v0.versionId, review_id: v1.storedCopy!.review_id, demo_id: s.demoId });
    expect(link.error?.message).toMatch(/version_copy_stale|duplicate key/);
    // a version with a changed page (CSS) is a new version without a review: not sendable until reviewed
    const changed = cleanRound0({ css: "body{margin:0;color:#222}\n" });
    const plain = await buildPackage({ html: String(changed.files.pageHtml), css: String(changed.files.pageCss), renders: { desktop_1440: new Uint8Array(await png(1440, 900)), mobile_390: new Uint8Array(await png(390, 900)) }, source: "test" });
    const v2 = await importPackage(plain, { client: serviceClient(), store: memoryStore(), demoId: s.demoId });
    expect(await copyBlock(v2.versionId)).toBe("demo_copy_review_missing");
    const linkStale = await serviceClient().from("sales_demo_version_copy_links").insert({ version_id: v2.versionId, review_id: v1.storedCopy!.review_id, demo_id: s.demoId });
    expect(linkStale.error?.message).toContain("version_copy_stale");
    // the server agrees on v0
    await decide(admin, v1.versionId, v1.storedCopy!.review_id, "approve");
    expect(await loadVersionCopyGate(admin, v0.versionId)).toMatchObject({ ok: false, code: "demo_copy_review_stale" });
    expect(await loadVersionCopyGate(admin, v1.versionId)).toEqual({ ok: true });
  });

  it("the stored gate found more than the missing owner approval", async () => {
    const s = await shop();
    const r0 = cleanRound0();
    const plain = await buildPackage({ html: String(r0.files.pageHtml), css: String(r0.files.pageCss), renders: { desktop_1440: new Uint8Array(await png(1440, 900)), mobile_390: new Uint8Array(await png(390, 900)) }, source: "test" });
    // DEV-263f: the demo names the pack before the version is made (the version's facts are the demo's)
    await nameFactsInContent(s.demoId, r0.files.factsPack);
    const v = await importPackage(plain, { client: serviceClient(), store: memoryStore(), demoId: s.demoId });
    const rec = await recordDirect(s, r0, { versionId: v.versionId, gate: ["OWNER_APPROVAL_MISSING", "REVIEW_INVALID"] });
    expect(rec.error, rec.error?.message).toBeNull();
    const reviewId = (rec.data as { review_id: string }).review_id;
    expect((await decide(admin, v.versionId, reviewId, "approve")).error).toBeNull();
    expect(await copyBlock(v.versionId)).toBe("demo_copy_send_blocked");
    expect(await loadVersionCopyGate(admin, v.versionId)).toMatchObject({ ok: false, code: "demo_copy_send_blocked" });
  });

  it("owner confirmation missing: none, revise, reject, or made on another version showing the same review", async () => {
    const s = await shop();
    const r0 = cleanRound0();
    const pkg = await pkgOf(r0);
    const a = await importRound(s, pkg, r0);
    // the same page with other renders: a second version, linked to the same stored review (a replay)
    const b = await importRound(s, await pkgOf(r0), r0);
    expect(b.storedCopy).toMatchObject({ review_id: a.storedCopy!.review_id, replayed: true, linked_version_id: b.versionId });
    expect(await copyBlock(a.versionId)).toBe("demo_copy_owner_confirmation_missing");
    expect((await decide(admin, a.versionId, a.storedCopy!.review_id, "approve")).error).toBeNull();
    expect(await copyBlock(a.versionId)).toBeNull();
    expect(await copyBlock(b.versionId)).toBe("demo_copy_owner_confirmation_missing");
    expect(await loadVersionCopyGate(admin, b.versionId)).toMatchObject({ ok: false, code: "demo_copy_owner_confirmation_missing" });
    // one decision per review: no second one (approve or otherwise)
    expect((await decide(admin, b.versionId, a.storedCopy!.review_id, "approve")).error?.message).toContain("copy_decision_exists");

    const t = await shop();
    const tr = await importRound(t, await pkgOf(r0), r0);
    expect((await decide(admin, tr.versionId, tr.storedCopy!.review_id, "reject")).error).toBeNull();
    expect(await copyBlock(tr.versionId)).toBe("demo_copy_owner_confirmation_missing");
  });

  it("owner confirmation bound to other hashes is refused at the source (what the owner saw must be the review)", async () => {
    const s = await shop();
    const r0 = cleanRound0();
    const v = await importRound(s, await pkgOf(r0), r0);
    for (const k of ["p_review_sha256", "p_facts_sha256", "p_copy_sha256", "p_page_html_sha256", "p_page_css_sha256"])
      expect((await decide(admin, v.versionId, v.storedCopy!.review_id, "approve", { [k]: "6".repeat(64) })).error?.message, k).toContain("stale_copy_review");
    // a direct write that bypasses the function (as the database owner, with an admin identity) is still bound
    const c = await db.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: adminId, role: "authenticated" })]);
      const q = await reviewRow(v.storedCopy!.review_id);
      await expect(
        c.query(
          "insert into public.sales_demo_copy_owner_decisions (review_id, version_id, demo_id, decision, review_sha256, facts_sha256, copy_sha256, page_html_sha256, page_css_sha256, decided_by) values ($1, $2, $3, 'approve', $4, $5, $6, $7, $8, $9)",
          [q.id, v.versionId, s.demoId, q.review_sha256, q.facts_sha256, "7".repeat(64), q.page_html_sha256, q.page_css_sha256, adminId],
        ),
      ).rejects.toThrow("copy_decision_snapshot_mismatch");
    } finally {
      await c.query("rollback");
      c.release();
    }
    expect(await copyBlock(v.versionId)).toBe("demo_copy_owner_confirmation_missing");
  });
});

describe("the review store: append-only, the chain rules, round-0 replay", () => {
  it("round-0 replay: another round 0 for the same shop and facts content is refused by the importer (before ingest) and by the database", async () => {
    const s = await shop();
    const r0 = cleanRound0();
    await importRound(s, await pkgOf(r0), r0);
    const before = (await db.query("select count(*)::int as n from public.sales_demo_versions where demo_id = $1", [s.demoId])).rows[0].n;
    const other = otherRound0();
    await expect(importRound(s, await pkgOf(other), other)).rejects.toThrow(/COPY_NOT_APPENDABLE.*ROUND_0_ALREADY_STORED/);
    expect((await db.query("select count(*)::int as n from public.sales_demo_versions where demo_id = $1", [s.demoId])).rows[0].n).toBe(before);
    expect((await recordDirect(s, other)).error?.message).toContain("copy_review_round_0_replay");
    // a round 1 with no stored round 0 for its chain
    const t = await shop();
    const [, r1] = auditReviseChain();
    expect((await recordDirect(t, r1)).error?.message).toContain("copy_review_first_not_round_0");
  });

  it("owner revise as an explicit step: round 1 after owner review is refused until the owner asks, then stored and confirmable", async () => {
    const s = await shop();
    const [g0, g1] = ownerReviseChain();
    const v0 = await importRound(s, await pkgOf(g0), g0);
    // before the owner's request: the importer and the database refuse the next round
    await expect(importRound(s, await pkgOf(g1, [g0]), g1)).rejects.toThrow(/LAST_ROUND_DOES_NOT_ALLOW_REVISION/);
    expect((await recordDirect(s, g1)).error?.message).toContain("copy_review_revision_not_allowed");
    // the service role cannot write the owner's request
    expect((await decide(serviceClient(), v0.versionId, v0.storedCopy!.review_id, "revise")).error?.code).toBe("42501");
    expect((await serviceClient().from("sales_demo_copy_owner_decisions").insert({ review_id: v0.storedCopy!.review_id, version_id: v0.versionId, demo_id: s.demoId, decision: "revise", review_sha256: "0".repeat(64), facts_sha256: "0".repeat(64), copy_sha256: "0".repeat(64), page_html_sha256: "0".repeat(64), page_css_sha256: "0".repeat(64), decided_by: adminId })).error?.message).toContain("admin_identity_required");
    expect((await decide(admin, v0.versionId, v0.storedCopy!.review_id, "revise")).error).toBeNull();
    const v1 = await importRound(s, await pkgOf(g1, [g0]), g1);
    expect(v1.storedCopy).toMatchObject({ round: 1, previous_review_id: v0.storedCopy!.review_id });
    expect(await copyBlock(v0.versionId)).toBe("demo_copy_review_stale");
  });

  it("nothing is updated or deleted, whoever writes; the service role's direct writes still follow the chain rules", async () => {
    const s = await shop();
    const r0 = cleanRound0();
    const v = await importRound(s, await pkgOf(r0), r0);
    await decide(admin, v.versionId, v.storedCopy!.review_id, "approve");
    const svc = serviceClient();
    expect((await svc.from("sales_demo_copy_reviews").update({ gate_blockers: ["OWNER_APPROVAL_MISSING"] }).eq("id", v.storedCopy!.review_id)).error?.message).toContain("copy_review_immutable");
    expect((await svc.from("sales_demo_copy_facts_checks").update({ facts_sha256: "1".repeat(64) }).eq("review_id", v.storedCopy!.review_id)).error?.message).toContain("copy_facts_check_immutable");
    expect((await svc.from("sales_demo_version_copy_links").update({ linked_at: new Date().toISOString() }).eq("version_id", v.versionId)).error?.message).toContain("version_copy_link_immutable");
    expect((await svc.from("sales_demo_copy_owner_decisions").update({ decision: "reject" }).eq("review_id", v.storedCopy!.review_id)).error?.message).toContain("copy_decision_immutable");
    const key: Record<string, string> = { sales_demo_copy_reviews: "id", sales_demo_copy_facts_checks: "review_id", sales_demo_version_copy_links: "version_id", sales_demo_copy_owner_decisions: "id" };
    // no DELETE grant for any API role (the service role included)
    for (const t of COPY_TABLES) expect((await svc.from(t).delete().not(key[t]!, "is", null)).error, t).not.toBeNull();
    // as the database owner, the triggers still refuse
    await expect(db.query("delete from public.sales_demo_copy_reviews where id = $1", [v.storedCopy!.review_id])).rejects.toThrow(/copy_review_delete_forbidden|foreign key/);
    await expect(db.query("delete from public.sales_demo_copy_owner_decisions where review_id = $1", [v.storedCopy!.review_id])).rejects.toThrow("copy_decision_immutable");
    // a direct insert with forged columns: every column is derived from the review text and the texts are re-hashed
    const c = candidateOf(otherRound0());
    const forged = await svc.from("sales_demo_copy_reviews").insert({
      prospect_id: s.prospectId, demo_id: s.demoId, shop_id: "x", lane: "real_shop_proposal", round: 0, auditor_version: "copy_quality_rules_v1", verdict: "approve_candidate",
      copy_verdict: "approve_candidate", next_step: "owner_review", unresolved: [], revision_findings: [], facts_sha256: "0".repeat(64), facts_content_sha256: "1".repeat(64),
      copy_sha256: "0".repeat(64), page_html_sha256: "0".repeat(64), page_css_sha256: "0".repeat(64), review_sha256: "0".repeat(64), gate_blockers: ["OWNER_APPROVAL_MISSING"],
      review_text: c.review, copy_record_text: c.copyRecord, facts_pack_text: c.factsPack, page_html_text: c.pageHtml, page_css_text: `${c.pageCss} `,
    });
    expect(forged.error?.message).toContain("copy_review_hash_mismatch");
    const replayed = await svc.from("sales_demo_copy_reviews").insert({
      prospect_id: s.prospectId, demo_id: s.demoId, shop_id: "x", lane: "real_shop_proposal", round: 0, auditor_version: "copy_quality_rules_v1", verdict: "approve_candidate",
      copy_verdict: "approve_candidate", next_step: "owner_review", unresolved: [], revision_findings: [], facts_sha256: "0".repeat(64), facts_content_sha256: "1".repeat(64),
      copy_sha256: "0".repeat(64), page_html_sha256: "0".repeat(64), page_css_sha256: "0".repeat(64), review_sha256: "0".repeat(64), gate_blockers: ["OWNER_APPROVAL_MISSING"],
      review_text: c.review, copy_record_text: c.copyRecord, facts_pack_text: c.factsPack, page_html_text: c.pageHtml, page_css_text: c.pageCss,
    });
    expect(replayed.error?.message).toContain("copy_review_round_0_replay");
    // a gate result that drops OWNER_APPROVAL_MISSING is refused by the table check
    expect((await recordDirect(s, otherRound0(), { gate: [] })).error).not.toBeNull();
  });
});

describe("RLS and grants", () => {
  it("only the admin reads the store; nobody signed in writes it; the owner function needs a signed-in admin; the record function is server-only", async () => {
    const s = await shop();
    const r0 = cleanRound0();
    const v = await importRound(s, await pkgOf(r0), r0);
    await decide(admin, v.versionId, v.storedCopy!.review_id, "approve");
    for (const t of COPY_TABLES) {
      expect((await admin.from(t).select("*")).data?.length, t).toBeGreaterThan(0);
      expect((await outsider.from(t).select("*")).data ?? [], t).toEqual([]);
      expect((await anonClient().from(t).select("*")).error, t).not.toBeNull();
      expect((await admin.from(t).insert({})).error?.code, t).toBe("42501");
      expect((await outsider.from(t).insert({})).error?.code, t).toBe("42501");
    }
    for (const client of [outsider, anonClient(), serviceClient()])
      expect((await decide(client, v.versionId, v.storedCopy!.review_id, "approve")).error?.code).toBe("42501");
    const c = candidateOf(r0);
    const args = { p_demo_id: s.demoId, p_version_id: null, p_review: c.review, p_copy_record: c.copyRecord, p_facts_pack: c.factsPack, p_page_html: c.pageHtml, p_page_css: c.pageCss, p_gate_blockers: ["OWNER_APPROVAL_MISSING"], p_facts_from_facts_path: true };
    for (const client of [admin, outsider, anonClient()]) expect((await client.rpc("sales_record_copy_review", args)).error, "record").not.toBeNull();
    const { rows } = await db.query(`
      select p.proname, p.prosecdef, has_function_privilege('authenticated', p.oid, 'EXECUTE') as authed, has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
             has_function_privilege('service_role', p.oid, 'EXECUTE') as service
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('sales_copy_codes_valid', 'sales_check_copy_review_write', 'sales_check_copy_facts_check_write', 'sales_check_version_copy_link_write',
        'sales_check_copy_decision_write', 'sales_copy_send_block', 'sales_record_copy_review', 'sales_decide_copy_review')
      order by p.proname`);
    expect(rows).toEqual(
      rows.map((r) => r.proname).map((proname) =>
        proname === "sales_decide_copy_review" ? { proname, prosecdef: true, authed: true, anon: false, service: true } : { proname, prosecdef: false, authed: false, anon: false, service: true },
      ),
    );
    expect(rows).toHaveLength(8);
    const { rows: deletes } = await db.query(`
      select c.relname, r.rolname, p.privilege_type from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join lateral (values ('DELETE'), ('TRUNCATE')) as p(privilege_type) cross join (values ('anon'), ('authenticated'), ('service_role')) as r(rolname)
      where n.nspname = 'public' and c.relname = any($1::text[]) and has_table_privilege(r.rolname, c.oid, p.privilege_type)`, [COPY_TABLES]);
    expect(deletes).toEqual([]);
  });
});

describe("PR #262 M1: failed reviews are stored and terminal; one lane per facts content", () => {
  it("round-0 fail: the import is refused but the failed review is stored; resubmitting the same facts is refused", async () => {
    const s = await shop();
    const f0 = failingRound0();
    await expect(importRound(s, await rawPkgOf(f0), f0)).rejects.toThrow(/COPY_INVALID/);
    expect(await versionCount(s)).toBe(0);
    const stored = (await db.query("select round, verdict, next_step, gate_blockers from public.sales_demo_copy_reviews where prospect_id = $1", [s.prospectId])).rows;
    expect(stored).toEqual([expect.objectContaining({ round: 0, verdict: "fail", next_step: "stop_fail" })]);
    expect(stored[0].gate_blockers).toEqual(expect.arrayContaining(["REVIEW_NOT_PASSED", "OWNER_APPROVAL_MISSING"]));
    // the fixed page as a fresh round 0: refused by the importer (before any version) and by the database
    const fixed = cleanRound0();
    await expect(importRound(s, await pkgOf(fixed), fixed)).rejects.toThrow(/COPY_NOT_APPENDABLE.*STORED_FAIL_IS_TERMINAL/);
    expect(await versionCount(s)).toBe(0);
    expect((await recordDirect(s, fixed)).error?.message).toContain("copy_review_after_fail");
  });

  it("round-1 fail: stored after its round 0; another round 1 (or a round 0) for the same facts is refused", async () => {
    const s = await shop();
    const [r0, bad1] = failingRound1();
    await importRound(s, await pkgOf(r0), r0);
    await expect(importRound(s, await rawPkgOf(bad1, [r0]), bad1)).rejects.toThrow(/COPY_INVALID/);
    const rows = (await db.query("select round, next_step from public.sales_demo_copy_reviews where prospect_id = $1 order by seq", [s.prospectId])).rows;
    expect(rows).toEqual([{ round: 0, next_step: "revise" }, { round: 1, next_step: "stop_fail" }]);
    const [, good1] = auditReviseChain();
    await expect(importRound(s, await pkgOf(good1, [r0]), good1)).rejects.toThrow(/COPY_NOT_APPENDABLE.*STORED_FAIL_IS_TERMINAL/);
    expect((await recordDirect(s, good1)).error?.message).toContain("copy_review_after_fail");
    expect((await recordDirect(s, cleanRound0())).error?.message).toContain("copy_review_after_fail");
  });

  it("a lane switch for the same facts content is refused (importer and database)", async () => {
    const s = await shop();
    const r0 = cleanRound0();
    await importRound(s, await pkgOf(r0), r0);
    const other = sameFactsOtherLane();
    // (a real shop's facts in the fictional lane fails the base check, so this review is a fail: refused, and not
    // stored either, because the store refuses the lane switch)
    await expect(importRound(s, await rawPkgOf(other), other)).rejects.toThrow(/COPY_INVALID/);
    expect((await db.query("select lane from public.sales_demo_copy_reviews where prospect_id = $1", [s.prospectId])).rows).toEqual([{ lane: "real_shop_proposal" }]);
    expect((await recordDirect(s, other, { gate: ["FICTIONAL_RESEARCH_NOT_SENDABLE", "OWNER_APPROVAL_MISSING", "REVIEW_NOT_PASSED"] })).error?.message).toContain("copy_review_lane_switch");
  });
});

describe("PR #262 M2: the facts-path check must be made on the version's facts", () => {
  it("a check recorded after the demo's facts changed does not count for the version (demo_copy_facts_stale)", async () => {
    const s = await shop();
    const r0 = cleanRound0();
    // DEV-263f: the facts are in the store (a check needs it), the import itself without the facts path
    await registerFacts(s.demoId, r0.files.factsPack, adminId);
    const v = await importRound(s, await pkgOf(r0), r0, false);
    expect(await copyBlock(v.versionId)).toBe("demo_copy_facts_not_from_facts_path");
    await db.query("update public.sales_demos set content = content || '{\"note\": \"changed\"}'::jsonb where id = $1", [s.demoId]);
    const q = await reviewRow(v.storedCopy!.review_id);
    const ins = await serviceClient().from("sales_demo_copy_facts_checks").insert({ review_id: q.id, facts_sha256: q.facts_sha256, demo_facts_sha256: "0".repeat(64) });
    expect(ins.error, ins.error?.message).toBeNull();
    const check = (await db.query("select c.demo_facts_sha256, v.facts_sha256 as version_facts from public.sales_demo_copy_facts_checks c join public.sales_demo_versions v on v.id = $2 where c.review_id = $1", [q.id, v.versionId])).rows[0];
    expect(check.demo_facts_sha256).not.toBe(check.version_facts);
    expect(await copyBlock(v.versionId)).toBe("demo_copy_facts_stale");
    expect(await loadVersionCopyGate(admin, v.versionId)).toMatchObject({ ok: false, code: "demo_copy_facts_stale" });
  });
});

describe("PostgREST embed the server gate reads", () => {
  it("returns the demo's approved_version_id under prospect.demo (pinned against the real API)", async () => {
    const s = await shop();
    const { data, error } = await admin.from("sales_outreaches").select(OUTREACH_DEMO_SELECT).eq("id", s.outreachId).maybeSingle();
    expect(error).toBeNull();
    const demo = (data as unknown as { prospect: { demo: unknown } }).prospect.demo;
    const one = (Array.isArray(demo) ? demo[0] : demo) as Record<string, unknown>;
    expect(Object.keys(one)).toEqual(["approved_version_id"]);
    expect(one.approved_version_id).toBeNull();
  });
});

describe("legacy safety", () => {
  it("a demo with no approved version (the React demo) is approved exactly as before; the copy gate says legacy", async () => {
    const s = await shop();
    expect(await sendBlockOn(db, s.demoId)).toBeNull();
    expect(await withSharingOn((c) => sendBlockOn(c, s.demoId))).toBeNull();
    expect(await outreachCopyGate(admin, s.outreachId)).toEqual({ legacy: true });
    const res = await approve(admin, s.outreachId);
    expect(res.error, res.error?.message).toBeNull();
  });
});

/** The rollback SQL of the review record, without its own begin / commit (the test owns the transaction). */
function rollbackSql(): string {
  const md = readFileSync(".ai/reviews/DEV-199e.md", "utf8");
  const block = md.slice(md.indexOf("<!-- rollback-sql:start -->"), md.indexOf("<!-- rollback-sql:end -->"));
  const sql = block.slice(block.indexOf("```sql") + "```sql".length, block.lastIndexOf("```"));
  return sql.replace(/^\s*(begin|commit);\s*$/gm, "");
}

function manifest(seed: string): ArtifactManifest {
  const m = {
    version: 1 as const,
    files: [
      { name: "page/index.html", role: "html" as const, sha256: sha256Hex(`${seed}:html`), bytes: 2048, content_type: "text/html" as const },
      { name: "page/style.css", role: "css" as const, sha256: sha256Hex(`${seed}:css`), bytes: 1024, content_type: "text/css" as const },
      { name: "renders/desktop_1440.webp", role: "render" as const, sha256: sha256Hex(`${seed}:d`), bytes: 50_000, content_type: "image/webp" as const, width: 1440, height: 4000 },
      { name: "renders/mobile_390.webp", role: "render" as const, sha256: sha256Hex(`${seed}:m`), bytes: 50_000, content_type: "image/webp" as const, width: 390, height: 4000 },
    ],
  };
  const checked = validateManifest(m);
  if (!checked.ok) throw new Error("fixture manifest invalid");
  return checked.manifest;
}

describe("the migration on existing data, and its rollback", () => {
  it("rolled back and applied again inside a rolled-back transaction: existing rows unchanged, nothing becomes sendable, the legacy demo is untouched", async () => {
    // existing data made before (committed): a legacy demo with a live send approval, and a quality-approved version
    const legacy = await shop();
    expect((await approve(admin, legacy.outreachId)).error).toBeNull();
    const versioned = await shop();
    const m = manifest(randomUUID());
    const ing = await serviceClient().rpc("sales_ingest_demo_version", {
      p_demo_id: versioned.demoId, p_generation_job_id: `job-${randomUUID()}`, p_parent_version_id: null, p_origin: "worker_autogen", p_worker_commit: "abcdef1",
      p_direction_sha256: null, p_bundle_sha256: bundleSha256(m), p_manifest: m, p_images: [],
      p_validator_result: { version: 1, ok: true, codes: [], validator_commit: "abcdef1", checked_at: new Date().toISOString() }, p_worker_checks: { checkPrototype: "ok" },
      p_structure_descriptor: null, p_rights_summary: { version: 1, photos: 0, by_status: {}, earliest_expiry: null, label_required: false },
    });
    expect(ing.error, ing.error?.message).toBeNull();
    const versionId = (ing.data as { version_id: string }).version_id;
    await approveQuality(versionId);
    const snapshot = async (c: PoolClient) =>
      JSON.stringify((await c.query("select v.*, d.approved_version_id, a.state as approval_state, a.snapshot_sha256 from public.sales_demo_versions v join public.sales_demos d on d.id = v.demo_id left join public.sales_outreach_approvals a on a.prospect_id = d.prospect_id order by v.id")).rows);
    const legacyApproval = async (c: PoolClient) => (await c.query("select state, demo_version, demo_version_id from public.sales_outreach_approvals where outreach_id = $1", [legacy.outreachId])).rows;

    const c = await db.connect();
    try {
      await c.query("begin");
      const before = await snapshot(c);
      const approvalsBefore = await legacyApproval(c);
      // rollback
      await c.query(rollbackSql());
      const left = (await c.query("select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and relname = any($1::text[])", [COPY_TABLES])).rows;
      expect(left).toEqual([]);
      expect((await c.query("select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and (p.proname like 'sales\\_%copy%' or p.prosrc like '%sales_copy_send_block%')")).rows[0].n).toBe(0);
      expect(await sendBlockOn(c, versioned.demoId)).toBe("demo_not_shareable");
      expect(await sendBlockOn(c, legacy.demoId)).toBeNull();
      expect(await snapshot(c)).toBe(before);
      // the migration again, on this existing data
      await c.query(readFileSync(MIGRATION, "utf8"));
      expect(await snapshot(c)).toBe(before);
      expect(await legacyApproval(c)).toEqual(approvalsBefore);
      for (const t of COPY_TABLES) expect((await c.query(`select count(*)::int as n from public.${t}`)).rows[0].n, t).toBe(0);
      expect((await c.query("select public.sales_copy_send_block($1) as c", [versionId])).rows[0].c).toBe("demo_copy_review_missing");
      // (sharing switched on before the re-created send block runs in this transaction: a function's cached plan keeps
      // the old constant within a transaction. The sharing-off answer after the migration is checked below, outside.)
      await c.query("create or replace function public.sales_demo_versioned_sharing_enabled() returns boolean language sql immutable set search_path = '' as $$ select true $$");
      expect(await sendBlockOn(c, versioned.demoId)).toBe("demo_copy_review_missing");
      expect(await sendBlockOn(c, legacy.demoId)).toBeNull();
    } finally {
      await c.query("rollback");
      c.release();
    }
    // the shared schema is as it was
    expect((await db.query("select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and relname = any($1::text[])", [COPY_TABLES])).rows[0].n).toBe(4);
    expect(await sendBlockOn(db, versioned.demoId)).toBe("demo_not_shareable");
    expect(await sendBlockOn(db, legacy.demoId)).toBeNull();
  });
});
