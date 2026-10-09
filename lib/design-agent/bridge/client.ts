/**
 * The local design bridge (DEV-030): one run of `design-bridge --once`, as
 * its own Linux user (sr-designbridge), outside the worker's jail. It is the
 * only local process that holds the bridge API token, and it talks to two
 * things only: the Second Root bridge API and the file spool.
 *
 *   1. deliver: every new worker result (from-worker/) whose job this bridge
 *      handed out is checked again and submitted. Delivered, superseded and
 *      refused results are not sent again (ledger).
 *   2. expire: a job the worker has not answered within the lease is dropped
 *      here too (its job file removed); the server hands it out again.
 *   3. claim: when no job is outstanding and the worker is running
 *      regularly (its heartbeat is recent), ask for one and write it to
 *      to-worker/ as the worker's job file. With the worker stopped, nothing
 *      is claimed, so no job uses up its lease and attempts while waiting.
 *
 * Output is fixed codes only. The token is read from a file owned by this
 * user (0600), never from the environment, and nothing is started as a child
 * process, so it cannot be inherited by anything.
 */
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkProfile } from "../profile";
import { DESIGN_LEASE_SECONDS } from "../../sales/design";
import { ClaimResponseSchema, SubmitResponseSchema, workerJobIdFor, type DesignJob } from "../../sales/design-bridge-schema";
import { MAX_RESULT_BYTES, readHeartbeat, readSpoolJson, resultCode, spoolIds, writeSpoolJson, WorkerResultSchema, type BridgeSpool, type WorkerResult } from "./spool";

export const MIN_TOKEN_LENGTH = 32;
/** Kept a little longer than the server's lease, so the server always gives up first. */
export const LOCAL_EXPIRY_MS = (DESIGN_LEASE_SECONDS + 15 * 60) * 1000;
/** Finished ledger entries are kept this long, so a late duplicate result is still recognised. */
const LEDGER_KEEP_MS = 14 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;
/** A worker heartbeat older than this means the worker is not running often enough to take a job within its lease. */
export const WORKER_HEARTBEAT_MAX_MS = 90 * 60 * 1000;

export type BridgeCode =
  | "BRIDGE_NOT_CONFIGURED"
  | "BRIDGE_TOKEN_UNSAFE"
  | "BRIDGE_API_UNSAFE"
  | "BRIDGE_UNAUTHORIZED"
  | "BRIDGE_DISABLED"
  | "BRIDGE_API_UNAVAILABLE"
  | "BRIDGE_RESPONSE_INVALID"
  | "BRIDGE_SPOOL_INVALID";

export class BridgeError extends Error {
  constructor(readonly code: BridgeCode) {
    super(code);
  }
}

type LedgerEntry = {
  jobId: string;
  claimedAt: string;
  /** delivered = the server took it (or replayed it); superseded / refused = the server will never take it. */
  closed?: { at: string; as: "delivered" | "superseded" | "refused" | "expired" };
};
export type Ledger = { version: 1; jobs: Record<string, LedgerEntry> };

export type BridgeOptions = {
  spool: BridgeSpool;
  stateDir: string;
  apiUrl: string;
  token: string;
  fetch?: typeof fetch;
  now?: () => Date;
  log?: (line: string) => void;
  /** Tests only: allow http://127.0.0.1 / localhost. Production requires https. */
  allowLocalHttp?: boolean;
};

export type BridgeReport = {
  delivered: string[];
  superseded: string[];
  refused: string[];
  expired: string[];
  claimed: string | null;
  /** No claim because the worker has not run recently (BRIDGE_WORKER_IDLE). */
  workerIdle: boolean;
  stopped: BridgeCode | null;
};

/** The bridge API URL: https only (a local http URL only in tests), no credentials, query or fragment. */
export function bridgeEndpoint(base: string, allowLocalHttp = false): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new BridgeError("BRIDGE_API_UNSAFE");
  }
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(allowLocalHttp && local && url.protocol === "http:")) throw new BridgeError("BRIDGE_API_UNSAFE");
  if (url.username || url.password || url.search || url.hash) throw new BridgeError("BRIDGE_API_UNSAFE");
  return `${url.origin}/api/internal/sales-design/jobs`;
}

