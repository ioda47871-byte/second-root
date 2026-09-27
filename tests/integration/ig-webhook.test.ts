import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/webhooks/instagram/route";
import { anonClient, createUser, db, makeAdmin, resetSalesData, signedInClient } from "./helpers";

// Instagram webhook end to end: signature → idempotent storage (DEV-020).

const SECRET = ["ig", "app", "secret", "for", "tests", "0123"].join("-");
const VERIFY = ["ig", "verify", "token", "for", "tests"].join("-");
const OURS = "17841400000000001";
// Recent enough for the webhook's 7-day age limit.
const T0 = Date.now() - 60_000;
const THEM = "900000000000002";

const message = (mid: string, text: string, extra: Record<string, unknown> = {}, timestamp = T0) => ({
  object: "instagram",
  entry: [{ id: OURS, time: timestamp, messaging: [{ sender: { id: THEM }, recipient: { id: OURS }, timestamp, message: { mid, text, ...extra } }] }],
});

function post(body: unknown, { sign = true, secret = SECRET }: { sign?: boolean; secret?: string } = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (sign) headers["X-Hub-Signature-256"] = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  return POST(new NextRequest("http://localhost/api/webhooks/instagram", { method: "POST", headers, body: raw }));
}

const count = async (table: string) => (await db.query(`select count(*)::int as n from public.${table}`)).rows[0].n as number;

beforeEach(async () => {
  await resetSalesData();
  vi.stubEnv("INSTAGRAM_APP_SECRET", SECRET);
  vi.stubEnv("INSTAGRAM_WEBHOOK_VERIFY_TOKEN", VERIFY);
  vi.stubEnv("INSTAGRAM_ACCOUNT_ID", OURS);
});
afterEach(() => vi.unstubAllEnvs());
afterAll(resetSalesData);

