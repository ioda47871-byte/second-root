import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { candidate, db, emailCandidate, resetSalesData, rpc, verifiedRun } from "./helpers";

// Run lifecycle: checkpoint / resume / run_id idempotency / fail-closed
// (docs/ARCHITECTURE.md §7).

type State = {
  run_id: string;
  status: string;
  phase: string;
  persist_attempts: number;
  error_code: string | null;
  candidates: Record<string, { stage: string; prospect_id?: string; reason?: string; error_code?: string }>;
  result: { outreach_ready: number; unprepared: number } | null;
  replayed: boolean;
};

const count = async (table: string) => (await db.query(`select count(*)::int as n from public.${table}`)).rows[0].n as number;

async function persistAll(runId: string, keys: string[]) {
  await rpc("sales_run_begin_persist", { p_run_id: runId });
  const results = [];
  for (const key of keys) results.push(await rpc<{ stage: string }>("sales_persist_candidate", { p_run_id: runId, p_key: key }));
  const state = await rpc<State>("sales_run_finalize", { p_run_id: runId });
  return { results, state };
}

beforeEach(resetSalesData);
afterAll(resetSalesData);

describe("run start / status", () => {
  it("start is idempotent for the same run_id", async () => {
    const runId = randomUUID();
    const first = await rpc<State>("sales_run_start", { p_run_id: runId });
    const again = await rpc<State>("sales_run_start", { p_run_id: runId });
    expect(first).toMatchObject({ status: "running", phase: "started", replayed: false });
    expect(again).toMatchObject({ status: "running", phase: "started", replayed: true });
    expect(await count("sales_agent_runs")).toBe(1);
  });

  it("status without run_id returns the latest resumable run, or null", async () => {
    expect(await rpc("sales_run_status", { p_run_id: null })).toBeNull();
    const runId = randomUUID();
    await rpc("sales_run_start", { p_run_id: runId });
    expect(await rpc<State>("sales_run_status", { p_run_id: null })).toMatchObject({ run_id: runId });
  });

  it("expires a run with no checkpoint for 24h and never resumes it", async () => {
    const runId = randomUUID();
    await rpc("sales_run_start", { p_run_id: runId });
    await db.query("update public.sales_agent_runs set checkpoint_at = now() - interval '25 hours' where run_id = $1", [runId]);
    expect(await rpc("sales_run_status", { p_run_id: null })).toBeNull();
    const state = await rpc<State>("sales_run_status", { p_run_id: runId });
    expect(state).toMatchObject({ status: "failed", error_code: "run_expired" });
    await expect(
      rpc("sales_run_checkpoint", { p_run_id: runId, p_phase: "discovered", p_payload: { candidates: [] } }),
    ).rejects.toThrow(/run_expired/);
  });
});

describe("checkpoint phase order", () => {
  it("refuses to skip a phase", async () => {
    const runId = randomUUID();
    await rpc("sales_run_start", { p_run_id: runId });
    await expect(
      rpc("sales_run_checkpoint", { p_run_id: runId, p_phase: "verified", p_payload: { order: [], candidates: {} } }),
    ).rejects.toThrow(/phase_order_violation/);
    await expect(rpc("sales_run_begin_persist", { p_run_id: runId })).rejects.toThrow(/phase_order_violation/);
  });

  it("treats a late re-send of an earlier phase as a no-op", async () => {
    const runId = randomUUID();
    await verifiedRun(runId, { c01: candidate() });
    const state = await rpc<State>("sales_run_checkpoint", {
      p_run_id: runId,
      p_phase: "discovered",
      p_payload: { candidates: [{ key: "zzz" }] },
    });
    expect(state).toMatchObject({ phase: "verified", replayed: true });
    expect(Object.keys(state.candidates)).toEqual(["c01"]);
  });

  it("caps discovered at 20 and verified at 10, and only accepts discovered keys", async () => {
    const runId = randomUUID();
    await rpc("sales_run_start", { p_run_id: runId });
    const stubs = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `c${i}` }));
    await expect(
      rpc("sales_run_checkpoint", { p_run_id: runId, p_phase: "discovered", p_payload: { candidates: stubs(21) } }),
    ).rejects.toThrow(/too_many_candidates/);
    await rpc("sales_run_checkpoint", { p_run_id: runId, p_phase: "discovered", p_payload: { candidates: stubs(20) } });
    const eleven = Object.fromEntries(stubs(11).map((s) => [s.key, candidate()]));
    await expect(
      rpc("sales_run_checkpoint", { p_run_id: runId, p_phase: "verified", p_payload: { order: Object.keys(eleven), candidates: eleven } }),
    ).rejects.toThrow(/too_many_candidates/);
    await expect(
      rpc("sales_run_checkpoint", { p_run_id: runId, p_phase: "verified", p_payload: { order: ["nope"], candidates: { nope: candidate() } } }),
    ).rejects.toThrow(/unknown_candidate_key/);
  });
});

