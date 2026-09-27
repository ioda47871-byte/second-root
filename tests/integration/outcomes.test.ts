import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadPublicDemo } from "@/lib/sales/demo-data";
import { anonClient, createUser, db, emailCandidate, makeAdmin, resetSalesData, rpc, serviceClient, signedInClient, verifiedRun } from "./helpers";

// 返信 → 商談 → 成約 / 失注, decline vs DNC (MVP_SPEC §5, §6).

let admin: Awaited<ReturnType<typeof signedInClient>>;
let outsider: Awaited<ReturnType<typeof signedInClient>>;

async function sentOutreach() {
  const runId = randomUUID();
  await verifiedRun(runId, { c01: emailCandidate() });
  await rpc("sales_run_begin_persist", { p_run_id: runId });
  const { prospect_id } = await rpc<{ prospect_id: string }>("sales_persist_candidate", { p_run_id: runId, p_key: "c01" });
  const { rows } = await db.query("select id from public.sales_outreaches where prospect_id = $1", [prospect_id]);
  const outreachId = rows[0].id as string;
  expect((await admin.rpc("sales_mark_sent", { p_outreach_id: outreachId })).error).toBeNull();
  const token = (await db.query("select public_token from public.sales_demos where prospect_id = $1", [prospect_id])).rows[0].public_token;
  return { outreachId, prospectId: prospect_id, token };
}

const state = async (outreachId: string) =>
  (
    await db.query(
      `select o.status, o.reply_type, o.won_amount_jpy, o.lost_reason, p.do_not_contact, p.dnc_reason, d.disabled_at is not null as demo_disabled
       from public.sales_outreaches o join public.sales_prospects p on p.id = o.prospect_id join public.sales_demos d on d.prospect_id = p.id
       where o.id = $1`,
      [outreachId],
    )
  ).rows[0];

beforeAll(async () => {
  await resetSalesData();
  await makeAdmin(await createUser("outcome-admin@test.example.com"));
  await createUser("outcome-outsider@test.example.com");
  admin = await signedInClient("outcome-admin@test.example.com");
  outsider = await signedInClient("outcome-outsider@test.example.com");
});
beforeEach(async () => {
  await db.query("truncate public.sales_outreaches, public.sales_demos, public.sales_sources, public.sales_prospects, public.sales_agent_runs cascade");
});
afterAll(resetSalesData);

describe("reply → meeting → won", () => {
  it("records each step and requires an amount for won", async () => {
    const { outreachId } = await sentOutreach();
    expect((await admin.rpc("sales_record_reply", { p_outreach_id: outreachId, p_reply_type: "interested", p_future_contact_refused: false })).error).toBeNull();
    expect((await admin.rpc("sales_mark_meeting", { p_outreach_id: outreachId })).error).toBeNull();
    expect((await admin.rpc("sales_mark_won", { p_outreach_id: outreachId, p_amount_jpy: 0 })).error?.message).toMatch(/won_amount_required/);
    expect((await admin.rpc("sales_mark_won", { p_outreach_id: outreachId, p_amount_jpy: 198000 })).error).toBeNull();
    expect(await state(outreachId)).toMatchObject({ status: "won", reply_type: "interested", won_amount_jpy: 198000, do_not_contact: false });
  });

  it("refuses skipped steps", async () => {
    const { outreachId } = await sentOutreach();
    expect((await admin.rpc("sales_mark_meeting", { p_outreach_id: outreachId })).error?.message).toMatch(/invalid_transition/);
    expect((await admin.rpc("sales_mark_won", { p_outreach_id: outreachId, p_amount_jpy: 1 })).error?.message).toMatch(/invalid_transition/);
  });

  it("is idempotent for repeated taps", async () => {
    const { outreachId } = await sentOutreach();
    await admin.rpc("sales_record_reply", { p_outreach_id: outreachId, p_reply_type: "question", p_future_contact_refused: false });
    const again = await admin.rpc("sales_record_reply", { p_outreach_id: outreachId, p_reply_type: "question", p_future_contact_refused: false });
    expect(again.data).toMatchObject({ replayed: true });
  });
});

describe("decline and DNC", () => {
  it("a plain decline closes the deal but does not set DNC", async () => {
    const { outreachId, token } = await sentOutreach();
    await admin.rpc("sales_record_reply", { p_outreach_id: outreachId, p_reply_type: "decline", p_future_contact_refused: false });
    expect(await state(outreachId)).toMatchObject({ status: "lost", reply_type: "decline", lost_reason: "declined", do_not_contact: false, demo_disabled: false });
    expect(await loadPublicDemo(serviceClient(), token)).not.toBeNull();
  });

  it("an explicit refusal of future contact sets DNC and disables the demo", async () => {
    const { outreachId, token } = await sentOutreach();
    await admin.rpc("sales_record_reply", { p_outreach_id: outreachId, p_reply_type: "decline", p_future_contact_refused: true });
    expect(await state(outreachId)).toMatchObject({ status: "lost", do_not_contact: true, dnc_reason: "explicit_refusal", demo_disabled: true });
    expect(await loadPublicDemo(serviceClient(), token)).toBeNull();
  });

  it("refusal can only be recorded with a decline", async () => {
    const { outreachId } = await sentOutreach();
    const { error } = await admin.rpc("sales_record_reply", { p_outreach_id: outreachId, p_reply_type: "question", p_future_contact_refused: true });
    expect(error?.message).toMatch(/refusal_requires_decline/);
    expect(await state(outreachId)).toMatchObject({ status: "sent", do_not_contact: false });
  });

  it("clearing DNC is admin-only and keeps the demo disabled", async () => {
    const { outreachId, prospectId } = await sentOutreach();
    await admin.rpc("sales_record_reply", { p_outreach_id: outreachId, p_reply_type: "decline", p_future_contact_refused: true });
    expect((await outsider.rpc("sales_clear_dnc", { p_prospect_id: prospectId })).error?.code).toBe("42501");
    expect((await admin.rpc("sales_clear_dnc", { p_prospect_id: prospectId })).error).toBeNull();
    expect(await state(outreachId)).toMatchObject({ do_not_contact: false, demo_disabled: true });
  });
});

describe("authorization", () => {
  it.each([
    ["sales_record_reply", (id: string) => ({ p_outreach_id: id, p_reply_type: "interested", p_future_contact_refused: false })],
    ["sales_mark_meeting", (id: string) => ({ p_outreach_id: id })],
    ["sales_mark_won", (id: string) => ({ p_outreach_id: id, p_amount_jpy: 1 })],
    ["sales_mark_lost", (id: string) => ({ p_outreach_id: id, p_reason: "x" })],
  ] as const)("%s is refused for non-admins and anon", async (fn, args) => {
    const { outreachId } = await sentOutreach();
    expect((await outsider.rpc(fn, args(outreachId))).error?.code).toBe("42501");
    expect((await anonClient().rpc(fn, args(outreachId))).error?.code).toBe("42501");
    expect((await state(outreachId)).status).toBe("sent");
  });

  it("internal helpers are not callable through the API", async () => {
    for (const client of [admin, outsider, anonClient()]) {
      expect((await client.rpc("sales_set_dnc_internal", { p_prospect_id: randomUUID(), p_reason: "x" })).error?.code).toBe("42501");
    }
  });
});
