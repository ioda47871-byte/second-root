/**
 * The design-image PoC (DEV-074; 第2案 DEV-075): ONE Codex call that asks
 * Codex's built-in image tool for one original web-design mockup PNG of the
 * fictional wagashi shop (DEV-073 fixture), from the chosen art direction
 * (v2 by default, v1 on request; prompt.ts). Human-approved, local, run by
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
 * - diagnostics (DEV-077, diagnostics.ts): on every outcome once the output
 *   root is ready, BEFORE the cleanup removes anything, a diag-XXXXXX/
 *   diagnostics.json (0700 / 0600) of fixed codes, booleans and numbers only
 *   (event / item type counts from an allowlist, error codes, agent message
 *   count and length, timings, exit, where image files are); it never changes
 *   what the cleanup removes
 * - DEV-078 (capability.ts): preflight before the one model call — a
 *   $CODEX_HOME/.env stops the run (CODEX_DOTENV_PRESENT: Codex would load an
 *   API key from it), `codex --version` runs in the same jail
 *   (CODEX_PREFLIGHT_FAILED when it cannot); `-c features.image_generation=true`
 *   pins the image tool's flag on the command line (never in config.toml);
 *   after the call the CLI's session log is read in memory for fixed facts (was
 *   the image tool called, did it fail and why) and the final answer becomes one
 *   fixed code; an image-tool usage limit stops as CODEX_QUOTA, another tool
 *   failure as CODEX_IMAGE_TOOL_FAILED. Still exactly one model call, no retry.
 * - DEV-080: `codex exec` writes the session log in the paginated history mode
 *   (the tool's structured end record is an item_completed Extension item, not
 *   image_generation_end), and with a code_mode_only model (the default when no
 *   `-m` is given) imagegen is called from a code-mode `exec` cell, so there is
 *   no `function_call imagegen` at all. No image call seen in code mode is
 *   TOOL_NOT_SEEN_CODE_MODE (class `inconclusive`), never TOOL_NOT_CALLED. No
 *   model or config override is passed (forcing a direct-mode model needs approval).
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
import {
  CodexEventTracker,
  DIAGNOSTICS_SCHEMA,
  diagnosticsSummary,
  generatedImageEntries,
  snapshotImageLocations,
  type ImageLocationDiagnostics,
  type PocDiagnostics,
} from "./diagnostics";
import {
  classifyAnswerText,
  codexDotenvPresent,
  deriveImageOutcome,
  parseCodexVersion,
  readSessionFacts,
  type AnswerTextCode,
  type ImageOutcome,
  type SessionFacts,
} from "./capability";
import { PngError, readPngNoFollow } from "./png";
import { buildMockupPrompt, DEFAULT_DIRECTION_VERSION, DIRECTION_VERSIONS, loadPocInputs, POC_SHOP_KEY, PocDirectionError, PocInputError, type DirectionVersion } from "./prompt";

/** The diagnostics snapshot before the cleanup waits at most this long (it only reads and counts). */
const DIAGNOSTICS_MAX_MS = 5_000;
/** One image call: at most 15 minutes (the jail's run and the shell budget hold the whole PoC). */
export const POC_CODEX_TIMEOUT_MS = 15 * 60 * 1000;
export const POC_STATUS = "IMAGE_GENERATED_NOT_IMPLEMENTED";
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PNG_NAME = /^[A-Za-z0-9_.-]{1,120}\.png$/i;
const CODE = /^[A-Z][A-Z0-9_]{2,40}$/;

export type PocCode =
  | "POC_NOT_APPROVED"
  | "POC_INPUT_INVALID"
  | "POC_DIRECTION_INVALID"
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
  | "CODEX_IMAGE_UNSUPPORTED_FORMAT"
  | "CODEX_IMAGE_INVALID"
  | "CODEX_DOTENV_PRESENT"
  | "CODEX_PREFLIGHT_FAILED"
  | "CODEX_IMAGE_TOOL_FAILED";

