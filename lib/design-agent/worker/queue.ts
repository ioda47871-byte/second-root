// File job queue for the design worker (DEV-028 worker), outside the
// repository (default ~/sr-design-jobs, 0700):
//
//   inbox/<job_id>.json        waiting
//   processing/<job_id>.json   claimed (atomic rename from inbox)
//   processing/<job_id>.claim.json   who claimed it (pid, boot id, start time, token)
//   done/<job_id>.json         reached an expected outcome (+ <job_id>.result.json)
//   failed/<job_id>.json       could not be processed (+ <job_id>.result.json)
//
// A job holds verified facts, the shop's verified official website and / or
// its public Instagram profile URL. Nothing
// in the queue is ever read by the web app or committed.
import { lstat, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { holderAlive, LOCK_STALE_MS, parseHolder, writeJsonAtomic, type Holder } from "./state";

export const JOB_ID = /^[a-z0-9][a-z0-9-]{2,62}$/;
const JOB_FILE = /^([a-z0-9][a-z0-9-]{2,62})\.json$/;

export const JobSchema = z.strictObject({
  version: z.literal(1),
  job_id: z.string().regex(JOB_ID),
  facts: z.record(z.string(), z.unknown()),
  // At least one: the verified official website and / or the public Instagram profile.
  source: z
    .strictObject({ instagram_url: z.string().max(200).optional(), website_url: z.string().max(300).optional() })
    .refine((s) => s.instagram_url !== undefined || s.website_url !== undefined),
});
export type Job = z.infer<typeof JobSchema>;

/** The sales_demos.content keys a design job may carry (everything else is dropped). */
export const FACT_KEYS = ["name", "category", "ward", "address", "hours", "closed_days", "access", "phone", "description", "menu_items"] as const;

export function pickFacts(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(FACT_KEYS.filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]]));
}

export type QueueDirs = { root: string; inbox: string; processing: string; done: string; failed: string };

export function queueDirs(root: string): QueueDirs {
  return { root, inbox: join(root, "inbox"), processing: join(root, "processing"), done: join(root, "done"), failed: join(root, "failed") };
}

export async function ensureQueue(dirs: QueueDirs): Promise<void> {
  for (const dir of [dirs.root, dirs.inbox, dirs.processing, dirs.done, dirs.failed]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw Object.assign(new Error("queue directory"), { code: "WORKER_QUEUE_INVALID" });
  }
}

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

export type Claimed = { jobId: string; path: string };

/**
 * Moves the oldest waiting job to processing/ with one atomic rename and
 * records the claim. Files that are not `<job_id>.json` regular files go to
 * failed/ as JOB_INVALID. Ids in `skip` stay in the inbox.
 */
export async function claimNext(dirs: QueueDirs, holder: Holder, skip: ReadonlySet<string>): Promise<Claimed | null> {
  const names = (await readdir(dirs.inbox)).filter((n) => !n.startsWith(".")).sort();
  for (const name of names) {
    const match = JOB_FILE.exec(name);
    const from = join(dirs.inbox, name);
    const info = await lstat(from).catch(() => null);
    if (!info) continue;
    if (!match || !info.isFile()) {
      await moveUnique(from, dirs.failed, `invalid-${Date.now()}-${name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60)}`);
      continue;
    }
    const jobId = match[1]!;
    if (skip.has(jobId)) continue;
    const to = join(dirs.processing, name);
    if (await exists(to)) continue; // a live claim of the same id; recovery decides
    try {
      await rename(from, to);
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") continue;
      throw error;
    }
    await writeJsonAtomic(join(dirs.processing, `${jobId}.claim.json`), holder);
    return { jobId, path: to };
  }
  return null;
}

export async function readJob(path: string): Promise<Job | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 64 * 1024) return null;
    const parsed = JobSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function moveUnique(from: string, dir: string, name: string): Promise<string> {
  let target = join(dir, name);
  if (await exists(target)) target = join(dir, name.replace(/\.json$/, "") + `.${Date.now()}.json`);
  await rename(from, target);
  return target;
}

/** Ends a claimed job: result record next to it, job file moved, claim removed. */
export async function finishJob(dirs: QueueDirs, jobId: string, bucket: "done" | "failed", result: Record<string, unknown>): Promise<void> {
  const dir = bucket === "done" ? dirs.done : dirs.failed;
  const moved = await moveUnique(join(dirs.processing, `${jobId}.json`), dir, `${jobId}.json`);
  await writeJsonAtomic(moved.replace(/\.json$/, ".result.json"), { job_id: jobId, bucket, ...result });
  await rm(join(dirs.processing, `${jobId}.claim.json`), { force: true });
}

/** Puts a claimed job back in the inbox (not finished; tried again later). */
export async function requeueJob(dirs: QueueDirs, jobId: string): Promise<void> {
  const target = join(dirs.inbox, `${jobId}.json`);
  if (await exists(target)) {
    // A newer copy with the same id is waiting; keep that one.
    await moveUnique(join(dirs.processing, `${jobId}.json`), dirs.failed, `${jobId}.superseded.json`);
  } else {
    await rename(join(dirs.processing, `${jobId}.json`), target);
  }
  await rm(join(dirs.processing, `${jobId}.claim.json`), { force: true });
}

export const NO_CLAIM_STALE_MS = 10 * 60 * 1000;

export type ProcessingState = { jobId: string; stale: boolean; reason: "HOLDER_GONE" | "CLAIM_EXPIRED" | "NO_CLAIM" | "LIVE" };

/**
 * Looks at processing/. A job is stale when the process that claimed it is
 * gone (pid, boot id and start time), or the claim is older than
 * LOCK_STALE_MS, or it has no readable claim for NO_CLAIM_STALE_MS (the
 * claim is written right after the rename, so only a worker killed between
 * the two leaves a job without one).
 * Jobs of a live worker are reported as LIVE and never touched.
 */
export async function inspectProcessing(dirs: QueueDirs, now: Date, staleMs: number = LOCK_STALE_MS): Promise<ProcessingState[]> {
  const out: ProcessingState[] = [];
  for (const name of (await readdir(dirs.processing)).sort()) {
    const match = JOB_FILE.exec(name);
    if (!match || name.endsWith(".claim.json")) continue;
    const jobId = match[1]!;
    const claim = parseHolder(await readFile(join(dirs.processing, `${jobId}.claim.json`), "utf8").then((t) => JSON.parse(t) as unknown).catch(() => null));
    if (claim === null) {
      const changed = await stat(join(dirs.processing, name)).then(
        (info) => info.ctimeMs,
        () => 0,
      );
      out.push({ jobId, stale: now.getTime() - changed > Math.min(staleMs, NO_CLAIM_STALE_MS), reason: "NO_CLAIM" });
      continue;
    }
    if (!(await holderAlive(claim))) out.push({ jobId, stale: true, reason: "HOLDER_GONE" });
    else if (now.getTime() - Date.parse(claim.at) > staleMs) out.push({ jobId, stale: true, reason: "CLAIM_EXPIRED" });
    else out.push({ jobId, stale: false, reason: "LIVE" });
  }
  return out;
}

export async function hasFinished(dirs: QueueDirs, jobId: string): Promise<boolean> {
  return exists(join(dirs.done, `${jobId}.json`));
}

export async function inboxCount(dirs: QueueDirs): Promise<number> {
  return (await readdir(dirs.inbox)).filter((n) => !n.startsWith(".")).length;
}
