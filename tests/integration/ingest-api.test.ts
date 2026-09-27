import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/internal/sales-agent/runs/route";
import { verifiedEmailInput, verifiedInput } from "../unit/sales/ingest-fixtures";
import { db, resetSalesData } from "./helpers";

// End-to-end through the real route handler and the local Supabase stack.

const TOKEN = "test-ingest-token-0123456789abcdef-0123456789";

function call(body: unknown, token: string | null = TOKEN) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return POST(new NextRequest("http://localhost/api/internal/sales-agent/runs", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }));
}

async function ok(body: unknown) {
  const res = await call(body);
  const json = await res.json();
  expect(res.status, JSON.stringify(json)).toBe(200);
  return json.run;
}

async function fullRun(candidates: ReturnType<typeof verifiedInput>[]) {
  const runId = randomUUID();
  await ok({ action: "start", runId });
  await ok({ action: "checkpoint", runId, phase: "discovered", candidates: candidates.map((c) => ({ key: c.key, name: c.name, category: "bakery" })) });
  await ok({ action: "checkpoint", runId, phase: "verified", candidates });
  const run = await ok({ action: "persist", runId });
  return { runId, run };
}

const count = async (table: string) => (await db.query(`select count(*)::int as n from public.${table}`)).rows[0].n as number;

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await resetSalesData();
  vi.stubEnv("SALES_AGENT_INGEST_TOKEN", TOKEN);
  const realFetch = globalThis.fetch;
  // The server may only talk to Supabase; submitted URLs are never fetched.
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(process.env.NEXT_PUBLIC_SUPABASE_URL!)) throw new Error(`unexpected fetch: ${url}`);
    return realFetch(input, init);
  });
});

afterEach(() => {
  fetchSpy.mockRestore();
  vi.unstubAllEnvs();
});

afterAll(resetSalesData);

describe("auth and validation", () => {
  it("fails closed when the ingest token is not configured", async () => {
    vi.stubEnv("SALES_AGENT_INGEST_TOKEN", "");
    expect((await call({ action: "status" })).status).toBe(503);
    vi.stubEnv("SALES_AGENT_INGEST_TOKEN", "short");
    expect((await call({ action: "status" }, "short")).status).toBe(503);
  });

  it("rejects missing or wrong tokens", async () => {
    expect((await call({ action: "status" }, null)).status).toBe(401);
    expect((await call({ action: "status" }, `${TOKEN}x`)).status).toBe(401);
    expect((await call({ action: "status" }, "")).status).toBe(401);
  });

  it("rejects invalid JSON, unknown actions and unknown fields without echoing values", async () => {
    expect((await call("{")).status).toBe(400);
    const res = await call({ action: "set_dnc", runId: randomUUID(), secretValue: "do-not-echo" });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("do-not-echo");
  });

  it("rejects more than 10 verified candidates as a whole", async () => {
    const runId = randomUUID();
    const res = await call({ action: "checkpoint", runId, phase: "verified", candidates: Array.from({ length: 11 }, () => verifiedInput()) });
    expect(res.status).toBe(400);
    expect(await count("sales_agent_runs")).toBe(0);
  });

  it("rejects oversized bodies", async () => {
    const res = await call({ action: "abort", runId: randomUUID(), errorCode: "x", errorSummary: "x".repeat(300_000) });
    expect(res.status).toBe(413);
  });
});

