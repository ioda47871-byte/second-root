/**
 * The design-image PoC (DEV-074): ONE Codex call that asks Codex's built-in
 * image tool for one original web-design mockup PNG of the fictional wagashi
 * shop (DEV-073 fixture). Human-approved, local, run by
 * scripts/sales-design-worker/design-image-poc.sh only (docs/operations/
 * design-image-poc.md). Same safety design as the Kaii Dokuhon image worker
 * (curiosity-media codex-image.ts, D-139 / D-141 / D-143) and the design
 * worker's Codex calls (codex.ts):
 *
 * - nothing at all happens without humanApprovalConfirmed (no file is read)
 * - Codex runs only in the worker's bubblewrap jail (prepareCodexSandbox,
 *   the worker's protected paths plus this PoC's output root), ChatGPT
 *   sign-in only (assertChatGptSignIn), `--sandbox read-only`, prompt on stdin,
 *   no reference image attached
 * - the image is taken only from CODEX_HOME/generated_images/<thread>/ (where
 *   the image tool writes; commands under `--sandbox read-only` cannot), and
 *   accepted only as a fully checked PNG (png.ts)
 * - the work dir uses the design agent's prefix (sr-design-codex-), so an
 *   interrupted run's session log is found by removeStaleCodexSessions; stale
 *   design-agent sessions and their image dirs are removed at the start
 * - every exit (also a signal: cleanupActivePoc waits for the same, complete
 *   cleanup) removes the thread's image dir and any image dir that appeared
 *   during this run (never one that existed before; none at all when the
 *   snapshot could not be taken), then the session logs whose cwd is this
 *   run's work dir, a partly written result dir, and the work dir
 * - results and failures are fixed codes and numbers; Codex's words, stdout
 *   and stderr are never copied anywhere
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import {
  assertChatGptSignIn,
  CodexError,
  codexLooksRateLimited,
  codexLooksSignedOut,
  fromSandboxError,
  listDesignAgentSessions,
  readCodexEvents,
  removeCodexSession,
  removeStaleCodexSessions,
} from "../codex";
import { workerProtectedPaths } from "../protected-paths";
import { SandboxError, type CodexSandbox } from "../sandbox";
import { childEnvironment } from "../worker/env";
import { PngError, readPngNoFollow } from "./png";
import { buildMockupPrompt, loadPocInputs, POC_SHOP_KEY, PocInputError } from "./prompt";

/** One image call: at most 15 minutes (the jail's run and the shell budget hold the whole PoC). */
export const POC_CODEX_TIMEOUT_MS = 15 * 60 * 1000;
export const POC_STATUS = "IMAGE_GENERATED_NOT_IMPLEMENTED";
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PNG_NAME = /^[A-Za-z0-9_.-]{1,120}\.png$/i;
const CODE = /^[A-Z][A-Z0-9_]{2,40}$/;

export type PocCode =
  | "POC_NOT_APPROVED"
  | "POC_INPUT_INVALID"
  | "POC_OUTPUT_UNSAFE"
  | "POC_UNEXPECTED"
  | "CODEX_NOT_INSTALLED"
  | "CODEX_NOT_SIGNED_IN"
  | "CODEX_API_KEY_AUTH"
  | "CODEX_SANDBOX_UNAVAILABLE"
  | "CODEX_SANDBOX_LEAK"
  | "CODEX_SANDBOX_CONFIG"
  | "CODEX_EXEC_FAILED"
  | "CODEX_TIMEOUT"
  | "CODEX_QUOTA"
  | "CODEX_NO_THREAD"
  | "CODEX_NO_IMAGE"
  | "CODEX_IMAGE_INVALID";

export class PocError extends Error {
  constructor(readonly code: PocCode) {
    super(code);
    this.name = "PocError";
  }
}

/** The report written next to the image: fixed codes, numbers, a hash. Never any text from Codex. */
export interface PocReport {
  status: typeof POC_STATUS;
  shop: typeof POC_SHOP_KEY;
  width: number;
  height: number;
  aspect_h_per_w: number;
  png_bytes: number;
  png_sha256: string;
  png_chunks: number;
  codex_ms: number;
  prompt_chars: number;
  worker_commit: string | null;
  notes: readonly string[];
}

export const REPORT_NOTES = [
  "NO_WEBSITE_IMPLEMENTED_OR_PUBLISHED",
  "TEXT_IN_IMAGE_IS_NOT_A_SOURCE_OF_TRUTH_USE_SHOP_FACTS_JSON",
  "HUMAN_VISUAL_REVIEW_REQUIRED",
  "FIXTURE_HOLDS_PLACEHOLDER_TEST_VALUES",
] as const;