describe("persist", () => {
  it("prepares prospect, sources, demo and outreach, then completes", async () => {
    const runId = randomUUID();
    await verifiedRun(runId, { c01: candidate(), c02: emailCandidate() });
    const { results, state } = await persistAll(runId, ["c01", "c02"]);
    expect(results.map((r) => r.stage)).toEqual(["outreach_ready", "outreach_ready"]);
    expect(state).toMatchObject({ status: "completed", phase: "completed", error_code: null });
    expect(state.result).toMatchObject({ outreach_ready: 2, unprepared: 0 });
    expect(await count("sales_prospects")).toBe(2);
    expect(await count("sales_demos")).toBe(2);
    expect(await count("sales_outreaches")).toBe(2);
  });

  it("re-sending to a completed run returns the stored result without new rows", async () => {
    const runId = randomUUID();
    await verifiedRun(runId, { c01: candidate() });
    await persistAll(runId, ["c01"]);
    const replay = await rpc<State>("sales_run_begin_persist", { p_run_id: runId });
    expect(replay).toMatchObject({ status: "completed", replayed: true });
    const replay2 = await rpc<State>("sales_run_checkpoint", {
      p_run_id: runId,
      p_phase: "verified",
      p_payload: { order: ["c01"], candidates: { c01: candidate() } },
    });
    expect(replay2).toMatchObject({ status: "completed", replayed: true });
    expect(await count("sales_prospects")).toBe(1);
    expect(await count("sales_outreaches")).toBe(1);
  });

  it("does not reprocess a candidate that already reached a terminal stage (resume)", async () => {
    const runId = randomUUID();
    await verifiedRun(runId, { c01: candidate(), c02: candidate() });
    await rpc("sales_run_begin_persist", { p_run_id: runId });
    await rpc("sales_persist_candidate", { p_run_id: runId, p_key: "c01" });
    // Session vanishes here. Lease expires; a new session resumes.
    await db.query("update public.sales_agent_runs set persist_lease_until = now() - interval '1 second' where run_id = $1", [runId]);
    const status = await rpc<State>("sales_run_status", { p_run_id: null });
    expect(status).toMatchObject({ run_id: runId, phase: "persisting" });
    const { results, state } = await persistAll(runId, ["c01", "c02"]);
    expect(results.map((r) => r.stage)).toEqual(["outreach_ready", "outreach_ready"]);
    expect(state.status).toBe("completed");
    expect(await count("sales_prospects")).toBe(2);
    expect(await count("sales_outreaches")).toBe(2);
  });

  it("recognises its own prospect if the checkpoint was lost, instead of calling it a duplicate", async () => {
    const runId = randomUUID();
    await verifiedRun(runId, { c01: candidate() });
    await rpc("sales_run_begin_persist", { p_run_id: runId });
    await rpc("sales_persist_candidate", { p_run_id: runId, p_key: "c01" });
    await db.query(
      `update public.sales_agent_runs set checkpoint = jsonb_set(checkpoint, '{candidates,c01}', '{"stage":"pending"}') where run_id = $1`,
      [runId],
    );
    const again = await rpc<{ stage: string }>("sales_persist_candidate", { p_run_id: runId, p_key: "c01" });
    expect(again.stage).toBe("outreach_ready");
    expect(await count("sales_outreaches")).toBe(1);
  });

  it("marks the same shop from another run as duplicate without new demo or outreach", async () => {
    const shop = candidate();
    const first = randomUUID();
    await verifiedRun(first, { c01: shop });
    await persistAll(first, ["c01"]);
    const second = randomUUID();
    await verifiedRun(second, { x: { ...candidate(), instagram_handle: shop.instagram_handle, instagram_url: shop.instagram_url } });
    const { results } = await persistAll(second, ["x"]);
    expect(results[0].stage).toBe("duplicate");
    expect(await count("sales_demos")).toBe(1);
    expect(await count("sales_outreaches")).toBe(1);
  });

  it("rejects a DNC shop", async () => {
    const shop = emailCandidate();
    const first = randomUUID();
    await verifiedRun(first, { c01: shop });
    await persistAll(first, ["c01"]);
    await db.query("update public.sales_prospects set do_not_contact = true, dnc_reason = 'explicit_refusal', dnc_set_at = now()");
    const second = randomUUID();
    await verifiedRun(second, { x: { ...emailCandidate(), public_email: shop.public_email, sources: shop.sources } });
    const { results } = await persistAll(second, ["x"]);
    expect(results[0]).toMatchObject({ stage: "rejected", reason: "do_not_contact" });
  });

  it("caps new actionable prospects at 5 per JST day across runs, in submission order", async () => {
    const a = randomUUID();
    const four = Object.fromEntries(["a1", "a2", "a3", "a4"].map((k) => [k, candidate()]));
    await verifiedRun(a, four);
    await persistAll(a, Object.keys(four));
    const b = randomUUID();
    const three = Object.fromEntries(["b1", "b2", "b3"].map((k) => [k, candidate()]));
    await verifiedRun(b, three);
    const { results } = await persistAll(b, Object.keys(three));
    expect(results.map((r) => r.stage)).toEqual(["outreach_ready", "rejected", "rejected"]);
    expect(await count("sales_outreaches")).toBe(5);
  });

  it("rolls back everything for a candidate that fails a check (fail closed)", async () => {
    const runId = randomUUID();
    const bad = emailCandidate({ sources: [] }); // email without first-party provenance
    await verifiedRun(runId, { c01: bad });
    await rpc("sales_run_begin_persist", { p_run_id: runId });
    await expect(rpc("sales_persist_candidate", { p_run_id: runId, p_key: "c01" })).rejects.toThrow(/persist_failed/);
    expect(await count("sales_prospects")).toBe(0);
    expect(await count("sales_demos")).toBe(0);
    expect(await count("sales_outreaches")).toBe(0);
    const state = await rpc<State>("sales_run_mark_candidate_error", { p_run_id: runId, p_key: "c01", p_error_code: "persist_failed" });
    expect(state.candidates.c01).toMatchObject({ stage: "error", error_code: "persist_failed" });
  });

  it("serialises persist per run (run_busy)", async () => {
    const runId = randomUUID();
    await verifiedRun(runId, { c01: candidate() });
    await rpc("sales_run_begin_persist", { p_run_id: runId });
    await expect(rpc("sales_run_begin_persist", { p_run_id: runId })).rejects.toThrow(/run_busy/);
  });

  it("completes with partial_errors after 3 attempts, leaving errors unprepared", async () => {
    const runId = randomUUID();
    await verifiedRun(runId, { ok: candidate(), bad: emailCandidate({ sources: [] }) });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await rpc("sales_run_begin_persist", { p_run_id: runId });
      await rpc("sales_persist_candidate", { p_run_id: runId, p_key: "ok" });
      await expect(rpc("sales_persist_candidate", { p_run_id: runId, p_key: "bad" })).rejects.toThrow();
      await rpc("sales_run_mark_candidate_error", { p_run_id: runId, p_key: "bad", p_error_code: "persist_failed" });
      const state = await rpc<State>("sales_run_finalize", { p_run_id: runId });
      expect(state.status).toBe(attempt < 3 ? "running" : "completed");
    }
    const final = await rpc<State>("sales_run_status", { p_run_id: runId });
    expect(final).toMatchObject({ status: "completed", error_code: "partial_errors" });
    expect(final.result).toMatchObject({ outreach_ready: 1, unprepared: 1 });
    expect(await count("sales_outreaches")).toBe(1);
  });

  it("stores rejections decided at verify time and never persists them", async () => {
    const runId = randomUUID();
    await rpc("sales_run_start", { p_run_id: runId });
    await rpc("sales_run_checkpoint", { p_run_id: runId, p_phase: "discovered", p_payload: { candidates: [{ key: "c01" }] } });
    await rpc("sales_run_checkpoint", {
      p_run_id: runId,
      p_phase: "verified",
      p_payload: { order: ["c01"], candidates: {}, stages: { c01: { stage: "rejected", reason: "no_eligible_channel" } } },
    });
    const { state } = await persistAll(runId, ["c01"]);
    expect(state.candidates.c01).toMatchObject({ stage: "rejected", reason: "no_eligible_channel" });
    expect(await count("sales_prospects")).toBe(0);
  });

  it("abort fails the run and later actions are refused", async () => {
    const runId = randomUUID();
    await rpc("sales_run_start", { p_run_id: runId });
    const state = await rpc<State>("sales_run_abort", { p_run_id: runId, p_error_code: "search_unavailable", p_error_summary: "web search down" });
    expect(state).toMatchObject({ status: "failed", error_code: "search_unavailable" });
    await expect(
      rpc("sales_run_checkpoint", { p_run_id: runId, p_phase: "discovered", p_payload: { candidates: [] } }),
    ).rejects.toThrow(/search_unavailable/);
  });
});
