import { chmod, link, mkdir, mkdtemp, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { bridgeEndpoint, bridgeModeFor, bridgeSummary, isReviewRejection, LOCAL_EXPIRY_MS, readTokenFile, runBridgeOnce, submitBody, WORKER_HEARTBEAT_MAX_MS, type BridgeOptions } from "@/lib/design-agent/bridge/client";
import { bridgeSpool, readHeartbeat, readReviewSidecar, readSpoolJson, resultCode, spoolIds, writeHeartbeat, writeSpoolJson, WorkerResultSchema, type BridgeSpool } from "@/lib/design-agent/bridge/spool";
import { exportBridgeResults, importBridgeJobs, resultFromRecords, reviewForResult } from "@/lib/design-agent/bridge/worker-side";
import type { ReviewSummary } from "@/lib/design-agent/review-summary";
import type { DesignProfile } from "@/lib/design-agent/profile";
import { childEnvironment } from "@/lib/design-agent/worker/env";
import { ensureQueue, queueDirs, type QueueDirs } from "@/lib/design-agent/worker/queue";
import { designBridgeRequest, workerJobIdFor } from "@/lib/sales/design-bridge-schema";
import { AMERICAN_EDITORIAL } from "./fixtures";

// DEV-030 local design bridge: the file spool between the bridge user
// (holds the token, talks to the server) and the worker user (never holds
// it), the worker-side import / export, and one pass of the bridge.

const JOB = "6f1c2e7a-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
const JOB2 = "7a2d3f8b-4c5e-4f60-9b0c-1d2e3f4a5b6c";
const WJOB = workerJobIdFor(JOB);
const WJOB2 = workerJobIdFor(JOB2);
const TOKEN = "bridge-token-0123456789abcdef-0123456789";
const PROFILE: DesignProfile = { ...AMERICAN_EDITORIAL, rationale: [] };

let base: string;
let spool: BridgeSpool;
let dirs: QueueDirs;
let outRoot: string;
let stateDir: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "sr-bridge-test-"));
  spool = bridgeSpool(join(base, "spool"));
  await mkdir(spool.toWorker, { recursive: true });
  await mkdir(spool.fromWorker, { recursive: true });
  dirs = queueDirs(join(base, "queue"));
  await ensureQueue(dirs);
  outRoot = join(base, "out");
  await mkdir(outRoot);
  stateDir = join(base, "state");
});

const job = (id = WJOB) => ({ version: 1, job_id: id, facts: { name: "テスト工房", category: "bakery" }, source: { instagram_url: "https://www.instagram.com/example_shop/" } });

/** A finished worker run, as run.ts leaves it. */
async function finished(id: string, outcome: string, final: unknown = null, extra: Record<string, unknown> = {}) {
  await writeFile(join(dirs.done, `${id}.json`), JSON.stringify(job(id)));
  await writeFile(join(dirs.done, `${id}.result.json`), JSON.stringify({ job_id: id, bucket: "done", outcome, worker_commit: "0123abcd4567" }));
  await mkdir(join(outRoot, id));
  await writeFile(
    join(outRoot, id, "report.json"),
    JSON.stringify({ version: 1, job_id: id, worker: { commit: "0123abcd4567" }, outcome, codex: { notes: ["CODEX_SAID_SOMETHING"], rounds: [{ verdict: "accept" }] }, timing: { capture_ms: 1 }, ...extra }),
  );
  if (final) await writeFile(join(outRoot, id, "final.json"), JSON.stringify(final));
}

describe("spool files", () => {
  it("writes atomically with a fixed mode whatever the umask, and lists only job-shaped names", async () => {
    const old = process.umask(0o077);
    try {
      await writeSpoolJson(spool.toWorker, WJOB, job());
    } finally {
      process.umask(old);
    }
    expect((await stat(join(spool.toWorker, `${WJOB}.json`))).mode & 0o777).toBe(0o640);
    await writeFile(join(spool.toWorker, "notes.txt"), "x");
    await writeFile(join(spool.toWorker, "b-123.json"), "{}");
    await writeFile(join(spool.toWorker, `.tmp-${WJOB2}`), "{}");
    expect(await spoolIds(spool.toWorker)).toEqual([WJOB]);
    await expect(writeSpoolJson(spool.toWorker, "../escape", {})).rejects.toThrow();
  });

  it("reads only a regular file with one link and within the size limit", async () => {
    const target = join(base, "secret.json");
    await writeFile(target, JSON.stringify(job()));
    await symlink(target, join(spool.toWorker, `${WJOB}.json`));
    expect(await readSpoolJson(join(spool.toWorker, `${WJOB}.json`))).toBeNull();
    await link(target, join(spool.toWorker, `${WJOB2}.json`));
    expect(await readSpoolJson(join(spool.toWorker, `${WJOB2}.json`))).toBeNull();
    const big = join(base, "big.json");
    await writeFile(big, JSON.stringify({ x: "a".repeat(70 * 1024) }));
    expect(await readSpoolJson(big)).toBeNull();
    expect(await readSpoolJson(join(base, "spool"))).toBeNull();
    const fine = join(base, "fine.json");
    await writeFile(fine, JSON.stringify(job()));
    expect(await readSpoolJson(fine)).toEqual(job());
  });
});

