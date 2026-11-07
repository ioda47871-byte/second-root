import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadPublicDemo } from "@/lib/sales/demo-data";
import { anonClient, approve, approveAndMarkSent, candidate, createUser, db, emailCandidate, makeAdmin, resetSalesData, rpc, serviceClient, signedInClient, verifiedRun } from "./helpers";

// 送信済み: admin only, idempotent, re-checks DNC, starts the demo's 30 days.
// DEV-195: it is the confirm step of an opened approval (sales_mark_sent(outreach, approval, design)).

/** Approve and open the send screen; returns the approval id. */
async function openedApproval(outreachId: string): Promise<string> {
  const approved = await approve(admin, outreachId);
  expect(approved.error).toBeNull();
  const approvalId = (approved.data as { approval_id: string }).approval_id;
  expect((await admin.rpc("sales_mark_send_opened", { p_approval_id: approvalId, p_via: "mailto", p_design_enabled: false })).error).toBeNull();
  return approvalId;
}

const markSent = (client: typeof admin, outreachId: string, approvalId: string) =>
  client.rpc("sales_mark_sent", { p_outreach_id: outreachId, p_approval_id: approvalId, p_design_enabled: false });

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
    const { data, error } = await approveAndMarkSent(admin, outreachId);
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
    const approvalId = await openedApproval(outreachId);
    const first = await markSent(admin, outreachId, approvalId);
    const second = await markSent(admin, outreachId, approvalId);
    expect(second.error).toBeNull();
    expect(second.data).toMatchObject({ status: "sent", replayed: true, sent_at: first.data.sent_at });
  });

  it("refuses a DNC shop (before the send screen was opened)", async () => {
    const { outreachId, prospectId } = await prepare(candidate());
    const approved = await approve(admin, outreachId);
    const approvalId = (approved.data as { approval_id: string }).approval_id;
    await db.query("update public.sales_prospects set do_not_contact = true, dnc_reason = 'explicit_refusal', dnc_set_at = now() where id = $1", [prospectId]);
    expect((await admin.rpc("sales_mark_send_opened", { p_approval_id: approvalId, p_via: "mailto", p_design_enabled: false })).error?.message).toMatch(/do_not_contact/);
    expect((await markSent(admin, outreachId, approvalId)).error?.message).toMatch(/not_opened/);
    const { rows } = await db.query("select status from public.sales_outreaches where id = $1", [outreachId]);
    expect(rows[0].status).toBe("drafted");
  });

  it("PR #239 M2: a send confirmed from send_opened after the shop became DNC is recorded with the flag, not refused", async () => {
    const { outreachId, prospectId } = await prepare(candidate());
    const approvalId = await openedApproval(outreachId);
    await db.query("update public.sales_prospects set do_not_contact = true, dnc_reason = 'explicit_refusal', dnc_set_at = now() where id = $1", [prospectId]);
    const { data, error } = await markSent(admin, outreachId, approvalId);
    expect(error).toBeNull();
    expect(data).toMatchObject({ status: "sent", blocked_after_open: "do_not_contact" });
  });

  it("DEV-195: the one-argument version no longer exists (no send without an approval)", async () => {
    const { outreachId } = await prepare(candidate());
    const { error } = await admin.rpc("sales_mark_sent", { p_outreach_id: outreachId });
    expect(error).not.toBeNull();
    const { rows } = await db.query("select status from public.sales_outreaches where id = $1", [outreachId]);
    expect(rows[0].status).toBe("drafted");
  });

  it("is refused for non-admins and anon", async () => {
    const { outreachId } = await prepare(candidate());
    const approvalId = await openedApproval(outreachId);
    expect((await markSent(outsider, outreachId, approvalId)).error?.code).toBe("42501");
    expect((await markSent(anonClient(), outreachId, approvalId)).error?.code).toBe("42501");
    const { rows } = await db.query("select status from public.sales_outreaches where id = $1", [outreachId]);
    expect(rows[0].status).toBe("drafted");
  });

  it("rejects unknown ids and closed outreaches", async () => {
    expect((await markSent(admin, randomUUID(), randomUUID())).error?.message).toMatch(/not_found/);
    const { outreachId } = await prepare(candidate());
    const approvalId = await openedApproval(outreachId);
    await db.query("update public.sales_outreaches set status = 'lost', closed_at = now() where id = $1", [outreachId]);
    expect((await markSent(admin, outreachId, approvalId)).error?.message).toMatch(/invalid_transition/);
  });
});
