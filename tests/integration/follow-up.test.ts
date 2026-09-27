import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { candidate, createUser, db, emailCandidate, makeAdmin, resetSalesData, rpc, signedInClient, verifiedRun } from "./helpers";

// 5-day email follow-up (MVP_SPEC §4.3): email only, once, 5+ days after
// the initial email, no reply, not DNC, live demo; admin only; idempotent.

async function prepare(c: Record<string, unknown>) {
  const runId = randomUUID();
  await verifiedRun(runId, { c01: c });
  await rpc("sales_run_begin_persist", { p_run_id: runId });
  const { prospect_id } = await rpc<{ prospect_id: string }>("sales_persist_candidate", { p_run_id: runId, p_key: "c01" });
  const { rows } = await db.query("select id from public.sales_outreaches where prospect_id = $1 and kind = 'initial'", [prospect_id]);
  return { prospectId: prospect_id, outreachId: rows[0].id as string };
}

/** Initial outreach sent `days` ago with the demo public for 30 days from then. */
async function sentDaysAgo(outreachId: string, prospectId: string, days: number) {
  await db.query(
    `update public.sales_outreaches set status = 'sent', sent_at = now() - make_interval(days => $2) where id = $1`,
    [outreachId, days],
  );
  await db.query(
    `update public.sales_demos set expires_at = now() - make_interval(days => $2) + interval '30 days' where prospect_id = $1`,
    [prospectId, days],
  );
}

const SUBJECT = "Re: ホームページのご提案";
const BODY = "フォロー本文";

let admin: Awaited<ReturnType<typeof signedInClient>>;
let outsider: Awaited<ReturnType<typeof signedInClient>>;

beforeAll(async () => {
  await resetSalesData();
  await makeAdmin(await createUser("follow-admin@test.example.com"));
  await createUser("follow-outsider@test.example.com");
  admin = await signedInClient("follow-admin@test.example.com");
  outsider = await signedInClient("follow-outsider@test.example.com");
});
beforeEach(async () => {
  await db.query("truncate public.sales_outreaches, public.sales_demos, public.sales_sources, public.sales_prospects, public.sales_agent_runs cascade");
});
afterAll(resetSalesData);

const due = async () => (await admin.from("sales_followup_due").select("outreach_id")).data!.map((r) => r.outreach_id);
const followUps = async (prospectId: string) =>
  (await db.query("select status, subject, body, sent_at from public.sales_outreaches where prospect_id = $1 and kind = 'follow_up'", [prospectId])).rows;

describe("sales_mark_follow_up_sent", () => {
  it("records one follow-up for a due email and removes it from the queue", async () => {
    const { outreachId, prospectId } = await prepare(emailCandidate());
    await sentDaysAgo(outreachId, prospectId, 5);
    expect(await due()).toEqual([outreachId]);

    const { data, error } = await admin.rpc("sales_mark_follow_up_sent", { p_outreach_id: outreachId, p_subject: SUBJECT, p_body: BODY });
    expect(error).toBeNull();
    expect(data).toMatchObject({ status: "sent", replayed: false });
    expect(await followUps(prospectId)).toMatchObject([{ status: "sent", subject: SUBJECT, body: BODY }]);
    // The initial outreach keeps the state.
    const { rows } = await db.query("select status from public.sales_outreaches where id = $1", [outreachId]);
    expect(rows[0].status).toBe("sent");
    expect(await due()).toEqual([]);
  });

  it("is idempotent and never sends a second follow-up", async () => {
    const { outreachId, prospectId } = await prepare(emailCandidate());
    await sentDaysAgo(outreachId, prospectId, 6);
    const first = await admin.rpc("sales_mark_follow_up_sent", { p_outreach_id: outreachId, p_subject: SUBJECT, p_body: BODY });
    const second = await admin.rpc("sales_mark_follow_up_sent", { p_outreach_id: outreachId, p_subject: SUBJECT, p_body: "別の本文" });
    expect(second.error).toBeNull();
    expect(second.data).toMatchObject({ replayed: true, sent_at: first.data.sent_at });
    expect(await followUps(prospectId)).toMatchObject([{ body: BODY }]);
  });

  it.each([
    ["before 5 days", 4, null],
    ["after a reply", 6, "replied"],
    ["after the deal was lost", 6, "lost"],
  ])("refuses %s", async (_label, days, status) => {
    const { outreachId, prospectId } = await prepare(emailCandidate());
    await sentDaysAgo(outreachId, prospectId, days);
    if (status === "replied") {
      await db.query("update public.sales_outreaches set status = 'replied', reply_type = 'question', replied_at = now() where id = $1", [outreachId]);
    }
    if (status === "lost") {
      await db.query("update public.sales_outreaches set status = 'lost', closed_at = now() where id = $1", [outreachId]);
    }
    expect(await due()).toEqual([]);
    const { error } = await admin.rpc("sales_mark_follow_up_sent", { p_outreach_id: outreachId, p_subject: SUBJECT, p_body: BODY });
    expect(error?.message).toContain("not_due");
    expect(await followUps(prospectId)).toEqual([]);
  });

  it("refuses a DNC shop", async () => {
    const { outreachId, prospectId } = await prepare(emailCandidate());
    await sentDaysAgo(outreachId, prospectId, 6);
    await db.query("update public.sales_prospects set do_not_contact = true, dnc_reason = 'explicit_refusal', dnc_set_at = now() where id = $1", [prospectId]);
    expect(await due()).toEqual([]);
    const { error } = await admin.rpc("sales_mark_follow_up_sent", { p_outreach_id: outreachId, p_subject: SUBJECT, p_body: BODY });
    expect(error?.message).toContain("do_not_contact");
    expect(await followUps(prospectId)).toEqual([]);
  });

  it.each([
    ["disabled", "update public.sales_demos set disabled_at = now() where prospect_id = $1"],
    ["expired", "update public.sales_demos set expires_at = now() - interval '1 minute' where prospect_id = $1"],
  ])("refuses when the demo is %s", async (_label, sql) => {
    const { outreachId, prospectId } = await prepare(emailCandidate());
    await sentDaysAgo(outreachId, prospectId, 6);
    await db.query(sql, [prospectId]);
    expect(await due()).toEqual([]);
    const { error } = await admin.rpc("sales_mark_follow_up_sent", { p_outreach_id: outreachId, p_subject: SUBJECT, p_body: BODY });
    expect(error?.message).toContain("demo_unavailable");
  });

  it("never follows up on Instagram", async () => {
    const { outreachId, prospectId } = await prepare(candidate());
    await sentDaysAgo(outreachId, prospectId, 6);
    expect(await due()).toEqual([]);
    const { error } = await admin.rpc("sales_mark_follow_up_sent", { p_outreach_id: outreachId, p_subject: SUBJECT, p_body: BODY });
    expect(error?.message).toContain("not_due");
  });

  it("is admin only", async () => {
    const { outreachId, prospectId } = await prepare(emailCandidate());
    await sentDaysAgo(outreachId, prospectId, 6);
    const res = await outsider.rpc("sales_mark_follow_up_sent", { p_outreach_id: outreachId, p_subject: SUBJECT, p_body: BODY });
    expect(res.error?.code).toBe("42501");
    expect(await followUps(prospectId)).toEqual([]);
  });

  it("rejects an unknown or follow-up id", async () => {
    const { error } = await admin.rpc("sales_mark_follow_up_sent", { p_outreach_id: randomUUID(), p_subject: SUBJECT, p_body: BODY });
    expect(error?.code).toBe("P0002");
  });
});