/**
 * Reads the token file: a regular file (no link) owned by this user, not
 * readable by anyone else, at most 512 bytes, one token of 32+ visible
 * characters.
 */
export async function readTokenFile(path: string, uid: number = process.getuid?.() ?? -1): Promise<string> {
  const info = await lstat(path).catch(() => null);
  if (!info) throw new BridgeError("BRIDGE_NOT_CONFIGURED");
  if (!info.isFile() || info.uid !== uid || (info.mode & 0o077) !== 0 || info.size > 512) throw new BridgeError("BRIDGE_TOKEN_UNSAFE");
  const token = (await readFile(path, "utf8")).trim();
  if (token.length < MIN_TOKEN_LENGTH || !/^[\x21-\x7e]+$/.test(token)) throw new BridgeError("BRIDGE_TOKEN_UNSAFE");
  return token;
}

async function loadLedger(stateDir: string): Promise<Ledger> {
  const raw = await readFile(join(stateDir, "ledger.json"), "utf8")
    .then((t) => JSON.parse(t) as unknown)
    .catch(() => null);
  if (raw && typeof raw === "object" && (raw as Ledger).version === 1 && typeof (raw as Ledger).jobs === "object") return raw as Ledger;
  return { version: 1, jobs: {} };
}

async function saveLedger(stateDir: string, ledger: Ledger): Promise<void> {
  const temp = join(stateDir, `.ledger-${process.pid}.json`);
  await writeFile(temp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, join(stateDir, "ledger.json"));
}

type Api = { post(body: Record<string, unknown>): Promise<{ status: number; body: unknown }> };

function api(options: BridgeOptions): Api {
  const endpoint = bridgeEndpoint(options.apiUrl, options.allowLocalHttp);
  const doFetch = options.fetch ?? fetch;
  return {
    async post(body) {
      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        throw new BridgeError("BRIDGE_API_UNAVAILABLE");
      }
      const parsed = await response.json().catch(() => null);
      return { status: response.status, body: parsed };
    },
  };
}

/** Maps auth / availability answers to a stop; anything else is the caller's. */
function stopFor(status: number): BridgeCode | null {
  if (status === 401) return "BRIDGE_UNAUTHORIZED";
  if (status === 503) return "BRIDGE_DISABLED";
  if (status >= 500 || status === 429) return "BRIDGE_API_UNAVAILABLE";
  return null;
}

/** The submit body for a result: the result's own fields, checked again; a profile that cannot be drawn becomes a failure. */
export function submitBody(jobId: string, result: WorkerResult): Record<string, unknown> {
  let { outcome, profile, error_code } = result;
  // Only known fixed codes reach the server (a worker cannot invent a word).
  if (error_code !== null) error_code = resultCode(error_code);
  if (profile && !checkProfile(profile).ok) {
    outcome = "failed";
    profile = null;
    error_code = "PROFILE_INVALID";
  }
  return { action: "submit", jobId, outcome, profile, errorCode: error_code, workerCommit: result.worker_commit, lineage: { workerJobId: workerJobIdFor(jobId) } };
}

function workerJobFile(job: DesignJob) {
  return { version: 1, job_id: job.workerJobId, facts: job.facts, source: job.source };
}

