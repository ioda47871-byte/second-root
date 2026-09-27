import { createHmac, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as ingest } from "@/app/api/internal/sales-agent/runs/route";
import { POST as webhook } from "@/app/api/webhooks/instagram/route";
import { candidate, db, resetSalesData, rpc, verifiedRun } from "./helpers";

// Instagram inbox (DEV-021): safe matching, Operational Claude reads pending
// conversations and submits drafts through the ingest API; nothing sends.

const TOKEN = "test-ingest-token-0123456789abcdef-0123456789";
const SECRET = ["ig", "app", "secret", "for", "tests", "0123"].join("-");
const ACCESS = ["ig", "access", "token", "for", "tests", "0123456"].join("-");
const OURS = "17841400000000001";

let usernames: Record<string, string> = {};
let graphCalls = 0;

function api(body: unknown) {
  return ingest(
    new NextRequest("http://localhost/api/internal/sales-agent/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    }),
  );
}

async function receive(igsid: string, mid: string, text: string, timestamp = Date.now()) {
  const raw = JSON.stringify({
    object: "instagram",
    entry: [{ id: OURS, messaging: [{ sender: { id: igsid }, recipient: { id: OURS }, timestamp, message: { mid, text } }] }],
  });
  const res = await webhook(
    new NextRequest("http://localhost/api/webhooks/instagram", {
      method: "POST",
      headers: { "X-Hub-Signature-256": `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}` },
      body: raw,
    }),
  );
  expect(res.status).toBe(200);
}

/** A prospect contacted on Instagram (sent), returning its handle. */
async function contactedShop(sent = true) {
  const runId = randomUUID();
  const c = candidate();
  await verifiedRun(runId, { c01: c });
  await rpc("sales_run_begin_persist", { p_run_id: runId });
  const { prospect_id } = await rpc<{ prospect_id: string }>("sales_persist_candidate", { p_run_id: runId, p_key: "c01" });
  if (sent) {
    await db.query("update public.sales_outreaches set status = 'sent', sent_at = now() where prospect_id = $1", [prospect_id]);
    await db.query("update public.sales_demos set expires_at = now() + interval '30 days' where prospect_id = $1", [prospect_id]);
  }
  return { prospectId: prospect_id as string, handle: c.instagram_handle as string, name: c.name as string };
}

async function pending() {
  const res = await api({ action: "inbox_pending" });
  expect(res.status).toBe(200);
  return (await res.json()).inbox as Array<{ threadId: string; messageId: string; matched: boolean; messages: unknown[]; shop: Record<string, unknown> | null }>;
}

beforeEach(async () => {
  await resetSalesData();
  usernames = {};
  graphCalls = 0;
  vi.stubEnv("SALES_AGENT_INGEST_TOKEN", TOKEN);
  vi.stubEnv("INSTAGRAM_APP_SECRET", SECRET);
  vi.stubEnv("INSTAGRAM_WEBHOOK_VERIFY_TOKEN", "verify-token-for-tests");
  vi.stubEnv("INSTAGRAM_ACCOUNT_ID", OURS);
  vi.stubEnv("INSTAGRAM_ACCESS_TOKEN", ACCESS);
  vi.stubEnv("SALES_DEMO_BASE_URL", "https://secondroot.jp");
  const realFetch = globalThis.fetch;
  // Only Supabase and the fixed official Graph API host may be contacted.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(process.env.NEXT_PUBLIC_SUPABASE_URL!)) return realFetch(input, init);
    const m = /^https:\/\/graph\.instagram\.com\/v\d+\.0\/(\d+)\?fields=username$/.exec(url);
    if (!m) throw new Error(`unexpected fetch: ${url}`);
    graphCalls += 1;
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${ACCESS}`);
    const username = usernames[m[1]];
    return username ? Response.json({ username, id: m[1] }) : Response.json({ error: { message: "x" } }, { status: 400 });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(resetSalesData);

describe("matching", () => {
  it("links a conversation to the one shop we contacted on Instagram with that username", async () => {
    const shop = await contactedShop();
    usernames["900000000000101"] = shop.handle.toUpperCase();
    await receive("900000000000101", "mid-a1", "デモ見ました！詳しく聞きたいです");
    const [item] = await pending();
    expect(item).toMatchObject({ matched: true, shop: { name: shop.name, category: "bakery" } });
    expect(String(item.shop!.demoUrl)).toMatch(/^https:\/\/secondroot\.jp\/demo\//);
    const { rows } = await db.query("select match_status, prospect_id, username from public.sales_ig_threads");
    expect(rows[0]).toMatchObject({ match_status: "matched", prospect_id: shop.prospectId, username: shop.handle.toUpperCase() });
  });

  it("[fail-closed] leaves it unmatched when the username is unknown, unavailable, or the shop was never contacted", async () => {
    const notSent = await contactedShop(false);
    usernames["900000000000102"] = notSent.handle; // prepared but never sent → no match
    usernames["900000000000103"] = "someone_else";
    await receive("900000000000102", "mid-b1", "こんにちは");
    await receive("900000000000103", "mid-b2", "こんにちは");
    await receive("900000000000104", "mid-b3", "こんにちは"); // API gives no username
    const items = await pending();
    expect(items.map((i) => [i.matched, i.shop])).toEqual([[false, null], [false, null], [false, null]]);
  });

  it("does not call the Graph API at all without an access token", async () => {
    vi.stubEnv("INSTAGRAM_ACCESS_TOKEN", "");
    await receive("900000000000105", "mid-c1", "こんにちは");
    expect((await pending())[0]).toMatchObject({ matched: false });
    expect(graphCalls).toBe(0);
  });
});

describe("drafts", () => {
  it("[resume] keeps a conversation pending until a draft is saved, then idempotently", async () => {
    await receive("900000000000201", "mid-d1", "料金を教えてください");
    const [first] = await pending();
    // The session is lost here; a new one sees the same pending conversation.
    const [again] = await pending();
    expect(again.threadId).toBe(first.threadId);
    const body = { action: "inbox_draft", threadId: first.threadId, messageId: first.messageId, replyType: "question", body: "お問い合わせありがとうございます。詳しい内容を担当からご案内します。", futureContactRefused: false };
    const saved = await (await api(body)).json();
    expect(saved.draft).toMatchObject({ status: "pending", replayed: false, needsHumanReview: false });
    expect((await (await api(body)).json()).draft).toMatchObject({ replayed: true, draftId: saved.draft.draftId });
    expect(await pending()).toEqual([]);
    const { rows } = await db.query("select count(*)::int as n from public.sales_ig_drafts");
    expect(rows[0].n).toBe(1);
  });

  it("refuses a draft for an older message and supersedes the open draft when a new message arrives", async () => {
    await receive("900000000000202", "mid-e1", "質問です", Date.now() - 60_000);
    const [first] = await pending();
    await api({ action: "inbox_draft", threadId: first.threadId, messageId: first.messageId, replyType: "question", body: "ありがとうございます。", futureContactRefused: false });
    await receive("900000000000202", "mid-e2", "追加でもう一つ質問です");
    const stale = await api({ action: "inbox_draft", threadId: first.threadId, messageId: first.messageId, replyType: "question", body: "古い返信", futureContactRefused: false });
    expect(stale.status).toBe(409);
    const [next] = await pending();
    expect(next.messageId).not.toBe(first.messageId);
    await api({ action: "inbox_draft", threadId: next.threadId, messageId: next.messageId, replyType: "question", body: "両方にお答えします。", futureContactRefused: false });
    const { rows } = await db.query("select status from public.sales_ig_drafts order by created_at");
    expect(rows.map((r) => r.status)).toEqual(["superseded", "pending"]);
  });

  it("rejects drafts with contact details or foreign links and stores nothing", async () => {
    await receive("900000000000203", "mid-f1", "連絡先を教えて");
    const [item] = await pending();
    for (const text of ["info@secondroot.jp までどうぞ", "https://example.com/ をご覧ください"]) {
      const res = await api({ action: "inbox_draft", threadId: item.threadId, messageId: item.messageId, replyType: "question", body: text, futureContactRefused: false });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_draft");
    }
    const { rows } = await db.query("select count(*)::int as n from public.sales_ig_drafts");
    expect(rows[0].n).toBe(0);
  });

  it("flags an explicit refusal as a DNC candidate for the human, without setting DNC", async () => {
    const shop = await contactedShop();
    usernames["900000000000204"] = shop.handle;
    await receive("900000000000204", "mid-g1", "今後このような営業の連絡はしないでください");
    const [item] = await pending();
    const res = await (await api({ action: "inbox_draft", threadId: item.threadId, messageId: item.messageId, replyType: "decline", body: "承知いたしました。大変失礼いたしました。", futureContactRefused: false })).json();
    expect(res.draft).toMatchObject({ dncCandidate: true, needsHumanReview: true });
    const { rows } = await db.query("select do_not_contact from public.sales_prospects where id = $1", [shop.prospectId]);
    expect(rows[0].do_not_contact).toBe(false);
  });

  it("offers no drafting for DNC shops or ignored conversations", async () => {
    const shop = await contactedShop();
    usernames["900000000000205"] = shop.handle;
    await receive("900000000000205", "mid-h1", "こんにちは");
    const [item] = await pending();
    await db.query("update public.sales_prospects set do_not_contact = true, dnc_reason = 'explicit_refusal', dnc_set_at = now() where id = $1", [shop.prospectId]);
    expect(await pending()).toEqual([]);
    const res = await api({ action: "inbox_draft", threadId: item.threadId, messageId: item.messageId, replyType: "other", body: "ありがとうございます。", futureContactRefused: false });
    expect(res.status).toBe(409);

    await receive("900000000000206", "mid-h2", "こんにちは");
    await db.query("update public.sales_ig_threads set match_status = 'ignored' where igsid = '900000000000206'");
    expect(await pending()).toEqual([]);
  });

  it("gives the drafter recent messages as plain text only", async () => {
    await receive("900000000000207", "mid-i1", "一通目", Date.now() - 2000);
    await receive("900000000000207", "mid-i2", "二通目", Date.now() - 1000);
    const [item] = await pending();
    expect(item.messages).toEqual([
      expect.objectContaining({ direction: "inbound", text: "一通目" }),
      expect.objectContaining({ direction: "inbound", text: "二通目" }),
    ]);
    expect(JSON.stringify(item)).not.toMatch(/igsid|900000000000207/);
  });

describe("review regressions", () => {
  it("[M3] agrees on the latest message when two arrive with the same timestamp", async () => {
    const ts = Date.now();
    await receive("900000000000301", "mid-t1", "テキスト", ts);
    await receive("900000000000301", "mid-t2", "同時刻のもう一通", ts);
    const [item] = await pending();
    const res = await api({ action: "inbox_draft", threadId: item.threadId, messageId: item.messageId, replyType: "other", body: "ありがとうございます。", futureContactRefused: false });
    expect(res.status).toBe(200);
  });

  it("[M4] a re-submitted draft keeps the text under review and never clears warnings", async () => {
    await receive("900000000000302", "mid-u1", "今後は連絡しないでください。よろしくお願いします。");
    const [item] = await pending();
    const base = { action: "inbox_draft", threadId: item.threadId, messageId: item.messageId, replyType: "decline" };
    await api({ ...base, body: "承知しました。", futureContactRefused: true });
    await api({ ...base, body: "別の文面", futureContactRefused: false });
    const { rows } = await db.query("select body, dnc_candidate, needs_human_review from public.sales_ig_drafts");
    expect(rows).toEqual([{ body: "承知しました。", dnc_candidate: true, needs_human_review: true }]);
  });

  it("[L1] detects a refusal followed by a polite closing message", async () => {
    await receive("900000000000303", "mid-v1", "営業の連絡は今後ご遠慮ください", Date.now() - 1000);
    await receive("900000000000303", "mid-v2", "よろしくお願いします", Date.now());
    const [item] = await pending();
    const res = await (await api({ action: "inbox_draft", threadId: item.threadId, messageId: item.messageId, replyType: "decline", body: "承知いたしました。", futureContactRefused: false })).json();
    expect(res.draft.dncCandidate).toBe(true);
  });

  it("[M5] backs off a conversation after 3 failed drafts so it cannot block newer ones", async () => {
    await receive("900000000000304", "mid-w1", "スパム", Date.now() - 5000);
    const [item] = await pending();
    for (let i = 0; i < 3; i += 1) {
      const res = await api({ action: "inbox_draft", threadId: item.threadId, messageId: item.messageId, replyType: "other", body: "evil.com", futureContactRefused: false });
      expect(res.status).toBe(400);
    }
    expect(await pending()).toEqual([]);
    await receive("900000000000304", "mid-w2", "新しいメッセージ");
    expect((await pending()).length).toBe(1);
  });

  it("[R2-L4] a failed draft for an older message cannot reset the back-off", async () => {
    await receive("900000000000305", "mid-x1", "スパム1", Date.now() - 10000);
    await receive("900000000000305", "mid-x2", "スパム2", Date.now() - 5000);
    const [item] = await pending();
    const { rows: [old] } = await db.query("select id from public.sales_ig_messages where mid = 'mid-x1'");
    const bad = (messageId: string) => api({ action: "inbox_draft", threadId: item.threadId, messageId, replyType: "other", body: "evil.com", futureContactRefused: false });
    await bad(item.messageId);
    await bad(item.messageId);
    await bad(old.id);
    await bad(item.messageId);
    expect(await pending()).toEqual([]);
  });

  it("[M2] keeps matching new conversations even when many unmatched ones pile up", async () => {
    for (let i = 0; i < 25; i += 1) {
      const igsid = `9000000000010${String(i).padStart(2, "0")}`;
      usernames[igsid] = `stranger_${i}`;
      await receive(igsid, `mid-s${i}`, "こんにちは", Date.now() - 60_000 + i);
    }
    for (let i = 0; i < 5; i += 1) await pending(); // usernames get fetched over a few runs
    const shop = await contactedShop();
    usernames["900000000000399"] = shop.handle;
    await receive("900000000000399", "mid-s-new", "デモ見ました");
    await pending();
    const { rows } = await db.query("select match_status from public.sales_ig_threads where igsid = '900000000000399'");
    expect(rows[0].match_status).toBe("matched");
  });

  it("does not offer a message the sender unsent", async () => {
    await receive("900000000000305", "mid-x1", "送信取り消し予定");
    const raw = JSON.stringify({ object: "instagram", entry: [{ id: OURS, messaging: [{ sender: { id: "900000000000305" }, recipient: { id: OURS }, timestamp: Date.now(), message: { mid: "mid-x1", is_deleted: true } }] }] });
    await webhook(new NextRequest("http://localhost/api/webhooks/instagram", { method: "POST", headers: { "X-Hub-Signature-256": `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}` }, body: raw }));
    expect(await pending()).toEqual([]);
  });
});

});
