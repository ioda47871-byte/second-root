/**
 * Second Root design worker (DEV-028 worker): one run over the local job
 * queue, unattended, on the dedicated WSL user. Same shape as the Kaii
 * Dokuhon image worker (curiosity-media entry-image-worker.ts, D-141):
 * lock → clean up → recover → per job: capture → Codex → render → review →
 * final → record; fixed-message codes only; environment failures stop the
 * run without counting against a job.
 *
 * Per job:
 *   1. claim (inbox → processing, atomic rename) and validate the job
 *   2. idempotency: a job id with a result is never run again
 *   3. capture the public Instagram profile (logged out) into the run's temp
 *      root; PUBLIC_SOURCE_UNAVAILABLE is an expected outcome
 *   4. check the screenshots, run the design pipeline (Codex brief, render,
 *      Codex review, at most 2 profile revisions, BLOCKED / fallback)
 *   5. write the run directory (the record), delete the screenshots, copy the
 *      allowlisted files to Windows (best effort), move the job to done/
 *
 * The worker never commits, pushes, opens PRs, touches a database or
 * changes renderer code.
 */
import { lstatSync, renameSync, rmSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser } from "playwright";
import { DeadlineError, killAllBoundedChildren, type RunDeadline } from "../bounded-process";
import { assertChatGptSignIn, CodexError, removeStaleCodexSessions, runCodexJson } from "../codex";
import { runDesignPipeline, type PipelineReport, type Shots } from "../pipeline";
import { factsToDemoView } from "../preview";
import { looseJsonSchema } from "../profile";
import { capturePublicProfile, instagramTarget, type CaptureTarget } from "./capture";
import { childEnvironment } from "./env";
import { copyToWindows, exportFiles, type WindowsCopy } from "./export";
import { checkReferenceImages } from "./images";
import { codeOf, ENVIRONMENT_CODES, publicMessage } from "./messages";
import { claimNext, ensureQueue, finishJob, hasFinished, inboxCount, inspectProcessing, pickFacts, queueDirs, readJob, requeueJob, type QueueDirs } from "./queue";
import { parseInstagramProfileUrl, type ProfileSource } from "./source-url";
import { acquireLock, readLedger, writeJsonAtomic, writeLedger, type Holder, type Ledger } from "./state";
import { cleanStaleTemp, createTempRoot, removeTempRoot } from "./temp";

export const RUN_TIME_BUDGET_MS = 50 * 60 * 1000;
export const MAX_JOB_ATTEMPTS = 2;
export const DEFAULT_MAX_JOBS = 1;
const BRIEF_TIMEOUT_MS = 15 * 60 * 1000;
const REVIEW_TIMEOUT_MS = 10 * 60 * 1000;
const MIN_LONG_CALL_MS = 60 * 1000;

export interface Renderer {
  /** Screenshots of /design-preview/<runId>?profile=<candidate> into shotsDir. */
  render(runId: string, candidate: string, shotsDir: string): Promise<{ shots: Shots; overflow: string[] }>;
}

export interface PreviewSession {
  renderer: Renderer;
  stop(): Promise<void>;
}

export interface WorkerOptions {
  stateDir: string;
  queueRoot: string;
  /** Run directories: <outRoot>/<job_id>/ (the record). */
  outRoot: string;
  /** Where the temp root is made (os.tmpdir() of the worker). */
  tmpBase: string;
  /** Windows-visible folder for the best-effort copy; unset = unavailable. */
  exportDir?: string;
  workerSha: string;
  maxJobs?: number;
  deadline: RunDeadline;
  /** The worker's own environment; children get childEnvironment(env). */
  env: Record<string, string | undefined>;
  codexBin?: string;
  now?: () => Date;
  log?: (line: string) => void;
  /** A fresh, non-persistent browser for the Instagram capture. */
  launchBrowser: (env: NodeJS.ProcessEnv) => Promise<Browser>;
  /** Builds the app and starts the local preview (only when there is work). */
  startPreview: (options: { previewRoot: string; env: NodeJS.ProcessEnv; deadline: RunDeadline }) => Promise<PreviewSession>;
  /**
   * Tests only: capture target for a job's source (a local mock). Production
   * code never passes it, so the capture opens only instagramTarget(source).
   */
  captureTargetFor?: (source: ProfileSource) => CaptureTarget;
  captureSettleMs?: number;
}

