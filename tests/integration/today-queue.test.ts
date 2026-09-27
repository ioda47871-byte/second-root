import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadTodayQueue } from "@/lib/admin/today";
import { candidate, createUser, db, emailCandidate, makeAdmin, resetSalesData, rpc, signedInClient, verifiedRun } from "./helpers";

// Today's queue through the admin's own session (RLS applies).

async function prepare(c: Record<string, unknown>): Promise<string> {
  const runId = randomUUID();
  await verifiedRun(runId, { c01: c });
  await rpc("sales_run_begin_persist", { p_run_id: runId });
  const r = await rpc<{ prospect_id: string }>("sales_persist_candidate", { p_run_id: runId, p_key: "c01" });
  // Move the draft to an earlier day so tests can prepare more than the daily
  // cap of 5. Test-only: the identity trigger normally forbids this.
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    await client.query("update public.sales_outreaches set created_at = created_at - interval '2 days' where prospect_id = $1", [r.prospect_id]);
    await client.query("commit");
  } finally {
    client.release();
  }
  return r.prospect_id;
}

async function markSent(prospectId: string, daysAgo: number) {
  await db.query(
    `update public.sales_outreaches set status = 'sent', sent_at = now() - make_interval(days => $2) where prospect_id = $1 and kind = 'initial'`,
    [prospectId, daysAgo],
  );
}

let admin: Awaited<ReturnType<typeof signedInClient>>;

beforeAll(async () => {
  await resetSalesData();
  await makeAdmin(await createUser("queue-admin@test.example.com"));
  await createUser("queue-outsider@test.example.com");
  admin = await signedInClient("queue-admin@test.example.com");
});
beforeEach(async () => {
  await db.query("truncate public.sales_outreaches, public.sales_demos, public.sales_sources, public.sales_prospects, public.sales_agent_runs cascade");
});
afterAll(resetSalesData);

describe("today queue", () => {
  it("lists unsent drafts oldest first with what the card needs", async () => {
    const a = await prepare(candidate());
    const b = await prepare(emailCandidate());
    const items = await loadTodayQueue(admin);
    expect(items.map((i) => i.prospectId)).toEqual([a, b]);
    expect(items[0]).toMatchObject({ kind: "initial", channel: "instagram", demoToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect(items[1]).toMatchObject({ channel: "email", publicEmail: expect.stringContaining("@") });
  });

  it("never shows DNC shops or already-sent initials", async () => {
    const dnc = await prepare(emailCandidate());
    await db.query("update public.sales_prospects set do_not_contact = true, dnc_reason = 'explicit_refusal', dnc_set_at = now() where id = $1", [dnc]);
    const sent = await prepare(candidate());
    await markSent(sent, 1);
    expect(await loadTodayQueue(admin)).toEqual([]);
  });

  it("puts due email follow-ups first and caps the queue at 5", async () => {
    const drafts = [];
    for (let i = 0; i < 5; i += 1) drafts.push(await prepare(candidate()));
    const due = await prepare(emailCandidate());
    await markSent(due, 6);
    const notYet = await prepare(emailCandidate());
    await markSent(notYet, 4);
    const items = await loadTodayQueue(admin);
    expect(items).toHaveLength(5);
    expect(items[0]).toMatchObject({ kind: "follow_up", prospectId: due });
    expect(items.slice(1).every((i) => i.kind === "initial")).toBe(true);
    expect(items.some((i) => i.prospectId === notYet)).toBe(false);
  });

  it("drops a follow-up once it has been sent, after a reply, or for Instagram", async () => {
    const replied = await prepare(emailCandidate());
    await markSent(replied, 6);
    await db.query("update public.sales_outreaches set status = 'replied', reply_type = 'question', replied_at = now() where prospect_id = $1", [replied]);
    const insta = await prepare(candidate());
    await markSent(insta, 9);
    expect(await loadTodayQueue(admin)).toEqual([]);
  });

  it("counts exactly 5 days as due and keeps offering follow-ups beyond many past ones", async () => {
    const exactly = await prepare(emailCandidate());
    await db.query(`update public.sales_outreaches set status = 'sent', sent_at = now() - interval '5 days' - interval '1 second' where prospect_id = $1`, [exactly]);
    // 60 older shops that already had their follow-up must not crowd it out.
    for (let i = 0; i < 60; i += 1) {
      const old = await prepare(emailCandidate());
      await markSent(old, 30);
      await db.query(
        `insert into public.sales_outreaches (prospect_id, kind, channel, subject, body) values ($1, 'follow_up', 'email', 'Re: x', 'x')`,
        [old],
      );
      await db.query(`update public.sales_outreaches set status = 'sent', sent_at = now() - interval '20 days' where prospect_id = $1 and kind = 'follow_up'`, [old]);
    }
    const items = await loadTodayQueue(admin);
    expect(items.map((i) => i.prospectId)).toEqual([exactly]);
  });

  it("still offers the follow-up while a follow-up row is only drafted", async () => {
    const due = await prepare(emailCandidate());
    await markSent(due, 7);
    await db.query(`insert into public.sales_outreaches (prospect_id, kind, channel, subject, body) values ($1, 'follow_up', 'email', 'Re: x', 'x')`, [due]);
    const items = await loadTodayQueue(admin);
    expect(items.map((i) => [i.kind, i.prospectId])).toEqual([["follow_up", due]]);
  });

  it("shows nothing to a non-admin session", async () => {
    await prepare(candidate());
    const outsider = await signedInClient("queue-outsider@test.example.com");
    expect(await loadTodayQueue(outsider)).toEqual([]);
  });
});
