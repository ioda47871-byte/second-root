import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
    ["first-party email", emailCandidate, (c: Record<string, unknown>) => ({ public_email: c.public_email })],
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
    p_public_email: null,
    p_normalized_name: null,
    p_normalized_address: null,
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
