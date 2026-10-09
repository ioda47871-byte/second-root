/**
 * The design worker's side of the bridge spool (DEV-030). Runs as the worker
 * user (sr-designgen) before and after a worker run; it has no token and no
 * network: it only moves files between the spool and the worker's own queue.
 *
 *   import: to-worker/<id>.json → the worker inbox, once per job id (a job the
 *           worker already holds, ran or recorded is never imported again);
 *           a waiting bridge job whose spool file is gone (the bridge gave it
 *           up) is withdrawn from the inbox; the heartbeat is refreshed
 *   export: a finished bridge job (done/ or failed/) that the bridge still
 *           holds → from-worker/<id>.json, once, as a WorkerResult: outcome,
 *           the checked final profile without its rationale, a fixed code,
 *           the worker commit; results of jobs the bridge has closed are
 *           removed
 *
 * Nothing else of the run directory leaves the worker user: no report text,
 * screenshots, timing, Codex notes or rounds.
 */
import { lstat, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkProfile } from "../profile";
import { uploadableProfile, WORKER_COMMIT } from "../../sales/design";
import { JobSchema, type QueueDirs } from "../worker/queue";
import { readSpoolJson, resultCode, spoolIds, writeHeartbeat, writeSpoolJson, WorkerResultSchema, type BridgeSpool, type WorkerResult } from "./spool";

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

async function workerKnows(dirs: QueueDirs, outRoot: string, id: string): Promise<boolean> {
  for (const dir of [dirs.inbox, dirs.processing, dirs.done, dirs.failed]) {
    if (await exists(join(dir, `${id}.json`))) return true;
  }
  return exists(join(outRoot, id));
}

export type ImportReport = { imported: string[]; invalid: string[]; withdrawn: string[] };

