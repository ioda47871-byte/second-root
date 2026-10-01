/**
 * The capture helper (DEV-028 Phase 3). Runs ONLY as sr-igcapture, the user
 * that owns the signed-in Instagram browser profile, from a checkout that the
 * worker / Claude user cannot write (scripts/sales-design-capture/run.sh pins
 * it to a commit a person approved). It is started by systemd when a request
 * file appears in the spool, and ends when the spool is empty.
 *
 * For each request it:
 *   1. reads the request without following links (regular file, one link,
 *      ≤ 4 KiB, strict schema: an id and one public Instagram profile URL);
 *   2. captures that page with the dedicated profile (session.ts:
 *      runSignedInCapture: guarded navigation, no click / input, account
 *      chrome hidden, media blurred and pixelated before the PNG is written);
 *   3. writes results/<id>/status.json (fixed codes) and at most three PNGs
 *      with fixed names, group-readable; deletes its own working copy and the
 *      request.
 *
 * It never signs in: an expired session is LOGIN_REQUIRED and a person runs
 * the headed login. Limits keep it from being used to crawl: a few requests
 * per run, a pause between captures, a daily cap. Results are deleted after
 * 24 hours. Nothing it writes or logs contains a URL, a username, a cookie,
 * a session value or page text.
 */
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { checkProfileTree, type ProfileEnv, ProfileError } from "../browser/profile";
import { runSignedInCapture, type LaunchPersistent, type SignedInCaptureCode } from "../browser/session";
import { instagramTarget, type CaptureTarget } from "../worker/capture";
import { parseInstagramProfileUrl, type ProfileSource } from "../worker/source-url";
import { acquireLock, writeJsonAtomic } from "../worker/state";
import { MAX_REQUEST_BYTES, MAX_RESULT_PNG_BYTES, REQUEST_FILE, RequestSchema, RESULT_FILES, spoolDirs, type CaptureStatus, type StatusCode } from "./spool";

export const HELPER_LIMITS = { perRun: 3, minIntervalMs: 60_000, perDay: 30 };
export const RESULT_KEEP_MS = 24 * 60 * 60 * 1000;
const STRAY_KEEP_MS = 60 * 60 * 1000;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class HelperError extends Error {
  constructor(readonly code: "SPOOL_UNSAFE" | "HELPER_BUSY") {
    super(code);
  }
}

export interface HelperOptions {
  spoolRoot: string;
  profileDir: string;
  /** The helper's own state (locks, the rate ledger), in its home. */
  stateDir: string;
  /** The helper's private working directory for captures, in its home. */
  workRoot: string;
  env: ProfileEnv;
  launchPersistent: LaunchPersistent;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  limits?: typeof HELPER_LIMITS;
  settleMs?: number;
  /** Tests only: the capture target for a source (a local mock). Production uses instagramTarget. */
  targetFor?: (source: ProfileSource) => CaptureTarget;
}

/**
 * The spool must be exactly as installed, or the helper does nothing:
 * requests/ owned by the helper, sticky, group may create but not list or
 * read, nobody else anything; results/ owned by the helper, nobody else may
 * write; neither a link.
 */
export async function checkSpool(root: string, helperUid: number | undefined): Promise<void> {
  const dirs = spoolDirs(root);
  const unsafe = () => new HelperError("SPOOL_UNSAFE");
  const top = await lstat(dirs.root).catch(() => null);
  if (!top || top.isSymbolicLink() || !top.isDirectory() || (top.mode & 0o022) !== 0 || (top.uid !== 0 && top.uid !== helperUid)) throw unsafe();
  const req = await lstat(dirs.requests).catch(() => null);
  if (!req || req.isSymbolicLink() || !req.isDirectory() || req.uid !== helperUid) throw unsafe();
  if ((req.mode & 0o1000) === 0 || (req.mode & 0o040) !== 0 || (req.mode & 0o007) !== 0) throw unsafe();
  const res = await lstat(dirs.results).catch(() => null);
  if (!res || res.isSymbolicLink() || !res.isDirectory() || res.uid !== helperUid || (res.mode & 0o027) !== 0) throw unsafe();
}