/**
 * How automation treats a stop (DEV-078, docs/operations/design-image-poc.md
 * "Stop classes"). No class ever retries the same request on its own:
 *
 * - approval / input: nothing was started; fix the request or get approval
 * - environment: the machine, sign-in, jail or plan usage; halt and alert, no model call is worth retrying
 * - capability: the image tool failed, or the model said it has none; halt and alert, check HUMAN-021's local steps
 * - request: Codex ran but made no image (e.g. answered in text); a failure of this request, never retried as is
 * - inconclusive (DEV-080): no image call is visible, but the model reached imagegen only through code-mode
 *   `exec` cells (TOOL_NOT_SEEN_CODE_MODE), where a call refused before it started leaves no record; it is not
 *   known whether the model tried. Halt and alert a human; never read as a prompt problem, never retried
 * - output: an image came but was refused (format, PNG checks)
 * - interrupted: time budget, timeout or a signal; check for an OOM kill first
 */
export type PocStopClass = "approval" | "input" | "environment" | "capability" | "inconclusive" | "request" | "output" | "interrupted";

const STOP_CLASSES: Readonly<Record<string, PocStopClass>> = {
  POC_NOT_APPROVED: "approval",
  POC_INPUT_INVALID: "input",
  POC_DIRECTION_INVALID: "input",
  POC_OUTPUT_UNSAFE: "environment",
  CODEX_NOT_INSTALLED: "environment",
  CODEX_NOT_SIGNED_IN: "environment",
  CODEX_API_KEY_AUTH: "environment",
  CODEX_SANDBOX_UNAVAILABLE: "environment",
  CODEX_SANDBOX_LEAK: "environment",
  CODEX_SANDBOX_CONFIG: "environment",
  CODEX_QUOTA: "environment",
  CODEX_DOTENV_PRESENT: "environment",
  CODEX_PREFLIGHT_FAILED: "environment",
  CODEX_IMAGE_TOOL_FAILED: "capability",
  CODEX_EXEC_FAILED: "request",
  CODEX_NO_THREAD: "request",
  CODEX_NO_IMAGE: "request",
  CODEX_IMAGE_INVALID: "output",
  CODEX_IMAGE_UNSUPPORTED_FORMAT: "output",
  CODEX_TIMEOUT: "interrupted",
  POC_STOPPED_BY_SIGNAL: "interrupted",
  POC_RUN_TIME_BUDGET: "interrupted",
  POC_UNEXPECTED: "interrupted",
};

/**
 * The class of a stop. A text answer that says the image tool is unavailable
 * (with no image tool call in the CLI's session log) is a capability stop: it
 * only ever halts, it never loosens anything, so the model's words may choose it.
 * No image call seen while imagegen was reachable only from code-mode cells is `inconclusive` whatever the
 * answer says (DEV-080): the model's view of its tools there says nothing about whether the tool was offered.
 */
export function pocStopClass(code: string, outcome?: ImageOutcome | null, answer?: AnswerTextCode | null): PocStopClass {
  if (code === "CODEX_NO_IMAGE" && outcome === "TOOL_NOT_SEEN_CODE_MODE") return "inconclusive";
  if (code === "CODEX_NO_IMAGE" && outcome === "TOOL_NOT_CALLED" && answer === "TEXT_TOOL_UNAVAILABLE") return "capability";
  return STOP_CLASSES[code] ?? "interrupted";
}

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
  /** The art direction the prompt was built from (v1 / v2). */
  direction_version: DirectionVersion;
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

/**
 * v2 adds: the wagashi images are AI concept visuals (never real products), and
 * the image counts for nothing until it is scored against the PoC rubric
 * (docs/operations/design-image-eval-template.md).
 */
export const REPORT_NOTES_V2 = [...REPORT_NOTES, "AI_FOOD_VISUALS_CONCEPT_ONLY", "EVALUATION_REQUIRED"] as const;

