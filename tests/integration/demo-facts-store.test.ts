import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PoolClient } from "pg";
import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { importPackage, type PackageStore } from "@/lib/demo-version-package/import";
import { buildPackage, type DemoVersionPackage } from "@/lib/demo-version-package/package";
import { loadVersionCopyGate, outreachCopyGate } from "@/lib/sales/copy-review/store";
import { loadCurrentFactsPack, registerFactsPackAsAdmin, registerFactsPackAsOperator } from "@/lib/sales/facts-store";
import { QUALITY_CHECKLIST_ITEMS } from "@/lib/sales/demo-version/quality";
import { cleanRound0, json, type Round } from "../support/copy-review-fixture";
import { anonClient, candidate, createUser, db, makeAdmin, nameFactsInContent, resetSalesData, rpc, serviceClient, setFactsCliRegistration, signedInClient, verifiedRun } from "./helpers";

// DEV-263f (Issue #263, runbook B-2): the hosted facts store (sales_demo_facts_packs) and the send-time re-compare of
// the facts, on the LOCAL stack. The made-up real-shop sample ("パン店 見本") in test prospects, example.com only; no
// network, no model, no real send. Nothing touches 輪 (SR-001).

const MIGRATION = "supabase/migrations/20261115000000_sales_demo_facts_store.sql";
const ALL_OK = Object.fromEntries(QUALITY_CHECKLIST_ITEMS.map((k) => [k, "ok"]));

let admin: SupabaseClient;
let outsider: SupabaseClient;
let adminId: string;
let outsiderId: string;

async function shop() {
  const runId = randomUUID();
  await verifiedRun(runId, { c01: candidate() });
  await rpc("sales_run_begin_persist", { p_run_id: runId });
  const r = await rpc<{ prospect_id: string }>("sales_persist_candidate", { p_run_id: runId, p_key: "c01" });
  await rpc("sales_run_finalize", { p_run_id: runId });
  const { rows } = await db.query(
    "select d.id as demo_id, o.id as outreach_id from public.sales_demos d join public.sales_outreaches o on o.prospect_id = d.prospect_id and o.kind = 'initial' where d.prospect_id = $1",
    [r.prospect_id],
  );
  return { prospectId: r.prospect_id, demoId: rows[0].demo_id as string, outreachId: rows[0].outreach_id as string };
}
type Shop = Awaited<ReturnType<typeof shop>>;

const memoryStore = (): PackageStore => {
  const objects = new Map<string, Uint8Array>();
  return { download: async (k) => objects.get(k) ?? null, upload: async (k, b) => void objects.set(k, b) };
};
const png = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: { r: Math.floor(Math.random() * 255), g: 30, b: 60 } } }).png().toBuffer();
async function pkgOf(r: Round): Promise<DemoVersionPackage> {
  return buildPackage({
    html: String(r.files.pageHtml),
    css: String(r.files.pageCss),
    renders: { desktop_1440: new Uint8Array(await png(1440, 900)), mobile_390: new Uint8Array(await png(390, 900)) },
    source: "test",
    copy: { factsPack: r.files.factsPack, copyRecord: r.files.copyRecord, review: json(r.review), rounds: [] },
  });
}
const text = (b: string | Uint8Array) => (typeof b === "string" ? b : new TextDecoder().decode(b));
/** The same facts, other bytes (re-serialised): a different facts pack for the store. */
const reserialised = (b: string | Uint8Array) => `${JSON.stringify(JSON.parse(text(b)))}\n`;

const copyBlock = async (versionId: string) => (await db.query("select public.sales_copy_send_block($1) as c", [versionId])).rows[0].c as string | null;
const rows = async (prospectId: string) => (await db.query("select * from public.sales_demo_facts_packs where prospect_id = $1 order by seq", [prospectId])).rows;

/** Runs f with versioned sharing switched on INSIDE a transaction that is always rolled back. */
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
const sendBlockOn = async (c: PoolClient, demoId: string) => (await c.query("select public.sales_demo_version_send_block(d) as c from public.sales_demos d where d.id = $1", [demoId])).rows[0].c as string | null;