export type PocResult = { status: "done"; dir: string; report: PocReport } | { status: "refused" | "stopped"; code: PocCode };

export interface PocOptions {
  /** The human's explicit approval of this one run (--human-approval-confirmed). */
  humanApprovalConfirmed: boolean;
  repoDir: string;
  /** Where results go (outside the repository): ~/sr-design-image-poc by default. */
  outRoot: string;
  /** The worker's own directories (hidden from Codex like the worker hides them). */
  workerPaths: { stateDir: string; queueRoot: string; outRoot: string };
  /** Base of the work dir (sr-design-codex-XXXXXX). */
  tmpBase: string;
  /** The process environment (HOME, CODEX_HOME, PATH, SR_DESIGN_ASSETS_ROOT ...); Codex gets childEnvironment of it only. */
  env: Record<string, string | undefined>;
  prepareSandbox: (env: Record<string, string | undefined>, protectedPaths: string[]) => Promise<CodexSandbox>;
  timeoutMs?: number;
  workerCommit?: string | null;
  now?: () => number;
  log?: (line: string) => void;
}

/** Whether `child` is `parent` or lies below it (a sibling named "..out" is not inside). */
export function isInsidePath(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  if (rel === "") return true;
  return !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}
const inside = isInsidePath;

/** Cleanups of the run in progress (for a signal: the entry runs them before exiting). */
const activeCleanups = new Set<() => Promise<void>>();

/** Runs every pending cleanup of a run in progress (idempotent; never throws). */
export async function cleanupActivePoc(): Promise<void> {
  await Promise.all([...activeCleanups].map((fn) => fn().catch(() => undefined)));
}

/**
 * UUID-shaped entries of CODEX_HOME/generated_images (a thread dir per Codex
 * thread). No directory yet: an empty set. Any other failure: undefined (the
 * caller then cannot tell new dirs from old ones and removes only its own thread's).
 */
async function imageThreads(codexHome: string): Promise<Set<string> | undefined> {
  try {
    return new Set((await readdir(join(codexHome, "generated_images"))).filter((n) => THREAD_ID.test(n)));
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === "ENOENT" ? new Set() : undefined;
  }
}

/** Removes the design-agent session logs whose working directory is one of `cwds` (this run's own; never another call's). */
async function removeSessionsOf(env: Record<string, string | undefined>, cwds: ReadonlySet<string>): Promise<void> {
  for (const path of await listDesignAgentSessions(env).catch(() => [] as string[])) {
    const head = await readFile(path, "utf8").then((t) => t.slice(0, 256 * 1024), () => "");
    let meta: { cwd?: unknown; payload?: { cwd?: unknown } } | null;
    try {
      meta = JSON.parse(head.split("\n")[0] ?? "") as typeof meta;
    } catch {
      continue;
    }
    const cwd = meta?.payload?.cwd ?? meta?.cwd;
    if (typeof cwd === "string" && cwds.has(cwd)) await rm(path, { force: true }).catch(() => undefined);
  }
}

/**
 * Before the run: the session logs a cut-off design-agent call left (its work
 * dir was sr-design-codex-…) and the image dirs of those same threads. Other
 * Codex sessions of the user are not touched.
 */
async function removeStaleDesignAgentState(env: Record<string, string | undefined>, codexHome: string): Promise<void> {
  const stale = await listDesignAgentSessions(env).catch(() => [] as string[]);
  for (const path of stale) {
    const thread = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(basename(path))?.[1];
    if (thread) await rm(join(codexHome, "generated_images", thread), { recursive: true, force: true }).catch(() => undefined);
  }
  await removeStaleCodexSessions(env).catch(() => 0);
}

/** The newest PNG of a thread's image dir, fully checked. */
async function takeImage(dir: string): Promise<Awaited<ReturnType<typeof readPngNoFollow>>> {
  const info = await lstat(dir).catch(() => null);
  if (!info) throw new PocError("CODEX_NO_IMAGE");
  if (info.isSymbolicLink() || !info.isDirectory()) throw new PocError("CODEX_IMAGE_INVALID");
  const pngs: Array<{ path: string; mtime: number }> = [];
  for (const name of await readdir(dir)) {
    if (!name.toLowerCase().endsWith(".png")) continue;
    const path = join(dir, name);
    const entry = await lstat(path);
    // A link or anything but a regular file where the image tool writes is not trusted at all.
    if (!PNG_NAME.test(name) || entry.isSymbolicLink() || !entry.isFile()) throw new PocError("CODEX_IMAGE_INVALID");
    pngs.push({ path, mtime: entry.mtimeMs });
  }
  if (pngs.length === 0) throw new PocError("CODEX_NO_IMAGE");
  const newest = pngs.sort((a, b) => b.mtime - a.mtime)[0]!;
  try {
    return await readPngNoFollow(newest.path);
  } catch (error) {
    if (error instanceof PngError) throw new PocError("CODEX_IMAGE_INVALID");
    throw error;
  }
}