describe("GET subscription handshake", () => {
  const get = (q: string) => GET(new NextRequest(`http://localhost/api/webhooks/instagram?${q}`));

  it("echoes the challenge for the right verify token", async () => {
    const res = await get(`hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1158201444`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("1158201444");
  });

  it("refuses a wrong token or mode", async () => {
    expect((await get(`hub.mode=subscribe&hub.verify_token=wrong-token-value&hub.challenge=1`)).status).toBe(403);
    expect((await get(`hub.mode=unsubscribe&hub.verify_token=${VERIFY}&hub.challenge=1`)).status).toBe(403);
    expect((await get(`hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=%3Cscript%3E`)).status).toBe(403);
  });

  it("is disabled (503) when no verify token is configured", async () => {
    vi.stubEnv("INSTAGRAM_WEBHOOK_VERIFY_TOKEN", "");
    expect((await get(`hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1`)).status).toBe(503);
  });
});

describe("POST message events", () => {
  it("stores an inbound message in an unmatched thread", async () => {
    const res = await post(message("mid-1", "ホームページの件、詳しく聞きたいです"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, replayed: false, inserted: 1 });
    const { rows } = await db.query(
      `select t.igsid, t.match_status, t.prospect_id, t.last_inbound_at is not null as has_inbound, m.direction, m.text
       from public.sales_ig_threads t join public.sales_ig_messages m on m.thread_id = t.id`,
    );
    expect(rows).toEqual([{ igsid: THEM, match_status: "unmatched", prospect_id: null, has_inbound: true, direction: "inbound", text: "ホームページの件、詳しく聞きたいです" }]);
  });

  it("[idempotency] never duplicates a re-delivered webhook or message", async () => {
    const body = message("mid-2", "こんにちは");
    await post(body);
    const again = await post(body);
    expect(await again.json()).toMatchObject({ replayed: true });
    // Same message inside a different batch (different body bytes).
    const batch = { ...body, entry: [{ ...body.entry[0], time: T0 + 9999 }] };
    expect(await (await post(batch)).json()).toMatchObject({ replayed: false, inserted: 0, duplicates: 1 });
    expect(await count("sales_ig_messages")).toBe(1);
    expect(await count("sales_ig_threads")).toBe(1);
    expect(await count("sales_ig_webhook_events")).toBe(2);
  });

  it("keeps one thread per person across messages and records echoes as outbound", async () => {
    await post(message("mid-3", "一通目"));
    await post(message("mid-4", "二通目", {}, T0 + 100000));
    await post({
      object: "instagram",
      entry: [{ id: OURS, messaging: [{ sender: { id: OURS }, recipient: { id: THEM }, timestamp: T0 + 200000, message: { mid: "mid-5", text: "ご連絡ありがとうございます", is_echo: true } }] }],
    });
    const { rows } = await db.query("select direction, count(*)::int as n from public.sales_ig_messages group by direction order by direction");
    expect(rows).toEqual([{ direction: "inbound", n: 2 }, { direction: "outbound", n: 1 }]);
    expect(await count("sales_ig_threads")).toBe(1);
  });

  it("drops the text of a message the sender unsent", async () => {
    await post(message("mid-6", "間違えて送りました"));
    await post(message("mid-6", "", { is_deleted: true }, T0 + 300000));
    const { rows } = await db.query("select text, deleted_at is not null as deleted from public.sales_ig_messages where mid = 'mid-6'");
    expect(rows).toEqual([{ text: null, deleted: true }]);
  });

  it("[fail-closed] stores nothing without a valid signature", async () => {
    expect((await post(message("mid-7", "x"), { sign: false })).status).toBe(401);
    expect((await post(message("mid-7", "x"), { secret: "some-other-secret-value" })).status).toBe(401);
    expect(await count("sales_ig_webhook_events")).toBe(0);
    expect(await count("sales_ig_messages")).toBe(0);
  });

  it("[fail-closed] is disabled (503) when the app secret or our account id is not configured", async () => {
    vi.stubEnv("INSTAGRAM_APP_SECRET", "");
    expect((await post(message("mid-8", "x"))).status).toBe(503);
    vi.stubEnv("INSTAGRAM_APP_SECRET", SECRET);
    for (const id of ["", "not-a-number"]) {
      vi.stubEnv("INSTAGRAM_ACCOUNT_ID", id);
      expect((await post(message("mid-8", "x"))).status).toBe(503);
    }
    expect(await count("sales_ig_webhook_events")).toBe(0);
  });

  it("drops the text when the message and its deletion arrive in one delivery", async () => {
    await post({
      object: "instagram",
      entry: [{ id: OURS, messaging: [
        { sender: { id: THEM }, recipient: { id: OURS }, timestamp: T0, message: { mid: "mid-11", text: "secret" } },
        { sender: { id: THEM }, recipient: { id: OURS }, timestamp: T0 + 1000, message: { mid: "mid-11", is_deleted: true } },
      ] }],
    });
    const { rows } = await db.query("select text, deleted_at is not null as deleted from public.sales_ig_messages where mid = 'mid-11'");
    expect(rows).toEqual([{ text: null, deleted: true }]);
  });

  it("never stores a message whose deletion arrived first", async () => {
    await post(message("mid-12", "", { is_deleted: true }, T0 + 2000));
    await post(message("mid-12", "secret2"));
    const { rows } = await db.query("select text, deleted_at is not null as deleted from public.sales_ig_messages where mid = 'mid-12'");
    expect(rows).toEqual([{ text: null, deleted: true }]);
  });

  it("stores odd characters safely instead of failing the whole delivery", async () => {
    const res = await post(message("mid-13", "a\u0000b\ud800c"));
    expect(res.status).toBe(200);
    const { rows } = await db.query("select text from public.sales_ig_messages where mid = 'mid-13'");
    expect(rows).toEqual([{ text: "ab\ufffdc" }]);
  });

  it("rejects oversized bodies (declared or streamed) and malformed signature headers", async () => {
    const big = "x".repeat(2 * 1024 * 1024 + 1);
    expect((await post(big)).status).toBe(413);
    const raw = JSON.stringify(message("mid-14", "x"));
    const upper = `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex").toUpperCase()}`;
    const res = await POST(new NextRequest("http://localhost/api/webhooks/instagram", { method: "POST", headers: { "X-Hub-Signature-256": upper }, body: raw }));
    expect(res.status).toBe(401);
    expect(await count("sales_ig_webhook_events")).toBe(0);
  });

  it("rejects signed but malformed payloads without storing", async () => {
    expect((await post("{not json")).status).toBe(400);
    expect((await post({ object: "page", entry: [] })).status).toBe(400);
    expect(await count("sales_ig_webhook_events")).toBe(0);
  });

  it("stores nothing for events addressed to another account", async () => {
    const other = { object: "instagram", entry: [{ id: "555", messaging: [{ sender: { id: THEM }, recipient: { id: "555" }, timestamp: 1, message: { mid: "mid-9", text: "x" } }] }] };
    expect(await (await post(other)).json()).toMatchObject({ inserted: 0, ignored: 1 });
    expect(await count("sales_ig_messages")).toBe(0);
  });
});

describe("access", () => {
  it("lets only the admin read messages; nobody else reads or writes", async () => {
    await post(message("mid-10", "読めるのは管理者だけ"));
    await makeAdmin(await createUser("ig-admin@test.example.com"));
    await createUser("ig-outsider@test.example.com");
    const admin = await signedInClient("ig-admin@test.example.com");
    const outsider = await signedInClient("ig-outsider@test.example.com");
    expect((await admin.from("sales_ig_messages").select("text")).data).toEqual([{ text: "読めるのは管理者だけ" }]);
    expect((await outsider.from("sales_ig_messages").select("text")).data).toEqual([]);
    expect((await anonClient().from("sales_ig_messages").select("text")).error?.code).toBe("42501");
    expect((await admin.from("sales_ig_messages").insert({ mid: "x" })).error).not.toBeNull();
    expect((await admin.rpc("sales_ig_ingest", { p_body_sha256: "0".repeat(64), p_events: [] })).error?.code).toBe("42501");
  });
});
