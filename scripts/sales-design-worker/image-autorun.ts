/**
 * DEV-186: the design worker's guarded path for an "approved demo image generation job". OFF by default, fail closed.
 *
 * Queue (inside the worker's queue root, so Codex never sees it):  <queue>/image-autorun/
 *   inbox/<job_id>.json   a job file in the fixed schema below (nothing else is read; no free text reaches a shell or
 *                         the prompt — the prompt is only the pinned brief of the shop)
 *   processing/           the one job being run (concurrency 1; one left over from a crash = FAILED_INTERRUPTED)
 *   done/ failed/ held/   the job file + <job_id>.result.json (codes and paths only)
 *
 * The switch is a ROOT-OWNED file the owner creates on WSL (not writable by the worker user, so the jailed worker or
 * its Claude cannot turn itself on): /etc/sr-design-worker/image-autorun.json
 *   { "version": 1, "enabled": true, "approvals": [ { approval_id, job_id, shop, max_images, max_jobs: 1, expires_at } ] }
 * Missing, unreadable, not root-owned, group/other-writable, a link, or enabled !== true: OFF → HELD_AUTORUN_DISABLED,
 * and nothing that can start Codex is called. docs/operations/image-autorun-approval-sheet.md.
 *
 * Checks, in order, all before any Codex call: the schema (REFUSED_JOB_INVALID), the limits (REFUSED_LIMIT_EXCEEDED),
 * a duplicate (REFUSED_DUPLICATE), expiry (REFUSED_APPROVAL_EXPIRED), a used approval — the shared one-use ledger
 * poc-approval-used/<id> of the one-shot gates, and DEV-185's consumed id (REFUSED_APPROVAL_REUSED) — an earlier
 * failure (REFUSED_AFTER_FAILURE: the STOPPED marker; the owner removes it), the switch (HELD_AUTORUN_DISABLED), the
 * owner's approval entry with the same scope and this exact job_id (REFUSED_NO_APPROVAL). Then the approval is reserved with an atomic mkdir
 * (never retried from here on), and ONE generation (generateImagesInOneRun, at most 6 image calls, 15 min) runs, then
 * the DEV-185 intake (ai_generated_demo records), the d1-v10 swap and its PC 1440 / SP 390 renders into a private
 * dir under the worker's results root. Any failure writes the STOPPED marker. Every decision is one audit line
 * (stdout and <state>/image-autorun/audit.jsonl): codes, ids, hashes and paths only.
 *
 * Runs inside the worker run (run.sh holds the shared run.lock; this adds its own lock file) after the checkout check.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { appendFile, lstat, mkdir, open, readdir, readFile, rename, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Browser } from "playwright";
import { z } from "zod";
import { swapPage } from "../design-artifact/photo-swap";
import { importTsuguteAiPhotos } from "../design-artifact/tsugute-ai-intake";
import type { RunDeadline } from "../../lib/design-agent/bounded-process";
import { cleanupActiveImageCalls, generateImagesInOneRun, MAX_BATCH_IMAGES, type ImageBatchResult } from "../../lib/design-agent/design-image/image-once";

/** the worker's stop handler removes a cut-off image call's session log and image dir (as tsugute-photos.ts) */
export { cleanupActiveImageCalls };
import { writeTsugutePhotos } from "../../lib/design-agent/design-image/tsugute-photos";
import { workerProtectedPaths } from "../../lib/design-agent/protected-paths";
import { buildTsugutePhotosPrompt, TSUGUTE_PHOTOS_APPROVAL_ID, TSUGUTE_PROMPT_CHARS, TSUGUTE_PROMPT_SHA256, TSUGUTE_SLOTS } from "../../lib/design-agent/quality-pipeline/tsugute-ai-photos";
import { prepareCodexSandbox } from "../../lib/design-agent/sandbox";
import { childEnvironment } from "../../lib/design-agent/worker/env";
import { acquireLock, writeJsonAtomic } from "../../lib/design-agent/worker/state";

