import { createHmac, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as webhook } from "@/app/api/webhooks/instagram/route";
import { sendApprovedReply } from "@/lib/instagram/reply";
import { candidate, createUser, db, makeAdmin, resetSalesData, rpc, signedInClient, verifiedRun } from "./helpers";

// 「この内容で返信」 through the official Send API (mocked): human approval
// only, never sent twice, failures never recorded as sent (DEV-023).

const SECRET = ["ig", "app", "secret", "for", "tests", "0123"].join("-");
const ACCESS = ["ig", "access", "token", "for", "tests", "0123456"].join("-");
const OURS = "17841400000000001";

type Reply = { status: number; body: unknown } | "network";
let replies: Reply[] = [];
let sendCalls: Array<{ url: string; body: unknown }> = [];

let admin: SupabaseClient;
let outsider: SupabaseClient;

async function receive(igsid: string, mid: string, text: string, timestamp = Date.now()) {
  const raw = JSON.stringify({ object: "instagram", entry: [{ id: OURS, messaging: [{ sender: { id: igsid }, recipient: { id: OURS }, timestamp, message: { mid, text } }] }] });
  const res = await webhook(new NextRequest("http://localhost/api/webhooks/instagram", { method: "POST", headers: { "X-Hub-Signature-256": `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}` }, body: raw }));
  expect(res.status).toBe(200);
}

/** A matched conversation with an open draft, ready to send. */
async function conversation(igsid: string, { matched = true, receivedAgoMs = 0 } = {}) {
  const runId = randomUUID();
  const c = candidate();
  await verifiedRun(runId, { c01: c });
  await rpc("sales_run_begin_persist", { p_run_id: runId });
  const { prospect_id } = await rpc<{ prospect_id: string }>("sales_persist_candidate", { p_run_id: runId, p_key: "c01" });
  await db.query("update public.sales_outreaches set status = 'sent', sent_at = now() where prospect_id = $1", [prospect_id]);
  await receive(igsid, `mid-${igsid}`, "詳しく教えてください", Date.now() - receivedAgoMs);
  const { rows: [t] } = await db.query("select id from public.sales_ig_threads where igsid = $1", [igsid]);
  if (matched) await rpc("sales_ig_match_thread", { p_thread_id: t.id, p_username: c.instagram_handle });
  const { rows: [m] } = await db.query("select id from public.sales_ig_messages where mid = $1", [`mid-${igsid}`]);
  const saved = await rpc<{ draft_id: string }>("sales_ig_save_draft", {
    p_thread_id: t.id, p_message_id: m.id, p_reply_type: "question", p_body: "お問い合わせありがとうございます。", p_dnc_candidate: false, p_needs_review: false, p_review_reasons: [],
  });
  return { threadId: t.id as string, draftId: saved.draft_id, prospectId: prospect_id as string };
}

const state = async (draftId: string) => {
  const { rows: [d] } = await db.query("select status from public.sales_ig_drafts where id = $1", [draftId]);
  const { rows: sends } = await db.query("select status, attempts, meta_message_id, sent_at is not null as has_sent_at from public.sales_ig_sends where draft_id = $1", [draftId]);
  return { draft: d.status as string, sends };
};

