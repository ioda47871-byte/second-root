import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadAwaitingReplies, loadPipeline } from "@/lib/admin/pipeline";
import { candidate, createUser, db, emailCandidate, makeAdmin, resetSalesData, rpc, signedInClient, verifiedRun } from "./helpers";

// DEV-056: the 返信 tab's waiting list (oldest sent first, follow-up state)
// and the 商談 tab, read through the admin's own session (RLS applies).

async function prepare(c: Record<string, unknown>) {
  const runId = randomUUID();
  await verifiedRun(runId, { c01: c });
  await rpc("sales_run_begin_persist", { p_run_id: runId });
  const { prospect_id } = await rpc<{ prospect_id: string }>("sales_persist_candidate", { p_run_id: runId, p_key: "c01" });
  await rpc("sales_run_finalize", { p_run_id: runId });
  const { rows } = await db.query("select id from public.sales_outreaches where prospect_id = $1 and kind = 'initial'", [prospect_id]);
  return { prospectId: prospect_id, outreachId: rows[0].id as string };
}

/** Initial outreach sent `days` ago with the demo public for 30 days from then (as sales_mark_sent does). */
async function sentDaysAgo(shop: { outreachId: string; prospectId: string }, days: number) {
  await db.query(`update public.sales_outreaches set status = 'sent', sent_at = now() - make_interval(days => $2) where id = $1`, [shop.outreachId, days]);
  await db.query(`update public.sales_demos set expires_at = now() - make_interval(days => $2) + interval '30 days' where prospect_id = $1`, [
    shop.prospectId,
    days,
  ]);
}

async function followUpBody(prospectId: string) {
  const { rows } = await db.query("select public_token from public.sales_demos where prospect_id = $1", [prospectId]);
  return `フォロー本文\nhttp://127.0.0.1/demo/${rows[0].public_token}\n以後ご連絡いたしません。`;
}

let admin: Awaited<ReturnType<typeof signedInClient>>;
let outsider: Awaited<ReturnType<typeof signedInClient>>;

beforeAll(async () => {
  await resetSalesData();
  await makeAdmin(await createUser("reply-admin@test.example.com"));
  await createUser("reply-outsider@test.example.com");
  admin = await signedInClient("reply-admin@test.example.com");
  outsider = await signedInClient("reply-outsider@test.example.com");
});
beforeEach(async () => {
  await db.query("truncate public.sales_outreaches, public.sales_demos, public.sales_sources, public.sales_prospects, public.sales_agent_runs cascade");
});
afterAll(resetSalesData);

describe("loadAwaitingReplies", () => {
  it("lists sent initials oldest first with each follow-up state", async () => {
    const instagram = await prepare(candidate());
    const waiting = await prepare(emailCandidate());
    const due = await prepare(emailCandidate());
    const followed = await prepare(emailCandidate());
    const dnc = await prepare(emailCandidate());
    await sentDaysAgo(instagram, 9);
    await sentDaysAgo(waiting, 2);
    await sentDaysAgo(due, 6);
    await sentDaysAgo(followed, 8);
    await sentDaysAgo(dnc, 7);
    // The one follow-up, recorded through the admin RPC (§4.3).
    expect((await admin.rpc("sales_mark_follow_up_sent", { p_outreach_id: followed.outreachId, p_body: await followUpBody(followed.prospectId) })).error).toBeNull();
    await db.query("update public.sales_prospects set do_not_contact = true, dnc_reason = 'explicit_refusal', dnc_set_at = now() where id = $1", [dnc.prospectId]);

    const items = await loadAwaitingReplies(admin);
    expect(items.map((i) => i.outreachId)).toEqual([instagram, followed, dnc, due, waiting].map((s) => s.outreachId));
    expect(items.map((i) => i.followUp.kind)).toEqual(["instagram", "sent", "dnc", "due", "waiting"]);
    expect(items[4].followUp).toMatchObject({ daysLeft: 3 });
    // Follow-up rows themselves are never listed as waiting.
    expect(items.every((i) => i.status === "sent")).toBe(true);
  });

  it("does not offer a follow-up once the demo is no longer public", async () => {
    const shop = await prepare(emailCandidate());
    await sentDaysAgo(shop, 6);
    await db.query("update public.sales_demos set disabled_at = now() where prospect_id = $1", [shop.prospectId]);
    const [item] = await loadAwaitingReplies(admin);
    expect(item.followUp.kind).toBe("demo_unavailable");
  });

  it("agrees with the view sales_followup_due on what is due", async () => {
    const a = await prepare(emailCandidate());
    const b = await prepare(emailCandidate());
    await sentDaysAgo(a, 5);
    await sentDaysAgo(b, 4);
    const view = (await admin.from("sales_followup_due").select("outreach_id")).data!.map((r) => r.outreach_id);
    const dueIds = (await loadAwaitingReplies(admin)).filter((i) => i.followUp.kind === "due").map((i) => i.outreachId);
    expect(dueIds).toEqual(view);
    expect(dueIds).toEqual([a.outreachId]);
  });

  it("returns nothing to a signed-in non-admin", async () => {
    const shop = await prepare(emailCandidate());
    await sentDaysAgo(shop, 6);
    expect(await loadAwaitingReplies(admin)).toHaveLength(1);
    expect(await loadAwaitingReplies(outsider)).toEqual([]);
    expect(await loadPipeline(outsider, ["sent", "replied", "meeting"])).toEqual([]);
  });
});

describe("loadPipeline for 商談", () => {
  it("carries the reply and meeting dates the tab counts from", async () => {
    const replied = await prepare(emailCandidate());
    const meeting = await prepare(candidate());
    await sentDaysAgo(replied, 3);
    await sentDaysAgo(meeting, 3);
    for (const s of [replied, meeting]) {
      expect((await admin.rpc("sales_record_reply", { p_outreach_id: s.outreachId, p_reply_type: "interested", p_future_contact_refused: false })).error).toBeNull();
    }
    expect((await admin.rpc("sales_mark_meeting", { p_outreach_id: meeting.outreachId })).error).toBeNull();

    const items = await loadPipeline(admin, ["replied", "meeting"]);
    const byId = new Map(items.map((i) => [i.outreachId, i]));
    expect(byId.get(replied.outreachId)).toMatchObject({ status: "replied", repliedAt: expect.any(String), meetingAt: null });
    expect(byId.get(meeting.outreachId)).toMatchObject({ status: "meeting", meetingAt: expect.any(String) });
    expect(await loadPipeline(outsider, ["replied", "meeting"])).toEqual([]);
  });
});