export const IMAGE_AUTORUN_CONFIG = "/etc/sr-design-worker/image-autorun.json";
const JOB_ID = /^[a-z0-9][a-z0-9-]{2,62}$/;
const JOB_FILE = /^([a-z0-9][a-z0-9-]{2,62})\.json$/;
const APPROVAL_ID = /^[a-z0-9][a-z0-9-]{2,62}$/;
const Sha = z.string().regex(/^[a-f0-9]{64}$/);
const Iso = z.string().datetime({ offset: true });
/** the existing limit of one Codex image run (as the one-shot entry): 15 minutes */
const CODEX_TIMEOUT_MS = 15 * 60 * 1000;
/** a job is not started with less than this left of the worker's run (the one Codex run + intake, swap, renders) */
export const IMAGE_AUTORUN_MIN_MS = 25 * 60 * 1000;
/**
 * an approval window longer than this is a standing permission, not a one-use approval. PR #228 review M1: 24 h bounds
 * what remains — the one-use marker and STOPPED live in the worker user's state dir, so anything running as that user
 * could delete them; the root-owned entry (bound to one job_id) and the owner removing it right after the run are the
 * authoritative one-use and revocation.
 */
export const MAX_APPROVAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const LEDGER = "poc-approval-used";

/** The shops this path knows (only つぐ手 for now): its page and the pinned brief that is the whole prompt. */
const SHOPS = {
  tsugute: {
    page: "d1-v10",
    pageDir: "design-library/research/quality-pipeline/poc/tsugute/fidelity/d1-v10",
    slotIds: TSUGUTE_SLOTS.map((s) => s.slot_id),
    briefSha256: TSUGUTE_PROMPT_SHA256,
    briefChars: TSUGUTE_PROMPT_CHARS,
    buildPrompt: buildTsugutePhotosPrompt,
  },
} as const;

const Scope = z.strictObject({
  shop: z.literal("tsugute"),
  max_images: z.number().int().min(1).max(100),
  max_jobs: z.number().int().min(1).max(100),
  expires_at: Iso,
});

export const ImageAutorunJobSchema = z.strictObject({
  version: z.literal(1),
  shop_id: z.literal("tsugute"),
  page: z.literal(SHOPS.tsugute.page),
  slot_ids: z.array(z.enum(SHOPS.tsugute.slotIds as unknown as [string, ...string[]])).min(1).max(100),
  brief_sha256: Sha,
  approval_id: z.string().regex(APPROVAL_ID),
  approval_scope: Scope,
  requested_at: Iso,
});
export type ImageAutorunJob = z.infer<typeof ImageAutorunJobSchema>;

const ConfigSchema = z.strictObject({
  version: z.literal(1),
  enabled: z.boolean(),
  // each entry approves exactly ONE job file (<job_id>.json); a resubmission under another id is refused
  approvals: z.array(Scope.extend({ approval_id: z.string().regex(APPROVAL_ID), job_id: z.string().regex(JOB_ID) })).max(20),
});

export type ImageGenerate = (o: { prompt: string; maxImages: number; timeoutMs: number }) => Promise<ImageBatchResult>;

export type ImageAutorunOptions = {
  queueRoot: string;
  outRoot: string;
  stateDir: string;
  /** the checked worker commit (HEAD == origin/<ref>, clean) */
  workerCommit: string;
  deadline: RunDeadline;
  env: NodeJS.ProcessEnv;
  launchBrowser: () => Promise<Browser>;
  log: (line: string) => void;
  /** tests only: the switch file and the uid that must own it (production: IMAGE_AUTORUN_CONFIG, root) */
  configPath?: string;
  trustedUid?: number;
  /** tests only: a mock generator. Production: one generateImagesInOneRun in the worker's Codex sandbox. */
  generate?: ImageGenerate;
  now?: () => Date;
};

export type ImageAutorunReport = { code: string; jobId: string | null; out?: string; renders?: string[] } | null;

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const exists = (p: string) => lstat(p).then(() => true, () => false);