/** A request file read without following links: regular, one link, small, strict schema. */
async function readRequest(path: string, id: string): Promise<ProfileSource | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_REQUEST_BYTES) return null;
    const parsed = RequestSchema.safeParse(JSON.parse((await handle.readFile()).toString("utf8")));
    if (!parsed.success || parsed.data.request_id !== id) return null;
    return parseInstagramProfileUrl(parsed.data.url);
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

type Ledger = { day: string; count: number; lastAt: number };

async function readLedger(stateDir: string): Promise<Ledger> {
  try {
    const value = JSON.parse(await readFile(join(stateDir, "capture-rate.json"), "utf8")) as Ledger;
    if (typeof value.day === "string" && Number.isInteger(value.count) && Number.isFinite(value.lastAt)) return value;
  } catch {
    /* fresh */
  }
  return { day: "", count: 0, lastAt: 0 };
}

const STATUS_BY_CODE: Record<SignedInCaptureCode, StatusCode> = {
  CAPTURED: "CAPTURED",
  LOGIN_REQUIRED: "LOGIN_REQUIRED",
  INSTAGRAM_CHALLENGE: "INSTAGRAM_CHALLENGE",
  INSTAGRAM_CAPTCHA: "INSTAGRAM_CAPTCHA",
  PUBLIC_SOURCE_UNAVAILABLE: "PUBLIC_SOURCE_UNAVAILABLE",
  CAPTURE_FAILED: "CAPTURE_FAILED",
  BROWSER_BUSY: "BROWSER_BUSY",
};

/** Writes one result directory: the PNGs first, status.json last (atomically). */
async function writeResult(resultsDir: string, id: string, status: Omit<CaptureStatus, "version" | "request_id" | "finished_at">, sources: string[], now: Date): Promise<void> {
  const dir = join(resultsDir, id);
  await mkdir(dir, { mode: 0o750 });
  await chmod(dir, 0o750);
  const files: string[] = [];
  for (const [i, source] of sources.entries()) {
    const name = RESULT_FILES.find((n) => source.endsWith(`/${n}`));
    if (!name || files.includes(name) || i >= RESULT_FILES.length) continue;
    const data = await readFile(source);
    if (data.length > MAX_RESULT_PNG_BYTES || !data.subarray(0, PNG.length).equals(PNG)) continue;
    const handle = await open(join(dir, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o640);
    try {
      await handle.writeFile(data);
      await handle.chmod(0o640);
    } finally {
      await handle.close();
    }
    files.push(name);
  }
  const full: CaptureStatus = { version: 1, request_id: id, ...status, files: status.code === "CAPTURED" ? (files as CaptureStatus["files"]) : [], finished_at: now.toISOString() };
  // Group-readable before it appears under its name (the requester polls for it).
  const temp = join(dir, `.status-${process.pid}.tmp`);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o640);
  try {
    await handle.writeFile(`${JSON.stringify(full)}\n`);
    await handle.chmod(0o640);
  } finally {
    await handle.close();
  }
  await rename(temp, join(dir, "status.json"));
}

export type HelperRun = { processed: Array<{ requestId: string; code: StatusCode }>; removedResults: number; deferred: number };

