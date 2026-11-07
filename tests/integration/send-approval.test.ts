import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { emailDigest } from "@/lib/sales/email-digest";
import {
  anonClient,
  approve,
  approveAndMarkSent,
  candidate,
  composedSnapshot,
  createUser,
  db,
  emailCandidate,
  makeAdmin,
  resetSalesData,
  rpc,
  signedInClient,
  verifiedRun,
} from "./helpers";

// DEV-195: editable drafts, the send approval and the two-step manual send.
// Admin only (RLS + SECURITY DEFINER functions), every guard enforced by the
// database at approval, at 送信画面を開いた and again at 手動で送信済み,
// safe under concurrency, and nothing is ever recorded as sent on its own.

let admin: SupabaseClient;
let outsider: SupabaseClient;
let adminId: string;

/** Prepares candidates in one run and finishes it; returns prospect and outreach ids in order. */
async function prepare(...cands: Array<Record<string, unknown>>) {
  const runId = randomUUID();
  const keys = cands.map((_, i) => `c${String(i + 1).padStart(2, "0")}`);
  await verifiedRun(runId, Object.fromEntries(keys.map((k, i) => [k, cands[i]])));
  await rpc("sales_run_begin_persist", { p_run_id: runId });
  const out: Array<{ prospectId: string; outreachId: string; runId: string }> = [];
  for (const key of keys) {
    const r = await rpc<{ prospect_id: string; stage: string }>("sales_persist_candidate", { p_run_id: runId, p_key: key });
    expect(r.stage).toBe("outreach_ready");
    const { rows } = await db.query("select id from public.sales_outreaches where prospect_id = $1 and kind = 'initial'", [r.prospect_id]);
    out.push({ prospectId: r.prospect_id, outreachId: rows[0].id as string, runId });
  }
  await rpc("sales_run_finalize", { p_run_id: runId });
  return out;
}

const one = async (c: Record<string, unknown> = candidate()) => (await prepare(c))[0];

const approvalIdOf = (res: { data: unknown }) => (res.data as { approval_id: string }).approval_id;
const open = (client: SupabaseClient, approvalId: string, via = "instagram_profile", design = false) =>
  client.rpc("sales_mark_send_opened", { p_approval_id: approvalId, p_via: via, p_design_enabled: design });
const markSent = (client: SupabaseClient, outreachId: string, approvalId: string, design = false) =>
  client.rpc("sales_mark_sent", { p_outreach_id: outreachId, p_approval_id: approvalId, p_design_enabled: design });
const edit = (client: SupabaseClient, outreachId: string, version: number, body: string, subject: string | null = null) =>
  client.rpc("sales_update_outreach_draft", { p_outreach_id: outreachId, p_draft_version: version, p_subject: subject, p_body: body });

async function approvedAndOpened(outreachId: string) {
  const approved = await approve(admin, outreachId);
  expect(approved.error).toBeNull();
  const id = approvalIdOf(approved);
  expect((await open(admin, id)).error).toBeNull();
  return id;
}

const outreach = async (id: string) =>
  (await db.query("select status, sent_at, draft_version, subject, body, edited_at, edited_by from public.sales_outreaches where id = $1", [id])).rows[0];
const approvals = async (outreachId: string) =>
  (await db.query("select * from public.sales_outreach_approvals where outreach_id = $1 order by approved_at, id", [outreachId])).rows;
const handleOf = async (prospectId: string) =>
  (await db.query<{ instagram_handle: string }>("select instagram_handle from public.sales_prospects where id = $1", [prospectId])).rows[0].instagram_handle;
const exclude = (cols: Record<string, unknown>) =>
  db.query(
    `insert into public.sales_exclusions (label, reason, ${Object.keys(cols).join(", ")}) values ('テスト除外', 'existing_customer', ${Object.keys(cols).map((_, i) => `$${i + 1}`).join(", ")})`,
    Object.values(cols),
  );

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** supabase-js builders are lazy: this sends the request now and gives a plain promise. */
const start = <T,>(builder: PromiseLike<T>): Promise<T> => (async () => await builder)();

/** Waits until some backend is blocked on a lock (so the concurrent call really is in flight). */
async function waitForLockWaiter() {
  for (let i = 0; i < 100; i += 1) {
    const { rows } = await db.query("select count(*)::int as n from pg_stat_activity where wait_event_type in ('Lock', 'Advisory') and state = 'active'");
    if (rows[0].n > 0) return;
    await sleep(50);
  }
  throw new Error("no backend waited on the lock");
}

beforeAll(async () => {
  await resetSalesData();
  adminId = await createUser("approval-admin@test.example.com");
  await makeAdmin(adminId);
  await createUser("approval-outsider@test.example.com");
  admin = await signedInClient("approval-admin@test.example.com");
  outsider = await signedInClient("approval-outsider@test.example.com");
});
beforeEach(async () => {
  await db.query(
    "truncate public.sales_exclusions, public.sales_outreach_approvals, public.sales_outreach_draft_edits, public.sales_prospect_insights, public.sales_outreaches, public.sales_demos, public.sales_sources, public.sales_prospects, public.sales_agent_runs cascade",
  );
});
afterAll(resetSalesData);

