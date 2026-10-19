import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/internal/sales-agent/runs/route";
import { emailDigest } from "@/lib/sales/email-digest";
import { verifiedInput } from "../unit/sales/ingest-fixtures";
import { anonClient, createUser, db, makeAdmin, resetSalesData, rpc, signedInClient } from "./helpers";

// DEV-054: the discovered checkpoint marks stubs of shops the server already
// knows (prospect incl. DNC, exclusion list, remembered rejection) as
// "known" without saying why; durable verify-time rejections are remembered
// for 90 days; persist is unchanged. Fictional shops only.

const TOKEN = "test-ingest-token-0123456789abcdef-0123456789";

function call(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/internal/sales-agent/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    }),
  );
}

async function ok(body: unknown) {
  const res = await call(body);
  const json = await res.json();
  expect(res.status, JSON.stringify(json)).toBe(200);
  return json;
}

type Stub = { key: string; name: string; category: string; ward?: string | null; websiteUrl?: string | null; instagramUrl?: string | null };

async function discover(stubs: Stub[]) {
  const runId = randomUUID();
  await ok({ action: "start", runId });
  const body = await ok({ action: "checkpoint", runId, phase: "discovered", candidates: stubs });
  return { runId, body, run: body.run };
}

let seq = 0;
async function insertProspect(keys: { handle?: string; domain?: string; dnc?: boolean; name?: string; address?: string }) {
  seq += 1;
  await db.query(
    `insert into public.sales_prospects (name, normalized_name, address, normalized_address, ward, category, website_status,
       website_url, website_domain, instagram_url, instagram_handle, do_not_contact, dnc_reason, dnc_set_at)
     values ($1, $2, $3, $4, '中区', 'bakery', $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      keys.name ?? `既知の店${seq}`,
      keys.name ?? `きちのみせ${seq}`,
      keys.address ?? `名古屋市中区既知${seq}-1`,
      keys.address ? `愛知県${keys.address}` : `愛知県名古屋市中区既知${seq}-1`,
      keys.domain ? "present" : "not_found",
      keys.domain ? `https://${keys.domain}/` : null,
      keys.domain ?? null,
      keys.handle ? `https://www.instagram.com/${keys.handle}/` : null,
      keys.handle ?? null,
      keys.dnc ?? false,
      keys.dnc ? "explicit_refusal" : null,
      keys.dnc ? new Date().toISOString() : null,
    ],
  );
}