const BRIDGE_JOB_FILE = /^(b-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;

/** Copies new bridge jobs into the worker inbox (strict job schema, file name = job id). */
export async function importBridgeJobs(spool: BridgeSpool, dirs: QueueDirs, outRoot: string, now: Date = new Date()): Promise<ImportReport> {
  const report: ImportReport = { imported: [], invalid: [], withdrawn: [] };
  await writeHeartbeat(spool.fromWorker, now);
  const live = new Set(await spoolIds(spool.toWorker));
  // A bridge job still waiting in the inbox whose spool file is gone: the
  // bridge (or the server) gave it up. Do not spend a Codex run on it.
  for (const name of await readdir(dirs.inbox).catch(() => [] as string[])) {
    const id = BRIDGE_JOB_FILE.exec(name)?.[1];
    if (id && !live.has(id)) {
      await rm(join(dirs.inbox, name), { force: true });
      report.withdrawn.push(id);
    }
  }
  for (const id of live) {
    if (await workerKnows(dirs, outRoot, id)) continue;
    const parsed = JobSchema.safeParse(await readSpoolJson(join(spool.toWorker, `${id}.json`)));
    if (!parsed.success || parsed.data.job_id !== id) {
      report.invalid.push(id);
      continue;
    }
    // Same as `worker.ts enqueue`: a dot-named temp file (claimNext skips it), then one rename.
    const temp = join(dirs.inbox, `.tmp-${id}-${process.pid}`);
    await writeFile(temp, `${JSON.stringify(parsed.data, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, join(dirs.inbox, `${id}.json`));
    report.imported.push(id);
  }
  return report;
}

type Record_ = { bucket: "done" | "failed"; record: Record<string, unknown> };

const readJson = (path: string) =>
  readFile(path, "utf8")
    .then((t) => JSON.parse(t) as unknown)
    .catch(() => null);

/**
 * The result the bridge may upload for a finished job, from the worker's own
 * records. Pure: the mapping is the whole policy.
 *   done + outcome done + a final profile that passes checkProfile → ready
 *   done + blocked / fallback_template / PUBLIC_SOURCE_UNAVAILABLE → blocked
 *   failed (or anything unexpected)                                → failed
 */
export function resultFromRecords(input: {
  id: string;
  bucket: "done" | "failed";
  record: Record<string, unknown> | null;
  report: Record<string, unknown> | null;
  final: unknown;
}): WorkerResult {
  const commitRaw = (input.report?.worker as { commit?: unknown } | undefined)?.commit ?? input.record?.worker_commit;
  const worker_commit = typeof commitRaw === "string" && WORKER_COMMIT.test(commitRaw) ? commitRaw : null;
  const base = { version: 1 as const, job_id: input.id, worker_commit };
  if (input.bucket === "failed") return { ...base, outcome: "failed", profile: null, error_code: resultCode(input.record?.code) };
  const outcome = input.report?.outcome;
  if (outcome === "done") {
    const checked = checkProfile(input.final);
    if (!checked.ok) return { ...base, outcome: "failed", profile: null, error_code: "PROFILE_INVALID" };
    return { ...base, outcome: "ready", profile: uploadableProfile(checked.profile), error_code: null };
  }
  if (outcome === "blocked") {
    const rendererChange = (input.report?.codex as { renderer_change_needed?: unknown } | undefined)?.renderer_change_needed === true;
    return { ...base, outcome: "blocked", profile: null, error_code: rendererChange ? "RENDERER_CHANGE_NEEDED" : "DESIGN_BLOCKED" };
  }
  if (outcome === "fallback_template") return { ...base, outcome: "blocked", profile: null, error_code: "FALLBACK_TEMPLATE" };
  if (outcome === "PUBLIC_SOURCE_UNAVAILABLE") return { ...base, outcome: "blocked", profile: null, error_code: "PUBLIC_SOURCE_UNAVAILABLE" };
  return { ...base, outcome: "failed", profile: null, error_code: "RESULT_MISSING" };
}

async function finishedRecords(dirs: QueueDirs): Promise<Map<string, Record_>> {
  const out = new Map<string, Record_>();
  for (const bucket of ["done", "failed"] as const) {
    const dir = bucket === "done" ? dirs.done : dirs.failed;
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const m = /^(b-[0-9a-f-]{36})\.result\.json$/.exec(name);
      if (!m) continue;
      const record = await readJson(join(dir, name));
      if (record && typeof record === "object") out.set(m[1]!, { bucket, record: record as Record<string, unknown> });
    }
  }
  return out;
}

export type ExportReport = { exported: string[]; removed: string[] };

/**
 * Writes a WorkerResult for every finished bridge job the bridge still holds
 * (its job file is in to-worker/) and that has none yet. A result whose job
 * the bridge has closed (delivered, superseded, refused or expired) is
 * removed, so the spool does not grow.
 */
export async function exportBridgeResults(spool: BridgeSpool, dirs: QueueDirs, outRoot: string): Promise<ExportReport> {
  const report: ExportReport = { exported: [], removed: [] };
  const live = new Set(await spoolIds(spool.toWorker));
  const already = new Set(await spoolIds(spool.fromWorker));
  for (const id of already) {
    if (live.has(id)) continue;
    await rm(join(spool.fromWorker, `${id}.json`), { force: true });
    report.removed.push(id);
  }
  for (const [id, { bucket, record }] of await finishedRecords(dirs)) {
    if (!live.has(id) || already.has(id)) continue;
    const runDir = join(outRoot, id);
    const reportJson = bucket === "done" ? await readJson(join(runDir, "report.json")) : null;
    const final = bucket === "done" ? await readJson(join(runDir, "final.json")) : null;
    const result = resultFromRecords({
      id,
      bucket,
      record,
      report: reportJson && typeof reportJson === "object" ? (reportJson as Record<string, unknown>) : null,
      final,
    });
    // The same schema the bridge applies: a result that does not pass is never written.
    const checked = WorkerResultSchema.safeParse(result);
    if (!checked.success) continue;
    await writeSpoolJson(spool.fromWorker, id, checked.data);
    report.exported.push(id);
  }
  return report;
}
