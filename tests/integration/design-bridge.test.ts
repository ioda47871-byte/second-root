import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as designPost } from "@/app/api/internal/sales-design/jobs/route";
import { POST as ingestPost } from "@/app/api/internal/sales-agent/runs/route";
import { runBridgeOnce } from "@/lib/design-agent/bridge/client";
import { bridgeSpool } from "@/lib/design-agent/bridge/spool";
import { exportBridgeResults, importBridgeJobs } from "@/lib/design-agent/bridge/worker-side";
import type { DesignProfile } from "@/lib/design-agent/profile";
import { ensureQueue, queueDirs } from "@/lib/design-agent/worker/queue";
import { loadTodayQueue } from "@/lib/admin/today";
import { loadPublicDemo } from "@/lib/sales/demo-data";
import { workerJobIdFor } from "@/lib/sales/design-bridge-schema";
import { AMERICAN_EDITORIAL } from "../unit/design-agent/fixtures";
import { verifiedInput } from "../unit/sales/ingest-fixtures";
import { anonClient, candidate, createUser, db, emailCandidate, makeAdmin, resetSalesData, rpc, serviceClient, signedInClient, verifiedRun } from "./helpers";

// DEV-030 Sales Design Bridge against the local Supabase stack: the
// migration's constraints, the claim / submit state machine, the bridge API
// route, the end-to-end flow (bridge client → spool → worker side → bridge
// client → database → public demo) and the flag-off legacy behaviour.

const PROFILE: DesignProfile = { ...AMERICAN_EDITORIAL, rationale: [] };
const BRIDGE_TOKEN = "bridge-token-0123456789abcdef-0123456789";
const INGEST_TOKEN = "test-ingest-token-0123456789abcdef-0123456789";
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

type Claim = { job_id: string; attempt: number; template: string; content: Record<string, unknown>; website_url: string | null; instagram_url: string | null };
type State = { job_id: string; status: string; error_code: string | null; attempts: number; replayed: boolean };

const claim = () => rpc<Claim | null>("sales_design_claim", { p_lease_seconds: 7200, p_max_attempts: 3 });
const submit = (jobId: string, outcome: string, profile: unknown, code: string | null, commit: string | null = "0123abcd") =>
  rpc<State>("sales_design_submit", { p_job_id: jobId, p_outcome: outcome, p_profile: profile, p_error_code: code, p_worker_commit: commit, p_max_attempts: 3 });
const demoOf = async (prospectId: string) =>
  (await db.query("select * from public.sales_demos where prospect_id = $1", [prospectId])).rows[0] as Record<string, unknown>;

