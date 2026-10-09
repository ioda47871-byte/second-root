/**
 * The file spool between the local design bridge and the design worker
 * (DEV-030, Sales Design Bridge). Two Linux users, one direction each:
 *
 *   /srv/sr-design-bridge/                 root, 0755
 *     to-worker/    sr-designbridge:sr-designgen 2750
 *                   <worker job id>.json   jobs (worker JobSchema), written by the bridge,
 *                                          only read by the worker
 *     from-worker/  sr-designgen:sr-designbridge 2750
 *                   <worker job id>.json   results (WorkerResultSchema), written by the worker,
 *                                          only read by the bridge
 *
 * The bridge holds the bridge API token; the worker (sr-designgen, inside its
 * jail) never does and never talks to the server. What crosses the spool is
 * fixed: a job is the worker's existing job file (verified facts and source
 * URLs); a result is an outcome, a checked DesignProfile without rationale,
 * a fixed error code and the worker commit. No screenshot, HTML, cookie,
 * prompt, Codex output, stderr or reasoning can be expressed in either.
 *
 * Both sides read spool files the same careful way: no link followed, a
 * regular file with one link, a size limit, strict JSON schema.
 */
import { constants } from "node:fs";
import { open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { DesignProfileSchema } from "../profile";
import { DESIGN_ERROR_CODE, WORKER_COMMIT } from "../../sales/design";
import { DESIGN_OUTCOMES, WORKER_JOB_ID } from "../../sales/design-bridge-schema";

export const BRIDGE_SPOOL_ROOT = "/srv/sr-design-bridge";
export const MAX_SPOOL_FILE_BYTES = 64 * 1024;
/** A result is a few hundred bytes; anything bigger is not a result. */
export const MAX_RESULT_BYTES = 16 * 1024;

export type BridgeSpool = { root: string; toWorker: string; fromWorker: string };

export function bridgeSpool(root: string = BRIDGE_SPOOL_ROOT): BridgeSpool {
  return { root, toWorker: join(root, "to-worker"), fromWorker: join(root, "from-worker") };
}

const SPOOL_FILE = /^(b-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;

/** Worker job ids of the spool files in a directory (anything else is ignored, never read). */
export async function spoolIds(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  return names
    .map((n) => SPOOL_FILE.exec(n)?.[1])
    .filter((id): id is string => id !== undefined)
    .sort();
}

export const WorkerResultSchema = z
  .strictObject({
    version: z.literal(1),
    job_id: z.string().regex(WORKER_JOB_ID),
    outcome: z.enum(DESIGN_OUTCOMES),
    profile: DesignProfileSchema.nullable(),
    error_code: z.string().regex(DESIGN_ERROR_CODE).nullable(),
    worker_commit: z.string().regex(WORKER_COMMIT).nullable(),
  })
  .refine((r) => (r.outcome === "ready") === (r.profile !== null), { message: "profile only with ready" })
  .refine((r) => (r.outcome === "ready") === (r.error_code === null), { message: "error_code only without ready" })
  .refine((r) => r.profile === null || r.profile.rationale.length === 0, { message: "rationale must be empty" });
export type WorkerResult = z.infer<typeof WorkerResultSchema>;

/**
 * Reads one spool file: opened without following a link, a regular file
 * with exactly one link, at most `maxBytes`, JSON. Null for anything else.
 */
export async function readSpoolJson(path: string, maxBytes: number = MAX_SPOOL_FILE_BYTES): Promise<unknown> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes) return null;
    const text = await handle.readFile("utf8");
    if (Buffer.byteLength(text) > maxBytes) return null;
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * Writes a spool file atomically (temp file in the same directory, then
 * rename) with an explicit mode, so the other user can read it whatever the
 * writer's umask (the worker runs with 077).
 */
export async function writeSpoolJson(dir: string, id: string, value: unknown, mode: number = 0o640): Promise<void> {
  if (!SPOOL_FILE.test(`${id}.json`)) throw Object.assign(new Error("spool id"), { code: "BRIDGE_SPOOL_INVALID" });
  const temp = join(dir, `.tmp-${id}-${process.pid}-${Date.now()}`);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, join(dir, `${id}.json`));
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export async function spoolHas(dir: string, id: string): Promise<boolean> {
  return (await spoolIds(dir)).includes(id);
}