export const reportNotes = (version: DirectionVersion): readonly string[] => (version === "v2" ? REPORT_NOTES_V2 : REPORT_NOTES);

export type PocResult = { status: "done"; dir: string; report: PocReport } | { status: "refused" | "stopped"; code: PocCode };

export interface PocOptions {
  /** The human's explicit approval of this one run (--human-approval-confirmed). */
  humanApprovalConfirmed: boolean;
  repoDir: string;
  /** The art direction (v1 / v2; default v2). Anything else is refused before any file is read. */
  directionVersion?: DirectionVersion;
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
const activeCleanups = new Set<(stopCode?: string) => Promise<void>>();

/**
 * Runs every pending cleanup of a run in progress (idempotent; never throws).
 * `stopCode` (a fixed code: the entry's POC_STOPPED_BY_SIGNAL / POC_RUN_TIME_BUDGET)
 * goes into the diagnostics when the run itself has not ended yet.
 */
export async function cleanupActivePoc(stopCode?: string): Promise<void> {
  const code = stopCode !== undefined && CODE.test(stopCode) ? stopCode : undefined;
  await Promise.all([...activeCleanups].map((fn) => fn(code).catch(() => undefined)));
}

/** The diagnostics of the last run: the file (when the output root was ready) and the one-line summary. */
export interface PocDiagnosticsRecord {
  file?: string;
  summary: string;
  diagnostics: PocDiagnostics;
}
let lastDiagnostics: PocDiagnosticsRecord | undefined;
export const lastPocDiagnostics = (): PocDiagnosticsRecord | undefined => lastDiagnostics;

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
  if (pngs.length === 0) {
    // Another raster format from the image tool (a regular file, judged by its name) is reported as such,
    // never converted or accepted. Links and anything else are not counted.
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!/\.(jpe?g|webp|gif)$/i.test(name)) continue;
      const entry = await lstat(join(dir, name)).catch(() => null);
      if (entry && entry.isFile() && !entry.isSymbolicLink()) throw new PocError("CODEX_IMAGE_UNSUPPORTED_FORMAT");
    }
    throw new PocError("CODEX_NO_IMAGE");
  }
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

/** A fresh dir of ours under the output root: mkdtemp, 0700, not a link, a directory, our uid. */
async function freshDir(outRoot: string, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(outRoot, prefix));
  await chmod(dir, 0o700);
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid?.()) throw new PocError("POC_OUTPUT_UNSAFE");
  return dir;
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
  if (error instanceof PocDirectionError) return "POC_DIRECTION_INVALID";
  if (error instanceof SandboxError) return error.code === "CODEX_INPUT_REJECTED" ? "CODEX_SANDBOX_CONFIG" : error.code;
  if (error instanceof CodexError && CODE.test(error.code)) {
    const c = error.code;
    if (c === "CODEX_NO_JSON" || c === "CODEX_ANSWER_REJECTED" || c === "CODEX_INPUT_REJECTED") return "CODEX_EXEC_FAILED";
    return c;
  }
  return "POC_UNEXPECTED";
};

/**
 * `codex --version` inside the jail (DEV-078): clap prints the version and exits before any config,
 * sign-in or network. A failure to run it stops the PoC before the model call (CODEX_PREFLIGHT_FAILED);
 * an unexpected output shape is recorded as null and does not stop it.
 */