/** The production generator: ONE Codex run in the worker's sandbox; the worker's dirs are hidden from Codex. */
function realGenerate(o: ImageAutorunOptions): ImageGenerate {
  return async ({ prompt, maxImages, timeoutMs }) => {
    const env = childEnvironment(o.env);
    const protectedPaths = workerProtectedPaths({ stateDir: o.stateDir, queueRoot: o.queueRoot, outRoot: o.outRoot, env: o.env });
    const sandbox = await prepareCodexSandbox({ env, protectedPaths });
    return generateImagesInOneRun({ sandbox, prompt, timeoutMs, tmpBase: tmpdir(), maxImages });
  };
}

/** OFF unless the root-owned switch file is a plain file in a root-owned dir, not group/other-writable, and valid. */
async function readSwitch(path: string, uid: number): Promise<z.infer<typeof ConfigSchema> | null> {
  try {
    const dir = await lstat(dirname(path));
    const file = await lstat(path);
    if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== uid || (dir.mode & 0o022) !== 0) return null;
    if (!file.isFile() || file.isSymbolicLink() || file.uid !== uid || (file.mode & 0o022) !== 0 || file.size > 16 * 1024) return null;
    const parsed = ConfigSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success && parsed.data.enabled === true ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The hook. Returns null when there is no image job (the queue dir is not created by this). At most one job per call.
 */
export async function runImageAutorun(o: ImageAutorunOptions): Promise<ImageAutorunReport> {
  const now = o.now ?? (() => new Date());
  const root = join(o.queueRoot, "image-autorun");
  const q = { inbox: join(root, "inbox"), processing: join(root, "processing"), done: join(root, "done"), failed: join(root, "failed"), held: join(root, "held") };
  const inboxInfo = await lstat(q.inbox).catch(() => null);
  if (!inboxInfo) return null;
  const stateDir = join(o.stateDir, "image-autorun");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const audit = async (code: string, f: Record<string, unknown> = {}) => {
    const line = { at: now().toISOString(), code, ...f };
    o.log(`image-autorun: ${JSON.stringify(line)}`);
    await appendFile(join(stateDir, "audit.jsonl"), `${JSON.stringify(line)}\n`, { mode: 0o600 });
  };
  if (inboxInfo.isSymbolicLink() || !inboxInfo.isDirectory()) {
    await audit("STOP_QUEUE_INVALID");
    return { code: "STOP_QUEUE_INVALID", jobId: null };
  }
  for (const d of Object.values(q)) {
    await mkdir(d, { recursive: true, mode: 0o700 });
    const info = await lstat(d);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      await audit("STOP_QUEUE_INVALID");
      return { code: "STOP_QUEUE_INVALID", jobId: null };
    }
  }
  const lock = await acquireLock(stateDir, now(), "image-autorun.lock");
  if (!lock) {
    await audit("REFUSED_CONCURRENT");
    return { code: "REFUSED_CONCURRENT", jobId: null };
  }
  try {
    return await oneJob(o, q, stateDir, audit, now);
  } finally {
    await lock.release();
  }
}

type Q = { inbox: string; processing: string; done: string; failed: string; held: string };