describe("worker side: import", () => {
  it("imports a new job once, into the inbox, under its own id, and refreshes the heartbeat", async () => {
    await writeSpoolJson(spool.toWorker, WJOB, job());
    const at = new Date("2026-10-10T01:02:03.000Z");
    expect(await importBridgeJobs(spool, dirs, outRoot, at)).toEqual({ imported: [WJOB], invalid: [], withdrawn: [] });
    expect(await readHeartbeat(spool.fromWorker)).toEqual(at);
    expect(JSON.parse(await readFile(join(dirs.inbox, `${WJOB}.json`), "utf8"))).toEqual(job());
    expect(await importBridgeJobs(spool, dirs, outRoot)).toEqual({ imported: [], invalid: [], withdrawn: [] });
    // claimed, finished or recorded: never again
    for (const where of [dirs.processing, dirs.done, dirs.failed]) {
      await writeFile(join(where, `${WJOB2}.json`), "{}");
      await writeSpoolJson(spool.toWorker, WJOB2, job(WJOB2));
      expect((await importBridgeJobs(spool, dirs, outRoot)).imported).toEqual([]);
      await import("node:fs/promises").then((fs) => fs.rm(join(where, `${WJOB2}.json`)));
    }
    await mkdir(join(outRoot, WJOB2));
    expect((await importBridgeJobs(spool, dirs, outRoot)).imported).toEqual([]);
  });

  it("refuses a job whose content does not match the worker's job schema or its file name", async () => {
    await writeSpoolJson(spool.toWorker, WJOB, { ...job(), job_id: WJOB2 });
    await writeSpoolJson(spool.toWorker, WJOB2, { ...job(WJOB2), command: "rm -rf ~" });
    expect(await importBridgeJobs(spool, dirs, outRoot)).toEqual({ imported: [], invalid: [WJOB, WJOB2], withdrawn: [] });
    expect((await readdir(dirs.inbox)).filter((n) => !n.startsWith("."))).toEqual([]);
  });
});

describe("worker side: jobs the bridge gave up", () => {
  it("withdraws a waiting bridge job whose spool file is gone, and leaves local jobs alone", async () => {
    await writeSpoolJson(spool.toWorker, WJOB, job());
    await importBridgeJobs(spool, dirs, outRoot);
    await writeFile(join(dirs.inbox, "local-poc-job.json"), JSON.stringify(job("local-poc-job")));
    const { rm } = await import("node:fs/promises");
    await rm(join(spool.toWorker, `${WJOB}.json`));
    expect((await importBridgeJobs(spool, dirs, outRoot)).withdrawn).toEqual([WJOB]);
    expect((await readdir(dirs.inbox)).sort()).toEqual(["local-poc-job.json"]);
  });
});

