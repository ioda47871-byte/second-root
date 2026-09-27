import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  anonClient,
  candidate,
  createUser,
  db,
  makeAdmin,
  resetSalesData,
  rpc,
  signedInClient,
  verifiedRun,
} from "./helpers";

// Only the allowlisted admin may read sales data; nobody but the server
// (service role) may write it or drive runs.

const TABLES = ["sales_prospects", "sales_sources", "sales_demos", "sales_outreaches", "sales_agent_runs"];

beforeAll(async () => {
  await resetSalesData();
  const runId = randomUUID();
  await verifiedRun(runId, { c01: candidate() });
  await rpc("sales_run_begin_persist", { p_run_id: runId });
  await rpc("sales_persist_candidate", { p_run_id: runId, p_key: "c01" });
  const adminId = await createUser("admin@test.example.com");
  await makeAdmin(adminId);
  await createUser("someone@test.example.com");
});

afterAll(async () => {
  await resetSalesData();
});

describe("RLS", () => {
  it.each(TABLES)("anon cannot read %s", async (table) => {
    const { data, error } = await anonClient().from(table).select("*");
    // Either an explicit permission error or no rows — never data.
    expect(error !== null || (data ?? []).length === 0).toBe(true);
  });

  it.each(TABLES)("an authenticated non-admin sees no rows in %s", async (table) => {
    const client = await signedInClient("someone@test.example.com");
    const { data, error } = await client.from(table).select("*");
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it.each(TABLES)("the allowlisted admin can read %s", async (table) => {
    const client = await signedInClient("admin@test.example.com");
    const { data, error } = await client.from(table).select("*");
    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThan(0);
  });

  it("the admin cannot write tables directly", async () => {
    const client = await signedInClient("admin@test.example.com");
    const { data: rows } = await client.from("sales_prospects").select("id").limit(1);
    const id = rows![0].id;
    const upd = await client.from("sales_prospects").update({ do_not_contact: false }).eq("id", id).select();
    expect(upd.error ?? (upd.data ?? []).length === 0).toBeTruthy();
    const del = await client.from("sales_outreaches").delete().eq("prospect_id", id).select();
    expect(del.error ?? (del.data ?? []).length === 0).toBeTruthy();
    const { rows: still } = await db.query("select count(*)::int as n from public.sales_outreaches where prospect_id = $1", [id]);
    expect(still[0].n).toBe(1);
  });

  it("public sign-up is disabled (admins are created by a human)", async () => {
    const { data, error } = await anonClient().auth.signUp({ email: "stranger@test.example.com", password: "correct-horse-battery-staple" });
    expect(error).not.toBeNull();
    expect(data.user).toBeNull();
  });

  it("a non-admin cannot add itself to the admin allowlist", async () => {
    const client = await signedInClient("someone@test.example.com");
    const { data: user } = await client.auth.getUser();
    const { error } = await client.from("sales_admins").insert({ user_id: user.user!.id });
    expect(error).not.toBeNull();
  });

  it.each([
    ["sales_run_start", { p_run_id: randomUUID() }],
    ["sales_run_status", { p_run_id: null }],
    ["sales_persist_candidate", { p_run_id: randomUUID(), p_key: "c01" }],
    ["sales_run_abort", { p_run_id: randomUUID(), p_error_code: "x", p_error_summary: "x" }],
  ])("anon and admin users cannot call %s", async (fn, args) => {
    for (const client of [anonClient(), await signedInClient("admin@test.example.com")]) {
      const { error } = await client.rpc(fn, args);
      expect(error, fn).not.toBeNull();
    }
  });
});