describe("RLS and admin-only access", () => {
  it("only the admin reads approvals, draft edits and notes; nobody writes them directly", async () => {
    const shop = await one(candidate());
    await approvedAndOpened(shop.outreachId);
    await edit(admin, shop.outreachId, 1, "別の本文です。").then((r) => expect(r.error?.message).toContain("approval_open"));
    expect((await admin.rpc("sales_set_prospect_insight", { p_prospect_id: shop.prospectId, p_kind: "selection_rationale", p_body: "メモ" })).error).toBeNull();
    for (const table of ["sales_outreach_approvals", "sales_prospect_insights"]) {
      expect((await admin.from(table).select("id")).data?.length, table).toBe(1);
      expect((await outsider.from(table).select("id")).data ?? [], table).toEqual([]);
      expect((await anonClient().from(table).select("id")).error, table).not.toBeNull();
    }
    expect((await outsider.from("sales_outreach_draft_edits").select("id")).data ?? []).toEqual([]);
    const direct = await admin.from("sales_outreach_approvals").insert({ outreach_id: shop.outreachId });
    expect(direct.error?.code).toBe("42501");
    const directUpdate = await admin.from("sales_outreach_approvals").update({ state: "sent" }).eq("outreach_id", shop.outreachId);
    expect(directUpdate.error?.code).toBe("42501");
    const directNote = await admin.from("sales_prospect_insights").insert({ prospect_id: shop.prospectId, kind: "improvement_hypothesis", body: "x", source: "owner" });
    expect(directNote.error?.code).toBe("42501");
  });

  it("every new function refuses a non-admin and anon (42501) and changes nothing", async () => {
    const shop = await one(candidate());
    const snap = await composedSnapshot(shop.outreachId);
    const id = randomUUID();
    const calls: Array<[string, Record<string, unknown>]> = [
      ["sales_update_outreach_draft", { p_outreach_id: shop.outreachId, p_draft_version: 1, p_subject: null, p_body: "x" }],
      ["sales_approve_outreach", { p_outreach_id: shop.outreachId, p_draft_version: 1, p_subject: snap.subject, p_body: snap.body, p_design_enabled: false }],
      ["sales_mark_send_opened", { p_approval_id: id, p_via: "mailto", p_design_enabled: false }],
      ["sales_withdraw_approval", { p_approval_id: id }],
      ["sales_mark_sent", { p_outreach_id: shop.outreachId, p_approval_id: id, p_design_enabled: false }],
      ["sales_set_prospect_insight", { p_prospect_id: shop.prospectId, p_kind: "selection_rationale", p_body: "x" }],
    ];
    for (const [fn, args] of calls) {
      expect((await outsider.rpc(fn, args)).error?.code, fn).toBe("42501");
      expect((await anonClient().rpc(fn, args)).error?.code, fn).toBe("42501");
    }
    expect(await approvals(shop.outreachId)).toEqual([]);
    expect(await outreach(shop.outreachId)).toMatchObject({ status: "drafted", draft_version: 1 });
  });
});

describe("editable draft", () => {
  it("saves the owner's text, bumps the revision, keeps the history and who edited", async () => {
    const shop = await one(emailCandidate());
    const before = await outreach(shop.outreachId);
    const { data, error } = await edit(admin, shop.outreachId, 1, "オーナーが書き直した本文です。", "新しい件名");
    expect(error).toBeNull();
    expect(data).toMatchObject({ draft_version: 2, replayed: false });
    expect(await outreach(shop.outreachId)).toMatchObject({ draft_version: 2, subject: "新しい件名", body: "オーナーが書き直した本文です。", edited_by: adminId });
    const { rows } = await db.query("select * from public.sales_outreach_draft_edits where outreach_id = $1", [shop.outreachId]);
    expect(rows).toEqual([
      expect.objectContaining({ draft_version: 2, previous_subject: before.subject, previous_body: before.body, subject: "新しい件名", body: "オーナーが書き直した本文です。", edited_by: adminId }),
    ]);
    // Saving the same text again changes nothing.
    expect((await edit(admin, shop.outreachId, 2, "オーナーが書き直した本文です。", "新しい件名")).data).toMatchObject({ replayed: true, draft_version: 2 });
  });

  it("refuses a stale revision, links / addresses, an Instagram subject and a sent draft", async () => {
    const [ig, mail] = await prepare(candidate(), emailCandidate());
    expect((await edit(admin, ig.outreachId, 2, "本文")).error?.message).toContain("stale_draft");
    for (const body of ["詳しくは https://example.com を", "info@example.com までどうぞ", "www.example.com", "", " 前後に空白 "]) {
      expect((await edit(admin, ig.outreachId, 1, body)).error?.message, body).toContain("invalid_draft");
    }
    expect((await edit(admin, ig.outreachId, 1, "本文", "件名")).error?.message).toContain("invalid_draft");
    expect((await edit(admin, mail.outreachId, 1, "本文", null)).error?.message).toContain("invalid_draft");
    expect((await edit(admin, mail.outreachId, 1, "本文", "件名\n改行")).error?.message).toContain("invalid_draft");
    expect((await edit(admin, ig.outreachId, 1, "長".repeat(1201))).error?.message).toContain("invalid_draft");
    expect((await approveAndMarkSent(admin, ig.outreachId)).error).toBeNull();
    expect((await edit(admin, ig.outreachId, 1, "送信後の編集")).error?.message).toContain("not_editable");
    expect(await outreach(mail.outreachId)).toMatchObject({ draft_version: 1 });
  });

  it("an edit withdraws an approval of the earlier text; an opened approval blocks the edit", async () => {
    const shop = await one(candidate());
    const first = approvalIdOf(await approve(admin, shop.outreachId));
    expect((await edit(admin, shop.outreachId, 1, "編集した本文です。")).error).toBeNull();
    expect((await approvals(shop.outreachId))[0]).toMatchObject({ id: first, state: "superseded", superseded_reason: "draft_edited" });
    // The old approval cannot be opened or confirmed.
    expect((await open(admin, first)).error?.message).toContain("stale_snapshot");
    // The new text is approved and opened: now editing is refused until it is settled.
    const second = await approvedAndOpened(shop.outreachId);
    expect((await edit(admin, shop.outreachId, 2, "もう一度編集")).error?.message).toContain("approval_open");
    expect((await admin.rpc("sales_withdraw_approval", { p_approval_id: second })).error).toBeNull();
    expect((await edit(admin, shop.outreachId, 2, "もう一度編集")).error).toBeNull();
  });
});