describe("worker side: export", () => {
  it.each([
    ["done", "done", PROFILE, { outcome: "ready", profile: PROFILE, error_code: null }],
    ["done", "done", AMERICAN_EDITORIAL, { outcome: "ready", profile: PROFILE, error_code: null }],
    ["done", "done", { ...PROFILE, palette: { ...PROFILE.palette, text: PROFILE.palette.background } }, { outcome: "failed", profile: null, error_code: "PROFILE_INVALID" }],
    ["done", "done", null, { outcome: "failed", profile: null, error_code: "PROFILE_INVALID" }],
    ["done", "blocked", null, { outcome: "blocked", profile: null, error_code: "DESIGN_BLOCKED" }],
    ["done", "fallback_template", null, { outcome: "blocked", profile: null, error_code: "FALLBACK_TEMPLATE" }],
    ["done", "PUBLIC_SOURCE_UNAVAILABLE", null, { outcome: "blocked", profile: null, error_code: "PUBLIC_SOURCE_UNAVAILABLE" }],
    ["done", "recorded", null, { outcome: "failed", profile: null, error_code: "RESULT_MISSING" }],
  ] as const)("%s / %s → result", (bucket, outcome, final, expected) => {
    const result = resultFromRecords({ id: WJOB, bucket, record: {}, report: { outcome, worker: { commit: "0123abcd4567" } }, final });
    expect(result).toEqual({ version: 1, job_id: WJOB, worker_commit: "0123abcd4567", ...expected });
    expect(WorkerResultSchema.safeParse(result).success).toBe(true);
  });

  it("failed jobs carry the worker's fixed code, nothing else", () => {
    expect(resultFromRecords({ id: WJOB, bucket: "failed", record: { code: "WORKER_JOB_STALE", message: "a sentence" }, report: null, final: null })).toEqual({
      version: 1, job_id: WJOB, worker_commit: null, outcome: "failed", profile: null, error_code: "WORKER_JOB_STALE",
    });
    expect(resultFromRecords({ id: WJOB, bucket: "failed", record: { code: "see stderr: boom" }, report: null, final: null }).error_code).toBe("WORKER_FAILED");
    // a well-formed but unknown code is not passed on either (no made-up words in the database)
    expect(resultFromRecords({ id: WJOB, bucket: "failed", record: { code: "CALL_ME_AT_0123" }, report: null, final: null }).error_code).toBe("WORKER_FAILED");
    expect(resultCode("CODEX_TIMEOUT")).toBe("CODEX_TIMEOUT");
    const blocked = resultFromRecords({ id: WJOB, bucket: "done", record: {}, report: { outcome: "blocked", codex: { renderer_change_needed: true } }, final: null });
    expect(blocked.error_code).toBe("RENDERER_CHANGE_NEEDED");
  });

  it("DEV-053: a final no review accepted is blocked QUALITY_NOT_ACCEPTED, never ready, and reaches the server as that code", () => {
    // the run still wrote a valid final.json (the record): it must not be uploaded
    const quality = resultFromRecords({ id: WJOB, bucket: "done", record: {}, report: { outcome: "blocked", codex: { renderer_change_needed: false, quality_not_accepted: true } }, final: PROFILE });
    expect(quality).toMatchObject({ outcome: "blocked", profile: null, error_code: "QUALITY_NOT_ACCEPTED" });
    expect(WorkerResultSchema.safeParse(quality).success).toBe(true);
    expect(resultCode("QUALITY_NOT_ACCEPTED")).toBe("QUALITY_NOT_ACCEPTED");
    const body = submitBody(JOB, quality);
    expect(body).toMatchObject({ outcome: "blocked", profile: null, errorCode: "QUALITY_NOT_ACCEPTED" });
    expect(designBridgeRequest.safeParse(body).success).toBe(true);
    // the renderer-change stop keeps its own code; a blocked report without either flag stays DESIGN_BLOCKED
    expect(resultFromRecords({ id: WJOB, bucket: "done", record: {}, report: { outcome: "blocked", codex: { renderer_change_needed: true, quality_not_accepted: true } }, final: null }).error_code).toBe("RENDERER_CHANGE_NEEDED");
    expect(resultFromRecords({ id: WJOB, bucket: "done", record: {}, report: { outcome: "blocked", codex: { quality_not_accepted: "yes" } }, final: null }).error_code).toBe("DESIGN_BLOCKED");
  });

  describe("DEV-058: the review summary", () => {
    const round = (candidate: string, verdict: "accept" | "revise", s: number) => ({
      candidate,
      scores: { brand_fit: s, visual_quality: s, hierarchy: s, mobile_quality: s, generic_template_feel: 3, total: 4 * s + 3 },
      verdict,
      problems: [{ area: "hero", severity: "high" }],
    });
    const accepted = { rounds: [round("initial", "revise", 3), round("rev1", "accept", 4)], final_candidate: "rev1", confidence: 0.72, quality_not_accepted: false, notes: ["CODEX_SAID_SOMETHING"] };
    const notAccepted = { rounds: [round("initial", "revise", 4), round("rev1", "revise", 3)], final_candidate: "initial", confidence: 0.6, renderer_change_needed: false, quality_not_accepted: true };
    const SUMMARY: ReviewSummary = { version: 1, verdict: "accept", total: 19, max: 25, scores: { brand_fit: 4, visual_quality: 4, hierarchy: 4, mobile_quality: 4, generic_template_feel: 3 }, rounds: 2, confidence: 0.72, qualityNotAccepted: false };

    it("a ready and a QUALITY_NOT_ACCEPTED result get it; it reaches the submit body; the result itself keeps its old shape", () => {
      const readyReport = { outcome: "done", codex: accepted };
      const ready = resultFromRecords({ id: WJOB, bucket: "done", record: {}, report: readyReport, final: PROFILE });
      expect(Object.keys(ready).sort()).toEqual(["error_code", "job_id", "outcome", "profile", "version", "worker_commit"]);
      expect(reviewForResult(ready, readyReport)).toEqual(SUMMARY);
      expect(submitBody(JOB, ready, SUMMARY)).toMatchObject({ outcome: "ready", review: SUMMARY });
      expect(designBridgeRequest.safeParse(submitBody(JOB, ready, SUMMARY)).success).toBe(true);

      const qualityReport = { outcome: "blocked", codex: notAccepted };
      const quality = resultFromRecords({ id: WJOB, bucket: "done", record: {}, report: qualityReport, final: PROFILE });
      const review = reviewForResult(quality, qualityReport);
      expect(review).toMatchObject({ verdict: "revise", total: 19, rounds: 2, qualityNotAccepted: true });
      expect(designBridgeRequest.safeParse(submitBody(JOB, quality, review)).success).toBe(true);
    });

    it("no other result gets it (other blocks, failures, a report without well-formed rounds)", () => {
      const forReport = (bucket: "done" | "failed", report: Record<string, unknown>, final: unknown = null) =>
        reviewForResult(resultFromRecords({ id: WJOB, bucket, record: { code: "WORKER_FAILED" }, report, final }), report);
      expect(forReport("done", { outcome: "blocked", codex: { ...notAccepted, renderer_change_needed: true } })).toBeNull();
      expect(forReport("done", { outcome: "fallback_template", codex: accepted })).toBeNull();
      expect(forReport("failed", { outcome: "done", codex: accepted })).toBeNull();
      expect(forReport("done", { outcome: "done", codex: { ...accepted, rounds: [{ verdict: "accept" }] } }, PROFILE)).toBeNull();
      // a ready run whose final was not accepted cannot happen (DEV-053); its summary is not sent
      expect(forReport("done", { outcome: "done", codex: notAccepted }, PROFILE)).toBeNull();
    });

    it("the result schema is the one an older bridge has: a result with a review key is refused", () => {
      const base = { version: 1, job_id: WJOB, outcome: "ready", profile: PROFILE, error_code: null, worker_commit: "0123abcd" };
      expect(WorkerResultSchema.safeParse(base).success).toBe(true);
      expect(WorkerResultSchema.safeParse({ ...base, review: SUMMARY }).success).toBe(false);
    });

    it("a profile that cannot be drawn downgrades to failed without the summary", () => {
      const bad = { version: 1 as const, job_id: WJOB, outcome: "ready" as const, profile: { ...PROFILE, palette: { ...PROFILE.palette, text: PROFILE.palette.background } }, error_code: null, worker_commit: null };
      const body = submitBody(JOB, bad, SUMMARY);
      expect(body).toMatchObject({ outcome: "failed", errorCode: "PROFILE_INVALID" });
      expect(body).not.toHaveProperty("review");
    });

    it("the worker writes the summary as a sidecar next to an unchanged result, and removes both when the job closes", async () => {
      await writeSpoolJson(spool.toWorker, WJOB, job());
      await finished(WJOB, "done", AMERICAN_EDITORIAL, { codex: accepted });
      expect((await exportBridgeResults(spool, dirs, outRoot)).exported).toEqual([WJOB]);
      const written = JSON.parse(await readFile(join(spool.fromWorker, `${WJOB}.json`), "utf8")) as Record<string, unknown>;
      expect(Object.keys(written).sort()).toEqual(["error_code", "job_id", "outcome", "profile", "version", "worker_commit"]);
      const sidecar = join(spool.fromWorker, `${WJOB}.review.json`);
      expect(JSON.parse(await readFile(sidecar, "utf8"))).toEqual(SUMMARY);
      expect((await stat(sidecar)).mode & 0o777).toBe(0o640);
      expect(await readFile(sidecar, "utf8")).not.toMatch(/CODEX_SAID_SOMETHING|rev1|initial|severity|hero/);
      expect(await spoolIds(spool.fromWorker)).toEqual([WJOB]); // the sidecar is not a result to anyone listing results
      const { rm } = await import("node:fs/promises");
      await rm(join(spool.toWorker, `${WJOB}.json`)); // the bridge closed the job
      expect((await exportBridgeResults(spool, dirs, outRoot)).removed).toEqual([WJOB]);
      expect(await readdir(spool.fromWorker)).not.toContain(`${WJOB}.review.json`);
    });

    it("the sidecar is read like a result: no link, one link, size limit, strict schema", async () => {
      const sidecar = join(spool.fromWorker, `${WJOB}.review.json`);
      await writeFile(sidecar, JSON.stringify(SUMMARY));
      expect(await readReviewSidecar(spool.fromWorker, WJOB)).toEqual(SUMMARY);
      await writeFile(sidecar, JSON.stringify({ ...SUMMARY, note: "Codex said" }));
      expect(await readReviewSidecar(spool.fromWorker, WJOB)).toBeNull();
      await writeFile(sidecar, JSON.stringify({ ...SUMMARY, pad: "x".repeat(4096) }));
      expect(await readReviewSidecar(spool.fromWorker, WJOB)).toBeNull();
      const { rm } = await import("node:fs/promises");
      await rm(sidecar);
      const target = join(base, "elsewhere.json");
      await writeFile(target, JSON.stringify(SUMMARY));
      await symlink(target, sidecar);
      expect(await readReviewSidecar(spool.fromWorker, WJOB)).toBeNull();
      await rm(sidecar);
      await link(target, sidecar);
      expect(await readReviewSidecar(spool.fromWorker, WJOB)).toBeNull();
      expect(await readReviewSidecar(spool.fromWorker, WJOB2)).toBeNull(); // none at all
    });
  });

  it("writes one result per finished bridge job, with only the result fields", async () => {
    await writeSpoolJson(spool.toWorker, WJOB, job());
    await finished(WJOB, "done", AMERICAN_EDITORIAL);
    await finished("local-poc-job", "done", AMERICAN_EDITORIAL); // not a bridge job
    expect(await exportBridgeResults(spool, dirs, outRoot)).toEqual({ exported: [WJOB], removed: [] });
    const written = JSON.parse(await readFile(join(spool.fromWorker, `${WJOB}.json`), "utf8")) as Record<string, unknown>;
    expect(Object.keys(written).sort()).toEqual(["error_code", "job_id", "outcome", "profile", "version", "worker_commit"]);
    expect(written).toMatchObject({ outcome: "ready", profile: PROFILE });
    const text = JSON.stringify(written);
    for (const leak of ["fixture", "CODEX_SAID_SOMETHING", "rounds", "timing", "instagram.com", "テスト工房"]) expect(text).not.toContain(leak);
    expect(await exportBridgeResults(spool, dirs, outRoot)).toEqual({ exported: [], removed: [] });
    expect((await stat(join(spool.fromWorker, `${WJOB}.json`))).mode & 0o777).toBe(0o640);
  });

  it("exports nothing for a job the bridge has closed, and removes its old result", async () => {
    await writeSpoolJson(spool.toWorker, WJOB, job());
    await finished(WJOB, "done", AMERICAN_EDITORIAL);
    await finished(WJOB2, "done", AMERICAN_EDITORIAL); // its job file was never (or no longer) in to-worker
    expect(await exportBridgeResults(spool, dirs, outRoot)).toEqual({ exported: [WJOB], removed: [] });
    const { rm } = await import("node:fs/promises");
    await rm(join(spool.toWorker, `${WJOB}.json`)); // the bridge delivered it
    expect(await exportBridgeResults(spool, dirs, outRoot)).toEqual({ exported: [], removed: [WJOB] });
    expect(await spoolIds(spool.fromWorker)).toEqual([]);
    expect(await exportBridgeResults(spool, dirs, outRoot)).toEqual({ exported: [], removed: [] });
  });
});