async function codexVersion(sandbox: CodexSandbox, tmpBase: string): Promise<string | null> {
  const workDir = await mkdtemp(join(tmpBase, "sr-design-codex-"));
  try {
    let result;
    try {
      result = await sandbox.run(["--version"], { workDir, timeoutMs: 30_000 });
    } catch (error) {
      if (error instanceof SandboxError) throw error;
      throw new PocError("CODEX_SANDBOX_UNAVAILABLE");
    }
    if (result.timedOut || result.code !== 0) throw new PocError("CODEX_PREFLIGHT_FAILED");
    return parseCodexVersion(result.stdout);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Runs the PoC once. Never throws: a refusal or a stop is a fixed code. */
export async function runDesignImagePoc(o: PocOptions): Promise<PocResult> {
  lastDiagnostics = undefined;
  // The human's approval comes first: without it nothing is read, created or started.
  if (o.humanApprovalConfirmed !== true) return { status: "refused", code: "POC_NOT_APPROVED" };
  // Only a direction from the fixed list; checked before anything is read or created.
  const version = o.directionVersion ?? DEFAULT_DIRECTION_VERSION;
  if (!DIRECTION_VERSIONS.includes(version)) return { status: "refused", code: "POC_DIRECTION_INVALID" };
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => undefined);
  const runStarted = now();
  /** What the diagnostics need (fixed values and numbers only; the prompt itself is never kept here). */
  const diag: {
    promptChars: number | null;
    outRoot?: string;
    tracker?: CodexEventTracker;
    invoked: boolean;
    exit: { code: number | null; signal: string | null; timedOut: boolean } | null;
    codexMs: number | null;
    codexWallStart?: number;
    beforeAll?: Set<string>;
    stopCode?: string;
    done: boolean;
    cliVersion?: string | null;
    dotenvPresent?: boolean;
    session?: SessionFacts;
    answerText?: AnswerTextCode;
  } = { promptChars: null, invoked: false, exit: null, codexMs: null, done: false };
  let cwd: string | undefined;
  let sandbox: CodexSandbox | undefined;
  let threadId: string | undefined;
  let before: Set<string> | undefined;
  /** The work dir as given and as resolved (a session log names the path Codex saw). */
  const ownCwds = new Set<string>();
  /** The result dir while its files are being written (removed by a stop before the last one). */
  let partialDest: string | undefined;
  /** Snapshot first (nothing removed yet), then write diagnostics.json; any failure here is ignored and never stops the cleanup. */
  const recordDiagnostics = async (stopCode: string | null): Promise<void> => {
    let images: ImageLocationDiagnostics | null = null;
    if (sandbox && diag.invoked) {
      const codexHome = sandbox.env.CODEX_HOME ?? join(sandbox.env.HOME ?? "/nonexistent", ".codex");
      images = await snapshotImageLocations({
        codexHome,
        ...(threadId ? { threadId } : {}),
        ...(diag.beforeAll ? { before: diag.beforeAll } : {}),
        ...(cwd ? { cwd } : {}),
        sinceMs: (diag.codexWallStart ?? Date.now()) - 1000,
      }).catch(() => null);
    }
    const tracker = diag.tracker;
    tracker?.end(tracker.sawLiveOutput);
    // A stop before the session log was read (a signal mid-call, when the thread id never came from stdout): read
    // it now, before the cleanup removes it — by this thread's id when known, else, as the cleanup finds it, the
    // log whose cwd is this run's own work dir (never another call's).
    if (sandbox && diag.invoked && diag.session === undefined && (threadId || ownCwds.size > 0)) {
      const codexHome = sandbox.env.CODEX_HOME ?? join(sandbox.env.HOME ?? "/nonexistent", ".codex");
      diag.session = await readSessionFacts(codexHome, threadId ? { threadId } : { cwds: ownCwds }).catch(() => undefined);
    }
    const outcome = diag.invoked && diag.session ? deriveImageOutcome(diag.session, stopCode === null) : null;
    const d: PocDiagnostics = {
      schema: DIAGNOSTICS_SCHEMA,
      outcome: stopCode === null ? "done" : "stopped",
      stop_code: stopCode,
      direction_version: version,
      prompt_chars: diag.promptChars,
      worker_commit: o.workerCommit && /^[0-9a-f]{7,40}$/.test(o.workerCommit) ? o.workerCommit : null,
      codex: {
        invoked: diag.invoked,
        exit_code: diag.exit?.code ?? null,
        signal: diag.exit?.signal && /^SIG[A-Z0-9]{2,10}$/.test(diag.exit.signal) ? diag.exit.signal : null,
        timed_out: diag.exit?.timedOut ?? false,
        thread_id_present: threadId !== undefined || (tracker?.result().thread_started ?? false),
      },
      timings_ms: {
        total: now() - runStarted,
        codex: diag.codexMs,
        first_event: tracker?.firstEventMs ?? null,
        first_image_tool_event: tracker?.firstImageToolMs ?? null,
      },
      events: tracker ? tracker.result() : null,
      images,
      preflight: diag.dotenvPresent === undefined ? null : { cli_version: diag.cliVersion ?? null, dotenv_present: diag.dotenvPresent },
      session: diag.session ?? null,
      classification: {
        image_outcome: outcome,
        answer_text: diag.answerText ?? null,
        stop_class: stopCode === null ? null : pocStopClass(stopCode, outcome, diag.answerText),
      },
    };
    const record: PocDiagnosticsRecord = { summary: diagnosticsSummary(d), diagnostics: d };
    if (diag.outRoot) {
      try {
        const dir = await freshDir(diag.outRoot, "diag-");
        await writeNew(join(dir, "diagnostics.json"), `${JSON.stringify(d, null, 2)}\n`);
        record.file = join(dir, "diagnostics.json");
      } catch {
        // no diagnostics file; the summary line still says what is known
      }
    }
    lastDiagnostics = record;
  };
  const doCleanup = async (signalCode?: string): Promise<void> => {
    // The stop code is frozen now: a signal's / the watchdog's code wins over whatever the run's own catch sets
    // later (e.g. CODEX_EXEC_FAILED once the killed child returns), so the diagnostics say what the entry prints.
    const stopCode = signalCode ?? (diag.done ? null : (diag.stopCode ?? "POC_STOPPED_BY_SIGNAL"));
    // At most DIAGNOSTICS_MAX_MS, so a signal's 20 s cleanup window still removes everything below.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([recordDiagnostics(stopCode).catch(() => undefined), new Promise<void>((r) => (timer = setTimeout(r, DIAGNOSTICS_MAX_MS)))]);
    clearTimeout(timer);
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
  const cleanup = (signalCode?: string): Promise<void> => (pending ??= doCleanup(signalCode).catch(() => undefined));
  activeCleanups.add(cleanup);
  try {
    const inputs = await loadPocInputs(o.repoDir, version);
    const prompt = buildMockupPrompt(inputs);
    diag.promptChars = prompt.length;
    const outRoot = await prepareOutRoot(o, o.env.CODEX_HOME || (o.env.HOME ? join(o.env.HOME, ".codex") : undefined));
    diag.outRoot = outRoot;
    const protectedPaths = [...new Set([...workerProtectedPaths({ ...o.workerPaths, env: o.env }), outRoot])];
    sandbox = await o.prepareSandbox(childEnvironment(o.env), protectedPaths).catch((error: unknown) => {
      throw fromSandboxError(error);
    });
    const codexHome = sandbox.env.CODEX_HOME ?? join(sandbox.env.HOME ?? "/nonexistent", ".codex");
    // Preflight 1 (DEV-078), before any Codex process: Codex loads $CODEX_HOME/.env into its own
    // environment (only CODEX_* keys are filtered), which would bypass the env allowlist. Never opened.
    diag.dotenvPresent = await codexDotenvPresent(codexHome);
    if (diag.dotenvPresent) throw new PocError("CODEX_DOTENV_PRESENT");
    await removeStaleDesignAgentState(sandbox.env, codexHome);
    await assertChatGptSignIn({ sandbox });
    // Preflight 2 (DEV-078): `codex --version` in the same jail, same env (no config, no network, no model).
    diag.cliVersion = await codexVersion(sandbox, o.tmpBase);
    before = await imageThreads(codexHome);
    diag.beforeAll = await generatedImageEntries(codexHome);
    cwd = await mkdtemp(join(o.tmpBase, "sr-design-codex-"));
    ownCwds.add(cwd);
    ownCwds.add(await realpath(cwd));
    const started = now();
    const tracker = new CodexEventTracker(started, now);
    diag.tracker = tracker;
    diag.codexWallStart = Date.now();
    diag.invoked = true;
    log("codex: one image call");
    let result;
    try {
      // features.image_generation=true (DEV-078): the image tool's feature flag (stable, on by default in 0.163.0)
      // pinned on the command line, so a config.toml cannot switch it off; an older CLI only warns about the key.
      result = await sandbox.run(["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--json", "-c", 'model_provider="openai"', "-c", "features.image_generation=true", "--cd", cwd, "-"], {
        workDir: cwd,
        input: prompt,
        timeoutMs: o.timeoutMs ?? POC_CODEX_TIMEOUT_MS,
        onStdout: (chunk) => tracker.feed(chunk),
      });
    } catch (error) {
      // DEV-079: the jail refused before the spawn (a probe failure, a .env): Codex never started (codex=0)
      if (error instanceof SandboxError && !error.started) diag.invoked = false;
      if (error instanceof SandboxError) throw error;
      throw new PocError("CODEX_SANDBOX_UNAVAILABLE");
    }
    const codexMs = now() - started;
    diag.codexMs = codexMs;
    diag.exit = { code: result.code, signal: result.signal, timedOut: result.timedOut };
    // a sandbox that did not stream (or a cut stream): the counts from the whole stdout, without timings
    if (!tracker.sawLiveOutput) {
      tracker.feed(result.stdout, false);
      tracker.end(false);
    }
    const events = readCodexEvents(result.stdout);
    if (events.threadId !== undefined && THREAD_ID.test(events.threadId)) threadId = events.threadId;
    // In memory only: the final answer becomes one fixed code (the text is not kept), and the CLI's own
    // session log gives fixed facts about the image tool before the cleanup removes it (capability.ts).
    diag.answerText = classifyAnswerText(events.lastMessage);
    diag.session = await readSessionFacts(codexHome, threadId).catch(() => undefined);
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
      // The image tool's own failure (the CLI's record / the tool's output, never the model's answer).
      if (error instanceof PocError && error.code === "CODEX_NO_IMAGE" && diag.session) {
        const outcome = deriveImageOutcome(diag.session, false);
        if (outcome === "TOOL_FAILED_USAGE_LIMIT") throw new PocError("CODEX_QUOTA");
        if (outcome === "TOOL_FAILED" || outcome === "TOOL_FAILED_POLICY") throw new PocError("CODEX_IMAGE_TOOL_FAILED");
      }
      throw error;
    }
    const report: PocReport = {
      status: POC_STATUS,
      shop: POC_SHOP_KEY,
      direction_version: inputs.version,
      width: image.width,
      height: image.height,
      aspect_h_per_w: Math.round((image.height / image.width) * 1000) / 1000,
      png_bytes: image.bytes.length,
      png_sha256: createHash("sha256").update(image.bytes).digest("hex"),
      png_chunks: image.chunks,
      codex_ms: codexMs,
      prompt_chars: prompt.length,
      worker_commit: o.workerCommit && /^[0-9a-f]{7,40}$/.test(o.workerCommit) ? o.workerCommit : null,
      notes: reportNotes(inputs.version),
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
      diag.done = true;
    } catch {
      await rm(dest, { recursive: true, force: true });
      throw new PocError("POC_OUTPUT_UNSAFE");
    }
    return { status: "done", dir: dest, report };
  } catch (error) {
    const code = codeOf(error);
    diag.stopCode = code;
    return { status: code === "POC_INPUT_INVALID" || code === "POC_DIRECTION_INVALID" ? "refused" : "stopped", code };
  } finally {
    await cleanup();
    activeCleanups.delete(cleanup);
  }
}