/** A version imported with the facts from the store, quality approved and its copy approved by the owner. */
async function confirmedVersion(s: Shop, r: Round) {
  await nameFactsInContent(s.demoId, r.files.factsPack);
  expect((await registerFactsPackAsOperator(serviceClient(), { demoId: s.demoId, factsPack: text(r.files.factsPack), adminId })).replayed).toBe(false);
  const res = await importPackage(await pkgOf(r), { client: serviceClient(), store: memoryStore(), demoId: s.demoId, factsFromStore: true });
  expect(res.storedCopy).toMatchObject({ facts_from_facts_path: true });
  const v = (await db.query("select bundle_sha256 from public.sales_demo_versions where id = $1", [res.versionId])).rows[0];
  const renders = (await db.query("select path, sha256 from public.sales_demo_version_files where version_id = $1 and role = 'render'", [res.versionId])).rows;
  const viewed = Object.fromEntries(renders.map((f) => [String(f.path).replace(/^renders\/(.*)\.webp$/, "$1"), f.sha256]));
  const qr = await admin.rpc("sales_review_demo_version", { p_version_id: res.versionId, p_decision: "approved", p_checklist: ALL_OK, p_viewed_renders: viewed, p_bundle_sha256: v.bundle_sha256, p_note: null });
  expect(qr.error, qr.error?.message).toBeNull();
  const q = (await db.query("select * from public.sales_demo_copy_reviews where id = $1", [res.storedCopy!.review_id])).rows[0];
  const d = await admin.rpc("sales_decide_copy_review", {
    p_version_id: res.versionId, p_review_id: q.id, p_decision: "approve", p_review_sha256: q.review_sha256, p_facts_sha256: q.facts_sha256,
    p_copy_sha256: q.copy_sha256, p_page_html_sha256: q.page_html_sha256, p_page_css_sha256: q.page_css_sha256, p_note: null,
  });
  expect(d.error, d.error?.message).toBeNull();
  expect(await copyBlock(res.versionId)).toBeNull();
  return { versionId: res.versionId, reviewId: q.id as string };
}

beforeAll(async () => {
  await resetSalesData();
  adminId = await createUser("facts-store-admin@test.example.com");
  await makeAdmin(adminId);
  outsiderId = await createUser("facts-store-outsider@test.example.com");
  admin = await signedInClient("facts-store-admin@test.example.com");
  outsider = await signedInClient("facts-store-outsider@test.example.com");
});
beforeEach(async () => {
  await setFactsCliRegistration(true);
  await db.query(
    "truncate public.sales_demo_facts_packs, public.sales_demo_copy_owner_decisions, public.sales_demo_version_copy_links, public.sales_demo_copy_facts_checks, public.sales_demo_copy_reviews, public.sales_demo_quality_reviews, public.sales_demo_version_files, public.sales_demo_versions, public.sales_outreach_approvals, public.sales_outreaches, public.sales_demos, public.sales_sources, public.sales_prospects, public.sales_agent_runs cascade",
  );
});
afterAll(async () => {
  await setFactsCliRegistration(false);
  await resetSalesData();
});