async function oneJob(o: ImageAutorunOptions, q: Q, stateDir: string, audit: (code: string, f?: Record<string, unknown>) => Promise<void>, now: () => Date): Promise<ImageAutorunReport> {
  const stopped = join(stateDir, "STOPPED");
  const finish = async (from: string, jobId: string, bucket: "done" | "failed" | "held", code: string, extra: Record<string, unknown> = {}) => {
    const dir = q[bucket];
    let to = join(dir, `${jobId}.json`);
    if (await exists(to)) to = join(dir, `${jobId}.${Date.now()}.json`);
    await rename(from, to);
    await writeJsonAtomic(to.replace(/\.json$/, ".result.json"), { job_id: jobId, code, ...extra });
  };
  // a job left in processing/ is a run that was cut off: never resumed or retried
  for (const name of (await readdir(q.processing)).filter((n) => JOB_FILE.test(n))) {
    const jobId = JOB_FILE.exec(name)![1]!;
    await writeJsonAtomic(stopped, { at: now().toISOString(), code: "FAILED_INTERRUPTED", job_id: jobId });
    await finish(join(q.processing, name), jobId, "failed", "FAILED_INTERRUPTED");
    await audit("FAILED_INTERRUPTED", { job_id: jobId });
  }
  const names = (await readdir(q.inbox)).filter((n) => !n.startsWith(".")).sort();
  const name = names[0];
  if (name === undefined) return null;
  const match = JOB_FILE.exec(name);
  const from = join(q.inbox, name);
  const info = await lstat(from).catch(() => null);
  if (!match || !info || !info.isFile() || info.size > 16 * 1024) {
    const safe = `invalid-${Date.now()}`;
    if (info) await rename(from, join(q.failed, `${safe}.json`));
    await audit("REFUSED_JOB_INVALID", { job_id: null });
    return { code: "REFUSED_JOB_INVALID", jobId: null };
  }
  const jobId = match[1]!;
  if (o.deadline.remainingMs() < IMAGE_AUTORUN_MIN_MS) {
    await audit("DEFERRED_TIME_BUDGET", { job_id: jobId });
    return { code: "DEFERRED_TIME_BUDGET", jobId };
  }
  const processing = join(q.processing, name);
  await rename(from, processing);
  // PR #228 review L2: never follow a link; check and read the same open file
  let bytes: Buffer;
  try {
    const fh = await open(processing, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = await fh.stat();
      if (!st.isFile() || st.size > 16 * 1024) throw new Error("not a small regular file");
      bytes = await fh.readFile();
    } finally {
      await fh.close();
    }
  } catch {
    await finish(processing, jobId, "failed", "REFUSED_JOB_INVALID");
    await audit("REFUSED_JOB_INVALID", { job_id: jobId });
    return { code: "REFUSED_JOB_INVALID", jobId };
  }
  const jobSha = sha256(bytes);
  const base = { job_id: jobId, job_sha256: jobSha };
  const decide = async (bucket: "failed" | "held", code: string, f: Record<string, unknown> = {}) => {
    await finish(processing, jobId, bucket, code, { job_sha256: jobSha, ...f });
    await audit(code, { ...base, ...f });
    return { code, jobId };
  };
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    return decide("failed", "REFUSED_JOB_INVALID");
  }
  const parsed = ImageAutorunJobSchema.safeParse(raw);
  if (!parsed.success) return decide("failed", "REFUSED_JOB_INVALID");
  const job = parsed.data;
  const shop = SHOPS[job.shop_id];
  const ids = { approval_id: job.approval_id, shop: job.shop_id };
  // the pinned brief and the page's exact slot set (all or nothing: the swap needs all 6)
  if (job.brief_sha256 !== shop.briefSha256 || job.slot_ids.join(",") !== shop.slotIds.join(",")) return decide("failed", "REFUSED_JOB_INVALID", ids);
  const sc = job.approval_scope;
  const windowMs = Date.parse(sc.expires_at) - Date.parse(job.requested_at);
  if (sc.shop !== job.shop_id || sc.max_jobs !== 1 || sc.max_images > MAX_BATCH_IMAGES || job.slot_ids.length > sc.max_images || windowMs > MAX_APPROVAL_WINDOW_MS) return decide("failed", "REFUSED_LIMIT_EXCEEDED", ids);
  const seen = join(stateDir, "seen", jobSha);
  if ((await exists(seen)) || (await exists(join(q.done, name))) || (await exists(join(q.failed, name)))) return decide("failed", "REFUSED_DUPLICATE", ids);
  const nowMs = now().getTime();
  if (!(Date.parse(sc.expires_at) > nowMs) || Date.parse(job.requested_at) > nowMs + 5 * 60 * 1000 || windowMs <= 0) return decide("failed", "REFUSED_APPROVAL_EXPIRED", ids);
  const ledger = join(o.stateDir, LEDGER);
  if (job.approval_id === TSUGUTE_PHOTOS_APPROVAL_ID || (await exists(join(ledger, job.approval_id)))) return decide("failed", "REFUSED_APPROVAL_REUSED", ids);
  if (await exists(stopped)) return decide("failed", "REFUSED_AFTER_FAILURE", ids);
  const config = await readSwitch(o.configPath ?? IMAGE_AUTORUN_CONFIG, o.trustedUid ?? 0);
  if (!config) return decide("held", "HELD_AUTORUN_DISABLED", ids);
  const entry = config.approvals.find((a) => a.approval_id === job.approval_id);
  if (!entry || entry.job_id !== jobId || entry.shop !== sc.shop || entry.max_images !== sc.max_images || entry.max_jobs !== sc.max_jobs || entry.expires_at !== sc.expires_at) return decide("failed", "REFUSED_NO_APPROVAL", ids);
  const prompt = shop.buildPrompt();
  if (sha256(prompt) !== job.brief_sha256 || prompt.length !== shop.briefChars) return decide("failed", "REFUSED_JOB_INVALID", ids);

  // reserve: one job per approval, atomic, never retried from here on
  const ledgerInfo = await lstat(ledger).catch(() => null);
  if (ledgerInfo && (ledgerInfo.isSymbolicLink() || !ledgerInfo.isDirectory())) return decide("failed", "REFUSED_APPROVAL_REUSED", ids);
  await mkdir(ledger, { recursive: true, mode: 0o700 });
  try {
    await mkdir(join(ledger, job.approval_id), { mode: 0o700 });
  } catch {
    return decide("failed", "REFUSED_APPROVAL_REUSED", ids);
  }
  await writeJsonAtomic(join(ledger, job.approval_id, "receipt.json"), { direction: "image-autorun", job_sha256: jobSha, prompt_sha256: job.brief_sha256, worker_commit: o.workerCommit });
  await mkdir(seen, { recursive: true, mode: 0o700 });
  await audit("APPROVAL_RESERVED", { ...base, ...ids });

  const out = join(o.outRoot, "image-autorun", jobId);
  const fail = async (code: string, f: Record<string, unknown> = {}) => {
    await writeJsonAtomic(stopped, { at: now().toISOString(), code, job_id: jobId });
    return { ...(await decide("failed", code, { ...ids, ...f })), out };
  };
  let browser: Browser | null = null;
  try {
    await mkdir(join(out, "photos"), { recursive: true, mode: 0o700 });
    const generate = o.generate ?? realGenerate(o);
    const timeoutMs = Math.min(CODEX_TIMEOUT_MS, o.deadline.remainingMs() - 5 * 60 * 1000);
    const batch = await generate({ prompt, maxImages: job.slot_ids.length, timeoutMs });
    const { dir, manifest } = await writeTsugutePhotos({ outRoot: join(out, "photos"), batch, commit: o.workerCommit, prompt, generatedAt: now().toISOString(), approvalId: job.approval_id });
    await audit("GENERATED", { ...base, status: manifest.status, stop_code: manifest.stop_code, images: manifest.slots.length, image_tool_calls: manifest.image_tool_calls });
    if (manifest.status !== "complete") return await fail("FAILED_GENERATION", { stop_code: manifest.stop_code });
    const pipelineRoot = join(out, "pipeline");
    await mkdir(join(pipelineRoot, ".intake", "photos"), { recursive: true, mode: 0o700 });
    const manifestOut = join(out, "swap-manifest.json");
    const intake = await importTsuguteAiPhotos({ from: dir, manifestOut, pipelineRoot, approvalIds: [job.approval_id] });
    if (!intake.ok) return await fail("FAILED_INTAKE", { codes: intake.codes });
    browser = await o.launchBrowser();
    const swap = await swapPage({ pageDir: shop.pageDir, manifest: JSON.parse(await readFile(manifestOut, "utf8")), out: join(out, "swap"), pipelineRoot, now: now().toISOString().slice(0, 10), browser });
    if (!swap.ok) return await fail("FAILED_SWAP", { codes: swap.refusals.flatMap((r) => r.codes) });
    const renders = swap.renders.map((r) => r.file);
    for (const r of renders) await stat(r);
    await finish(processing, jobId, "done", "DONE", { job_sha256: jobSha, ...ids, out, renders });
    await audit("DONE", { ...base, ...ids, out, renders: renders.length });
    return { code: "DONE", jobId, out, renders };
  } catch {
    return await fail("FAILED_UNEXPECTED");
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