export async function runCaptureHelper(options: HelperOptions): Promise<HelperRun> {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = options.log ?? (() => undefined);
  const limits = options.limits ?? HELPER_LIMITS;
  await checkSpool(options.spoolRoot, options.env.uid);
  const dirs = spoolDirs(options.spoolRoot);
  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  await mkdir(options.workRoot, { recursive: true, mode: 0o700 });
  const lock = await acquireLock(options.stateDir, now(), "capture-helper.lock");
  if (!lock) throw new HelperError("HELPER_BUSY");
  const run: HelperRun = { processed: [], removedResults: 0, deferred: 0 };
  try {
    // ---- retention: results older than a day are deleted
    for (const name of await readdir(dirs.results)) {
      const info = await lstat(join(dirs.results, name)).catch(() => null);
      if (info && now().getTime() - info.mtimeMs > RESULT_KEEP_MS) {
        await rm(join(dirs.results, name), { recursive: true, force: true });
        run.removedResults += 1;
      }
    }

    const ledger = await readLedger(options.stateDir);
    const entries = await readdir(dirs.requests);
    for (const name of entries.sort()) {
      const path = join(dirs.requests, name);
      const match = REQUEST_FILE.exec(name);
      if (!match) {
        // half-written temp files get an hour; anything else that is not a request goes
        const info = await lstat(path).catch(() => null);
        if (info && (!name.startsWith(".tmp-") || now().getTime() - info.mtimeMs > STRAY_KEEP_MS)) await rm(path, { recursive: true, force: true });
        continue;
      }
      const id = match[1]!;
      if (await lstat(join(dirs.results, id)).catch(() => null)) {
        await rm(path, { recursive: true, force: true }); // an id is answered once
        continue;
      }
      if (run.processed.length >= limits.perRun) {
        run.deferred += 1;
        continue;
      }
      const source = await readRequest(path, id);
      await rm(path, { recursive: true, force: true });
      if (!source) {
        await writeResult(dirs.results, id, { code: "REQUEST_INVALID", files: [], softened: 0 }, [], now());
        run.processed.push({ requestId: id, code: "REQUEST_INVALID" });
        log(`${id}: REQUEST_INVALID`);
        continue;
      }
      const day = now().toISOString().slice(0, 10);
      if (ledger.day !== day) Object.assign(ledger, { day, count: 0 });
      if (ledger.count >= limits.perDay) {
        await writeResult(dirs.results, id, { code: "RATE_CAPPED", files: [], softened: 0 }, [], now());
        run.processed.push({ requestId: id, code: "RATE_CAPPED" });
        log(`${id}: RATE_CAPPED`);
        continue;
      }
      const wait = ledger.lastAt + limits.minIntervalMs - now().getTime();
      if (wait > 0) await sleep(wait);
      ledger.count += 1;
      ledger.lastAt = now().getTime();
      await writeJsonAtomic(join(options.stateDir, "capture-rate.json"), ledger);

      const work = join(options.workRoot, id);
      await rm(work, { recursive: true, force: true });
      await mkdir(work, { recursive: true, mode: 0o700 });
      let code: StatusCode;
      let reason: string | undefined;
      let files: string[] = [];
      let softened = 0;
      try {
        const result = await runSignedInCapture({
          profileDir: options.profileDir,
          stateDir: options.stateDir,
          env: options.env,
          target: options.targetFor ? options.targetFor(source) : instagramTarget(source),
          outDir: work,
          launchPersistent: options.launchPersistent,
          settleMs: options.settleMs,
        });
        code = STATUS_BY_CODE[result.code];
        reason = result.reason;
        files = result.files;
        softened = result.softened;
      } catch (error) {
        code = "HELPER_ERROR";
        reason = error instanceof ProfileError ? error.code : undefined;
      }
      try {
        await writeResult(dirs.results, id, { code, ...(reason && /^[A-Z][A-Z0-9_]{0,63}$/.test(reason) ? { reason } : {}), files: [], softened }, code === "CAPTURED" ? files : [], now());
      } finally {
        await rm(work, { recursive: true, force: true });
      }
      run.processed.push({ requestId: id, code });
      log(`${id}: ${code}${reason ? ` (${reason})` : ""}`);
      // A wall or an expired session: stop here; the rest waits for a person.
      if (code === "LOGIN_REQUIRED" || code === "INSTAGRAM_CHALLENGE" || code === "INSTAGRAM_CAPTCHA") break;
    }
    return run;
  } finally {
    await checkProfileTree(options.profileDir, options.env, { tighten: true }).catch(() => undefined);
    await lock.release().catch(() => undefined);
  }
}

/** Removes the helper's leftover private working copies (after a crash). */
export async function cleanWorkRoot(workRoot: string): Promise<void> {
  await rm(workRoot, { recursive: true, force: true });
  await mkdir(workRoot, { recursive: true, mode: 0o700 });
}