describe("registration: only the owner, tied to the demo's content, append-only", () => {
  it("the admin (own session) and the CLI (service role + a named admin) register; the same bytes replay; the newest row is current", async () => {
    const s = await shop();
    const r0 = cleanRound0();
    const packText = text(r0.files.factsPack);
    await nameFactsInContent(s.demoId, packText);
    const a = await registerFactsPackAsAdmin(admin, { demoId: s.demoId, factsPack: packText });
    expect(a).toMatchObject({ replayed: false, shop_id: JSON.parse(packText).shop_id });
    const again = await registerFactsPackAsOperator(serviceClient(), { demoId: s.demoId, factsPack: packText, adminId });
    expect(again).toMatchObject({ replayed: true, facts_pack_id: a.facts_pack_id });
    const [row] = await rows(s.prospectId);
    expect(row).toMatchObject({ demo_id: s.demoId, facts_pack_text: packText, recorded_by: adminId, recorded_via: "admin_session" });
    expect(row.facts_sha256).toBe((await db.query("select encode(sha256(convert_to($1::text, 'UTF8')), 'hex') as s", [packText])).rows[0].s);
    // the canonical content hash: the same facts re-serialised have the same jsonb form, other bytes
    const other = reserialised(packText);
    await nameFactsInContent(s.demoId, other);
    const b = await registerFactsPackAsOperator(serviceClient(), { demoId: s.demoId, factsPack: other, adminId });
    expect(b.replayed).toBe(false);
    const both = await rows(s.prospectId);
    expect(both.map((x) => x.recorded_via)).toEqual(["admin_session", "operator_cli"]);
    expect(both[1].facts_jsonb_sha256).toBe(both[0].facts_jsonb_sha256);
    expect(both[1].facts_sha256).not.toBe(both[0].facts_sha256);
    expect((await loadCurrentFactsPack(admin, s.prospectId))?.id).toBe(b.facts_pack_id);
  });

  it("refused: a pack the demo's content does not name, a malformed pack, a non-admin, an operator naming a non-admin", async () => {
    const s = await shop();
    const packText = text(cleanRound0().files.factsPack);
    // the demo's content does not name it yet
    await expect(registerFactsPackAsAdmin(admin, { demoId: s.demoId, factsPack: packText })).rejects.toThrow("facts_pack_not_demo_content");
    await nameFactsInContent(s.demoId, packText);
    await expect(registerFactsPackAsAdmin(admin, { demoId: s.demoId, factsPack: "{\"schema\":\"x\"}" })).rejects.toThrow("invalid_facts_pack");
    await expect(registerFactsPackAsAdmin(admin, { demoId: s.demoId, factsPack: "not json" })).rejects.toThrow("invalid_facts_pack");
    await expect(registerFactsPackAsAdmin(outsider, { demoId: s.demoId, factsPack: packText })).rejects.toThrow("forbidden");
    await expect(registerFactsPackAsOperator(serviceClient(), { demoId: s.demoId, factsPack: packText, adminId: outsiderId })).rejects.toThrow("forbidden");
    expect(await rows(s.prospectId)).toEqual([]);
  });

  it("no API role writes the table directly; nothing is updated or deleted; only the admin reads; each function has its one caller", async () => {
    const s = await shop();
    const packText = text(cleanRound0().files.factsPack);
    await nameFactsInContent(s.demoId, packText);
    const svc = serviceClient();
    const direct = await svc.from("sales_demo_facts_packs").insert({ prospect_id: s.prospectId, demo_id: s.demoId, shop_id: "xx", facts_sha256: "0".repeat(64), facts_jsonb_sha256: "0".repeat(64), facts_pack_text: packText, recorded_by: adminId, recorded_via: "operator_cli" });
    expect(direct.error?.message).toContain("facts_pack_owner_path_only");
    const r = await registerFactsPackAsOperator(svc, { demoId: s.demoId, factsPack: packText, adminId });
    expect((await svc.from("sales_demo_facts_packs").update({ recorded_via: "admin_session" }).eq("id", r.facts_pack_id)).error?.message).toContain("facts_pack_immutable");
    // no DELETE grant for any API role (and the trigger refuses it for the owner)
    expect((await svc.from("sales_demo_facts_packs").delete().eq("id", r.facts_pack_id)).error).not.toBeNull();
    await expect(db.query("delete from public.sales_demo_facts_packs where id = $1", [r.facts_pack_id])).rejects.toThrow("facts_pack_immutable");
    expect((await admin.from("sales_demo_facts_packs").select("id")).data).toHaveLength(1);
    expect((await outsider.from("sales_demo_facts_packs").select("id")).data).toEqual([]);
    expect((await anonClient().from("sales_demo_facts_packs").select("id")).data ?? []).toEqual([]);
    expect((await admin.from("sales_demo_facts_packs").insert({ prospect_id: s.prospectId, demo_id: s.demoId, shop_id: "xx", facts_sha256: "0".repeat(64), facts_jsonb_sha256: "0".repeat(64), facts_pack_text: packText, recorded_by: adminId, recorded_via: "admin_session" })).error).not.toBeNull();
    // the admin function needs a signed-in admin (not the service role); the CLI function is the service role's only
    expect((await svc.rpc("sales_register_facts_pack", { p_demo_id: s.demoId, p_facts_pack: packText })).error).not.toBeNull();
    expect((await admin.rpc("sales_register_facts_pack_as", { p_demo_id: s.demoId, p_facts_pack: packText, p_admin_id: adminId })).error).not.toBeNull();
    expect((await anonClient().rpc("sales_register_facts_pack", { p_demo_id: s.demoId, p_facts_pack: packText })).error).not.toBeNull();
    for (const fn of ["sales_insert_facts_pack(uuid, text, uuid, text)", "sales_check_facts_pack_write()"]) {
      for (const role of ["anon", "authenticated", "service_role"]) {
        expect((await db.query(`select has_function_privilege($1, 'public.${fn}', 'execute') as ok`, [role])).rows[0].ok, `${role} ${fn}`).toBe(false);
      }
    }
    const definer = (await db.query("select proname, prosecdef from pg_proc where proname in ('sales_register_facts_pack', 'sales_register_facts_pack_as', 'sales_insert_facts_pack') order by proname")).rows;
    expect(definer).toEqual([
      { proname: "sales_insert_facts_pack", prosecdef: false },
      { proname: "sales_register_facts_pack", prosecdef: true },
      { proname: "sales_register_facts_pack_as", prosecdef: true },
    ]);
  });
});

