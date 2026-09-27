import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadPublicDemo } from "@/lib/sales/demo-data";
import { anonClient, candidate, createUser, db, emailCandidate, makeAdmin, resetSalesData, rpc, serviceClient, signedInClient, verifiedRun } from "./helpers";

// 送信済み: admin only, idempotent, re-checks DNC, starts the demo's 30 days.

async function prepare(c: Record<string, unknown>) {
  const runId = randomUUID();
  await verifiedRun(runId, { c01: c });
  await rpc("sales_run_begin_persist", { p_run_id: runId });
  const { prospect_id } = await rpc<{ prospect_id: string }>("sales_persist_candidate", { p_run_id: runId, p_key: "c01" });
  const { rows } = await db.query("select id from public.sales_outreaches where prospect_id = $1", [prospect_id]);
  const demo = await db.query("select public_token from public.sales_demos where prospect_id = $1", [prospect_id]);
  return { prospectId: prospect_id, outreachId: rows[0].id as string, token: demo.rows[0].public_token as string };
}

let admin: Awaited<ReturnType<typeof signedInClient>>;
let outsider: Awaited<ReturnType<typeof signedInClient>>;

beforeAll(async () => {
  await resetSalesData();
  await makeAdmin(await createUser("sent-admin@test.example.com"));
  await createUser("sent-outsider@test.example.com");
  admin = await signedInClient("sent-admin@test.example.com");
  outsider = await signedInClient("sent-outsider@test.example.com");
});
beforeEach(async () => {
  await db.query("truncate public.sales_outreaches, public.sales_demos, public.sales_sources, public.sales_prospects, public.sales_agent_runs cascade");
});
afterAll(resetSalesData);

describe("sales_mark_sent", () => {
  it("marks the initial outreach sent and opens the demo for 30 days", async () => {
    const { outreachId, token, prospectId } = await prepare(candidate());
    expect(await loadPublicDemo(serviceClient(), token)).toBeNull();
    const { data, error } = await admin.rpc("sales_mark_sent", { p_outreach_id: outreachId });
    expect(error).toBeNull();
    expect(data).toMatchObject({ status: "sent", replayed: false });
    const { rows } = await db.query(
      `select o.status, o.sent_at, d.expires_at, (d.expires_at - o.sent_at) = interval '30 days' as thirty
       from public.sales_outreaches o join public.sales_demos d using (prospect_id) where o.prospect_id = $1`,
      [prospectId],
    );
    expect(rows[0]).toMatchObject({ status: "sent", thirty: true });
    expect(await loadPublicDemo(serviceClient(), token)).not.toBeNull();
  });

  it("is idempotent for a double tap", async () => {
    const { outreachId } = await prepare(emailCandidate());
    const first = await admin.rpc("sales_mark_sent", { p_outreach_id: outreachId });
    const second = await admin.rpc("sales_mark_sent", { p_outreach_id: outreachId });
    expect(second.error).toBeNull();
    expect(second.data).toMatchObject({ status: "sent", replayed: true, sent_at: first.data.sent_at });
  });

  it("refuses a DNC shop", async () => {
    const { outreachId, prospectId } = await prepare(candidate());
    await db.query("update public.sales_prospects set do_not_contact = true, dnc_reason = 'explicit_refusal', dnc_set_at = now() where id = $1", [prospectId]);
    const { error } = await admin.rpc("sales_mark_sent", { p_outreach_id: outreachId });
    expect(error?.message).toMatch(/do_not_contact/);
    const { rows } = await db.query("select status from public.sales_outreaches where id = $1", [outreachId]);
    expect(rows[0].status).toBe("drafted");
  });

  it("is refused for non-admins and anon", async () => {
    const { outreachId } = await prepare(candidate());
    expect((await outsider.rpc("sales_mark_sent", { p_outreach_id: outreachId })).error?.code).toBe("42501");
    expect((await anonClient().rpc("sales_mark_sent", { p_outreach_id: outreachId })).error?.code).toBe("42501");
    const { rows } = await db.query("select status from public.sales_outreaches where id = $1", [outreachId]);
    expect(rows[0].status).toBe("drafted");
  });

  it("rejects unknown ids and closed outreaches", async () => {
    expect((await admin.rpc("sales_mark_sent", { p_outreach_id: randomUUID() })).error?.message).toMatch(/not_found/);
    const { outreachId } = await prepare(candidate());
    await db.query("update public.sales_outreaches set status = 'lost', closed_at = now() where id = $1", [outreachId]);
    expect((await admin.rpc("sales_mark_sent", { p_outreach_id: outreachId })).error?.message).toMatch(/invalid_transition/);
  });
});