async function exclude(row: Record<string, unknown>) {
  const cols = Object.keys(row);
  await db.query(
    `insert into public.sales_exclusions (label, reason, ${cols.join(", ")}) values ('テスト', 'existing_customer', ${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
    Object.values(row),
  );
}

const ig = (handle: string) => `https://www.instagram.com/${handle}/`;
const count = async (table: string) => (await db.query(`select count(*)::int as n from public.${table}`)).rows[0].n as number;

// Business tables only: the access tests keep their signed-in users.
beforeEach(async () => {
  await db.query(
    "truncate public.sales_rejected_candidates, public.sales_exclusions, public.sales_outreaches, public.sales_demos, public.sales_sources, public.sales_prospects, public.sales_agent_runs cascade",
  );
  vi.stubEnv("SALES_AGENT_INGEST_TOKEN", TOKEN);
});
afterEach(() => vi.unstubAllEnvs());
afterAll(resetSalesData);

describe("discovered checkpoint: known marks", () => {
  it("marks a stub known by each key and list, and nothing else", async () => {
    await insertProspect({ handle: "prospect_pan" });
    await insertProspect({ domain: "prospect-site.example.com" });
    await insertProspect({ handle: "refused_pan", dnc: true });
    await exclude({ instagram_handle: "xlisted_pan" });
    await exclude({ website_domain: "xlisted-site.example.com" });
    await db.query(
      "insert into public.sales_rejected_candidates (key_type, key_value, reason, expires_at) values ('instagram_handle', 'remembered_pan', 'site_without_email', now() + interval '90 days'), ('website_domain', 'remembered-site.example.com', 'site_without_email', now() + interval '90 days')",
    );
    const stubs: Stub[] = [
      { key: "p1", name: "店1", category: "bakery", instagramUrl: "https://instagram.com/Prospect_Pan" },
      { key: "p2", name: "店2", category: "cafe", websiteUrl: "https://www.prospect-site.example.com/menu" },
      { key: "d1", name: "店3", category: "bakery", instagramUrl: ig("refused_pan") },
      { key: "x1", name: "店4", category: "bakery", instagramUrl: ig("xlisted_pan") },
      { key: "x2", name: "店5", category: "cafe", websiteUrl: "https://xlisted-site.example.com/" },
      { key: "m1", name: "店6", category: "bakery", instagramUrl: ig("remembered_pan") },
      { key: "m2", name: "店7", category: "cafe", websiteUrl: "https://remembered-site.example.com/" },
      { key: "n1", name: "店8", category: "bakery", instagramUrl: ig("new_pan") },
      { key: "n2", name: "店9", category: "cafe", websiteUrl: "https://new-site.example.com/" },
      { key: "n3", name: "店10", category: "baked_goods" },
    ];
    const { run, body } = await discover(stubs);
    expect(run.knownKeys).toEqual(["p1", "p2", "d1", "x1", "x2", "m1", "m2"]);
    expect(run.discovered.map((c: { key: string; known: boolean }) => [c.key, c.known])).toEqual(stubs.map((s) => [s.key, !s.key.startsWith("n")]));
    expect(run.discoveredKeys).toEqual(stubs.map((s) => s.key));
    // Never which list matched, nor anything from the lists.
    const text = JSON.stringify(body);
    for (const leak of ["excluded", "exclusion", "do_not_contact", "dnc", "prospect_id", "site_without_email", "existing_customer", "テスト"]) {
      expect(text, leak).not.toContain(leak);
    }
  });

  it("does not mark by name, ward, email digest or name + address (stubs have no address)", async () => {
    await insertProspect({ name: "同じ名前の店", address: "名古屋市中区同じ1-1" });
    await exclude({ email_digest: emailDigest("owner@known.example.com") });
    await exclude({ normalized_name: "おなじなまえのみせ", normalized_address: "愛知県名古屋市中区おなじ1-1" });
    const { run } = await discover([{ key: "c1", name: "同じ名前の店", category: "bakery", ward: "中区", instagramUrl: ig("someone_new") }]);
    expect(run.knownKeys).toEqual([]);
  });

  it("ignores expired memory", async () => {
    await db.query(
      "insert into public.sales_rejected_candidates (key_type, key_value, reason, first_rejected_at, last_rejected_at, expires_at) values ('instagram_handle', 'old_pan', 'site_without_email', now() - interval '100 days', now() - interval '100 days', now() - interval '10 days')",
    );
    const { run } = await discover([{ key: "c1", name: "店", category: "bakery", instagramUrl: ig("old_pan") }]);
    expect(run.knownKeys).toEqual([]);
  });

  it("keeps the marks for a new session (status) and after re-sending the same phase", async () => {
    await insertProspect({ handle: "resume_known" });
    const stubs: Stub[] = [
      { key: "c1", name: "店", category: "cafe", instagramUrl: ig("resume_known") },
      { key: "c2", name: "店2", category: "cafe", instagramUrl: ig("resume_new") },
    ];
    const { runId } = await discover(stubs);
    const status = (await ok({ action: "status" })).run;
    expect(status).toMatchObject({ runId, nextAction: "verify", knownKeys: ["c1"] });
    expect(status.discovered.map((c: { known: boolean }) => c.known)).toEqual([true, false]);
    const again = (await ok({ action: "checkpoint", runId, phase: "discovered", candidates: stubs })).run;
    expect(again.knownKeys).toEqual(["c1"]);
  });

  it("persist stays the final authority: a known shop verified anyway is still a duplicate", async () => {
    const shop = verifiedInput();
    await insertProspect({ handle: new URL(shop.instagramUrl!).pathname.split("/")[1] });
    const { runId, run } = await discover([{ key: shop.key, name: shop.name, category: "bakery", instagramUrl: shop.instagramUrl }]);
    expect(run.knownKeys).toEqual([shop.key]);
    await ok({ action: "checkpoint", runId, phase: "verified", candidates: [shop] });
    const done = (await ok({ action: "persist", runId })).run;
    expect(done.candidates[0]).toMatchObject({ stage: "duplicate" });
    expect(await count("sales_outreaches")).toBe(0);
  });
});

describe("memory of rejected candidates", () => {
  it("remembers a durable rejection at verify, idempotently, and marks the shop known next time", async () => {
    const site = verifiedInput({ website: { status: "present", url: "https://memory-site.example.com/", checks: 1 } });
    const transient = verifiedInput({ website: { status: "not_found", url: null, checks: 1 } }); // website_not_rechecked
    const { runId } = await discover([site, transient].map((c) => ({ key: c.key, name: c.name, category: "bakery", instagramUrl: c.instagramUrl })));
    const verified = (await ok({ action: "checkpoint", runId, phase: "verified", candidates: [site, transient] })).run;
    expect(verified.candidates.map((c: { reason: string }) => c.reason)).toEqual(["site_without_email", "website_not_rechecked"]);

    const { rows } = await db.query(
      "select key_type, key_value, reason, run_id, round(extract(epoch from expires_at - last_rejected_at) / 86400) as days from public.sales_rejected_candidates order by key_type",
    );
    const handle = new URL(site.instagramUrl!).pathname.split("/")[1];
    expect(rows.map((r) => [r.key_type, r.reason, r.run_id, Number(r.days)])).toEqual([
      ["instagram_handle", "site_without_email", runId, 90],
      ["name_address", "site_without_email", runId, 90],
      ["website_domain", "site_without_email", runId, 90],
    ]);
    expect(rows.find((r) => r.key_type === "instagram_handle").key_value).toBe(handle);
    expect(rows.find((r) => r.key_type === "website_domain").key_value).toBe("memory-site.example.com");

    // Re-sending the same verified checkpoint does not add rows.
    await ok({ action: "checkpoint", runId, phase: "verified", candidates: [site, transient] });
    expect(await count("sales_rejected_candidates")).toBe(3);
    await ok({ action: "persist", runId });

    // The next run's discovery skips the shop by either key.
    const next = await discover([
      { key: "a", name: "別表記", category: "bakery", instagramUrl: site.instagramUrl },
      { key: "b", name: "別表記2", category: "bakery", websiteUrl: "https://memory-site.example.com/about" },
      { key: "c", name: "再確認", category: "bakery", instagramUrl: transient.instagramUrl },
    ]);
    expect(next.run.knownKeys).toEqual(["a", "b"]);
  });

  it("never remembers daily_cap, excluded, DNC, duplicate or errors", async () => {
    const shops = Array.from({ length: 6 }, () => verifiedInput());
    const { runId } = await discover(shops.map((c) => ({ key: c.key, name: c.name, category: "bakery" })));
    await ok({ action: "checkpoint", runId, phase: "verified", candidates: shops });
    const done = (await ok({ action: "persist", runId })).run;
    expect(done.candidates.at(-1)).toMatchObject({ stage: "rejected", reason: "daily_cap" });
    expect(await count("sales_rejected_candidates")).toBe(0);
  });

  it("records only what the run's checkpoint really rejected for a durable reason", async () => {
    const shop = verifiedInput();
    const { runId } = await discover([{ key: shop.key, name: shop.name, category: "bakery" }]);
    await ok({ action: "checkpoint", runId, phase: "verified", candidates: [shop] }); // pending, not rejected
    const saved = await rpc<number>("sales_remember_rejections", {
      p_run_id: runId,
      p_entries: [
        { key: shop.key, reason: "site_without_email", keys: [{ type: "instagram_handle", value: "forged_pan" }] },
        { key: "nope", reason: "site_without_email", keys: [{ type: "instagram_handle", value: "forged_pan2" }] },
      ],
    });
    expect(saved).toBe(0);
    expect(await count("sales_rejected_candidates")).toBe(0);
    await expect(rpc("sales_remember_rejections", { p_run_id: randomUUID(), p_entries: [] })).rejects.toThrow(/run_not_found/);
    await expect(rpc("sales_remember_rejections", { p_run_id: runId, p_entries: {} })).rejects.toThrow(/invalid_rejection_memory/);
  });

  it("deletes expired rows on the next write", async () => {
    await db.query(
      "insert into public.sales_rejected_candidates (key_type, key_value, reason, first_rejected_at, last_rejected_at, expires_at) values ('instagram_handle', 'expired_pan', 'no_eligible_channel', now() - interval '100 days', now() - interval '100 days', now() - interval '10 days')",
    );
    const shop = verifiedInput({ website: { status: "present", url: "https://purge-site.example.com/", checks: 1 } });
    const { runId } = await discover([{ key: shop.key, name: shop.name, category: "bakery" }]);
    await ok({ action: "checkpoint", runId, phase: "verified", candidates: [shop] });
    const { rows } = await db.query("select key_value from public.sales_rejected_candidates where key_value = 'expired_pan'");
    expect(rows).toEqual([]);
  });

  it("refuses emails and malformed keys in the table", async () => {
    const insert = (type: string, value: string) =>
      db.query("insert into public.sales_rejected_candidates (key_type, key_value, reason, expires_at) values ($1, $2, 'site_without_email', now() + interval '1 day')", [type, value]);
    await expect(insert("name_address", "owner@shop.example.com|愛知県名古屋市中区1-1")).rejects.toThrow(/check constraint/);
    await expect(insert("instagram_handle", "Bad Handle")).rejects.toThrow(/check constraint/);
    await expect(insert("name_address", "店|愛知県豊田市1-1")).rejects.toThrow(/check constraint/);
    await expect(insert("email", "x")).rejects.toThrow(/check constraint/);
    const { rows } = await db.query("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'sales_rejected_candidates' and column_name like '%email%'");
    expect(rows).toEqual([]);
  });
});

describe("access", () => {
  let admin: Awaited<ReturnType<typeof signedInClient>>;
  let outsider: Awaited<ReturnType<typeof signedInClient>>;
  beforeAll(async () => {
    await resetSalesData();
    await makeAdmin(await createUser("disc-admin@test.example.com"));
    await createUser("disc-outsider@test.example.com");
    admin = await signedInClient("disc-admin@test.example.com");
    outsider = await signedInClient("disc-outsider@test.example.com");
  });
  beforeEach(async () => {
    await db.query("truncate public.sales_rejected_candidates");
    await db.query("insert into public.sales_rejected_candidates (key_type, key_value, reason, expires_at) values ('instagram_handle', 'access_pan', 'site_without_email', now() + interval '1 day')");
  });

  it("lets only the admin read the memory; nobody writes it through the API", async () => {
    expect((await admin.from("sales_rejected_candidates").select("key_value")).data).toEqual([{ key_value: "access_pan" }]);
    expect((await outsider.from("sales_rejected_candidates").select("key_value")).data ?? []).toEqual([]);
    expect((await anonClient().from("sales_rejected_candidates").select("key_value")).data ?? []).toEqual([]);
    const write = await admin.from("sales_rejected_candidates").insert({ key_type: "instagram_handle", key_value: "direct_pan", reason: "site_without_email", expires_at: new Date(Date.now() + 86400000).toISOString() });
    expect(write.error).not.toBeNull();
    expect((await admin.from("sales_rejected_candidates").delete().eq("key_value", "access_pan")).error).not.toBeNull();
  });

  it("lets no signed-in or anonymous caller run the screening or memory functions", async () => {
    for (const client of [admin, outsider, anonClient()]) {
      const screen = await client.rpc("sales_discovery_known_keys", { p_stubs: [{ key: "c1", instagram_handle: "access_pan" }] });
      expect(screen.error).not.toBeNull();
      const remember = await client.rpc("sales_remember_rejections", { p_run_id: randomUUID(), p_entries: [] });
      expect(remember.error).not.toBeNull();
    }
  });
});