describe("PR #269 review", () => {
  it("M2: the CLI registration needs the DB owner's local switch (off by default; only the owner changes it); a non-admin id is refused either way", async () => {
    const s = await shop();
    const packText = text(cleanRound0().files.factsPack);
    await nameFactsInContent(s.demoId, packText);
    await setFactsCliRegistration(false);
    await expect(registerFactsPackAsOperator(serviceClient(), { demoId: s.demoId, factsPack: packText, adminId })).rejects.toThrow("facts_cli_registration_disabled");
    // no API role can switch it on
    expect((await serviceClient().from("sales_facts_registration_settings").update({ operator_cli_enabled: true }).eq("id", true)).error?.message).toContain("facts_cli_switch_owner_only");
    // the admin's own session is not affected by the switch
    expect((await registerFactsPackAsAdmin(admin, { demoId: s.demoId, factsPack: packText })).replayed).toBe(false);
    await setFactsCliRegistration(true);
    await expect(registerFactsPackAsOperator(serviceClient(), { demoId: s.demoId, factsPack: packText, adminId: outsiderId })).rejects.toThrow("forbidden");
    // the migration's default is off
    const def = (await db.query("select column_default from information_schema.columns where table_name = 'sales_facts_registration_settings' and column_name = 'operator_cli_enabled'")).rows[0].column_default;
    expect(def).toBe("false");
  });

  it("M1: a review imported before the facts store (legacy evidence) is recovered by registering the facts and re-importing the same package", async () => {
    const s = await shop();
    const r0 = cleanRound0();
    const pkg = await pkgOf(r0);
    await nameFactsInContent(s.demoId, r0.files.factsPack);
    await registerFactsPackAsOperator(serviceClient(), { demoId: s.demoId, factsPack: text(r0.files.factsPack), adminId });
    const first = await importPackage(pkg, { client: serviceClient(), store: memoryStore(), demoId: s.demoId, factsFromStore: true });
    // make the evidence a pre-migration row (no store row), as the DB owner
    const own = await db.connect();
    try {
      await own.query("begin");
      await own.query("set local session_replication_role = replica");
      await own.query("update public.sales_demo_copy_facts_checks set facts_pack_id = null where review_id = $1", [first.storedCopy!.review_id]);
      await own.query("commit");
    } finally {
      own.release();
    }
    expect(await copyBlock(first.versionId)).toBe("demo_copy_facts_not_from_facts_path");
    // the same package again: the replay fills the store row of the existing check
    const again = await importPackage(pkg, { client: serviceClient(), store: memoryStore(), demoId: s.demoId, factsFromStore: true });
    expect(again.storedCopy).toMatchObject({ review_id: first.storedCopy!.review_id, replayed: true, facts_from_facts_path: true });
    const checks = (await db.query("select facts_pack_id from public.sales_demo_copy_facts_checks where review_id = $1", [first.storedCopy!.review_id])).rows;
    expect(checks).toHaveLength(1);
    expect(checks[0].facts_pack_id).not.toBeNull();
    expect(await copyBlock(first.versionId)).toBe("demo_copy_owner_confirmation_missing");
    // a check that names a row is never re-pointed or otherwise updated
    const svc = serviceClient();
    expect((await svc.from("sales_demo_copy_facts_checks").update({ facts_pack_id: null }).eq("review_id", first.storedCopy!.review_id)).error?.message).toContain("copy_facts_check_immutable");
  });

  it("M1: facts_from_facts_path is false when only legacy evidence exists and no store row matches", async () => {
    const s = await shop();
    const r0 = cleanRound0();
    await nameFactsInContent(s.demoId, r0.files.factsPack);
    const res = await importPackage(await pkgOf(r0), { client: serviceClient(), store: memoryStore(), demoId: s.demoId });
    expect(res.storedCopy).toMatchObject({ facts_from_facts_path: false });
  });

  it("L1: the owner cannot approve copy whose facts are no longer the current stored facts (a revise / reject stays possible)", async () => {
    const s = await shop();
    const r0 = cleanRound0();
    await nameFactsInContent(s.demoId, r0.files.factsPack);
    await registerFactsPackAsOperator(serviceClient(), { demoId: s.demoId, factsPack: text(r0.files.factsPack), adminId });
    const res = await importPackage(await pkgOf(r0), { client: serviceClient(), store: memoryStore(), demoId: s.demoId, factsFromStore: true });
    const other = reserialised(r0.files.factsPack);
    await nameFactsInContent(s.demoId, other);
    await registerFactsPackAsOperator(serviceClient(), { demoId: s.demoId, factsPack: other, adminId });
    const q = (await db.query("select * from public.sales_demo_copy_reviews where id = $1", [res.storedCopy!.review_id])).rows[0];
    const args = (decision: string) => ({
      p_version_id: res.versionId, p_review_id: q.id, p_decision: decision, p_review_sha256: q.review_sha256, p_facts_sha256: q.facts_sha256,
      p_copy_sha256: q.copy_sha256, p_page_html_sha256: q.page_html_sha256, p_page_css_sha256: q.page_css_sha256, p_note: null,
    });
    expect((await admin.rpc("sales_decide_copy_review", args("approve"))).error?.message).toContain("copy_facts_changed");
    expect((await admin.rpc("sales_decide_copy_review", args("reject"))).error).toBeNull();
    // legacy evidence only: no decision at all
    const t = await shop();
    await nameFactsInContent(t.demoId, r0.files.factsPack);
    await registerFactsPackAsOperator(serviceClient(), { demoId: t.demoId, factsPack: text(r0.files.factsPack), adminId });
    const tr = await importPackage(await pkgOf(r0), { client: serviceClient(), store: memoryStore(), demoId: t.demoId, factsFromStore: true });
    const tq = (await db.query("select * from public.sales_demo_copy_reviews where id = $1", [tr.storedCopy!.review_id])).rows[0];
    const c = await db.connect();
    try {
      await c.query("begin");
      await c.query("set local session_replication_role = replica");
      await c.query("update public.sales_demo_copy_facts_checks set facts_pack_id = null where review_id = $1", [tq.id]);
      await c.query("set local session_replication_role = origin");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: adminId, role: "authenticated" })]);
      await c.query("set local role authenticated");
      await expect(
        c.query("select public.sales_decide_copy_review($1, $2, 'reject', $3, $4, $5, $6, $7, null)", [tr.versionId, tq.id, tq.review_sha256, tq.facts_sha256, tq.copy_sha256, tq.page_html_sha256, tq.page_css_sha256]),
      ).rejects.toThrow("copy_facts_not_from_facts_path");
    } finally {
      await c.query("rollback");
      c.release();
    }
  });

  it("L4: without the facts store (migration not applied) the copy panel still reads (not set up) and the send stays refused", async () => {
    const s = await shop();
    const { versionId } = await confirmedVersion(s, cleanRound0());
    const c = await db.connect();
    try {
      await c.query("begin");
      await c.query(rollbackSql());
      await c.query("notify pgrst, 'reload schema'");
      await c.query("commit");
    } catch (e) {
      await c.query("rollback");
      c.release();
      throw e;
    }
    try {
      // wait for PostgREST to drop the table from its schema cache
      for (let i = 0; i < 50; i++) {
        const r = await admin.from("sales_demo_facts_packs").select("id").limit(1);
        if (r.error) break;
        await new Promise((ok) => setTimeout(ok, 200));
      }
      await expect(loadCurrentFactsPack(admin, s.prospectId)).rejects.toThrow("FACTS_STORE_NOT_SET_UP");
      const { loadVersionCopyContext } = await import("@/lib/sales/copy-review/store");
      const ctx = await loadVersionCopyContext(admin, versionId);
      expect(ctx.state.factsStore.notSetUp).toBe(true);
      expect(ctx.state.factsChecks.every((x) => x.facts_pack_id === null)).toBe(true);
      expect(await loadVersionCopyGate(admin, versionId)).toMatchObject({ ok: false, code: "demo_copy_facts_not_from_facts_path" });
    } finally {
      // the migration again (its own transaction), then the schema cache
      await c.query("begin");
      await c.query(readFileSync(MIGRATION, "utf8"));
      await c.query("insert into supabase_migrations.schema_migrations (version, name) values ('20261115000000', 'sales_demo_facts_store') on conflict do nothing");
      await c.query("commit");
      await c.query("notify pgrst, 'reload schema'");
      c.release();
      for (let i = 0; i < 50; i++) {
        const r = await admin.from("sales_demo_facts_packs").select("id").limit(1);
        if (!r.error) break;
        await new Promise((ok) => setTimeout(ok, 200));
      }
      await setFactsCliRegistration(true);
    }
  });
});