describe("run lifecycle through the API", () => {
  it("prepares Instagram and Email shops and completes", async () => {
    const { run } = await fullRun([verifiedInput(), verifiedEmailInput()]);
    expect(run).toMatchObject({ status: "completed", phase: "completed", nextAction: "none" });
    expect(run.candidates.map((c: { stage: string }) => c.stage)).toEqual(["outreach_ready", "outreach_ready"]);
    expect(await count("sales_outreaches")).toBe(2);
    expect(await count("sales_demos")).toBe(2);
    const { rows } = await db.query("select channel from public.sales_outreaches order by channel");
    expect(rows.map((r) => r.channel)).toEqual(["email", "instagram"]);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("returns the stored result when a completed run is re-sent", async () => {
    const shop = verifiedInput();
    const { runId } = await fullRun([shop]);
    const again = await ok({ action: "persist", runId });
    expect(again).toMatchObject({ status: "completed", replayed: true });
    const verifiedAgain = await ok({ action: "checkpoint", runId, phase: "verified", candidates: [shop] });
    expect(verifiedAgain).toMatchObject({ status: "completed", replayed: true });
    expect(await count("sales_outreaches")).toBe(1);
  });

  it("resumes from status after a lost session without duplicating anything", async () => {
    const a = verifiedInput();
    const b = verifiedInput();
    const runId = randomUUID();
    await ok({ action: "start", runId });
    await ok({ action: "checkpoint", runId, phase: "discovered", candidates: [a, b].map((c) => ({ key: c.key, name: c.name, category: "bakery" })) });
    await ok({ action: "checkpoint", runId, phase: "verified", candidates: [a, b] });
    // Session disappears before persist. A new session knows nothing but the API.
    const status = await ok({ action: "status" });
    expect(status).toMatchObject({ runId, nextAction: "persist" });
    const done = await ok({ action: "persist", runId: status.runId });
    expect(done.status).toBe("completed");
    await ok({ action: "persist", runId });
    expect(await count("sales_prospects")).toBe(2);
  });

  it("tells a new session to discover when only started, and verify after discovery", async () => {
    const runId = randomUUID();
    await ok({ action: "start", runId });
    expect(await ok({ action: "status" })).toMatchObject({ nextAction: "discover" });
    await ok({ action: "checkpoint", runId, phase: "discovered", candidates: [{ key: "c1", name: "店", category: "cafe" }] });
    const status = await ok({ action: "status", runId });
    expect(status).toMatchObject({ nextAction: "verify", discoveredKeys: ["c1"] });
  });

  it("rejects ineligible shops at verify time and never persists them", async () => {
    const unknownSite = verifiedInput({ website: { status: "unknown", url: null, checks: 0 } });
    const outside = verifiedInput({ address: "愛知県豊田市1-1" });
    const siteNoEmail = verifiedInput({ website: { status: "present", url: "https://pan-no-email.example.com/", checks: 1 } });
    const { run } = await fullRun([unknownSite, outside, siteNoEmail]);
    expect(run.candidates).toEqual([
      { key: unknownSite.key, stage: "rejected", reason: "website_unknown_without_email" },
      { key: outside.key, stage: "rejected", reason: "outside_nagoya" },
      { key: siteNoEmail.key, stage: "rejected", reason: "site_without_email" },
    ]);
    expect(await count("sales_prospects")).toBe(0);
  });

  it("marks duplicates and DNC shops without new outreach", async () => {
    const shop = verifiedEmailInput();
    await fullRun([shop]);
    const { run: dup } = await fullRun([{ ...verifiedEmailInput(), email: shop.email }]);
    expect(dup.candidates[0].stage).toBe("duplicate");
    await db.query("update public.sales_prospects set do_not_contact = true, dnc_reason = 'explicit_refusal', dnc_set_at = now()");
    const { run: dnc } = await fullRun([{ ...verifiedEmailInput(), email: shop.email }]);
    expect(dnc.candidates[0]).toMatchObject({ stage: "rejected", reason: "do_not_contact" });
    expect(await count("sales_outreaches")).toBe(1);
  });

  it("accepts up to 10 verified but prepares at most 5 new shops per day", async () => {
    const shops = Array.from({ length: 10 }, () => verifiedInput());
    const { run } = await fullRun(shops);
    const stages = run.candidates.map((c: { stage: string }) => c.stage);
    expect(stages.filter((s: string) => s === "outreach_ready")).toHaveLength(5);
    expect(stages.slice(5)).toEqual(Array(5).fill("rejected"));
    expect(await count("sales_outreaches")).toBe(5);
  });

  it("refuses to skip phases and reports expired runs with start_new_run", async () => {
    const runId = randomUUID();
    await ok({ action: "start", runId });
    const skip = await call({ action: "persist", runId });
    expect(skip.status).toBe(409);
    expect(await skip.json()).toEqual({ error: "phase_order_violation" });
    await db.query("update public.sales_agent_runs set checkpoint_at = now() - interval '25 hours' where run_id = $1", [runId]);
    const expired = await call({ action: "checkpoint", runId, phase: "discovered", candidates: [] });
    expect(expired.status).toBe(409);
    expect((await expired.json()).run).toMatchObject({ status: "failed", errorCode: "run_expired", nextAction: "start_new_run" });
  });

  it("returns 404 for an unknown run and 409 for a failed run", async () => {
    expect((await call({ action: "persist", runId: randomUUID() })).status).toBe(404);
    const runId = randomUUID();
    await ok({ action: "start", runId });
    const aborted = await call({ action: "abort", runId, errorCode: "search_unavailable", errorSummary: "search down" });
    expect(aborted.status).toBe(409);
    expect((await aborted.json()).run).toMatchObject({ status: "failed", nextAction: "start_new_run" });
  });

  it("cannot change DNC or outcomes: there is no action for it", async () => {
    for (const action of ["set_dnc", "clear_dnc", "mark_won", "mark_sent", "send"]) {
      expect((await call({ action, runId: randomUUID() })).status).toBe(400);
    }
  });
});