export async function runBridgeOnce(options: BridgeOptions): Promise<BridgeReport> {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => undefined);
  const report: BridgeReport = { delivered: [], superseded: [], refused: [], expired: [], claimed: null, workerIdle: false, stopped: null };
  const client = api(options);
  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  const ledger = await loadLedger(options.stateDir);
  const close = async (id: string, as: NonNullable<LedgerEntry["closed"]>["as"]) => {
    ledger.jobs[id]!.closed = { at: now().toISOString(), as };
    await rm(join(options.spool.toWorker, `${id}.json`), { force: true });
    await saveLedger(options.stateDir, ledger);
  };

  try {
    // 1. deliver
    for (const id of await spoolIds(options.spool.fromWorker)) {
      const entry = ledger.jobs[id];
      if (!entry || entry.closed) continue; // not ours, or already handled
      const parsed = WorkerResultSchema.safeParse(await readSpoolJson(join(options.spool.fromWorker, `${id}.json`), MAX_RESULT_BYTES));
      if (!parsed.success || parsed.data.job_id !== id) {
        log(`result ${id}: invalid; refused`);
        await close(id, "refused");
        report.refused.push(id);
        continue;
      }
      const answer = await client.post(submitBody(entry.jobId, parsed.data));
      const stop = stopFor(answer.status);
      if (stop) throw new BridgeError(stop);
      if (answer.status === 200) {
        if (!SubmitResponseSchema.safeParse(answer.body).success) throw new BridgeError("BRIDGE_RESPONSE_INVALID");
        await close(id, "delivered");
        report.delivered.push(id);
        log(`result ${id}: delivered (${parsed.data.outcome})`);
      } else if (answer.status === 409) {
        await close(id, "superseded");
        report.superseded.push(id);
        log(`result ${id}: superseded`);
      } else {
        await close(id, "refused");
        report.refused.push(id);
        log(`result ${id}: refused (${answer.status})`);
      }
    }

    // 2. expire jobs the worker never answered, and forget old entries
    for (const [id, entry] of Object.entries(ledger.jobs)) {
      const age = now().getTime() - Date.parse(entry.claimedAt);
      if (!entry.closed && age > LOCAL_EXPIRY_MS) {
        await close(id, "expired");
        report.expired.push(id);
        log(`job ${id}: expired`);
      } else if (entry.closed && now().getTime() - Date.parse(entry.closed.at) > LEDGER_KEEP_MS) {
        delete ledger.jobs[id];
        await saveLedger(options.stateDir, ledger);
      }
    }

    // 3. claim, one job at a time, only while the worker is running
    const heartbeat = await readHeartbeat(options.spool.fromWorker);
    const age = heartbeat ? now().getTime() - heartbeat.getTime() : Infinity;
    const workerRunning = age >= -5 * 60 * 1000 && age <= WORKER_HEARTBEAT_MAX_MS;
    if (!workerRunning && !Object.values(ledger.jobs).some((e) => !e.closed)) {
      report.workerIdle = true;
      log("not claiming: the worker has not run recently (BRIDGE_WORKER_IDLE)");
    }
    if (workerRunning && !Object.values(ledger.jobs).some((e) => !e.closed)) {
      const answer = await client.post({ action: "claim" });
      const stop = stopFor(answer.status);
      if (stop) throw new BridgeError(stop);
      const parsed = answer.status === 200 ? ClaimResponseSchema.safeParse(answer.body) : null;
      if (!parsed?.success) throw new BridgeError("BRIDGE_RESPONSE_INVALID");
      const job = parsed.data.job;
      if (job) {
        if (ledger.jobs[job.workerJobId]) throw new BridgeError("BRIDGE_RESPONSE_INVALID"); // a job id is never reused
        // Ledger first: a crash after this line leaves an entry that expires, never an untracked job file.
        ledger.jobs[job.workerJobId] = { jobId: job.jobId, claimedAt: now().toISOString() };
        await saveLedger(options.stateDir, ledger);
        try {
          await writeSpoolJson(options.spool.toWorker, job.workerJobId, workerJobFile(job));
        } catch {
          throw new BridgeError("BRIDGE_SPOOL_INVALID");
        }
        report.claimed = job.workerJobId;
        log(`job ${job.workerJobId}: claimed (attempt ${job.attempt})`);
      }
    }
  } catch (error) {
    if (!(error instanceof BridgeError)) throw error;
    report.stopped = error.code;
    log(`stopped: ${error.code}`);
  }
  return report;
}