describe("send approval record", () => {
  it("records approver, recipient, the exact text, channel, demo version, mode and time", async () => {
    const [ig, mail] = await prepare(candidate(), emailCandidate());
    for (const shop of [ig, mail]) {
      const snap = await composedSnapshot(shop.outreachId);
      const res = await approve(admin, shop.outreachId);
      expect(res.error).toBeNull();
      expect(res.data).toMatchObject({ state: "approved", replayed: false });
      const [a] = await approvals(shop.outreachId);
      const demo = (await db.query("select public_token, public.sales_demo_version(d) as version from public.sales_demos d where prospect_id = $1", [shop.prospectId])).rows[0];
      expect(a).toMatchObject({
        state: "approved",
        mode: "manual",
        channel: snap.channel,
        recipient: snap.recipient,
        subject: snap.subject,
        body: snap.body,
        draft_version: 1,
        demo_token: demo.public_token,
        demo_version: demo.version,
        approved_by: adminId,
        opened_at: null,
        sent_at: null,
      });
      expect(a.approved_at).toBeInstanceOf(Date);
      expect(a.snapshot_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(await outreach(shop.outreachId)).toMatchObject({ status: "drafted", sent_at: null });
    }
    expect((await approvals(ig.outreachId))[0].recipient).toBe(await handleOf(ig.prospectId));
  });

  it("the same snapshot again is a replay; a different text supersedes an unopened approval", async () => {
    const shop = await one(candidate());
    const first = await approve(admin, shop.outreachId);
    const again = await approve(admin, shop.outreachId);
    expect(again.data).toMatchObject({ approval_id: approvalIdOf(first), replayed: true });
    const snap = await composedSnapshot(shop.outreachId);
    const other = await admin.rpc("sales_approve_outreach", {
      p_outreach_id: shop.outreachId, p_draft_version: 1, p_subject: null, p_body: `${snap.body}\n追記`, p_design_enabled: false,
    });
    expect(other.error).toBeNull();
    const rows = await approvals(shop.outreachId);
    expect(rows.map((r) => r.state)).toEqual(["superseded", "approved"]);
    expect(rows[0].superseded_reason).toBe("reapproved");
  });

  it("refuses a text without the stored message, the demo URL, the disclaimer or the opt-out line, and a stale revision", async () => {
    const shop = await one(emailCandidate());
    const snap = await composedSnapshot(shop.outreachId);
    const call = (subject: string | null, body: string, version = 1) =>
      admin.rpc("sales_approve_outreach", { p_outreach_id: shop.outreachId, p_draft_version: version, p_subject: subject, p_body: body, p_design_enabled: false });
    expect((await call(snap.subject, snap.body.replace("テスト用の営業文です。", "別の文"))).error?.message).toContain("invalid_snapshot");
    expect((await call(snap.subject, snap.body.replace(/\/demo\/[A-Za-z0-9_-]+/, "/demo/other"))).error?.message).toContain("invalid_snapshot");
    expect((await call(snap.subject, snap.body.replace("貴店の公式サイトではありません。", ""))).error?.message).toContain("invalid_snapshot");
    expect((await call(snap.subject, snap.body.replace("以後ご連絡いたしません。", ""))).error?.message).toContain("invalid_snapshot");
    expect((await call("違う件名", snap.body)).error?.message).toContain("stale_snapshot");
    expect((await call(snap.subject, snap.body, 2)).error?.message).toContain("stale_snapshot");
    expect(await approvals(shop.outreachId)).toEqual([]);
  });

  it("the snapshot is immutable and its state only moves forward", async () => {
    const shop = await one(candidate());
    const id = await approvedAndOpened(shop.outreachId);
    await expect(db.query("update public.sales_outreach_approvals set body = 'x' where id = $1", [id])).rejects.toThrow(/approval_snapshot_immutable/);
    await expect(db.query("update public.sales_outreach_approvals set state = 'approved' where id = $1", [id])).rejects.toThrow(/invalid_approval_transition/);
    await expect(
      db.query(
        "insert into public.sales_outreach_approvals (outreach_id, prospect_id, state, channel, recipient, body, draft_version, demo_token, demo_version, snapshot_sha256, approved_by, opened_at, opened_via, open_count) select outreach_id, prospect_id, 'send_opened', channel, recipient, body, draft_version, demo_token, demo_version, snapshot_sha256, approved_by, now(), 'copy', 1 from public.sales_outreach_approvals where id = $1",
        [id],
      ),
    ).rejects.toThrow(/approval_must_start_approved/);
  });
});

describe("manual send: opened vs sent", () => {
  it("approve → opened → confirmed; opening is never a send", async () => {
    const shop = await one(candidate());
    const id = approvalIdOf(await approve(admin, shop.outreachId));
    // Not opened yet: the confirm step is refused.
    expect((await markSent(admin, shop.outreachId, id)).error?.message).toContain("not_opened");
    expect((await open(admin, id, "instagram_profile")).data).toMatchObject({ state: "send_opened", replayed: false });
    let [a] = await approvals(shop.outreachId);
    expect(a).toMatchObject({ state: "send_opened", opened_via: "instagram_profile", open_count: 1, sent_at: null });
    expect(a.opened_at).toBeInstanceOf(Date);
    // Opened, not confirmed: still unsent and the demo still private.
    expect(await outreach(shop.outreachId)).toMatchObject({ status: "drafted", sent_at: null });
    expect((await db.query("select expires_at from public.sales_demos where prospect_id = $1", [shop.prospectId])).rows[0].expires_at).toBeNull();
    expect((await open(admin, id, "copy")).error).toBeNull();
    [a] = await approvals(shop.outreachId);
    expect(a).toMatchObject({ open_count: 2, opened_via: "instagram_profile" });
    const sent = await markSent(admin, shop.outreachId, id);
    expect(sent.error).toBeNull();
    expect(sent.data).toMatchObject({ status: "sent", approval_id: id, replayed: false });
    [a] = await approvals(shop.outreachId);
    expect(a).toMatchObject({ state: "sent", sent_by: adminId });
    expect(await outreach(shop.outreachId)).toMatchObject({ status: "sent" });
    // After the send, opening again is a replay and the approval cannot be withdrawn.
    expect((await open(admin, id)).data).toMatchObject({ state: "sent", replayed: true });
    expect((await admin.rpc("sales_withdraw_approval", { p_approval_id: id })).error?.message).toContain("already_sent");
  });

  it("送らなかった: a withdrawn approval cannot be confirmed; the draft can be approved again", async () => {
    const shop = await one(candidate());
    const id = await approvedAndOpened(shop.outreachId);
    expect((await admin.rpc("sales_withdraw_approval", { p_approval_id: id })).data).toMatchObject({ state: "superseded", replayed: false });
    expect((await markSent(admin, shop.outreachId, id)).error?.message).toContain("stale_snapshot");
    expect(await outreach(shop.outreachId)).toMatchObject({ status: "drafted" });
    expect((await approveAndMarkSent(admin, shop.outreachId)).error).toBeNull();
    expect((await approvals(shop.outreachId)).map((r) => r.state)).toEqual(["superseded", "sent"]);
  });

  it("an approval of another outreach is not accepted", async () => {
    const [a, b] = await prepare(candidate(), candidate());
    const idA = await approvedAndOpened(a.outreachId);
    expect((await markSent(admin, b.outreachId, idA)).error?.message).toContain("approval_required");
    expect(await outreach(b.outreachId)).toMatchObject({ status: "drafted" });
  });
});

describe("stale snapshot", () => {
  it("refuses to confirm when the text, the demo content, the design or the recipient changed after approval", async () => {
    const shops = await prepare(candidate(), candidate(), candidate(), candidate());
    const ids = await Promise.all(shops.map((s) => approvedAndOpened(s.outreachId)));
    // 1. text changed by any path (the revision moves on).
    await db.query("update public.sales_outreaches set body = '裏で変えた本文' where id = $1", [shops[0].outreachId]);
    expect((await outreach(shops[0].outreachId)).draft_version).toBe(2);
    // 2. demo content changed.
    await db.query("update public.sales_demos set content = content || '{\"hours\": \"9:00-17:00\"}'::jsonb where prospect_id = $1", [shops[1].prospectId]);
    // 3. the AI design changed (what the recipient would see).
    await db.query("update public.sales_demos set design_status = 'failed', design_error_code = 'WORKER_FAILED', design_updated_at = now() where prospect_id = $1", [shops[2].prospectId]);
    // 4. the demo was disabled.
    await db.query("update public.sales_demos set disabled_at = now() where prospect_id = $1", [shops[3].prospectId]);
    for (const [i, code] of [[0, "stale_snapshot"], [1, "stale_snapshot"], [2, "stale_snapshot"], [3, "demo_unavailable"]] as const) {
      expect((await markSent(admin, shops[i].outreachId, ids[i])).error?.message, `case ${i}`).toContain(code);
      expect(await outreach(shops[i].outreachId)).toMatchObject({ status: "drafted" });
    }
  });

  it("a change the recipient does not see (keep_alive) keeps the approval usable", async () => {
    const shop = await one(candidate());
    const id = await approvedAndOpened(shop.outreachId);
    await db.query("update public.sales_demos set keep_alive = true where prospect_id = $1", [shop.prospectId]);
    expect((await markSent(admin, shop.outreachId, id)).error).toBeNull();
  });
});

describe("guards at approval and at 送信済み", () => {
  it.each([
    ["instagram handle", () => candidate(), async (s: { prospectId: string }) => ({ instagram_handle: await handleOf(s.prospectId) })],
    ["website domain", () => emailCandidate(), async (s: { prospectId: string }) => ({ website_domain: (await db.query("select website_domain from public.sales_prospects where id = $1", [s.prospectId])).rows[0].website_domain })],
    ["email digest", () => emailCandidate(), async (s: { prospectId: string }) => ({ email_digest: emailDigest((await db.query("select public_email from public.sales_prospects where id = $1", [s.prospectId])).rows[0].public_email) })],
    ["name + address", () => candidate(), async (s: { prospectId: string }) => (await db.query("select normalized_name, normalized_address from public.sales_prospects where id = $1", [s.prospectId])).rows[0]],
  ])("an exclusion by %s refuses the approval", async (_label, make, key) => {
    const shop = await one(make());
    await exclude(await key(shop));
    expect((await approve(admin, shop.outreachId)).error?.message).toContain("excluded");
    expect(await approvals(shop.outreachId)).toEqual([]);
  });

  it("an exclusion added after the approval refuses opening; a not-yet-opened approval cannot be confirmed (the DEV-194 gap)", async () => {
    const [a] = await prepare(candidate());
    const approvedA = approvalIdOf(await approve(admin, a.outreachId));
    await exclude({ instagram_handle: await handleOf(a.prospectId) });
    expect((await open(admin, approvedA)).error?.message).toContain("excluded");
    expect((await markSent(admin, a.outreachId, approvedA)).error?.message).toContain("not_opened");
    expect((await approve(admin, a.outreachId)).error?.message).toContain("excluded");
    expect(await outreach(a.outreachId)).toMatchObject({ status: "drafted" });
    expect((await approvals(a.outreachId))[0]).toMatchObject({ state: "approved", opened_at: null });
  });

  it("refuses DNC, a channel that is no longer eligible, a missing demo and (with the step on) a pending design", async () => {
    const shops = await prepare(candidate(), emailCandidate(), candidate(), candidate());
    await db.query("update public.sales_prospects set do_not_contact = true, dnc_reason = 'admin_manual', dnc_set_at = now() where id = $1", [shops[0].prospectId]);
    expect((await approve(admin, shops[0].outreachId)).error?.message).toContain("do_not_contact");
    await db.query("delete from public.sales_sources where prospect_id = $1 and field = 'email'", [shops[1].prospectId]);
    expect((await approve(admin, shops[1].outreachId)).error?.message).toContain("email_not_eligible");
    await db.query("update public.sales_demos set disabled_at = now() where prospect_id = $1", [shops[2].prospectId]);
    // The composer has no demo to link either; the database refuses on its own too.
    const snap = await composedSnapshot(shops[3].outreachId);
    const noDemo = await admin.rpc("sales_approve_outreach", { p_outreach_id: shops[2].outreachId, p_draft_version: 1, p_subject: null, p_body: snap.body, p_design_enabled: false });
    expect(noDemo.error?.message).toContain("demo_unavailable");
    await db.query("update public.sales_demos set design_status = 'pending', design_updated_at = now() where prospect_id = $1", [shops[3].prospectId]);
    expect((await approve(admin, shops[3].outreachId, true)).error?.message).toContain("design_pending");
    // With the step off the stored state is not a gate (as initialSendAllowed).
    expect((await approve(admin, shops[3].outreachId, false)).error).toBeNull();
    const id = approvalIdOf(await approve(admin, shops[3].outreachId));
    expect((await open(admin, id, "copy", true)).error?.message).toContain("design_pending");
  });

  it("refuses a recipient already approved or sent for another outreach (duplicate)", async () => {
    const [a, b] = await prepare(candidate(), candidate());
    const handleA = await handleOf(a.prospectId);
    expect((await approveAndMarkSent(admin, a.outreachId)).error).toBeNull();
    // The shop's stored handle moves to another prospect after A was contacted.
    await db.query("update public.sales_prospects set instagram_handle = 'moved_away_1', instagram_url = 'https://www.instagram.com/moved_away_1/' where id = $1", [a.prospectId]);
    await db.query("update public.sales_prospects set instagram_handle = $2, instagram_url = $3 where id = $1", [b.prospectId, handleA, `https://www.instagram.com/${handleA}/`]);
    expect((await approve(admin, b.outreachId)).error?.message).toContain("duplicate_recipient");
  });

  it("a follow-up to a shop excluded after its first email is refused", async () => {
    const shop = await one(emailCandidate());
    expect((await approveAndMarkSent(admin, shop.outreachId)).error).toBeNull();
    await db.query("update public.sales_outreaches set sent_at = now() - interval '6 days' where id = $1", [shop.outreachId]);
    const token = (await db.query("select public_token from public.sales_demos where prospect_id = $1", [shop.prospectId])).rows[0].public_token;
    await exclude({ website_domain: (await db.query("select website_domain from public.sales_prospects where id = $1", [shop.prospectId])).rows[0].website_domain });
    const res = await admin.rpc("sales_mark_follow_up_sent", { p_outreach_id: shop.outreachId, p_body: `フォロー\nhttp://127.0.0.1/demo/${token}\n以後ご連絡いたしません。` });
    expect(res.error?.message).toContain("excluded");
  });
});

describe("concurrency", () => {
  it("two concurrent approvals of the same snapshot: one approval row, one replay", async () => {
    const shop = await one(candidate());
    const results = await Promise.all([approve(admin, shop.outreachId), approve(admin, shop.outreachId), approve(admin, shop.outreachId)]);
    expect(results.map((r) => r.error)).toEqual([null, null, null]);
    expect(results.filter((r) => (r.data as { replayed: boolean }).replayed === false)).toHaveLength(1);
    expect(new Set(results.map(approvalIdOf)).size).toBe(1);
    expect(await approvals(shop.outreachId)).toHaveLength(1);
  });

  it("two concurrent 送信済み: one send, one replay with the same time", async () => {
    const shop = await one(candidate());
    const id = await approvedAndOpened(shop.outreachId);
    const [x, y] = await Promise.all([markSent(admin, shop.outreachId, id), markSent(admin, shop.outreachId, id)]);
    expect([x.error, y.error]).toEqual([null, null]);
    const data = [x.data, y.data] as Array<{ replayed: boolean; sent_at: string }>;
    expect(data.map((d) => d.replayed).sort()).toEqual([false, true]);
    expect(data[0].sent_at).toBe(data[1].sent_at);
  });

  it("only one live approval can exist, even written past the functions (unique index)", async () => {
    const shop = await one(candidate());
    const id = approvalIdOf(await approve(admin, shop.outreachId));
    await expect(
      db.query(
        "insert into public.sales_outreach_approvals (outreach_id, prospect_id, channel, recipient, body, draft_version, demo_token, demo_version, snapshot_sha256, approved_by) select outreach_id, prospect_id, channel, recipient, body || 'x', draft_version, demo_token, demo_version, repeat('0', 64), approved_by from public.sales_outreach_approvals where id = $1",
        [id],
      ),
    ).rejects.toThrow(/sales_outreach_approvals_live_key/);
  });

  it("an exclusion committed while opening the send screen waits is seen, and opening is refused", async () => {
    const shop = await one(candidate());
    const id = approvalIdOf(await approve(admin, shop.outreachId));
    const handle = await handleOf(shop.prospectId);
    const tx = await db.connect();
    try {
      await tx.query("begin");
      // As sales_add_exclusion does: the exclusive lock, then the insert.
      await tx.query("select pg_advisory_xact_lock(hashtext('second_root_sales_exclusions'))");
      await tx.query("insert into public.sales_exclusions (label, reason, instagram_handle) values ('途中で追加', 'existing_customer', $1)", [handle]);
      const pending = start(open(admin, id));
      await waitForLockWaiter();
      await tx.query("commit");
      expect((await pending).error?.message).toContain("excluded");
    } finally {
      await tx.query("rollback").catch(() => undefined);
      tx.release();
    }
    expect((await approvals(shop.outreachId))[0]).toMatchObject({ state: "approved" });
  });

  it("PR #239 M2: an exclusion committed while a 送信済み (from send_opened) waits is seen and recorded, not lost", async () => {
    const shop = await one(candidate());
    const id = await approvedAndOpened(shop.outreachId);
    const handle = await handleOf(shop.prospectId);
    const tx = await db.connect();
    try {
      await tx.query("begin");
      await tx.query("select pg_advisory_xact_lock(hashtext('second_root_sales_exclusions'))");
      await tx.query("insert into public.sales_exclusions (label, reason, instagram_handle) values ('途中で追加', 'existing_customer', $1)", [handle]);
      const pending = start(markSent(admin, shop.outreachId, id));
      await waitForLockWaiter();
      await tx.query("commit");
      const res = await pending;
      expect(res.error).toBeNull();
      expect(res.data).toMatchObject({ status: "sent", blocked_after_open: "excluded" });
    } finally {
      await tx.query("rollback").catch(() => undefined);
      tx.release();
    }
  });

  it("a DNC committed while an approval waits on the shop is seen, and the approval is refused", async () => {
    const shop = await one(candidate());
    const tx = await db.connect();
    try {
      await tx.query("begin");
      await tx.query("update public.sales_prospects set do_not_contact = true, dnc_reason = 'admin_manual', dnc_set_at = now() where id = $1", [shop.prospectId]);
      const pending = start(approve(admin, shop.outreachId));
      await waitForLockWaiter();
      await tx.query("commit");
      expect((await pending).error?.message).toContain("do_not_contact");
    } finally {
      await tx.query("rollback").catch(() => undefined);
      tx.release();
    }
    expect(await approvals(shop.outreachId)).toEqual([]);
  });

  it("an edit racing an approval never leaves a usable approval of the old text", async () => {
    const shop = await one(candidate());
    const tx = await db.connect();
    let approved;
    try {
      await tx.query("begin");
      await tx.query("select 1 from public.sales_outreaches where id = $1 for update", [shop.outreachId]);
      const snap = await composedSnapshot(shop.outreachId);
      const pendingApprove = start(admin.rpc("sales_approve_outreach", { p_outreach_id: shop.outreachId, p_draft_version: 1, p_subject: null, p_body: snap.body, p_design_enabled: false }));
      const pendingEdit = start(edit(admin, shop.outreachId, 1, "競合して編集した本文"));
      await waitForLockWaiter();
      await tx.query("commit");
      [approved] = await Promise.all([pendingApprove, pendingEdit]);
    } finally {
      await tx.query("rollback").catch(() => undefined);
      tx.release();
    }
    const live = (await approvals(shop.outreachId)).filter((r) => r.state === "approved" || r.state === "send_opened");
    const { draft_version } = await outreach(shop.outreachId);
    expect(draft_version).toBe(2);
    // Either the approval came first and the edit superseded it, or the edit came first and the approval was stale.
    expect(live).toEqual([]);
    if (approved?.error) expect(approved.error.message).toContain("stale_snapshot");
  });
});

describe("selection rationale and improvement hypothesis", () => {
  it("are stored from ingest with the run as source, only when given; the owner can edit and clear them", async () => {
    const [withNotes, without] = await prepare(
      candidate({ insights: { selection_rationale: "Instagram だけで営業時間を案内している", improvement_hypothesis: "メニューと地図を1ページにまとめる" } }),
      candidate(),
    );
    const rows = (await db.query("select prospect_id, kind, body, source, run_id, written_by from public.sales_prospect_insights order by kind")).rows;
    expect(rows).toEqual([
      { prospect_id: withNotes.prospectId, kind: "improvement_hypothesis", body: "メニューと地図を1ページにまとめる", source: "ingest", run_id: withNotes.runId, written_by: null },
      { prospect_id: withNotes.prospectId, kind: "selection_rationale", body: "Instagram だけで営業時間を案内している", source: "ingest", run_id: withNotes.runId, written_by: null },
    ]);
    expect(rows.some((r) => r.prospect_id === without.prospectId)).toBe(false);

    expect((await admin.rpc("sales_set_prospect_insight", { p_prospect_id: withNotes.prospectId, p_kind: "improvement_hypothesis", p_body: "  写真を増やす  " })).error).toBeNull();
    const edited = (await db.query("select body, source, run_id, written_by from public.sales_prospect_insights where prospect_id = $1 and kind = 'improvement_hypothesis'", [withNotes.prospectId])).rows[0];
    expect(edited).toEqual({ body: "写真を増やす", source: "owner", run_id: null, written_by: adminId });
    expect((await admin.rpc("sales_set_prospect_insight", { p_prospect_id: withNotes.prospectId, p_kind: "selection_rationale", p_body: "" })).data).toMatchObject({ cleared: true });
    expect((await db.query("select kind from public.sales_prospect_insights where prospect_id = $1", [withNotes.prospectId])).rows).toEqual([{ kind: "improvement_hypothesis" }]);
    for (const body of ["連絡先 owner@example.com", "長".repeat(301)]) {
      expect((await admin.rpc("sales_set_prospect_insight", { p_prospect_id: withNotes.prospectId, p_kind: "improvement_hypothesis", p_body: body })).error?.message).toContain("invalid_insight");
    }
    expect((await admin.rpc("sales_set_prospect_insight", { p_prospect_id: withNotes.prospectId, p_kind: "other", p_body: "x" })).error?.message).toContain("invalid_kind");
  });

  it("a note the table refuses is dropped at persist; the shop is still prepared", async () => {
    const [shop] = await prepare(candidate({ insights: { selection_rationale: "長".repeat(400), improvement_hypothesis: "見つかったことだけ" } }));
    expect((await db.query("select kind from public.sales_prospect_insights where prospect_id = $1", [shop.prospectId])).rows).toEqual([{ kind: "improvement_hypothesis" }]);
  });
});

describe("PR #239 M2: a send confirmed after the shop became DNC / excluded", () => {
  it("is recorded from send_opened with the reason, on the outreach and the approval", async () => {
    const [dnc, excl] = await prepare(candidate(), emailCandidate());
    const idDnc = await approvedAndOpened(dnc.outreachId);
    const idExcl = await approvedAndOpened(excl.outreachId);
    // As the admin does it: DNC also disables the demo.
    expect((await admin.rpc("sales_set_dnc", { p_prospect_id: dnc.prospectId })).error).toBeNull();
    await exclude({ website_domain: (await db.query("select website_domain from public.sales_prospects where id = $1", [excl.prospectId])).rows[0].website_domain });
    for (const [shop, id, reason] of [[dnc, idDnc, "do_not_contact"], [excl, idExcl, "excluded"]] as const) {
      const res = await markSent(admin, shop.outreachId, id);
      expect(res.error, reason).toBeNull();
      expect(res.data).toMatchObject({ status: "sent", blocked_after_open: reason, replayed: false });
      expect((await db.query("select status, blocked_after_open from public.sales_outreaches where id = $1", [shop.outreachId])).rows[0]).toEqual({ status: "sent", blocked_after_open: reason });
      expect((await approvals(shop.outreachId))[0]).toMatchObject({ state: "sent", blocked_after_open: reason, sent_by: adminId });
      // A double tap is a replay with the same flag.
      expect((await markSent(admin, shop.outreachId, id)).data).toMatchObject({ replayed: true, blocked_after_open: reason });
    }
    // The DNC shop's demo stays disabled.
    expect((await db.query("select disabled_at is not null as off from public.sales_demos where prospect_id = $1", [dnc.prospectId])).rows[0].off).toBe(true);
  });

  it("still refuses a stale snapshot, a not-opened approval and the other guards; nothing is relaxed for approving or opening", async () => {
    const [stale, notOpened, channel] = await prepare(candidate(), candidate(), emailCandidate());
    const idStale = await approvedAndOpened(stale.outreachId);
    const idNotOpened = approvalIdOf(await approve(admin, notOpened.outreachId));
    const idChannel = await approvedAndOpened(channel.outreachId);
    for (const s of [stale, notOpened, channel]) {
      await db.query("update public.sales_prospects set do_not_contact = true, dnc_reason = 'admin_manual', dnc_set_at = now() where id = $1", [s.prospectId]);
    }
    await db.query("update public.sales_outreaches set body = '裏で変えた本文' where id = $1", [stale.outreachId]);
    expect((await markSent(admin, stale.outreachId, idStale)).error?.message).toContain("stale_snapshot");
    expect((await markSent(admin, notOpened.outreachId, idNotOpened)).error?.message).toContain("not_opened");
    expect((await open(admin, idNotOpened)).error?.message).toContain("do_not_contact");
    await db.query("delete from public.sales_sources where prospect_id = $1 and field = 'email'", [channel.prospectId]);
    expect((await markSent(admin, channel.outreachId, idChannel)).error?.message).toContain("email_not_eligible");
    for (const s of [stale, notOpened, channel]) expect(await outreach(s.outreachId)).toMatchObject({ status: "drafted" });
  });

  it("the flag is written only on that transition and must match the shop's state", async () => {
    const [a, b] = await prepare(candidate(), candidate());
    expect((await approveAndMarkSent(admin, a.outreachId)).error).toBeNull();
    await expect(db.query("update public.sales_outreaches set blocked_after_open = 'excluded' where id = $1", [a.outreachId])).rejects.toThrow(/blocked_after_open_immutable/);
    // Not DNC / excluded: a flag on the sent transition is refused.
    await expect(db.query("update public.sales_outreaches set status = 'sent', sent_at = now(), blocked_after_open = 'do_not_contact' where id = $1", [b.outreachId])).rejects.toThrow(/blocked_after_open_mismatch/);
  });

  it("is never followed up: not offered by the queue and refused by sales_mark_follow_up_sent, even after the block is lifted", async () => {
    const [blocked] = await prepare(emailCandidate());
    const id = await approvedAndOpened(blocked.outreachId);
    const domain = (await db.query("select website_domain from public.sales_prospects where id = $1", [blocked.prospectId])).rows[0].website_domain;
    await exclude({ website_domain: domain });
    expect((await markSent(admin, blocked.outreachId, id)).data).toMatchObject({ blocked_after_open: "excluded" });
    await db.query("update public.sales_outreaches set sent_at = now() - interval '6 days' where id = $1", [blocked.outreachId]);
    await db.query("delete from public.sales_exclusions");
    const due = await admin.from("sales_followup_due").select("outreach_id");
    expect(due.error).toBeNull();
    expect(due.data).toEqual([]);
    const token = (await db.query("select public_token from public.sales_demos where prospect_id = $1", [blocked.prospectId])).rows[0].public_token;
    const res = await admin.rpc("sales_mark_follow_up_sent", { p_outreach_id: blocked.outreachId, p_body: `フォロー\nhttp://127.0.0.1/demo/${token}\n以後ご連絡いたしません。` });
    expect(res.error?.message).toContain("blocked_after_open");
    expect((await db.query("select count(*)::int as n from public.sales_outreaches where prospect_id = $1 and kind = 'follow_up'", [blocked.prospectId])).rows[0].n).toBe(0);
  });

  it("history and funnel count it as sent (and the DNC as DNC)", async () => {
    const [shop] = await prepare(candidate());
    const id = await approvedAndOpened(shop.outreachId);
    expect((await admin.rpc("sales_set_dnc", { p_prospect_id: shop.prospectId })).error).toBeNull();
    expect((await markSent(admin, shop.outreachId, id)).error).toBeNull();
    const funnel = await admin.from("sales_funnel_daily").select("prepared, unsent, sent, dnc");
    expect(funnel.error).toBeNull();
    expect(funnel.data).toEqual([{ prepared: 1, unsent: 0, sent: 1, dnc: 1 }]);
    const metrics = await admin.from("sales_metrics").select("sent");
    expect(metrics.error).toBeNull();
    expect((metrics.data ?? []).every((r) => r.sent === 1)).toBe(true);
    expect((metrics.data ?? []).length).toBeGreaterThan(0);
  });
});

describe("PR #239 L2: a closed outreach retires its approval", () => {
  it("見送る (sales_mark_lost) supersedes an unopened approval, and its recipient no longer counts as a duplicate", async () => {
    const [a, b] = await prepare(candidate(), candidate());
    const handleA = await handleOf(a.prospectId);
    const id = approvalIdOf(await approve(admin, a.outreachId));
    expect((await admin.rpc("sales_mark_lost", { p_outreach_id: a.outreachId, p_reason: "見送り" })).error).toBeNull();
    expect((await approvals(a.outreachId))[0]).toMatchObject({ id, state: "superseded", superseded_reason: "outreach_closed" });
    expect((await markSent(admin, a.outreachId, id)).error?.message).toContain("invalid_transition");
    await db.query("update public.sales_prospects set instagram_handle = 'moved_away_2', instagram_url = 'https://www.instagram.com/moved_away_2/' where id = $1", [a.prospectId]);
    await db.query("update public.sales_prospects set instagram_handle = $2, instagram_url = $3 where id = $1", [b.prospectId, handleA, `https://www.instagram.com/${handleA}/`]);
    expect((await approve(admin, b.outreachId)).error).toBeNull();
  });
});

describe("PR #239 re-review", () => {
  it("L4b: 見送る is refused while an approval is send_opened; settled first, it works", async () => {
    const shop = await one(candidate());
    const id = await approvedAndOpened(shop.outreachId);
    expect((await admin.rpc("sales_mark_lost", { p_outreach_id: shop.outreachId, p_reason: "見送り" })).error?.message).toContain("approval_open");
    expect(await outreach(shop.outreachId)).toMatchObject({ status: "drafted" });
    expect((await approvals(shop.outreachId))[0]).toMatchObject({ state: "send_opened" });
    expect((await admin.rpc("sales_withdraw_approval", { p_approval_id: id })).error).toBeNull();
    expect((await admin.rpc("sales_mark_lost", { p_outreach_id: shop.outreachId, p_reason: "見送り" })).error).toBeNull();
    expect((await approvals(shop.outreachId))[0]).toMatchObject({ state: "superseded", superseded_reason: "withdrawn" });
  });

  it("L3: a sent or superseded approval is final (sent_at, sent_by, blocked_after_open included)", async () => {
    const [sent, gone] = await prepare(candidate(), candidate());
    expect((await approveAndMarkSent(admin, sent.outreachId)).error).toBeNull();
    const goneId = await approvedAndOpened(gone.outreachId);
    expect((await admin.rpc("sales_withdraw_approval", { p_approval_id: goneId })).error).toBeNull();
    for (const set of ["sent_at = now() - interval '1 day'", "sent_by = gen_random_uuid()", "blocked_after_open = 'excluded'", "open_count = open_count + 1"]) {
      await expect(db.query(`update public.sales_outreach_approvals set ${set} where outreach_id = $1`, [sent.outreachId]), set).rejects.toThrow(/approval_final_immutable/);
    }
    await expect(db.query("update public.sales_outreach_approvals set superseded_reason = 'reapproved' where id = $1", [goneId])).rejects.toThrow(/approval_final_immutable/);
    // The flag cannot be put on an approval that is not being confirmed.
    const [open] = await prepare(candidate());
    const openId = await approvedAndOpened(open.outreachId);
    await expect(db.query("update public.sales_outreach_approvals set blocked_after_open = 'excluded' where id = $1", [openId])).rejects.toThrow(/approval_final_immutable|sales_outreach_approvals_blocked/);
  });

  it("L1: removing an exclusion waits for an in-flight 送信済み (same lock), so the confirm never fails on a mismatch", async () => {
    const shop = await one(candidate());
    const id = await approvedAndOpened(shop.outreachId);
    await exclude({ instagram_handle: await handleOf(shop.prospectId) });
    const exclusionId = (await db.query("select id from public.sales_exclusions limit 1")).rows[0].id;
    const tx = await db.connect();
    let removal: Promise<{ error: unknown }> | null = null;
    try {
      await tx.query("begin");
      // Holds the outreach row as a 送信済み in progress would, after reading the block reason.
      await tx.query("select pg_advisory_xact_lock_shared(hashtext('second_root_sales_exclusions'))");
      removal = start(admin.rpc("sales_remove_exclusion", { p_id: exclusionId }));
      await waitForLockWaiter();
      expect((await db.query("select count(*)::int as n from public.sales_exclusions")).rows[0].n).toBe(1);
      await tx.query("commit");
      expect((await removal).error).toBeNull();
    } finally {
      await tx.query("rollback").catch(() => undefined);
      tx.release();
    }
    // And end to end: confirm right after removal is a normal send (no flag).
    expect((await markSent(admin, shop.outreachId, id)).data).toMatchObject({ status: "sent", blocked_after_open: null });
  });
});