/** A new file of ours: never through a link, never over an existing file, 0600. */
async function writeNew(path: string, data: string | Buffer): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}

/** The output root: created 0700, ours, not a link, outside the repository and every worker / Codex directory. */
async function prepareOutRoot(o: PocOptions, codexHome: string | undefined): Promise<string> {
  if (!isAbsolute(o.outRoot)) throw new PocError("POC_OUTPUT_UNSAFE");
  const repo = await realpath(o.repoDir);
  const forbidden = [o.repoDir, repo, ...Object.values(o.workerPaths), ...(codexHome ? [codexHome] : [])];
  const clear = (p: string) => forbidden.every((f) => !inside(p, f) && !inside(f, p));
  // Checked before anything is created (the configured path), and again once it exists (its real path).
  if (!clear(o.outRoot)) throw new PocError("POC_OUTPUT_UNSAFE");
  await mkdir(o.outRoot, { recursive: true, mode: 0o700 });
  const info = await lstat(o.outRoot);
  if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid?.()) throw new PocError("POC_OUTPUT_UNSAFE");
  const real = await realpath(o.outRoot);
  if (!clear(real)) throw new PocError("POC_OUTPUT_UNSAFE");
  await chmod(real, 0o700);
  return real;
}

const codeOf = (error: unknown): PocCode => {
  if (error instanceof PocError) return error.code;
  if (error instanceof PocInputError) return "POC_INPUT_INVALID";
  if (error instanceof SandboxError) return error.code === "CODEX_INPUT_REJECTED" ? "CODEX_SANDBOX_CONFIG" : error.code;
  if (error instanceof CodexError && CODE.test(error.code)) {
    const c = error.code;
    if (c === "CODEX_NO_JSON" || c === "CODEX_ANSWER_REJECTED" || c === "CODEX_INPUT_REJECTED") return "CODEX_EXEC_FAILED";
    return c;
  }
  return "POC_UNEXPECTED";
};