/** Persists one candidate the way the ingest API does (design on / off), on an earlier day so the daily cap does not bite. */
async function prepare(c: Record<string, unknown>, design: boolean): Promise<string> {
  const runId = randomUUID();
  await verifiedRun(runId, { c01: c });
  await rpc("sales_run_begin_persist", { p_run_id: runId });
  const r = await rpc<{ prospect_id: string }>("sales_persist_candidate", { p_run_id: runId, p_key: "c01", ...(design ? { p_design: true } : {}) });
  await rpc("sales_run_finalize", { p_run_id: runId });
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

async function markSent(prospectId: string) {
  await db.query("update public.sales_outreaches set status = 'sent', sent_at = now() where prospect_id = $1 and kind = 'initial'", [prospectId]);
  await db.query("update public.sales_demos set expires_at = now() + interval '30 days' where prospect_id = $1", [prospectId]);
}

beforeEach(async () => {
  await db.query("truncate public.sales_outreaches, public.sales_demos, public.sales_sources, public.sales_prospects, public.sales_agent_runs cascade");
});
afterAll(resetSalesData);

describe("persist", () => {
  it("with p_design the demo waits for its design (same transaction); without it is a legacy demo", async () => {
    const designed = await demoOf(await prepare(candidate(), true));
    const legacy = await demoOf(await prepare(candidate(), false));
    expect(designed).toMatchObject({ design_status: "pending", design_profile: null, design_job_id: null, design_attempts: 0 });
    expect(designed.design_updated_at).not.toBeNull();
    expect(legacy).toMatchObject({ design_status: null, design_profile: null, design_job_id: null, design_attempts: 0, design_updated_at: null, design_error_code: null });
  });
});

describe("constraints", () => {
  let prospectId: string;
  beforeEach(async () => {
    prospectId = await prepare(candidate(), true);
  });
  const set = (sql: string, args: unknown[] = []) => db.query(`update public.sales_demos set ${sql} where prospect_id = $1`, [prospectId, ...args]);

  it.each([
    ["an unknown status", "design_status = 'done'"],
    ["ready without a profile", "design_status = 'ready'"],
    ["a profile while pending", `design_profile = '{"version":1}'::jsonb`],
    ["processing without a job", "design_status = 'processing', design_claimed_at = now()"],
    ["processing without a lease", "design_status = 'processing', design_job_id = gen_random_uuid()"],
    ["a non-object profile", `design_status = 'ready', design_profile = '"x"'::jsonb`],
    ["a profile of another version", `design_status = 'ready', design_profile = '{"version":2}'::jsonb`],
    ["a profile over 8 KB", `design_status = 'ready', design_profile = jsonb_build_object('version', 1, 'pad', repeat('x', 20000))`],
    ["a free-text error", "design_error_code = 'see stderr: boom'"],
    ["a lower-case error", "design_error_code = 'design_blocked'"],
    ["a non-sha commit", "design_worker_commit = 'main'"],
    ["more than 3 attempts", "design_attempts = 4"],
    ["design data on a legacy demo", "design_status = null, design_error_code = 'DESIGN_BLOCKED'"],
  ])("refuses %s", async (_label, sql) => {
    await expect(set(sql)).rejects.toThrow(/check constraint|violates/);
  });

  it("job ids are unique across demos", async () => {
    const other = await prepare(candidate(), true);
    const id = randomUUID();
    await set("design_status = 'processing', design_job_id = $2, design_claimed_at = now()", [id]);
    await expect(
      db.query("update public.sales_demos set design_status = 'processing', design_job_id = $2, design_claimed_at = now() where prospect_id = $1", [other, id]),
    ).rejects.toThrow(/duplicate key/);
  });
});

describe("claim / submit", () => {
  it("hands out each waiting demo once, with facts and verified sources only", async () => {
    const a = await prepare(candidate(), true);
    await prepare(candidate(), false); // legacy: never claimed
    const job = await claim();
    expect(job).toMatchObject({ attempt: 1, template: "bakery_v1", website_url: null, instagram_url: expect.stringMatching(/^https:\/\/www\.instagram\.com\//) });
    expect(Object.keys(job!).sort()).toEqual(["attempt", "content", "instagram_url", "job_id", "template", "website_url"]);
    expect(await demoOf(a)).toMatchObject({ design_status: "processing", design_job_id: job!.job_id, design_attempts: 1 });
    expect(await claim()).toBeNull();
  });

  it("concurrent claims never hand out the same demo twice", async () => {
    await prepare(candidate(), true);
    await prepare(candidate(), true);
    const jobs = await Promise.all(Array.from({ length: 6 }, () => claim()));
    const ids = jobs.filter((j): j is Claim => j !== null).map((j) => j.job_id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("ready stores the profile; a re-sent result is a replay; a ready demo is never handed out again", async () => {
    const p = await prepare(candidate(), true);
    const job = (await claim())!;
    expect(await submit(job.job_id, "ready", PROFILE, null)).toMatchObject({ status: "ready", replayed: false, attempts: 1 });
    expect(await submit(job.job_id, "ready", PROFILE, null)).toMatchObject({ status: "ready", replayed: true });
    expect(await submit(job.job_id, "failed", null, "WORKER_FAILED")).toMatchObject({ status: "ready", replayed: true });
    const demo = await demoOf(p);
    expect(demo).toMatchObject({ design_status: "ready", design_profile: PROFILE, design_worker_commit: "0123abcd", design_claimed_at: null });
    expect(await claim()).toBeNull();
  });

  it("a failed job is retried at most 3 times; the superseded job's late result is refused", async () => {
    const p = await prepare(candidate(), true);
    const first = (await claim())!;
    expect(await submit(first.job_id, "failed", null, "WORKER_FAILED")).toMatchObject({ status: "pending", attempts: 1 });
    const second = (await claim())!;
    expect(second).toMatchObject({ attempt: 2 });
    expect(second.job_id).not.toBe(first.job_id);
    await expect(submit(first.job_id, "ready", PROFILE, null)).rejects.toThrow(/job_superseded/);
    expect(await submit(second.job_id, "failed", null, "WORKER_FAILED")).toMatchObject({ status: "pending", attempts: 2 });
    const third = (await claim())!;
    expect(await submit(third.job_id, "failed", null, "WORKER_FAILED")).toMatchObject({ status: "failed", attempts: 3, error_code: "WORKER_FAILED" });
    expect(await claim()).toBeNull();
    expect(await demoOf(p)).toMatchObject({ design_status: "failed", design_profile: null });
  });

  it("blocked is final", async () => {
    await prepare(candidate(), true);
    const job = (await claim())!;
    expect(await submit(job.job_id, "blocked", null, "PUBLIC_SOURCE_UNAVAILABLE")).toMatchObject({ status: "blocked", error_code: "PUBLIC_SOURCE_UNAVAILABLE" });
    expect(await claim()).toBeNull();
  });

  it("a stale job (lease over) is handed out again, and fails after the last attempt", async () => {
    const p = await prepare(candidate(), true);
    const first = (await claim())!;
    await db.query("update public.sales_demos set design_claimed_at = now() - interval '3 hours' where prospect_id = $1", [p]);
    const second = (await claim())!;
    expect(second).toMatchObject({ attempt: 2 });
    await expect(submit(first.job_id, "ready", PROFILE, null)).rejects.toThrow(/job_superseded/);
    await db.query("update public.sales_demos set design_claimed_at = now() - interval '3 hours' where prospect_id = $1", [p]);
    expect((await claim())!).toMatchObject({ attempt: 3 });
    await db.query("update public.sales_demos set design_claimed_at = now() - interval '3 hours' where prospect_id = $1", [p]);
    expect(await claim()).toBeNull();
    expect(await demoOf(p)).toMatchObject({ design_status: "failed", design_error_code: "DESIGN_STALE", design_job_id: null });
  });

  it("a late result for a job swept back to pending is superseded, not replayed", async () => {
    const p = await prepare(candidate(), true);
    await prepare(candidate(), true);
    const first = (await claim())!;
    const other = (await claim())!; // the other demo: keeps the queue busy
    await db.query("update public.sales_demos set design_claimed_at = now() - interval '3 hours' where prospect_id = $1", [p]);
    await submit(other.job_id, "blocked", null, "DESIGN_BLOCKED");
    // The sweep runs inside the next claim, which then hands the demo out again with a new job id.
    const again = (await claim())!;
    expect(again.job_id).not.toBe(first.job_id);
    await expect(submit(first.job_id, "ready", PROFILE, null)).rejects.toThrow(/job_superseded/);
  });

  it("a demo whose outreach was closed as lost is OUTREACH_CLOSED, not ALREADY_SENT", async () => {
    const p = await prepare(candidate(), true);
    await db.query("update public.sales_outreaches set status = 'lost', closed_at = now() where prospect_id = $1 and kind = 'initial'", [p]);
    expect(await claim()).toBeNull();
    expect(await demoOf(p)).toMatchObject({ design_status: "blocked", design_error_code: "OUTREACH_CLOSED" });
  });

  it("a live job is not taken over before its lease ends", async () => {
    await prepare(candidate(), true);
    await claim();
    expect(await claim()).toBeNull();
  });

  it("closes demos that must not be designed: DNC, disabled, already sent, no visual source", async () => {
    const dnc = await prepare(candidate(), true);
    await db.query("update public.sales_prospects set do_not_contact = true, dnc_reason = 'explicit_refusal', dnc_set_at = now() where id = $1", [dnc]);
    const disabled = await prepare(candidate(), true);
    await db.query("update public.sales_demos set disabled_at = now() where prospect_id = $1", [disabled]);
    const sent = await prepare(candidate(), true);
    await markSent(sent);
    const noSource = await prepare(emailCandidate(), true);
    // A shop whose site could not be confirmed and that has no Instagram (test-only: row checks bypassed).
    const client = await db.connect();
    try {
      await client.query("begin");
      await client.query("set local session_replication_role = replica");
      await client.query("update public.sales_prospects set website_status = 'unknown', website_url = null, website_domain = null, instagram_url = null, instagram_handle = null where id = $1", [noSource]);
      await client.query("commit");
    } finally {
      client.release();
    }
    expect(await claim()).toBeNull();
    expect((await demoOf(dnc)).design_error_code).toBe("DO_NOT_CONTACT");
    expect((await demoOf(disabled)).design_error_code).toBe("DEMO_DISABLED");
    expect((await demoOf(sent)).design_error_code).toBe("ALREADY_SENT");
    expect((await demoOf(noSource)).design_error_code).toBe("NO_VISUAL_SOURCE");
    for (const p of [dnc, disabled, sent, noSource]) expect((await demoOf(p)).design_status).toBe("blocked");
  });

  it("a result for a demo whose first message went out meanwhile does not change the demo", async () => {
    const p = await prepare(candidate(), true);
    const job = (await claim())!;
    await markSent(p);
    expect(await submit(job.job_id, "ready", PROFILE, null)).toMatchObject({ status: "blocked", error_code: "ALREADY_SENT" });
    expect((await demoOf(p)).design_profile).toBeNull();
  });

  it("refuses inconsistent results without writing", async () => {
    const p = await prepare(candidate(), true);
    const job = (await claim())!;
    await expect(submit(job.job_id, "ready", null, null)).rejects.toThrow(/invalid_result/);
    await expect(submit(job.job_id, "ready", PROFILE, "DESIGN_BLOCKED")).rejects.toThrow(/invalid_result/);
    await expect(submit(job.job_id, "blocked", null, null)).rejects.toThrow(/invalid_result/);
    await expect(submit(job.job_id, "done", null, "X_Y")).rejects.toThrow(/invalid_result/);
    expect((await demoOf(p)).design_status).toBe("processing");
  });

  it("only the service role can drive design jobs", async () => {
    await prepare(candidate(), true);
    const { error } = await anonClient().rpc("sales_design_claim", { p_lease_seconds: 7200, p_max_attempts: 3 });
    expect(error).not.toBeNull();
    await makeAdmin(await createUser("design-admin@test.example.com"));
    const admin = await signedInClient("design-admin@test.example.com");
    for (const fn of ["sales_design_claim", "sales_design_submit"]) {
      const { error: e } = await admin.rpc(fn, fn === "sales_design_claim" ? {} : { p_job_id: randomUUID(), p_outcome: "failed", p_profile: null, p_error_code: "X_Y_Z", p_worker_commit: null });
      expect(e, fn).not.toBeNull();
    }
    expect((await db.query("select count(*)::int as n from public.sales_demos where design_status = 'processing'")).rows[0].n).toBe(0);
  });
});

// ------------------------------------------------------------------ the API route

function bridgeCall(body: unknown, token: string | null = BRIDGE_TOKEN) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return designPost(new NextRequest("http://localhost/api/internal/sales-design/jobs", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }));
}

describe("bridge API", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.stubEnv("SALES_AI_DESIGN_ENABLED", "true");
    vi.stubEnv("SALES_DESIGN_BRIDGE_TOKEN_SHA256", sha(BRIDGE_TOKEN));
    vi.stubEnv("SALES_AGENT_INGEST_TOKEN", INGEST_TOKEN);
    const realFetch = globalThis.fetch;
    // The server may only talk to Supabase; source URLs are never fetched.
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

  it("fails closed: flag off / digest unset / ingest token reused → 503, wrong token → 401, nothing claimed", async () => {
    await prepare(candidate(), true);
    vi.stubEnv("SALES_AI_DESIGN_ENABLED", "false");
    expect((await bridgeCall({ action: "claim" })).status).toBe(503);
    vi.stubEnv("SALES_AI_DESIGN_ENABLED", "true");
    vi.stubEnv("SALES_DESIGN_BRIDGE_TOKEN_SHA256", "");
    expect((await bridgeCall({ action: "claim" })).status).toBe(503);
    vi.stubEnv("SALES_DESIGN_BRIDGE_TOKEN_SHA256", "not-a-sha256");
    expect((await bridgeCall({ action: "claim" })).status).toBe(503);
    vi.stubEnv("SALES_DESIGN_BRIDGE_TOKEN_SHA256", sha(INGEST_TOKEN));
    expect((await bridgeCall({ action: "claim" }, INGEST_TOKEN)).status).toBe(503);
    // the raw token never belongs on the server: configured anyway → 503
    vi.stubEnv("SALES_DESIGN_BRIDGE_TOKEN_SHA256", sha(BRIDGE_TOKEN));
    vi.stubEnv("SALES_DESIGN_BRIDGE_TOKEN", BRIDGE_TOKEN);
    expect((await bridgeCall({ action: "claim" })).status).toBe(503);
    vi.stubEnv("SALES_DESIGN_BRIDGE_TOKEN", "");
    vi.stubEnv("SALES_DESIGN_BRIDGE_TOKEN_SHA256", sha(BRIDGE_TOKEN));
    expect((await bridgeCall({ action: "claim" }, INGEST_TOKEN)).status).toBe(401);
    expect((await bridgeCall({ action: "claim" }, null)).status).toBe(401);
    expect((await db.query("select count(*)::int as n from public.sales_demos where design_status = 'processing'")).rows[0].n).toBe(0);
  });

  it("the bridge token does not open the ingest API", async () => {
    const res = await ingestPost(new NextRequest("http://localhost/api/internal/sales-agent/runs", { method: "POST", headers: { Authorization: `Bearer ${BRIDGE_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ action: "status" }) }));
    expect(res.status).toBe(401);
  });

  it("claim answers the narrow job shape; submit takes only a valid result", async () => {
    const p = await prepare(candidate({ demo: { template: "bakery_v1", content: { name: "テスト工房", category: "bakery", description: "連絡は info@example.com まで", hours: "8:00〜17:00", internal_note: "内部メモ" } } }), true);
    const res = await bridgeCall({ action: "claim" });
    expect(res.status).toBe(200);
    const { job } = await res.json();
    expect(job).toEqual({
      jobId: expect.any(String),
      workerJobId: workerJobIdFor(job.jobId),
      attempt: 1,
      facts: { name: "テスト工房", category: "bakery", hours: "8:00〜17:00" },
      source: { instagram_url: expect.stringMatching(/^https:\/\/www\.instagram\.com\/[a-z0-9._]+\/$/) },
    });
    const body = { action: "submit", jobId: job.jobId, outcome: "ready", profile: PROFILE, errorCode: null, workerCommit: "0123abcd", lineage: { workerJobId: job.workerJobId } };

    for (const bad of [
      { ...body, screenshot: "iVBORw0KGgo=" },
      { ...body, prompt: "You are an art director" },
      { ...body, stderr: "Traceback" },
      { ...body, profile: { ...PROFILE, rationale: ["because"] } },
      { ...body, lineage: { workerJobId: workerJobIdFor(randomUUID()) } },
    ]) {
      const r = await bridgeCall(bad);
      expect(r.status).toBe(400);
      expect(JSON.stringify(await r.json())).not.toMatch(/iVBOR|art director|Traceback|because/);
    }
    const lowContrast = await bridgeCall({ ...body, profile: { ...PROFILE, palette: { ...PROFILE.palette, text: PROFILE.palette.background } } });
    expect(lowContrast.status).toBe(400);
    expect((await demoOf(p)).design_status).toBe("processing");

    const ok = await bridgeCall(body);
    expect(ok.status).toBe(200);
    expect((await ok.json()).result).toEqual({ jobId: job.jobId, status: "ready", errorCode: null, attempts: 1, replayed: false });
    expect((await (await bridgeCall(body)).json()).result).toMatchObject({ replayed: true });
    const stale = await bridgeCall({ ...body, jobId: randomUUID(), lineage: undefined });
    expect(stale.status).toBe(400);
    const other = randomUUID();
    expect((await bridgeCall({ ...body, jobId: other, lineage: { workerJobId: workerJobIdFor(other) } })).status).toBe(409);
  });

  it("persist through the ingest API: pending with the flag on, legacy with it off", async () => {
    const run = async () => {
      const runId = randomUUID();
      const c = verifiedInput();
      const call = (body: unknown) =>
        ingestPost(new NextRequest("http://localhost/api/internal/sales-agent/runs", { method: "POST", headers: { Authorization: `Bearer ${INGEST_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }));
      await call({ action: "start", runId });
      await call({ action: "checkpoint", runId, phase: "discovered", candidates: [{ key: c.key, name: c.name, category: "bakery" }] });
      await call({ action: "checkpoint", runId, phase: "verified", candidates: [c] });
      const persisted = await (await call({ action: "persist", runId })).json();
      return persisted.run.candidates[0].prospectId as string;
    };
    expect((await demoOf(await run())).design_status).toBe("pending");
    vi.stubEnv("SALES_AI_DESIGN_ENABLED", "");
    expect((await demoOf(await run())).design_status).toBeNull();
  });
});

// ------------------------------------------------------------------ end to end

describe("end to end: bridge → spool → worker → bridge → public demo", () => {
  beforeEach(() => {
    vi.stubEnv("SALES_AI_DESIGN_ENABLED", "true");
    vi.stubEnv("SALES_DESIGN_BRIDGE_TOKEN_SHA256", sha(BRIDGE_TOKEN));
    vi.stubEnv("SALES_AGENT_INGEST_TOKEN", INGEST_TOKEN);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("a demo gets its design and the public page draws it once sent", async () => {
    const prospectId = await prepare(candidate(), true);
    const base = await mkdtemp(join(tmpdir(), "sr-bridge-e2e-"));
    const spool = bridgeSpool(join(base, "spool"));
    await mkdir(spool.toWorker, { recursive: true });
    await mkdir(spool.fromWorker, { recursive: true });
    const dirs = queueDirs(join(base, "queue"));
    await ensureQueue(dirs);
    const outRoot = join(base, "out");
    await mkdir(outRoot);
    // The bridge talks to the real route handler (no network).
    const viaRoute: typeof fetch = async (input, init) =>
      designPost(new NextRequest(String(input), { method: "POST", headers: init?.headers as Record<string, string>, body: String(init?.body) }));
    const bridge = () => runBridgeOnce({ spool, stateDir: join(base, "state"), apiUrl: "https://secondroot.example.com", token: BRIDGE_TOKEN, fetch: viaRoute });

    // Without a worker run, the bridge claims nothing.
    expect(await bridge()).toMatchObject({ claimed: null, workerIdle: true });
    expect((await demoOf(prospectId)).design_status).toBe("pending");
    // A worker run (nothing to import yet) leaves its heartbeat; now the bridge claims.
    await importBridgeJobs(spool, dirs, outRoot);
    const first = await bridge();
    expect(first).toMatchObject({ claimed: expect.stringMatching(/^b-/), stopped: null });
    const workerJobId = first.claimed!;
    expect((await demoOf(prospectId)).design_status).toBe("processing");

    // The worker user: import, "run" (as run.ts records a finished job), export.
    expect((await importBridgeJobs(spool, dirs, outRoot)).imported).toEqual([workerJobId]);
    await writeFile(join(dirs.done, `${workerJobId}.json`), "{}");
    await writeFile(join(dirs.done, `${workerJobId}.result.json`), JSON.stringify({ job_id: workerJobId, bucket: "done", outcome: "done" }));
    await mkdir(join(outRoot, workerJobId));
    await writeFile(join(outRoot, workerJobId, "report.json"), JSON.stringify({ outcome: "done", worker: { commit: "0123abcd4567" } }));
    await writeFile(join(outRoot, workerJobId, "final.json"), JSON.stringify(AMERICAN_EDITORIAL));
    expect((await exportBridgeResults(spool, dirs, outRoot)).exported).toEqual([workerJobId]);

    expect(await bridge()).toMatchObject({ delivered: [workerJobId], stopped: null });
    const demo = await demoOf(prospectId);
    expect(demo).toMatchObject({ design_status: "ready", design_profile: PROFILE, design_worker_commit: "0123abcd4567" });

    // Unsent: still not public. Sent: drawn with the profile; flag off: the legacy template.
    const token = demo.public_token as string;
    expect(await loadPublicDemo(serviceClient(), token, new Date(), { SALES_AI_DESIGN_ENABLED: "true" })).toBeNull();
    await markSent(prospectId);
    expect((await loadPublicDemo(serviceClient(), token, new Date(), { SALES_AI_DESIGN_ENABLED: "true" }))?.profile).toEqual(PROFILE);
    expect((await loadPublicDemo(serviceClient(), token, new Date(), {}))?.profile).toBeNull();
  });
});

// ------------------------------------------------------------------ admin

describe("today queue", () => {
  let admin: Awaited<ReturnType<typeof signedInClient>>;
  beforeAll(async () => {
    await makeAdmin(await createUser("design-queue-admin@test.example.com"));
    admin = await signedInClient("design-queue-admin@test.example.com");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("shows the design state only with the step on", async () => {
    const waiting = await prepare(candidate(), true);
    const legacy = await prepare(candidate(), false);
    vi.stubEnv("SALES_AI_DESIGN_ENABLED", "true");
    const on = await loadTodayQueue(admin);
    expect(on.find((i) => i.prospectId === waiting)?.designStatus).toBe("pending");
    expect(on.find((i) => i.prospectId === legacy)?.designStatus).toBeNull();
    vi.stubEnv("SALES_AI_DESIGN_ENABLED", "false");
    const off = await loadTodayQueue(admin);
    expect(off.map((i) => i.designStatus)).toEqual([null, null]);
  });
});
