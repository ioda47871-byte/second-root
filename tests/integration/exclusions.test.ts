import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { emailDigest } from "@/lib/sales/email-digest";
import { candidate, createUser, db, emailCandidate, makeAdmin, resetSalesData, rpc, signedInClient, verifiedRun } from "./helpers";

// DEV-049: the admin's exclusion list is checked at persist (rejected(excluded),
// nothing created), is admin-only to read and write, and never touches the
// own-run replay.

async function persistAll(runId: string, keys: string[]) {
  await rpc("sales_run_begin_persist", { p_run_id: runId });
  const results: Array<Record<string, unknown>> = [];
  for (const key of keys) results.push(await rpc("sales_persist_candidate", { p_run_id: runId, p_key: key }));
  await rpc("sales_run_finalize", { p_run_id: runId });
  return results;
}

async function exclude(row: Record<string, unknown>) {
  const cols = Object.keys(row);
  await db.query(
    `insert into public.sales_exclusions (label, reason, ${cols.join(", ")}) values ('テスト', 'existing_customer', ${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
    Object.values(row),
  );
}

const count = async (table: string) => Number((await db.query(`select count(*)::int as n from public.${table}`)).rows[0].n);

beforeEach(async () => {
  await db.query("truncate public.sales_exclusions, public.sales_outreaches, public.sales_demos, public.sales_sources, public.sales_prospects, public.sales_agent_runs cascade");
});
afterAll(resetSalesData);

describe("persist with the exclusion list", () => {
  it.each([
    ["instagram handle", candidate, (c: Record<string, unknown>) => ({ instagram_handle: c.instagram_handle })],
    ["website domain", emailCandidate, (c: Record<string, unknown>) => ({ website_domain: c.website_domain })],
    ["first-party email (digest)", (o?: Record<string, unknown>) => { const c = emailCandidate(o); return { ...c, email_digest: emailDigest(String(c.public_email)) }; }, (c: Record<string, unknown>) => ({ email_digest: c.email_digest })],
    ["name + address", candidate, (c: Record<string, unknown>) => ({ normalized_name: c.normalized_name, normalized_address: c.normalized_address })],
  ])("rejects a candidate matching by %s and creates nothing", async (_label, make, key) => {
    const shop = make();
    expect(Object.values(key(shop)).every((v) => typeof v === "string" && v.length > 0)).toBe(true);
    await exclude(key(shop));
    const run = randomUUID();
    await verifiedRun(run, { c01: shop });
    const [result] = await persistAll(run, ["c01"]);
    expect(result).toMatchObject({ key: "c01", stage: "rejected", reason: "excluded" });
    expect(await count("sales_prospects")).toBe(0);
    expect(await count("sales_demos")).toBe(0);
    expect(await count("sales_outreaches")).toBe(0);
  });

  it("matches an email exclusion against a candidate whose email is not first-party (digest only)", async () => {
    const shop = candidate({ email_digest: emailDigest("owner@customer.example.com") });
    expect(shop.public_email).toBeNull();
    await exclude({ email_digest: emailDigest("owner@customer.example.com") });
    const run = randomUUID();
    await verifiedRun(run, { c01: shop, c02: candidate({ email_digest: emailDigest("someone@else.example.com") }) });
    const results = await persistAll(run, ["c01", "c02"]);
    expect(results.map((r) => r.stage)).toEqual(["rejected", "outreach_ready"]);
    expect(results[0]).toMatchObject({ reason: "excluded" });
  });

  it("DEV-050: a checkpoint written before email_digest existed still matches by its first-party email", async () => {
    const shop = emailCandidate();
    expect(shop.email_digest).toBeUndefined();
    await exclude({ email_digest: emailDigest(String(shop.public_email)) });
    const run = randomUUID();
    await verifiedRun(run, { c01: shop });
    const [result] = await persistAll(run, ["c01"]);
    expect(result).toMatchObject({ stage: "rejected", reason: "excluded" });
  });

  it("does not match a name without the same address", async () => {
    const shop = candidate();
    await exclude({ normalized_name: shop.normalized_name, normalized_address: "愛知県名古屋市中区べつの町1-1" });
    const run = randomUUID();
    await verifiedRun(run, { c01: shop });
    const [result] = await persistAll(run, ["c01"]);
    expect(result.stage).toBe("outreach_ready");
  });

  it("prepares other candidates as before", async () => {
    await exclude({ instagram_handle: "someone_else" });
    const run = randomUUID();
    await verifiedRun(run, { c01: candidate(), c02: emailCandidate() });
    const results = await persistAll(run, ["c01", "c02"]);
    expect(results.map((r) => r.stage)).toEqual(["outreach_ready", "outreach_ready"]);
  });

  it("keeps the own-run replay idempotent even if the shop is excluded afterwards", async () => {
    const shop = candidate();
    const run = randomUUID();
    await verifiedRun(run, { c01: shop });
    await rpc("sales_run_begin_persist", { p_run_id: run });
    const first = await rpc<{ stage: string; prospect_id: string }>("sales_persist_candidate", { p_run_id: run, p_key: "c01" });
    expect(first.stage).toBe("outreach_ready");
    await exclude({ instagram_handle: shop.instagram_handle });
    // Simulate a lost checkpoint write: the stage is pending again but the rows exist.
    await db.query(
      "update public.sales_agent_runs set checkpoint = jsonb_set(checkpoint, '{candidates,c01}', '{\"stage\":\"pending\"}') where run_id = $1",
      [run],
    );
    const again = await rpc<{ stage: string; prospect_id: string }>("sales_persist_candidate", { p_run_id: run, p_key: "c01" });
    expect(again).toMatchObject({ stage: "outreach_ready", prospect_id: first.prospect_id });
  });

  it("an excluded candidate does not use a daily-cap slot", async () => {
    const shops = Array.from({ length: 6 }, () => candidate());
    await exclude({ instagram_handle: shops[0].instagram_handle });
    const run = randomUUID();
    await verifiedRun(run, Object.fromEntries(shops.map((s, i) => [`c0${i}`, s])));
    const results = await persistAll(run, shops.map((_, i) => `c0${i}`));
    expect(results.map((r) => r.stage)).toEqual(["rejected", "outreach_ready", "outreach_ready", "outreach_ready", "outreach_ready", "outreach_ready"]);
  });
});

describe("DEV-050: no plain email in the exclusion list", () => {
  it("has no email column other than the 64-hex digest", async () => {
    const { rows } = await db.query(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'sales_exclusions' and column_name like '%email%'",
    );
    expect(rows).toEqual([{ column_name: "email_digest" }]);
    await expect(exclude({ email_digest: "owner@customer.example.com" })).rejects.toThrow(/check constraint/);
    await expect(exclude({ email_digest: "A".repeat(64) })).rejects.toThrow(/check constraint/);
    await expect(
      db.query("insert into public.sales_exclusions (label, reason, instagram_handle) values ('連絡 owner@customer.example.jp', 'other', 'x_shop')"),
    ).rejects.toThrow(/check constraint/);
    await expect(
      db.query("insert into public.sales_exclusions (label, reason, note, instagram_handle) values ('店', 'other', 'owner@customer.example.jp', 'x_shop')"),
    ).rejects.toThrow(/check constraint/);
    await db.query("insert into public.sales_exclusions (label, reason, instagram_handle) values ('Cafe@Home', 'other', 'x_shop')");
  });

  it("the add function takes a digest, not an email", async () => {
    const { rows } = await db.query(
      "select pg_get_function_identity_arguments('public.sales_add_exclusion(text, text, text, text, text, text, text, text)'::regprocedure) as args",
    );
    expect(rows[0].args).toContain("p_email_digest");
    expect(rows[0].args).not.toMatch(/public_email/);
  });
});

describe("exclusion list access", () => {
  let admin: Awaited<ReturnType<typeof signedInClient>>;
  let outsider: Awaited<ReturnType<typeof signedInClient>>;
  beforeAll(async () => {
    await makeAdmin(await createUser("excl-admin@test.example.com"));
    await createUser("excl-outsider@test.example.com");
    admin = await signedInClient("excl-admin@test.example.com");
    outsider = await signedInClient("excl-outsider@test.example.com");
  });

  const args = (handle: string) => ({
    p_label: "既存のお客様",
    p_reason: "existing_customer",
    p_note: "",
    p_instagram_handle: handle,
    p_website_domain: null,
    p_email_digest: null,
    p_normalized_name: null,
    p_normalized_address: null,
  });

  it("DEV-050: refuses an email (or anything but a digest) in the digest argument and stores no '@'", async () => {
    const bad = await admin.rpc("sales_add_exclusion", { ...args(""), p_email_digest: "owner@rpc-check.example.com" });
    expect(bad.error?.message).toMatch(/invalid_exclusion/);
    const inLabel = await admin.rpc("sales_add_exclusion", { ...args("label_shop"), p_label: "owner@rpc-check.example.com" });
    expect(inLabel.error?.message).toMatch(/invalid_exclusion/);
    const inNote = await admin.rpc("sales_add_exclusion", { ...args("note_shop"), p_note: "owner@rpc-check.example.com" });
    expect(inNote.error?.message).toMatch(/invalid_exclusion/);
    const good = await admin.rpc("sales_add_exclusion", { ...args(""), p_email_digest: emailDigest("owner@customer.example.com") });
    expect(good.error).toBeNull();
    const { rows } = await db.query("select row_to_json(e)::text as row from public.sales_exclusions e");
    expect(rows).toHaveLength(1);
    expect(rows[0].row).not.toContain("@");
    await admin.rpc("sales_remove_exclusion", { p_id: good.data });
  });

  it("lets the admin add, read and remove; refuses duplicates and empty keys", async () => {
    const added = await admin.rpc("sales_add_exclusion", args("existing_shop"));
    expect(added.error).toBeNull();
    const read = await admin.from("sales_exclusions").select("label, reason, instagram_handle, note, created_by");
    expect(read.data).toEqual([expect.objectContaining({ label: "既存のお客様", reason: "existing_customer", instagram_handle: "existing_shop", note: null })]);
    expect(read.data?.[0].created_by).toEqual(expect.any(String));
    const dup = await admin.rpc("sales_add_exclusion", args("existing_shop"));
    expect(dup.error?.message).toMatch(/already_excluded/);
    const empty = await admin.rpc("sales_add_exclusion", args(""));
    expect(empty.error?.message).toMatch(/invalid_exclusion/);
    const removed = await admin.rpc("sales_remove_exclusion", { p_id: added.data });
    expect(removed.error).toBeNull();
    expect(await count("sales_exclusions")).toBe(0);
  });

  it("refuses a non-admin: no read, no add, no remove, no direct write", async () => {
    await exclude({ instagram_handle: "hidden_shop" });
    const read = await outsider.from("sales_exclusions").select("id");
    expect(read.data ?? []).toEqual([]);
    const add = await outsider.rpc("sales_add_exclusion", args("outsider_shop"));
    expect(add.error?.message).toMatch(/forbidden/);
    const id = (await db.query("select id from public.sales_exclusions")).rows[0].id;
    const remove = await outsider.rpc("sales_remove_exclusion", { p_id: id });
    expect(remove.error?.message).toMatch(/forbidden/);
    const direct = await admin.from("sales_exclusions").insert({ label: "x", reason: "other", instagram_handle: "direct_shop" });
    expect(direct.error).not.toBeNull();
    expect(await count("sales_exclusions")).toBe(1);
  });
});