/** Runs the PoC once. Never throws: a refusal or a stop is a fixed code. */
export async function runDesignImagePoc(o: PocOptions): Promise<PocResult> {
  // The human's approval comes first: without it nothing is read, created or started.
  if (o.humanApprovalConfirmed !== true) return { status: "refused", code: "POC_NOT_APPROVED" };
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => undefined);
  let cwd: string | undefined;
  let sandbox: CodexSandbox | undefined;
  let threadId: string | undefined;
  let before: Set<string> | undefined;
  /** The work dir as given and as resolved (a session log names the path Codex saw). */
  const ownCwds = new Set<string>();
  /** The result dir while its files are being written (removed by a stop before the last one). */
  let partialDest: string | undefined;
  const doCleanup = async (): Promise<void> => {
    if (sandbox) {
      const codexHome = sandbox.env.CODEX_HOME ?? join(sandbox.env.HOME ?? "/nonexistent", ".codex");
      // Images first: an image dir left behind would later look "pre-existing" and never be removed.
      // The thread's image dir, and any image dir created during this run (also when the thread id never came).
      const images = join(codexHome, "generated_images");
      if (threadId) await rm(join(images, threadId), { recursive: true, force: true }).catch(() => undefined);
      if (before) {
        const after = await imageThreads(codexHome);
        for (const name of after ?? []) if (!before.has(name)) await rm(join(images, name), { recursive: true, force: true }).catch(() => undefined);
      }
      // Then the session logs: this thread's, and any whose cwd is this run's work dir (a call cut off before
      // its thread id was read). Another design-agent call's logs (design-demo, photo PoC: no run lock) are not touched.
      if (threadId) await removeCodexSession(threadId, sandbox.env).catch(() => 0);
      if (ownCwds.size > 0) await removeSessionsOf(sandbox.env, ownCwds);
    }
    if (partialDest) await rm(partialDest, { recursive: true, force: true }).catch(() => undefined);
    if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  };
  /** Memoised: every caller (the finally, a signal, the watchdog) waits for the same, complete cleanup. */
  let pending: Promise<void> | undefined;
  const cleanup = (): Promise<void> => (pending ??= doCleanup().catch(() => undefined));
  activeCleanups.add(cleanup);
  try {
    const inputs = await loadPocInputs(o.repoDir);
    const prompt = buildMockupPrompt(inputs);
    const outRoot = await prepareOutRoot(o, o.env.CODEX_HOME || (o.env.HOME ? join(o.env.HOME, ".codex") : undefined));
    const protectedPaths = [...new Set([...workerProtectedPaths({ ...o.workerPaths, env: o.env }), outRoot])];
    sandbox = await o.prepareSandbox(childEnvironment(o.env), protectedPaths).catch((error: unknown) => {
      throw fromSandboxError(error);
    });
    const codexHome = sandbox.env.CODEX_HOME ?? join(sandbox.env.HOME ?? "/nonexistent", ".codex");
    await removeStaleDesignAgentState(sandbox.env, codexHome);
    await assertChatGptSignIn({ sandbox });
    before = await imageThreads(codexHome);
    cwd = await mkdtemp(join(o.tmpBase, "sr-design-codex-"));
    ownCwds.add(cwd);
    ownCwds.add(await realpath(cwd));
    const started = now();
    log("codex: one image call");
    let result;
    try {
      result = await sandbox.run(["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--json", "-c", 'model_provider="openai"', "--cd", cwd, "-"], {
        workDir: cwd,
        input: prompt,
        timeoutMs: o.timeoutMs ?? POC_CODEX_TIMEOUT_MS,
      });
    } catch (error) {
      if (error instanceof SandboxError) throw error;
      throw new PocError("CODEX_SANDBOX_UNAVAILABLE");
    }
    const codexMs = now() - started;
    const events = readCodexEvents(result.stdout);
    if (events.threadId !== undefined && THREAD_ID.test(events.threadId)) threadId = events.threadId;
    if (result.timedOut) throw new PocError("CODEX_TIMEOUT");
    if (result.code !== 0 && codexLooksSignedOut(result.stdout, result.stderr)) throw new PocError("CODEX_NOT_SIGNED_IN");
    if (result.code !== 0 && codexLooksRateLimited(result.stdout, result.stderr)) throw new PocError("CODEX_QUOTA");
    if (result.code !== 0) throw new PocError("CODEX_EXEC_FAILED");
    if (!threadId) throw new PocError("CODEX_NO_THREAD");
    let image;
    try {
      image = await takeImage(join(codexHome, "generated_images", threadId));
    } catch (error) {
      if (error instanceof PocError && error.code === "CODEX_NO_IMAGE" && codexLooksRateLimited(result.stdout, result.stderr)) throw new PocError("CODEX_QUOTA");
      throw error;
    }
    const report: PocReport = {
      status: POC_STATUS,
      shop: POC_SHOP_KEY,
      width: image.width,
      height: image.height,
      aspect_h_per_w: Math.round((image.height / image.width) * 1000) / 1000,
      png_bytes: image.bytes.length,
      png_sha256: createHash("sha256").update(image.bytes).digest("hex"),
      png_chunks: image.chunks,
      codex_ms: codexMs,
      prompt_chars: prompt.length,
      worker_commit: o.workerCommit && /^[0-9a-f]{7,40}$/.test(o.workerCommit) ? o.workerCommit : null,
      notes: REPORT_NOTES,
    };
    if (pending) throw new PocError("POC_OUTPUT_UNSAFE"); // a stop already began: never create the result dir
    const dest = await mkdtemp(join(outRoot, `${POC_SHOP_KEY}-`));
    partialDest = dest;
    try {
      await chmod(dest, 0o700);
      await writeNew(join(dest, "mockup.png"), image.bytes);
      await writeNew(join(dest, "shop-facts.json"), `${JSON.stringify(inputs.facts, null, 2)}\n`);
      await writeNew(join(dest, "design-spec.json"), `${JSON.stringify(inputs.direction, null, 2)}\n`);
      await writeNew(join(dest, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
      if (pending) throw new PocError("POC_OUTPUT_UNSAFE"); // a stop cleaned up meanwhile: the dir is gone or incomplete
      partialDest = undefined;
    } catch {
      await rm(dest, { recursive: true, force: true });
      throw new PocError("POC_OUTPUT_UNSAFE");
    }
    return { status: "done", dir: dest, report };
  } catch (error) {
    const code = codeOf(error);
    return { status: code === "POC_INPUT_INVALID" ? "refused" : "stopped", code };
  } finally {
    await cleanup();
    activeCleanups.delete(cleanup);
  }
}