beforeAll(async () => {
  await resetSalesData();
  await makeAdmin(await createUser("igsend-admin@test.example.com"));
  await createUser("igsend-outsider@test.example.com");
  admin = await signedInClient("igsend-admin@test.example.com");
  outsider = await signedInClient("igsend-outsider@test.example.com");
});
beforeEach(async () => {
  await db.query("truncate public.sales_ig_messages, public.sales_ig_threads, public.sales_ig_webhook_events, public.sales_outreaches, public.sales_demos, public.sales_sources, public.sales_prospects, public.sales_agent_runs cascade");
  replies = [];
  sendCalls = [];
  vi.stubEnv("INSTAGRAM_APP_SECRET", SECRET);
  vi.stubEnv("INSTAGRAM_WEBHOOK_VERIFY_TOKEN", "verify-token-for-tests");
  vi.stubEnv("INSTAGRAM_ACCOUNT_ID", OURS);
  vi.stubEnv("INSTAGRAM_ACCESS_TOKEN", ACCESS);
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(process.env.NEXT_PUBLIC_SUPABASE_URL!)) return realFetch(input, init);
    if (!/^https:\/\/graph\.instagram\.com\/v\d+\.0\/17841400000000001\/messages$/.test(url) || init?.method !== "POST") throw new Error(`unexpected fetch: ${url}`);
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${ACCESS}`);
    sendCalls.push({ url, body: JSON.parse(String(init?.body)) });
    const reply = replies.shift() ?? { status: 200, body: { recipient_id: "x", message_id: `m_${sendCalls.length}` } };
    if (reply === "network") throw new TypeError("fetch failed");
    return Response.json(reply.body, { status: reply.status });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(resetSalesData);

describe("sending an approved reply", () => {
  it("sends once through the official API, records the message id and the conversation", async () => {
    const c = await conversation("900000000000501");
    expect(await sendApprovedReply(admin, c.draftId)).toEqual({ kind: "sent" });
    expect(sendCalls).toEqual([{ url: expect.any(String), body: { recipient: { id: "900000000000501" }, message: { text: "お問い合わせありがとうございます。" } } }]);
    expect(await state(c.draftId)).toEqual({ draft: "sent", sends: [{ status: "sent", attempts: 1, meta_message_id: "m_1", has_sent_at: true }] });
    // Meta's echo of the same message is not stored twice.
    const raw = JSON.stringify({ object: "instagram", entry: [{ id: OURS, messaging: [{ sender: { id: OURS }, recipient: { id: "900000000000501" }, timestamp: Date.now(), message: { mid: "m_1", text: "お問い合わせありがとうございます。", is_echo: true } }] }] });
    await webhook(new NextRequest("http://localhost/api/webhooks/instagram", { method: "POST", headers: { "X-Hub-Signature-256": `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}` }, body: raw }));
    const { rows } = await db.query("select count(*)::int as n from public.sales_ig_messages where direction = 'outbound'");
    expect(rows[0].n).toBe(1);
  });

  it("[idempotency] never sends twice on a double tap or retry", async () => {
    const c = await conversation("900000000000502");
    const [a, b] = await Promise.all([sendApprovedReply(admin, c.draftId), sendApprovedReply(admin, c.draftId)]);
    expect([a.kind, b.kind].sort()).toEqual(expect.arrayContaining(["sent"]));
    expect(await sendApprovedReply(admin, c.draftId)).toEqual({ kind: "already_sent" });
    expect(sendCalls).toHaveLength(1);
  });

  it("[fail-closed] a clear refusal from Meta is never recorded as sent, and can be retried safely", async () => {
    const c = await conversation("900000000000503");
    replies = [{ status: 400, body: { error: { code: 10, error_subcode: 2534022, message: "outside window" } } }];
    expect(await sendApprovedReply(admin, c.draftId)).toEqual({ kind: "failed", errorCode: "meta_10_2534022" });
    expect(await state(c.draftId)).toMatchObject({ draft: "failed", sends: [{ status: "failed", has_sent_at: false }] });
    expect(await sendApprovedReply(admin, c.draftId)).toEqual({ kind: "sent" });
    expect(await state(c.draftId)).toMatchObject({ draft: "sent", sends: [{ status: "sent", attempts: 2 }] });
    expect(sendCalls).toHaveLength(2);
  });

  it.each([
    ["a network failure", "network" as const],
    ["a server error", { status: 500, body: { error: { code: 2, is_transient: true } } }],
    ["Meta's 'sent but errored' case", { status: 400, body: { error: { code: 100, error_subcode: 1357046 } } }],
    ["an unreadable success", { status: 200, body: { recipient_id: "x" } }],
    ["Meta's generic 4xx error", { status: 400, body: { error: { code: 1, message: "unknown error" } } }],
    ["a transient 4xx error", { status: 400, body: { error: { code: 4, is_transient: true } } }],
  ])("[fail-closed] %s becomes 'unknown' and is never retried automatically", async (_label, reply) => {
    const c = await conversation("900000000000504");
    replies = [reply];
    expect(await sendApprovedReply(admin, c.draftId)).toEqual({ kind: "unknown" });
    expect(await sendApprovedReply(admin, c.draftId)).toEqual({ kind: "unknown" });
    expect(sendCalls).toHaveLength(1);
    const { rows: [s] } = await db.query("select id from public.sales_ig_sends where draft_id = $1", [c.draftId]);
    // The human checked Instagram: it was not sent → may send again.
    await admin.rpc("sales_ig_resolve_unknown", { p_send_id: s.id, p_was_sent: false });
    expect(await sendApprovedReply(admin, c.draftId)).toEqual({ kind: "sent" });
    expect(sendCalls).toHaveLength(2);
  });

  it("records 'it was sent' from the human without sending again", async () => {
    const c = await conversation("900000000000505");
    replies = ["network"];
    await sendApprovedReply(admin, c.draftId);
    const { rows: [s] } = await db.query("select id from public.sales_ig_sends where draft_id = $1", [c.draftId]);
    await admin.rpc("sales_ig_resolve_unknown", { p_send_id: s.id, p_was_sent: true });
    expect(await sendApprovedReply(admin, c.draftId)).toEqual({ kind: "already_sent" });
    expect(sendCalls).toHaveLength(1);
  });

  it("[resume] an interrupted send (server died mid-call) becomes 'unknown', never resent", async () => {
    const c = await conversation("900000000000506");
    await admin.rpc("sales_ig_begin_send", { p_draft_id: c.draftId }); // reserved, then the process died
    expect(await sendApprovedReply(admin, c.draftId)).toEqual({ kind: "in_flight" });
    // Time passes (the touch trigger would reset updated_at, so bypass it here only).
    await db.query(`begin; set local session_replication_role = replica; update public.sales_ig_sends set updated_at = now() - interval '3 minutes' where draft_id = '${c.draftId}'; commit;`);
    expect(await sendApprovedReply(admin, c.draftId)).toEqual({ kind: "unknown" });
    expect(sendCalls).toHaveLength(0);
  });

  it("an edited text is a new send; the old one stays as it was", async () => {
    const c = await conversation("900000000000507");
    replies = [{ status: 400, body: { error: { code: 100 } } }];
    await sendApprovedReply(admin, c.draftId);
    await admin.rpc("sales_ig_update_draft", { p_draft_id: c.draftId, p_body: "修正した返信です。", p_needs_review: false, p_review_reasons: [] });
    expect(await sendApprovedReply(admin, c.draftId)).toEqual({ kind: "sent" });
    expect((sendCalls[1].body as { message: { text: string } }).message.text).toBe("修正した返信です。");
    const { rows } = await db.query("select status from public.sales_ig_sends where draft_id = $1 order by created_at", [c.draftId]);
    expect(rows.map((r) => r.status)).toEqual(["failed", "sent"]);
  });
});

describe("what is never sent", () => {
  it("refuses outside Meta's 24-hour window, to unmatched conversations and to DNC shops", async () => {
    const late = await conversation("900000000000601", { receivedAgoMs: 25 * 60 * 60 * 1000 });
    expect(await sendApprovedReply(admin, late.draftId)).toEqual({ kind: "refused", code: "window_closed" });
    const unmatched = await conversation("900000000000602", { matched: false });
    expect(await sendApprovedReply(admin, unmatched.draftId)).toEqual({ kind: "refused", code: "unmatched" });
    const dnc = await conversation("900000000000603");
    await db.query("update public.sales_prospects set do_not_contact = true, dnc_reason = 'explicit_refusal', dnc_set_at = now() where id = $1", [dnc.prospectId]);
    expect(await sendApprovedReply(admin, dnc.draftId)).toEqual({ kind: "refused", code: "do_not_contact" });
    expect(sendCalls).toHaveLength(0);
  });

  it("does nothing for a non-admin session and needs no Graph call to refuse", async () => {
    const c = await conversation("900000000000604");
    expect(await sendApprovedReply(outsider, c.draftId)).toEqual({ kind: "refused", code: "forbidden" });
    for (const fn of ["sales_ig_update_draft", "sales_ig_snooze_draft", "sales_ig_resolve_thread", "sales_ig_finish_send", "sales_ig_resolve_unknown"]) {
      const args: Record<string, Record<string, unknown>> = {
        sales_ig_update_draft: { p_draft_id: c.draftId, p_body: "x", p_needs_review: false, p_review_reasons: [] },
        sales_ig_snooze_draft: { p_draft_id: c.draftId, p_snooze: true },
        sales_ig_resolve_thread: { p_thread_id: c.threadId, p_prospect_id: null },
        sales_ig_finish_send: { p_send_id: randomUUID(), p_attempt: 1, p_outcome: "sent", p_meta_message_id: "x", p_error_code: null },
        sales_ig_resolve_unknown: { p_send_id: randomUUID(), p_was_sent: true },
      };
      expect((await outsider.rpc(fn, args[fn])).error?.code, fn).toBe("42501");
    }
    expect(sendCalls).toHaveLength(0);
    expect(await state(c.draftId)).toMatchObject({ draft: "pending", sends: [] });
  });

  it("a human can link an unmatched conversation to a contacted shop, or dismiss it", async () => {
    const c = await conversation("900000000000605", { matched: false });
    await admin.rpc("sales_ig_resolve_thread", { p_thread_id: c.threadId, p_prospect_id: c.prospectId });
    expect(await sendApprovedReply(admin, c.draftId)).toEqual({ kind: "sent" });
    const other = await conversation("900000000000606", { matched: false });
    await admin.rpc("sales_ig_resolve_thread", { p_thread_id: other.threadId, p_prospect_id: null });
    expect(await state(other.draftId)).toMatchObject({ draft: "superseded" });
  });
});

describe("review regressions", () => {
  it("[R1-M1] a failed reply to an older message is never sent after a newer message arrived", async () => {
    const c = await conversation("900000000000701");
    replies = [{ status: 400, body: { error: { code: 100 } } }];
    expect((await sendApprovedReply(admin, c.draftId)).kind).toBe("failed");
    await receive("900000000000701", "mid-900000000000701-b", "もう一つ質問です");
    expect(await sendApprovedReply(admin, c.draftId)).toEqual({ kind: "refused", code: "stale_draft" });
    expect(sendCalls).toHaveLength(1);
    expect((await state(c.draftId)).draft).toBe("superseded");
  });

  it("[R1-M2] a late or duplicate result never overwrites a newer send", async () => {
    const c = await conversation("900000000000702");
    replies = ["network"];
    await sendApprovedReply(admin, c.draftId);
    const { rows: [a] } = await db.query("select id from public.sales_ig_sends where draft_id = $1", [c.draftId]);
    await admin.rpc("sales_ig_resolve_unknown", { p_send_id: a.id, p_was_sent: false });
    await admin.rpc("sales_ig_update_draft", { p_draft_id: c.draftId, p_body: "別の返信です。", p_needs_review: false, p_review_reasons: [] });
    const begun = (await admin.rpc("sales_ig_begin_send", { p_draft_id: c.draftId })).data as { send_id: string; status: string };
    expect(begun.status).toBe("sending");
    // A late answer for the first text arrives now.
    const late = await admin.rpc("sales_ig_finish_send", { p_send_id: a.id, p_attempt: 1, p_outcome: "failed", p_meta_message_id: null, p_error_code: "meta_100" });
    expect(late.data).toMatchObject({ replayed: true, status: "failed" });
    expect((await state(c.draftId)).draft).toBe("sending");
    // And a duplicate finish for the current send changes nothing either.
    await admin.rpc("sales_ig_finish_send", { p_send_id: begun.send_id, p_attempt: 1, p_outcome: "sent", p_meta_message_id: "m_late", p_error_code: null });
    const dup = await admin.rpc("sales_ig_finish_send", { p_send_id: begun.send_id, p_attempt: 1, p_outcome: "failed", p_meta_message_id: null, p_error_code: "meta_100" });
    expect(dup.data).toMatchObject({ replayed: true, status: "sent" });
    expect((await state(c.draftId)).draft).toBe("sent");
  });

  it("[R1-M2] a definite late answer settles an unknown send", async () => {
    const c = await conversation("900000000000703");
    await admin.rpc("sales_ig_begin_send", { p_draft_id: c.draftId });
    await db.query(`begin; set local session_replication_role = replica; update public.sales_ig_sends set updated_at = now() - interval '3 minutes' where draft_id = '${c.draftId}'; commit;`);
    expect(await sendApprovedReply(admin, c.draftId)).toEqual({ kind: "unknown" });
    const { rows: [s] } = await db.query("select id from public.sales_ig_sends where draft_id = $1", [c.draftId]);
    await admin.rpc("sales_ig_finish_send", { p_send_id: s.id, p_attempt: 1, p_outcome: "sent", p_meta_message_id: "m_settled", p_error_code: null });
    expect(await state(c.draftId)).toMatchObject({ draft: "sent", sends: [{ status: "sent", meta_message_id: "m_settled" }] });
    expect(sendCalls).toHaveLength(0);
  });

  it("[R1-L8] a matched conversation is not re-linked, and one with an open send is not dismissed", async () => {
    const c = await conversation("900000000000704");
    const relink = await admin.rpc("sales_ig_resolve_thread", { p_thread_id: c.threadId, p_prospect_id: c.prospectId });
    expect(relink.error?.message).toMatch(/already_resolved/);
    replies = ["network"];
    await sendApprovedReply(admin, c.draftId);
    const dismiss = await admin.rpc("sales_ig_resolve_thread", { p_thread_id: c.threadId, p_prospect_id: null });
    expect(dismiss.error?.message).toMatch(/send_open/);
  });

  it("[R2-H1] retrying an earlier text (A → B → A) settles the draft", async () => {
    const c = await conversation("900000000000705");
    const edit = (body: string) => admin.rpc("sales_ig_update_draft", { p_draft_id: c.draftId, p_body: body, p_needs_review: false, p_review_reasons: [] });
    replies = [{ status: 400, body: { error: { code: 100 } } }, { status: 400, body: { error: { code: 100 } } }];
    expect((await sendApprovedReply(admin, c.draftId)).kind).toBe("failed");
    await edit("別の文面です。");
    expect((await sendApprovedReply(admin, c.draftId)).kind).toBe("failed");
    await edit("お問い合わせありがとうございます。");
    expect(await sendApprovedReply(admin, c.draftId)).toEqual({ kind: "sent" });
    expect((await state(c.draftId)).draft).toBe("sent");
    expect(sendCalls).toHaveLength(3);
  });

  it("[R2-M1] a late answer for an earlier attempt never overrides the current attempt", async () => {
    const c = await conversation("900000000000706");
    const first = (await admin.rpc("sales_ig_begin_send", { p_draft_id: c.draftId })).data as { send_id: string; attempt: number };
    expect(first.attempt).toBe(1);
    await db.query(`begin; set local session_replication_role = replica; update public.sales_ig_sends set updated_at = now() - interval '3 minutes' where id = '${first.send_id}'; commit;`);
    expect(await sendApprovedReply(admin, c.draftId)).toEqual({ kind: "unknown" });
    await admin.rpc("sales_ig_resolve_unknown", { p_send_id: first.send_id, p_was_sent: false });
    const second = (await admin.rpc("sales_ig_begin_send", { p_draft_id: c.draftId })).data as { send_id: string; attempt: number };
    expect(second).toMatchObject({ send_id: first.send_id, attempt: 2 });
    const late = await admin.rpc("sales_ig_finish_send", { p_send_id: first.send_id, p_attempt: 1, p_outcome: "failed", p_meta_message_id: null, p_error_code: "meta_100" });
    expect(late.data).toMatchObject({ replayed: true, status: "sending" });
    await admin.rpc("sales_ig_finish_send", { p_send_id: first.send_id, p_attempt: 2, p_outcome: "sent", p_meta_message_id: "m_attempt2", p_error_code: null });
    expect(await state(c.draftId)).toMatchObject({ draft: "sent", sends: [{ status: "sent", attempts: 2, meta_message_id: "m_attempt2" }] });
  });
});