export type JobOutcome =
  | { jobId: string; status: "done"; outcome: string; windowsCopy: WindowsCopy | null; recovered?: true }
  | { jobId: string; status: "failed"; code: string; message: string }
  | { jobId: string; status: "retry"; code: string; message: string };

export type WorkerReport =
  | { status: "locked" }
  | { status: "idle"; recovered: string[] }
  | { status: "finished"; workerSha: string; jobs: JobOutcome[]; recovered: string[] }
  | { status: "stopped"; code: string; message: string; jobs: JobOutcome[] };

/** The job this process is working on, for signal handlers (abandonActiveJobSync). */
let active: { dirs: QueueDirs; jobId: string; runDir: string } | null = null;

/**
 * For a stop by signal (a person or systemd stopping the run): puts the job
 * being worked on back in the inbox, not counted as an attempt, and removes
 * its unfinished run directory. A job whose report.json exists, or whose id
 * already waits in the inbox again, is left in processing for recovery.
 * (An unexpected crash or the watchdog does not call this: the job stays in
 * processing and recovery counts it, so a job that always breaks the run
 * ends in failed/.)
 */
export function abandonActiveJobSync(): void {
  const job = active;
  active = null;
  if (!job) return;
  try {
    lstatSync(join(job.dirs.inbox, `${job.jobId}.json`));
    return;
  } catch {
    /* no newer copy waiting */
  }
  try {
    lstatSync(join(job.runDir, "report.json"));
    return;
  } catch {
    /* unfinished */
  }
  try {
    rmSync(job.runDir, { recursive: true, force: true });
    renameSync(join(job.dirs.processing, `${job.jobId}.json`), join(job.dirs.inbox, `${job.jobId}.json`));
    rmSync(join(job.dirs.processing, `${job.jobId}.claim.json`), { force: true });
  } catch {
    /* recovery on the next run handles it */
  }
}

class StopRun extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