describe("the facts-path evidence references the store row", () => {
  it("the importer reads the store; a check is recorded only for the current stored pack of the demo", async () => {
    const s = await shop();
    const r0 = cleanRound0();
    await nameFactsInContent(s.demoId, r0.files.factsPack);
    // nothing in the store: the import from the store is refused before anything is written
    await expect(importPackage(await pkgOf(r0), { client: serviceClient(), store: memoryStore(), demoId: s.demoId, factsFromStore: true })).rejects.toThrow("FACTS_STORE_EMPTY");
    expect((await db.query("select count(*)::int as n from public.sales_demo_versions where demo_id = $1", [s.demoId])).rows[0].n).toBe(0);
    // the facts pack given directly (no store row): the database records no facts-path check
    await expect(importPackage(await pkgOf(r0), { client: serviceClient(), store: memoryStore(), demoId: s.demoId, trustedFactsPack: r0.files.factsPack })).rejects.toThrow("copy_facts_not_in_store");
    // a different pack is current: the same refusal
    const other = reserialised(r0.files.factsPack);
    await nameFactsInContent(s.demoId, other);
    await registerFactsPackAsOperator(serviceClient(), { demoId: s.demoId, factsPack: other, adminId });
    await nameFactsInContent(s.demoId, r0.files.factsPack);
    await expect(importPackage(await pkgOf(r0), { client: serviceClient(), store: memoryStore(), demoId: s.demoId, factsFromStore: true })).rejects.toThrow("COPY_FACTS_NOT_FROM_FACTS_PATH");
    // registered: the import reads the store and the check names the row
    const reg = await registerFactsPackAsOperator(serviceClient(), { demoId: s.demoId, factsPack: text(r0.files.factsPack), adminId });
    const res = await importPackage(await pkgOf(r0), { client: serviceClient(), store: memoryStore(), demoId: s.demoId, factsFromStore: true });
    const checks = (await db.query("select facts_pack_id from public.sales_demo_copy_facts_checks where review_id = $1", [res.storedCopy!.review_id])).rows;
    expect(checks).toEqual([{ facts_pack_id: reg.facts_pack_id }]);
    expect(await copyBlock(res.versionId)).toBe("demo_copy_owner_confirmation_missing");
    // the importer refuses both sources at once
    await expect(importPackage(await pkgOf(r0), { client: serviceClient(), store: memoryStore(), demoId: s.demoId, factsFromStore: true, trustedFactsPack: r0.files.factsPack })).rejects.toThrow("TRUSTED_FACTS_TWICE");
  });

  it("a check made before the store (no facts_pack_id) does not count (database and server)", async () => {
    const s = await shop();
    const { versionId } = await confirmedVersion(s, cleanRound0());
    const c = await db.connect();
    try {
      await c.query("begin");
      await c.query("set local session_replication_role = replica");
      await c.query("update public.sales_demo_copy_facts_checks set facts_pack_id = null");
      await c.query("set local session_replication_role = origin");
      expect((await c.query("select public.sales_copy_send_block($1) as c", [versionId])).rows[0].c).toBe("demo_copy_facts_not_from_facts_path");
    } finally {
      await c.query("rollback");
      c.release();
    }
    expect(await copyBlock(versionId)).toBeNull();
  });
});

