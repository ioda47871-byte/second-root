import { createHmac, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as webhook } from "@/app/api/webhooks/instagram/route";
import { db, resetSalesData, rpc } from "./helpers";

// Conversation retention (DEV-024, docs/INSTAGRAM_MESSAGING.md §8): old
// conversations and webhook fingerprints are deleted, open sends are kept,
// and replayed old deliveries cannot bring deleted messages back.

const SECRET = ["ig", "app", "secret", "for", "tests", "0123"].join("-");
const OURS = "17841400000000001";
const DAY = 24 * 60 * 60 * 1000;

function post(igsid: string, mid: string, timestamp: number) {
  const raw = JSON.stringify({ object: "instagram", entry: [{ id: OURS, messaging: [{ sender: { id: igsid }, recipient: { id: OURS }, timestamp, message: { mid, text: "こんにちは" } }] }] });
  return webhook(new NextRequest("http://localhost/api/webhooks/instagram", { method: "POST", headers: { "X-Hub-Signature-256": `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}` }, body: raw }));
}

/** A conversation whose last message was `ageDays` ago (backdated in the DB). */
async function conversation(igsid: string, ageDays: number, draftStatus?: string) {
  expect((await post(igsid, `mid-${igsid}`, Date.now())).status).toBe(200);
  const { rows: [t] } = await db.query("select id from public.sales_ig_threads where igsid = $1", [igsid]);
  const { rows: [m] } = await db.query("select id from public.sales_ig_messages where thread_id = $1", [t.id]);
  if (draftStatus) {
    await db.query("insert into public.sales_ig_drafts (thread_id, message_id, reply_type, body, status) values ($1, $2, 'question', 'ありがとうございます。', $3)", [t.id, m.id, draftStatus]);
  }
  const at = `now() - interval '${ageDays} days'`;
  await db.query(`begin; set local session_replication_role = replica;
    update public.sales_ig_messages set sent_at = ${at}, received_at = ${at} where thread_id = '${t.id}';
    update public.sales_ig_threads set created_at = ${at}, last_inbound_at = ${at} where id = '${t.id}';
    update public.sales_ig_webhook_events set received_at = ${at};
    commit;`);
  return t.id as string;
}

const exists = async (threadId: string) => (await db.query("select 1 from public.sales_ig_threads where id = $1", [threadId])).rowCount === 1;

beforeEach(async () => {
  await resetSalesData();
  vi.stubEnv("INSTAGRAM_APP_SECRET", SECRET);
  vi.stubEnv("INSTAGRAM_ACCOUNT_ID", OURS);
});
afterEach(() => vi.unstubAllEnvs());
afterAll(resetSalesData);

describe("retention", () => {
  it("deletes conversations 180 days after their last message, with everything in them", async () => {
    const old = await conversation("900000000000801", 181, "failed");
    const recent = await conversation("900000000000802", 30, "pending");
    const result = await rpc<{ threads: number; events: number }>("sales_ig_purge", {});
    expect(result.threads).toBe(1);
    expect(await exists(old)).toBe(false);
    expect(await exists(recent)).toBe(true);
    const { rows } = await db.query("select count(*)::int as n from public.sales_ig_messages where thread_id = $1", [old]);
    expect(rows[0].n).toBe(0);
  });

  it("[fail-closed] keeps a conversation whose send outcome the human has not settled", async () => {
    const unknown = await conversation("900000000000803", 200, "unknown");
    const sending = await conversation("900000000000804", 200, "sending");
    await rpc("sales_ig_purge", {});
    expect(await exists(unknown)).toBe(true);
    expect(await exists(sending)).toBe(true);
  });

  it("deletes webhook fingerprints after 30 days, and is idempotent", async () => {
    await conversation("900000000000805", 31);
    expect((await rpc<{ events: number }>("sales_ig_purge", {})).events).toBe(1);
    expect(await rpc<{ threads: number; events: number }>("sales_ig_purge", {})).toEqual({ threads: 0, events: 0 });
  });

  it("[idempotency] ignores deliveries older than 7 days, so a replay cannot restore deleted messages", async () => {
    const res = await post("900000000000806", `mid-${randomUUID()}`, Date.now() - 8 * DAY);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: 1 });
    const { rows } = await db.query("select count(*)::int as n from public.sales_ig_messages");
    expect(rows[0].n).toBe(0);
  });

  it("only the server can purge", async () => {
    const { rows } = await db.query(
      "select has_function_privilege('authenticated', 'public.sales_ig_purge()', 'execute') as auth, has_function_privilege('anon', 'public.sales_ig_purge()', 'execute') as anon",
    );
    expect(rows[0]).toEqual({ auth: false, anon: false });
  });
});