describe("bridge client", () => {
  type Call = { url: string; auth: string | null; body: Record<string, unknown> };
  let calls: Call[];
  let answers: Array<{ status: number; body: unknown }>;
  let lines: string[];
  let clock: Date;

  beforeEach(async () => {
    calls = [];
    answers = [];
    lines = [];
    clock = new Date("2026-10-10T00:00:00Z");
    await writeHeartbeat(spool.fromWorker, clock); // the worker is running
  });

  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const answer = answers.shift() ?? { status: 500, body: null };
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
  };
  const options = (): BridgeOptions => ({ spool, stateDir, apiUrl: "https://secondroot.example.com", token: TOKEN, fetch: fakeFetch, now: () => clock, log: (l) => lines.push(l) });
  const claimed = (jobId = JOB) => ({
    status: 200,
    body: { job: { jobId, workerJobId: workerJobIdFor(jobId), attempt: 1, facts: { name: "テスト工房", category: "bakery" }, source: { instagram_url: "https://www.instagram.com/example_shop/" } } },
  });
  const submitted = (jobId = JOB, replayed = false) => ({ status: 200, body: { result: { jobId, status: "ready", errorCode: null, attempts: 1, replayed } } });
  const resultFile = (id = WJOB, extra: Record<string, unknown> = {}) =>
    writeSpoolJson(spool.fromWorker, id, { version: 1, job_id: id, outcome: "ready", profile: PROFILE, error_code: null, worker_commit: "0123abcd", ...extra });

  it("claims one job, writes the worker's job file, and does not claim again while it is outstanding", async () => {
    answers.push(claimed());
    const first = await runBridgeOnce(options());
    expect(first).toMatchObject({ claimed: WJOB, stopped: null });
    expect(calls).toEqual([{ url: "https://secondroot.example.com/api/internal/sales-design/jobs", auth: `Bearer ${TOKEN}`, body: { action: "claim" } }]);
    expect(JSON.parse(await readFile(join(spool.toWorker, `${WJOB}.json`), "utf8"))).toEqual(job());
    expect(await runBridgeOnce(options())).toMatchObject({ claimed: null, stopped: null });
    expect(calls).toHaveLength(1);
    // the token is never written anywhere or logged
    for (const file of [join(spool.toWorker, `${WJOB}.json`), join(stateDir, "ledger.json")]) expect(await readFile(file, "utf8")).not.toContain(TOKEN);
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("delivers a result exactly once, with only the allowed fields, then claims the next job", async () => {
    answers.push(claimed());
    await runBridgeOnce(options());
    await resultFile();
    answers.push(submitted(), claimed(JOB2));
    const report = await runBridgeOnce(options());
    expect(report).toMatchObject({ delivered: [WJOB], claimed: WJOB2 });
    expect(calls[1]!.body).toEqual({ action: "submit", jobId: JOB, outcome: "ready", profile: PROFILE, errorCode: null, workerCommit: "0123abcd", lineage: { workerJobId: WJOB } });
    expect(await spoolIds(spool.toWorker)).toEqual([WJOB2]); // the delivered job's file is gone
    answers.push({ status: 500, body: null });
    await runBridgeOnce(options());
    expect(calls.map((c) => c.body.action)).toEqual(["claim", "submit", "claim"]); // not re-sent, no claim while JOB2 is out
  });

  describe("DEV-058: the review summary", () => {
    const review = { version: 1, verdict: "accept", total: 19, max: 25, scores: { brand_fit: 4, visual_quality: 4, hierarchy: 4, mobile_quality: 4, generic_template_feel: 3 }, rounds: 2, confidence: 0.72, qualityNotAccepted: false };
    const plain = { action: "submit", jobId: JOB, outcome: "ready", profile: PROFILE, errorCode: null, workerCommit: "0123abcd", lineage: { workerJobId: WJOB } };
    const sidecar = (id = WJOB, value: unknown = review) => writeFile(join(spool.fromWorker, `${id}.review.json`), JSON.stringify(value));
    const oldServer400 = { status: 400, body: { error: "invalid_request", issues: [{ path: "", code: "unrecognized_keys" }] } };
    const outstanding = async () => {
      answers.push(claimed());
      await runBridgeOnce(options());
      await resultFile();
    };

    it("sends the sidecar's summary with the result", async () => {
      await outstanding();
      await sidecar();
      answers.push(submitted(), { status: 200, body: { job: null } });
      expect(await runBridgeOnce(options())).toMatchObject({ delivered: [WJOB], stopped: null });
      expect(calls[1]!.body).toEqual({ ...plain, review });
    });

    it("an old-shape result with no sidecar (an older worker) goes without a review key", async () => {
      await outstanding();
      answers.push(submitted(), { status: 200, body: { job: null } });
      expect(await runBridgeOnce(options())).toMatchObject({ delivered: [WJOB] });
      expect(calls[1]!.body).toEqual(plain);
    });

    it("an invalid sidecar is dropped and the result still goes", async () => {
      await outstanding();
      await sidecar(WJOB, { ...review, note: "Codex said it is lovely" });
      answers.push(submitted(), { status: 200, body: { job: null } });
      expect(await runBridgeOnce(options())).toMatchObject({ delivered: [WJOB], refused: [] });
      expect(calls[1]!.body).toEqual(plain);
    });

    it("a server that predates the summary (400 on review): sent once more without it, then delivered", async () => {
      await outstanding();
      await sidecar();
      answers.push(oldServer400, submitted(), { status: 200, body: { job: null } });
      expect(await runBridgeOnce(options())).toMatchObject({ delivered: [WJOB], refused: [], stopped: null });
      expect(calls.slice(1, 3).map((c) => c.body)).toEqual([{ ...plain, review }, plain]);
      expect(lines).toContain(`result ${WJOB}: BRIDGE_REVIEW_DROPPED`);
      expect(lines.join("\n")).not.toMatch(/accept|19|brand_fit/);
    });

    it("a refused resubmit is refused as before; only one resubmit", async () => {
      await outstanding();
      await sidecar();
      answers.push(oldServer400, oldServer400, { status: 200, body: { job: null } });
      expect(await runBridgeOnce(options())).toMatchObject({ delivered: [], refused: [WJOB] });
      expect(calls.filter((c) => c.body.action === "submit")).toHaveLength(2);
    });

    it("a 400 on a submit without review is not retried", async () => {
      await outstanding();
      answers.push(oldServer400, { status: 200, body: { job: null } });
      expect(await runBridgeOnce(options())).toMatchObject({ refused: [WJOB] });
      expect(calls.filter((c) => c.body.action === "submit")).toHaveLength(1);
      expect(lines.join("\n")).not.toContain("BRIDGE_REVIEW_DROPPED");
    });

    it.each([
      ["another 400 (invalid_profile)", { status: 400, body: { error: "invalid_profile" } }, { refused: [WJOB] }],
      ["a 400 about another field", { status: 400, body: { error: "invalid_request", issues: [{ path: "profile", code: "custom" }] } }, { refused: [WJOB] }],
      ["401", { status: 401, body: { error: "unauthorized" } }, { stopped: "BRIDGE_UNAUTHORIZED" }],
      ["403", { status: 403, body: null }, { refused: [WJOB] }],
      ["503", { status: 503, body: null }, { stopped: "BRIDGE_DISABLED" }],
      ["500", { status: 500, body: null }, { stopped: "BRIDGE_API_UNAVAILABLE" }],
    ])("a submit with review answered %s is not resent without it", async (_label, answer, expected) => {
      await outstanding();
      await sidecar();
      answers.push(answer, { status: 200, body: { job: null } });
      expect(await runBridgeOnce(options())).toMatchObject(expected);
      expect(calls.filter((c) => c.body.action === "submit")).toHaveLength(1);
      expect(isReviewRejection(answer.status, answer.body)).toBe(false);
    });
  });

  it("drops a superseded or refused result and never sends results of jobs it did not claim", async () => {
    await resultFile(); // not in the ledger
    answers.push(claimed());
    expect(await runBridgeOnce(options())).toMatchObject({ delivered: [], claimed: WJOB });
    expect(calls.map((c) => c.body.action)).toEqual(["claim"]);
    answers.push({ status: 409, body: { error: "job_superseded" } }, { status: 200, body: { job: null } });
    expect(await runBridgeOnce(options())).toMatchObject({ superseded: [WJOB], stopped: null });
    expect(await spoolIds(spool.toWorker)).toEqual([]);
  });

  it("refuses a malformed result file without sending it", async () => {
    answers.push(claimed());
    await runBridgeOnce(options());
    await resultFile(WJOB, { screenshot: "iVBORw0KGgo=" });
    answers.push({ status: 200, body: { job: null } });
    expect(await runBridgeOnce(options())).toMatchObject({ refused: [WJOB] });
    expect(calls.map((c) => c.body.action)).toEqual(["claim", "claim"]);
  });

  it("turns a profile that cannot be drawn into a failure before sending", () => {
    const bad = { version: 1 as const, job_id: WJOB, outcome: "ready" as const, profile: { ...PROFILE, palette: { ...PROFILE.palette, text: PROFILE.palette.background } }, error_code: null, worker_commit: null };
    expect(submitBody(JOB, bad)).toMatchObject({ outcome: "failed", profile: null, errorCode: "PROFILE_INVALID" });
  });

  it("stops on auth / availability answers and keeps the result for the next run", async () => {
    answers.push(claimed());
    await runBridgeOnce(options());
    await resultFile();
    answers.push({ status: 401, body: { error: "unauthorized" } });
    expect(await runBridgeOnce(options())).toMatchObject({ stopped: "BRIDGE_UNAUTHORIZED", delivered: [] });
    answers.push({ status: 503, body: { error: "design_bridge_disabled" } });
    expect(await runBridgeOnce(options())).toMatchObject({ stopped: "BRIDGE_DISABLED" });
    answers.push(submitted(JOB, true), { status: 200, body: { job: null } });
    expect(await runBridgeOnce(options())).toMatchObject({ delivered: [WJOB], stopped: null });
  });

  it("stops on an answer that is not the agreed shape", async () => {
    answers.push({ status: 200, body: { job: { jobId: JOB, workerJobId: WJOB2, attempt: 1, facts: { name: "x", category: "cafe" }, source: { instagram_url: "https://www.instagram.com/x/" } } } });
    expect(await runBridgeOnce(options())).toMatchObject({ stopped: "BRIDGE_RESPONSE_INVALID", claimed: null });
    expect(await spoolIds(spool.toWorker)).toEqual([]);
  });

  it("expires a job the worker never answered, after the server's lease", async () => {
    answers.push(claimed());
    await runBridgeOnce(options());
    clock = new Date(clock.getTime() + LOCAL_EXPIRY_MS + 1000);
    await writeHeartbeat(spool.fromWorker, clock);
    answers.push(claimed(JOB2));
    expect(await runBridgeOnce(options())).toMatchObject({ expired: [WJOB], claimed: WJOB2 });
    expect(await spoolIds(spool.toWorker)).toEqual([WJOB2]);
  });

  it("deliver-only delivers a finished result and never claims the pending next job; a later --once may", async () => {
    answers.push(claimed());
    await runBridgeOnce(options());
    await resultFile();
    // The server has JOB2 pending: a claim would hand it out. deliver-only must not ask.
    answers.push(submitted(), claimed(JOB2));
    const report = await runBridgeOnce({ ...options(), mode: "deliver-only" });
    expect(report).toMatchObject({ delivered: [WJOB], claimed: null, workerIdle: false, stopped: null });
    expect(calls.map((c) => c.body.action)).toEqual(["claim", "submit"]);
    expect(await spoolIds(spool.toWorker)).toEqual([]); // no new job file for the worker
    const ledger = JSON.parse(await readFile(join(stateDir, "ledger.json"), "utf8")) as { jobs: Record<string, unknown> };
    expect(Object.keys(ledger.jobs)).toEqual([WJOB]);
    expect(lines.join("\n")).not.toContain(TOKEN);
    // Nothing left to deliver: still no claim.
    expect(await runBridgeOnce({ ...options(), mode: "deliver-only" })).toMatchObject({ delivered: [], claimed: null });
    expect(calls).toHaveLength(2);
    // The ordinary pass claims the next job.
    expect(await runBridgeOnce(options())).toMatchObject({ claimed: WJOB2 });
    expect(calls.map((c) => c.body.action)).toEqual(["claim", "submit", "claim"]);
    expect(await spoolIds(spool.toWorker)).toEqual([WJOB2]);
  });

  it("deliver-only still expires a job the worker never answered, and claims nothing", async () => {
    answers.push(claimed());
    await runBridgeOnce(options());
    clock = new Date(clock.getTime() + LOCAL_EXPIRY_MS + 1000);
    await writeHeartbeat(spool.fromWorker, clock);
    answers.push(claimed(JOB2));
    expect(await runBridgeOnce({ ...options(), mode: "deliver-only" })).toMatchObject({ expired: [WJOB], claimed: null });
    expect(calls).toHaveLength(1);
    expect(await spoolIds(spool.toWorker)).toEqual([]);
  });

  it("deliver-only keeps the fixed stops, and never reaches a claim-time stop", async () => {
    answers.push(claimed());
    await runBridgeOnce(options());
    await resultFile();
    answers.push({ status: 401, body: { error: "unauthorized" } });
    expect(await runBridgeOnce({ ...options(), mode: "deliver-only" })).toMatchObject({ stopped: "BRIDGE_UNAUTHORIZED", delivered: [], claimed: null });
    answers.length = 0;
    answers.push(submitted(), { status: 401, body: { error: "unauthorized" } }); // a claim would stop here
    expect(await runBridgeOnce({ ...options(), mode: "deliver-only" })).toMatchObject({ delivered: [WJOB], stopped: null, claimed: null });
    expect(calls.map((c) => c.body.action)).toEqual(["claim", "submit", "submit"]);
  });

  it("an unknown mode never claims, and only the two exact arguments name a mode", async () => {
    answers.push(claimed());
    expect(await runBridgeOnce({ ...options(), mode: "claim" as never })).toMatchObject({ claimed: null });
    expect(calls).toEqual([]);
    expect(bridgeModeFor(["--once"])).toBe("once");
    expect(bridgeModeFor(["--deliver-only"])).toBe("deliver-only");
    for (const args of [[], ["constructor"], ["__proto__"], ["toString"], ["--ONCE"], ["--once", "--once"]]) expect(bridgeModeFor(args)).toBeNull();
  });

  it("prints one fixed summary line per mode", () => {
    const report = { delivered: ["b-1"], superseded: [], refused: [], expired: [], claimed: null, workerIdle: false, stopped: null };
    expect(bridgeSummary(report, "deliver-only")).toBe("bridge: delivered 1, superseded 0, refused 0, expired 0, claimed none (BRIDGE_DELIVER_ONLY)");
    expect(bridgeSummary(report, "once")).toBe("bridge: delivered 1, superseded 0, refused 0, expired 0, claimed none");
    expect(bridgeSummary({ ...report, workerIdle: true }, "once")).toBe("bridge: delivered 1, superseded 0, refused 0, expired 0, claimed none (BRIDGE_WORKER_IDLE)");
    expect(bridgeSummary({ ...report, claimed: "b-2" }, "once")).toBe("bridge: delivered 1, superseded 0, refused 0, expired 0, claimed b-2");
  });

  it("claims nothing while the worker is not running (no heartbeat, or an old one)", async () => {
    const { rm } = await import("node:fs/promises");
    await rm(join(spool.fromWorker, "worker-heartbeat.json"));
    expect(await runBridgeOnce(options())).toMatchObject({ claimed: null, workerIdle: true, stopped: null });
    await writeHeartbeat(spool.fromWorker, new Date(clock.getTime() - WORKER_HEARTBEAT_MAX_MS - 1000));
    expect(await runBridgeOnce(options())).toMatchObject({ claimed: null, workerIdle: true });
    await writeHeartbeat(spool.fromWorker, new Date(clock.getTime() + 60 * 60 * 1000)); // from the future
    expect(await runBridgeOnce(options())).toMatchObject({ claimed: null, workerIdle: true });
    expect(calls).toEqual([]);
    await writeHeartbeat(spool.fromWorker, new Date(clock.getTime() - 30 * 60 * 1000));
    answers.push(claimed());
    expect(await runBridgeOnce(options())).toMatchObject({ claimed: WJOB, workerIdle: false });
  });

  it("passes only known fixed codes to the server", () => {
    const failed = { version: 1 as const, job_id: WJOB, outcome: "failed" as const, profile: null, error_code: "CALL_ME_AT_0123", worker_commit: null };
    expect(submitBody(JOB, failed)).toMatchObject({ errorCode: "WORKER_FAILED" });
    expect(submitBody(JOB, { ...failed, error_code: "CODEX_QUOTA" })).toMatchObject({ errorCode: "CODEX_QUOTA" });
  });

  it("only talks https (no credentials, query or redirect target in the URL)", () => {
    expect(bridgeEndpoint("https://secondroot.jp")).toBe("https://secondroot.jp/api/internal/sales-design/jobs");
    expect(bridgeEndpoint("https://secondroot.jp/anything")).toBe("https://secondroot.jp/api/internal/sales-design/jobs");
    for (const bad of ["http://secondroot.jp", "https://u:p@secondroot.jp", "https://secondroot.jp/?x=1", "file:///etc/passwd", "not a url"]) expect(() => bridgeEndpoint(bad)).toThrow();
    expect(() => bridgeEndpoint("http://127.0.0.1:3000")).toThrow();
    expect(bridgeEndpoint("http://127.0.0.1:3000", true)).toBe("http://127.0.0.1:3000/api/internal/sales-design/jobs");
  });
});

describe("bridge token file", () => {
  it("reads a private file of this user only", async () => {
    const path = join(base, "design-bridge.token");
    await writeFile(path, `${TOKEN}\n`, { mode: 0o600 });
    expect(await readTokenFile(path)).toBe(TOKEN);
    await chmod(path, 0o640);
    await expect(readTokenFile(path)).rejects.toMatchObject({ code: "BRIDGE_TOKEN_UNSAFE" });
    await chmod(path, 0o600);
    await expect(readTokenFile(path, 12345)).rejects.toMatchObject({ code: "BRIDGE_TOKEN_UNSAFE" });
    await writeFile(path, "short", { mode: 0o600 });
    await expect(readTokenFile(path)).rejects.toMatchObject({ code: "BRIDGE_TOKEN_UNSAFE" });
    const linked = join(base, "linked.token");
    await symlink(path, linked);
    await expect(readTokenFile(linked)).rejects.toMatchObject({ code: "BRIDGE_TOKEN_UNSAFE" });
    await expect(readTokenFile(join(base, "missing"))).rejects.toMatchObject({ code: "BRIDGE_NOT_CONFIGURED" });
  });
});

describe("the worker never gets the bridge token", () => {
  it("child processes of the worker do not inherit any Sales or bridge secret", () => {
    const env = childEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/sr-designgen",
      SALES_DESIGN_BRIDGE_TOKEN: TOKEN,
      SR_DESIGN_BRIDGE_TOKEN_FILE: "/home/sr-designbridge/.config/second-root/design-bridge.token",
      SR_DESIGN_BRIDGE_API_URL: "https://secondroot.jp",
      SALES_AGENT_INGEST_TOKEN: TOKEN,
      SUPABASE_SERVICE_ROLE_KEY: TOKEN,
      SR_DESIGN_BRIDGE_SPOOL: "/srv/sr-design-bridge",
    });
    expect(Object.keys(env).filter((k) => /TOKEN|SALES_|SUPABASE|BRIDGE/.test(k))).toEqual([]);
    expect(JSON.stringify(env)).not.toContain(TOKEN);
  });

  it("the worker's run.sh keeps only the spool path of the bridge, never a token or the API URL", async () => {
    const runSh = await readFile(join(process.cwd(), "scripts/sales-design-worker/run.sh"), "utf8");
    const keep = /for name in ([\s\S]*?); do/.exec(runSh)![1]!.split(/[\s\\]+/).filter(Boolean);
    expect(keep).toContain("SR_DESIGN_BRIDGE_SPOOL");
    expect(keep.filter((n) => /TOKEN|SECRET|KEY|SALES_|SUPABASE|BRIDGE_API|BRIDGE_TOKEN/.test(n))).toEqual([]);
  });

  it("bridge.ts takes exactly one of --once / --deliver-only, and passes the mode to the run", async () => {
    const { spawn, spawnSync } = await import("node:child_process");
    const { createServer } = await import("node:net");
    const tsx = join(process.cwd(), "node_modules/.bin/tsx");
    const script = join(process.cwd(), "scripts/sales-design-bridge/bridge.ts");
    // One refused argument end to end; the full set of refused arguments is checked in-process (bridgeModeFor).
    const refused = spawnSync(tsx, [script, "constructor"], { env: { PATH: process.env.PATH ?? "", HOME: base } as unknown as NodeJS.ProcessEnv, encoding: "utf8", timeout: 20_000 });
    expect(refused.status).toBe(2);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("usage: bridge.ts --once | --deliver-only");
    // Configured, with a running worker and nothing outstanding, against a local port that drops every
    // connection at once (no network): --once tries to claim and stops; --deliver-only never asks.
    const refuser = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => refuser.listen(0, "127.0.0.1", resolve));
    const port = (refuser.address() as { port: number }).port;
    const tokenFile = join(base, "bridge.token");
    await writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
    await writeHeartbeat(spool.fromWorker, new Date());
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: base,
      XDG_STATE_HOME: join(base, "xdg"),
      SR_DESIGN_BRIDGE_API_URL: `https://127.0.0.1:${port}`,
      SR_DESIGN_BRIDGE_TOKEN_FILE: tokenFile,
      SR_DESIGN_BRIDGE_SPOOL: join(base, "spool"),
    } as unknown as NodeJS.ProcessEnv;
    // Spawned asynchronously, so this process keeps serving the local port.
    const runBridge = (mode: string) =>
      new Promise<{ status: number | null; signal: string | null; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(tsx, [script, mode], { env, timeout: 20_000 });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += String(d)));
        child.stderr.on("data", (d) => (stderr += String(d)));
        child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
      });
    let deliverOnly, once;
    try {
      deliverOnly = await runBridge("--deliver-only");
      once = await runBridge("--once");
    } finally {
      refuser.close();
    }
    expect(deliverOnly.signal).toBeNull();
    expect(once.signal).toBeNull(); // not killed by the time limit
    expect(deliverOnly.stdout).toBe("bridge: delivered 0, superseded 0, refused 0, expired 0, claimed none (BRIDGE_DELIVER_ONLY)\n");
    expect(deliverOnly.status).toBe(0);
    expect(await spoolIds(spool.toWorker)).toEqual([]);
    expect(once.stdout).toContain("stopped: BRIDGE_API_UNAVAILABLE"); // it asked for a job
    expect(once.status).toBe(3);
    for (const out of [deliverOnly.stdout, deliverOnly.stderr, once.stdout, once.stderr]) expect(out).not.toContain(TOKEN);
  }, 60_000);

  it("the bridge's run.sh keeps no token variable and refuses the worker and helper users", async () => {
    const runSh = await readFile(join(process.cwd(), "scripts/sales-design-bridge/run.sh"), "utf8");
    const keep = /for name in ([\s\S]*?); do/.exec(runSh)![1]!.split(/[\s\\]+/).filter(Boolean);
    expect(keep.filter((n) => /TOKEN(?!_FILE)|SECRET|KEY|SALES_|SUPABASE/.test(n))).toEqual([]);
    expect(runSh).toMatch(/root \| sr-designgen \| sr-igcapture\)/);
    expect(runSh).not.toMatch(/git (fetch|checkout|pull)|npm (ci|install)/);
  });

  it("the systemd units run as the bridge user, keep no secret, and nothing in the repository enables them", async () => {
    const service = await readFile(join(process.cwd(), "scripts/sales-design-bridge/systemd/sr-design-bridge.service"), "utf8");
    const timer = await readFile(join(process.cwd(), "scripts/sales-design-bridge/systemd/sr-design-bridge.timer"), "utf8");
    expect(service).toMatch(/^User=sr-designbridge$/m);
    expect(service).not.toMatch(/sr-designgen|sr-igcapture/);
    for (const setting of ["NoNewPrivileges=yes", "ProtectSystem=strict", "ProtectHome=read-only", "PrivateTmp=yes", "ReadOnlyPaths=/srv/sr-design-bridge/from-worker", "UMask=0077"]) {
      expect(service).toContain(setting);
    }
    expect(service).not.toMatch(/^Environment=.*(TOKEN|SECRET|KEY)/m);
    expect(timer).toMatch(/OnUnitActiveSec=10min/);
    const { spawnSync } = await import("node:child_process");
    // git grep: exit 1 = no match (what we want), 0 = a match, anything else = could not search.
    const grep = spawnSync("git", ["grep", "--untracked", "-l", "-E", "systemctl (--user )?(enable|start).*sr-design-bridge", "--", ":!docs", ":!tests"], { encoding: "utf8" });
    expect({ status: grep.status, hits: grep.stdout.trim() }).toEqual({ status: 1, hits: "" });
  });
});