describe("the send-time re-compare", () => {
  it("a newer facts pack (re-registered) refuses the send (demo_copy_facts_changed) in the database and on the server; registering the old pack again restores it", async () => {
    const s = await shop();
    const r0 = cleanRound0();
    const { versionId } = await confirmedVersion(s, r0);
    expect(await withSharingOn((c) => sendBlockOn(c, s.demoId))).toBeNull();
    expect(await loadVersionCopyGate(admin, versionId)).toEqual({ ok: true });

    const other = reserialised(r0.files.factsPack);
    await nameFactsInContent(s.demoId, other);
    await registerFactsPackAsAdmin(admin, { demoId: s.demoId, factsPack: other });
    expect(await copyBlock(versionId)).toBe("demo_copy_facts_changed");
    expect(await loadVersionCopyGate(admin, versionId)).toMatchObject({ ok: false, code: "demo_copy_facts_changed" });
    expect(await outreachCopyGate(admin, s.outreachId)).toMatchObject({ legacy: false, ok: false, code: "demo_copy_facts_changed" });
    // the whole send guard stops earlier (the demo's facts changed with the new pack)
    expect(await withSharingOn((c) => sendBlockOn(c, s.demoId))).toBe("demo_facts_changed");

    // the old pack registered again: the newest row is those bytes again, and the demo names them again
    await nameFactsInContent(s.demoId, r0.files.factsPack);
    await registerFactsPackAsAdmin(admin, { demoId: s.demoId, factsPack: text(r0.files.factsPack) });
    expect((await rows(s.prospectId)).length).toBe(3);
    expect(await copyBlock(versionId)).toBeNull();
    expect(await loadVersionCopyGate(admin, versionId)).toEqual({ ok: true });
  });

  it("the demo's content no longer naming the stored pack refuses the send", async () => {
    const s = await shop();
    const { versionId } = await confirmedVersion(s, cleanRound0());
    const c = await db.connect();
    try {
      await c.query("begin");
      await c.query("update public.sales_demos set content = content - 'facts_pack_sha256' where id = $1", [s.demoId]);
      expect((await c.query("select public.sales_copy_send_block($1) as c", [versionId])).rows[0].c).toBe("demo_copy_facts_changed");
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});

/** The rollback SQL of the review record, without its own begin / commit (the test owns the transaction). */
function rollbackSql(): string {
  const md = readFileSync(".ai/reviews/DEV-263f.md", "utf8");
  const block = md.slice(md.indexOf("<!-- rollback-sql:start -->"), md.indexOf("<!-- rollback-sql:end -->"));
  const sql = block.slice(block.indexOf("```sql") + "```sql".length, block.lastIndexOf("```"));
  return sql.replace(/^\s*(begin|commit);\s*$/gm, "");
}

describe("the migration's rollback", () => {
  it("rolled back and applied again inside a rolled-back transaction: the table and functions go, the copy send block is the 20261113 one", async () => {
    const s = await shop();
    const { versionId } = await confirmedVersion(s, cleanRound0());
    const c = await db.connect();
    try {
      await c.query("begin");
      await c.query(rollbackSql());
      expect((await c.query("select to_regclass('public.sales_demo_facts_packs') as t")).rows[0].t).toBeNull();
      expect((await c.query("select count(*)::int as n from pg_proc where proname like 'sales\\_%facts\\_pack%'")).rows[0].n).toBe(0);
      expect((await c.query("select count(*)::int as n from information_schema.columns where table_name = 'sales_demo_copy_facts_checks' and column_name = 'facts_pack_id'")).rows[0].n).toBe(0);
      const fn = (await c.query("select prosrc from pg_proc where proname = 'sales_copy_send_block'")).rows[0].prosrc as string;
      expect(fn).not.toContain("demo_copy_facts_changed");
      // the 20261113 send block: the check made on the version's facts counts again on its own
      expect((await c.query("select public.sales_copy_send_block($1) as c", [versionId])).rows[0].c).toBeNull();
      await c.query(readFileSync(MIGRATION, "utf8"));
      // applied again on existing data: the old checks have no store row, so they do not count
      expect((await c.query("select public.sales_copy_send_block($1) as c", [versionId])).rows[0].c).toBe("demo_copy_facts_not_from_facts_path");
    } finally {
      await c.query("rollback");
      c.release();
    }
    expect(await copyBlock(versionId)).toBeNull();
  });
});