async function resultComplete(outRoot: string, jobId: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(outRoot, jobId, "report.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function runDesignWorker(options: WorkerOptions): Promise<WorkerReport> {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => undefined);
  let lock: Awaited<ReturnType<typeof acquireLock>>;
  try {
    lock = await acquireLock(options.stateDir, now());
  } catch (error) {
    const code = codeOf(error);
    return { status: "stopped", code, message: publicMessage(code), jobs: [] };
  }
  if (lock === undefined) {
    log("another worker holds the lock; nothing to do");
    return { status: "locked" };
  }
  const previousTmp = process.env.TMPDIR;
  let tempRoot: string | undefined;
  try {
    const removed = await cleanStaleTemp(options.tmpBase, now());
    if (removed.length > 0) log(`removed ${removed.length} stale temporary director${removed.length === 1 ? "y" : "ies"}`);
    // Session logs of Codex calls a stopped run could not clean up (they can hold the screenshots).
    const sessions = await removeStaleCodexSessions(options.env).catch(() => 0);
    if (sessions > 0) log(`removed ${sessions} leftover Codex session log${sessions === 1 ? "" : "s"}`);
    tempRoot = await createTempRoot(options.tmpBase, lock.holder);
    // Browser profiles, screenshots and Codex scratch dirs all go inside.
    process.env.TMPDIR = tempRoot;
    return await runLocked(options, lock.holder, tempRoot, now, log);
  } catch (error) {
    const code = error instanceof StopRun ? error.code : codeOf(error);
    log(`run stopped: ${code}`);
    return { status: "stopped", code, message: publicMessage(code), jobs: [] };
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    killAllBoundedChildren();
    if (tempRoot) await removeTempRoot(tempRoot);
    await lock.release().catch(() => undefined);
  }
}

async function runLocked(options: WorkerOptions, holder: Holder, tempRoot: string, now: () => Date, log: (line: string) => void): Promise<WorkerReport> {
  const dirs = queueDirs(options.queueRoot);
  await ensureQueue(dirs);
  await mkdir(options.outRoot, { recursive: true, mode: 0o700 });
  const ledger = await readLedger(options.stateDir);
  const saveLedger = () => writeLedger(options.stateDir, ledger);

  // ---- recover jobs a stopped worker left in processing/
  const recovered: string[] = [];
  for (const entry of await inspectProcessing(dirs, now())) {
    if (!entry.stale) {
      log(`job ${entry.jobId}: held by a live worker; left alone`);
      continue;
    }
    recovered.push(entry.jobId);
    const report = await resultComplete(options.outRoot, entry.jobId);
    if (report && !(await hasFinished(dirs, entry.jobId))) {
      await finishJob(dirs, entry.jobId, "done", { outcome: report.outcome ?? null, recovered: true, at: now().toISOString() });
      log(`job ${entry.jobId}: already had a result; moved to done (${entry.reason})`);
      continue;
    }
    const attempts = bump(ledger, entry.jobId, "WORKER_JOB_STALE", now());
    if (attempts >= MAX_JOB_ATTEMPTS) {
      await finishJob(dirs, entry.jobId, "failed", { code: "WORKER_JOB_STALE", message: publicMessage("WORKER_JOB_STALE"), at: now().toISOString() });
      log(`job ${entry.jobId}: stale ${attempts} times → failed`);
    } else {
      await requeueJob(dirs, entry.jobId);
      log(`job ${entry.jobId}: stale (${entry.reason}) → back to inbox`);
    }
  }
  await saveLedger();

  if ((await inboxCount(dirs)) === 0) {
    log("no jobs in the inbox");
    return { status: "idle", recovered };
  }

  // ---- environment: Codex signed in with ChatGPT, no API key anywhere
  const childEnv = () => childEnvironment({ ...options.env, TMPDIR: tempRoot });
  const codexBin = options.codexBin ?? "codex";
  try {
    await assertChatGptSignIn({ codexBin, env: childEnv(), cwd: tempRoot });
  } catch (error) {
    throw new StopRun(codeOf(error));
  }

  let session: PreviewSession | undefined;
  const jobs: JobOutcome[] = [];
  const attempted = new Set<string>();
  try {
    try {
      session = await options.startPreview({ previewRoot: options.outRoot, env: childEnv(), deadline: options.deadline });
    } catch (error) {
      const code = codeOf(error);
      throw new StopRun(code === "RUN_TIME_BUDGET" || ENVIRONMENT_CODES.has(code) ? code : "WORKER_BUILD_FAILED");
    }
    const maxJobs = options.maxJobs ?? DEFAULT_MAX_JOBS;
    while (jobs.length < maxJobs) {
      if (options.deadline.remainingMs() < 10 * 60 * 1000) {
        log("not enough time left for another job");
        break;
      }
      const claimed = await claimNext(dirs, holder, attempted);
      if (!claimed) break;
      attempted.add(claimed.jobId);
      log(`job ${claimed.jobId}: claimed`);
      active = { dirs, jobId: claimed.jobId, runDir: join(options.outRoot, claimed.jobId) };
      const outcome = await runJob({ options, dirs, jobId: claimed.jobId, path: claimed.path, session, tempRoot, childEnv, codexBin, ledger, now, log }).finally(() => {
        active = null;
      });
      await saveLedger();
      if ("stop" in outcome) {
        jobs.push({ jobId: claimed.jobId, status: "retry", code: outcome.stop, message: publicMessage(outcome.stop) });
        log(`run stopped: ${outcome.stop}`);
        return { status: "stopped", code: outcome.stop, message: publicMessage(outcome.stop), jobs };
      }
      jobs.push(outcome);
    }
    return { status: "finished", workerSha: options.workerSha, jobs, recovered };
  } finally {
    await session?.stop().catch(() => undefined);
  }
}

function bump(ledger: Ledger, jobId: string, code: string, at: Date): number {
  const entry = ledger.jobs[jobId] ?? { attempts: 0, lastCode: code, lastAt: at.toISOString() };
  entry.attempts += 1;
  entry.lastCode = code;
  entry.lastAt = at.toISOString();
  ledger.jobs[jobId] = entry;
  return entry.attempts;
}

type JobContext = {
  options: WorkerOptions;
  dirs: QueueDirs;
  jobId: string;
  path: string;
  session: PreviewSession;
  tempRoot: string;
  childEnv: () => NodeJS.ProcessEnv;
  codexBin: string;
  ledger: Ledger;
  now: () => Date;
  log: (line: string) => void;
};

async function runJob(ctx: JobContext): Promise<JobOutcome | { stop: string }> {
  const { options, dirs, jobId, now, log } = ctx;
  const fail = async (code: string): Promise<JobOutcome> => {
    await finishJob(dirs, jobId, "failed", { code, message: publicMessage(code), at: now().toISOString() });
    delete ctx.ledger.jobs[jobId];
    log(`job ${jobId}: failed (${code})`);
    return { jobId, status: "failed", code, message: publicMessage(code) };
  };

  // ---- validate (never retried: the file itself is wrong)
  const job = await readJob(ctx.path);
  if (!job || job.job_id !== jobId) return fail("JOB_INVALID");
  const source = parseInstagramProfileUrl(job.source.instagram_url);
  if (!source) return fail("SOURCE_URL_INVALID");
  const facts = pickFacts(job.facts);
  const demo = factsToDemoView(facts);
  if (!demo) return fail("FACTS_INVALID");

  // ---- idempotency: one result per job id
  if (await hasFinished(dirs, jobId)) return fail("DUPLICATE_JOB_ID");
  const existing = await resultComplete(options.outRoot, jobId);
  if (existing) {
    await finishJob(dirs, jobId, "done", { outcome: existing.outcome ?? null, recovered: true, at: now().toISOString() });
    log(`job ${jobId}: already had a result; moved to done`);
    return { jobId, status: "done", outcome: String(existing.outcome ?? "unknown"), windowsCopy: null, recovered: true };
  }

  const runDir = join(options.outRoot, jobId);
  const jobTemp = join(ctx.tempRoot, `job-${jobId}`);
  const refsDir = join(jobTemp, "refs");
  const startedAt = now().toISOString();
  let tempDeleted = false;
  try {
    // A run directory without report.json is an interrupted attempt of this
    // same job: start it again from nothing.
    const info = await lstat(runDir).catch(() => null);
    if (info?.isSymbolicLink()) return fail("WORKER_SYSTEM_ERROR");
    await rm(runDir, { recursive: true, force: true });
    await mkdir(join(runDir, "shots"), { recursive: true, mode: 0o700 });
    await writeFile(join(runDir, "facts.json"), JSON.stringify(facts, null, 2), { mode: 0o600 });
    await mkdir(refsDir, { recursive: true, mode: 0o700 });

    // ---- capture
    const target = options.captureTargetFor ? options.captureTargetFor(source) : instagramTarget(source);
    const capture = await capturePublicProfile({
      target,
      outDir: refsDir,
      launch: () => options.launchBrowser(ctx.childEnv()),
      settleMs: options.captureSettleMs,
    });
    if (capture.status === "retry") {
      // A network error or a browser failure says nothing about the profile.
      log(`job ${jobId}: capture failed (${capture.reason}); tried again later`);
      throw Object.assign(new Error(capture.reason), { code: "SOURCE_CAPTURE_FAILED" });
    }
    if (capture.status === "PUBLIC_SOURCE_UNAVAILABLE") {
      log(`job ${jobId}: PUBLIC_SOURCE_UNAVAILABLE (${capture.reason})`);
      await rm(jobTemp, { recursive: true, force: true });
      tempDeleted = !(await exists(jobTemp));
      const report = {
        ...baseReport(options, jobId, startedAt, now),
        outcome: "PUBLIC_SOURCE_UNAVAILABLE",
        instagram: { status: "unavailable", reason: capture.reason, images: 0, temp_deleted: tempDeleted },
        codex: null,
      };
      return await complete(ctx, runDir, report);
    }
    log(`job ${jobId}: instagram captured (${capture.files.length} image${capture.files.length === 1 ? "" : "s"})`);
    const problem = await checkReferenceImages(capture.files);
    if (problem) throw Object.assign(new Error(problem), { code: "REFERENCE_CHECK_FAILED" });

    // ---- design pipeline
    const notes: string[] = [];
    const overflow: string[] = [];
    // Every job starts with the strict schema. If the CLI refuses it (it
    // fails, or answers without JSON), that one call is retried once with the
    // loose schema and the rest of the job (brief and reviews) uses the loose
    // schema from the start. Answers are always checked against the full zod
    // schemas (and the palette checks) by the pipeline, whichever was sent.
    let schemaMode: "strict" | "loose" = "strict";
    const pipeline: PipelineReport = await runDesignPipeline(
      { demo, references: capture.files },
      {
        askCodex: async ({ kind, prompt, images, schema }) => {
          const limit = kind === "brief" ? BRIEF_TIMEOUT_MS : REVIEW_TIMEOUT_MS;
          // The time left is read again for each call, so a retry never overruns the run.
          const ask = (s: object) =>
            runCodexJson({ prompt, images, schema: s, codexBin: ctx.codexBin, env: ctx.childEnv(), timeoutMs: options.deadline.timeoutFor(limit, MIN_LONG_CALL_MS) });
          if (schemaMode === "loose") return ask(looseJsonSchema(schema));
          try {
            return await ask(schema);
          } catch (error) {
            // Only a refused schema falls back; any other failure (timeout,
            // quota, sign-in) is reported as it is. One retry, never more.
            if (!(error instanceof CodexError) || (error.code !== "CODEX_EXEC_FAILED" && error.code !== "CODEX_NO_JSON")) throw error;
            schemaMode = "loose";
            notes.push(`SCHEMA_LOOSE_AFTER_${kind.toUpperCase()}_${error.code}`);
            log(`job ${jobId}: ${kind} ${error.code} with the strict schema; loose schema from here on`);
            return ask(looseJsonSchema(schema));
          }
        },
        writeProfile: (name, profile) => writeFile(join(runDir, `${name}.json`), JSON.stringify(profile, null, 2), { mode: 0o600 }),
        writeRecord: (name, value) => writeFile(join(runDir, name), JSON.stringify(value, null, 2), { mode: 0o600 }),
        render: async (candidate) => {
          const result = await ctx.session.renderer.render(jobId, candidate, join(runDir, "shots"));
          overflow.push(...result.overflow);
          return result.shots;
        },
        log: (line) => log(`job ${jobId}: ${line}`),
      },
    );

    // ---- the screenshots of the shop are not needed any more
    await rm(jobTemp, { recursive: true, force: true });
    tempDeleted = !(await exists(jobTemp));

    if (pipeline.status === "environment_failure") {
      const code = pipeline.notes.map((n) => n.replace(/^REVIEW_/, "")).find((n) => ENVIRONMENT_CODES.has(n)) ?? "CODEX_QUOTA";
      await rm(runDir, { recursive: true, force: true });
      await requeueJob(dirs, jobId);
      return { stop: code };
    }
    if (pipeline.after) {
      await copyFile(pipeline.before.desktop, join(runDir, "before-desktop.png"));
      await copyFile(pipeline.before.mobile, join(runDir, "before-mobile.png"));
      await copyFile(pipeline.after.desktop, join(runDir, "after-desktop.png"));
      await copyFile(pipeline.after.mobile, join(runDir, "after-mobile.png"));
    } else {
      await copyFile(pipeline.before.desktop, join(runDir, "before-desktop.png"));
      await copyFile(pipeline.before.mobile, join(runDir, "before-mobile.png"));
    }
    const final = pipeline.finalCandidate ? await readFile(join(runDir, "final.json"), "utf8").then((t) => JSON.parse(t) as Record<string, unknown>).catch(() => null) : null;
    const report = {
      ...baseReport(options, jobId, startedAt, now),
      outcome: pipeline.status,
      instagram: { status: "captured", images: capture.files.length, media_softened: capture.softened, temp_deleted: tempDeleted },
      codex: {
        status: pipeline.status,
        profile_source: pipeline.profileSource,
        direction: final?.direction ?? null,
        confidence: final?.confidence ?? null,
        brief_confidence: pipeline.briefConfidence,
        reviews: pipeline.rounds.length,
        revisions: pipeline.revisions,
        rounds: pipeline.rounds,
        final_candidate: pipeline.finalCandidate,
        fallback: pipeline.status === "fallback_template",
        blocked: pipeline.status === "blocked",
        renderer_change_needed: pipeline.notes.includes("RENDERER_CHANGE_NEEDED"),
        schema_mode: schemaMode,
        notes: [...notes, ...pipeline.notes],
      },
      overflow,
    };
    return await complete(ctx, runDir, report);
  } catch (error) {
    const code = error instanceof DeadlineError ? "WORKER_RUN_TIME_BUDGET" : codeOf(error);
    // Once report.json exists the run directory is the record: never delete
    // it. Only the move to done/ is left, which recovery can also do.
    if (await exists(join(runDir, "report.json"))) {
      log(`job ${jobId}: recorded, but finishing failed (${code})`);
      await finishJob(dirs, jobId, "done", { outcome: "recorded", recovered: true, at: now().toISOString() }).catch(() => undefined);
      return { stop: ENVIRONMENT_CODES.has(code) ? code : "WORKER_SYSTEM_ERROR" };
    }
    await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
    if (ENVIRONMENT_CODES.has(code)) {
      await requeueJob(dirs, jobId).catch(() => undefined);
      return { stop: code };
    }
    const attempts = bump(ctx.ledger, jobId, code, now());
    log(`job ${jobId}: ${code} (attempt ${attempts})`);
    if (attempts >= MAX_JOB_ATTEMPTS) return fail(code === "REFERENCE_CHECK_FAILED" ? code : "WORKER_JOB_FAILED");
    await requeueJob(dirs, jobId);
    return { jobId, status: "retry", code, message: publicMessage(code) };
  } finally {
    await rm(jobTemp, { recursive: true, force: true }).catch(() => undefined);
  }
}

function baseReport(options: WorkerOptions, jobId: string, startedAt: string, now: () => Date) {
  return {
    version: 1,
    job_id: jobId,
    run_id: jobId,
    worker: { commit: options.workerSha },
    started_at: startedAt,
    finished_at: now().toISOString(),
  };
}

/**
 * Writes report.json (the completion marker, written last and atomically),
 * then copies to Windows (best effort) and moves the job to done/.
 */
async function complete(ctx: JobContext, runDir: string, report: Record<string, unknown>): Promise<JobOutcome> {
  const { options, dirs, jobId, now, log } = ctx;
  const names = await exportFiles(runDir);
  let windowsCopy = await copyToWindows(runDir, options.exportDir, jobId, names);
  const full = { ...report, windows_copy: windowsCopy };
  await writeJsonAtomic(join(runDir, "report.json"), full);
  if (windowsCopy === "success") {
    windowsCopy = await copyToWindows(runDir, options.exportDir, jobId, ["report.json"]);
    if (windowsCopy !== "success") await writeJsonAtomic(join(runDir, "report.json"), { ...report, windows_copy: windowsCopy });
  }
  const outcome = String(report.outcome);
  await finishJob(dirs, jobId, "done", { outcome, run_dir: runDir, worker_commit: options.workerSha, windows_copy: windowsCopy, at: now().toISOString() });
  delete ctx.ledger.jobs[jobId];
  log(`job ${jobId}: ${outcome}; windows copy ${windowsCopy}`);
  return { jobId, status: "done", outcome, windowsCopy };
}
