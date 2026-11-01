/**
 * Phase 2f-2: what the real-call CLIs share (design step, image step; DEV-150: the direction step). Not an entry point.
 *
 * - argument parsing (exact flags only), the stop signals (SIGTERM / SIGINT / SIGHUP abort the call; a second
 *   signal or 20 s later every process is killed) and the watchdog;
 * - the places: the output dir (outside the repository, its parent a real directory that does not contain what
 *   the sandbox needs) and the ledger (outside the repository);
 * - the commit pin (git), and the preflight before an approval is used: the .env rule and the sandbox set-up
 *   (no Codex, no bubblewrap started; bubblewrap's own probe runs right before the call, as for every Codex call).
 * - DEV-150 (owner approval A′): the generation pin, only when asked for (--expect-cli-version, --previous-steps;
 *   required by the three-method entries): the Codex CLI version, read with one sandboxed `codex --version` (the same
 *   probe every real call already makes; no model is called), must be the approved one, and the earlier calls named
 *   must all have succeeded with that version and one and the same model. Checked in the preflight, so a mismatch
 *   refuses the call before its approval is used. The model itself cannot be known before a call (the CLI picks it;
 *   it is read from the session log afterwards): a changed model is caught at the next call, by --previous-steps.
 */
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { killAllBoundedChildren, runBounded } from "../../lib/design-agent/bounded-process";
import { codexDotenvPresent, parseCliVersion } from "../../lib/design-agent/codex";
import { defaultLedgerDir, openLedger, WATCHDOG_MS, type CallKind, type Ledger, type Route } from "../../lib/design-agent/phase2f-live/ledger";
import { readStep, StepStop, type CommitState } from "../../lib/design-agent/phase2f-live/steps";
import { workerProtectedPaths } from "../../lib/design-agent/protected-paths";
import { prepareCodexSandbox, SandboxError, type CodexSandbox } from "../../lib/design-agent/sandbox";
import { childEnvironment } from "../../lib/design-agent/worker/env";

export const REPO = resolve(__dirname, "../..");
export const expand = (p: string) => resolve(p.replace(/^~(?=$|\/)/, homedir()));
const within = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
/** A path with links resolved as far as it exists (the part that does not exist yet is kept as written). */
async function real(p: string): Promise<string> {
  const abs = resolve(p);
  const r = await realpath(abs).catch(() => null);
  if (r !== null) return r;
  const up = dirname(abs);
  return up === abs ? abs : join(await real(up), abs.slice(up.length + (up.endsWith("/") ? 0 : 1)));
}
export const insideRepo = async (p: string) => within(await real(p), await real(REPO));

/**
 * The output dir's parent is hidden from Codex (it holds every run's results). Hiding it must not hide what the
 * sandbox needs (Codex's home, the temp dir its work dir is made in, the home dir) or the repository: such a
 * parent is refused before the approval is used.
 */
async function outParentProblem(out: string): Promise<string | null> {
  const parent = await realpath(dirname(resolve(out))).catch(() => null);
  if (parent === null) return "OUT_DIR_PARENT_MISSING";
  const codexHome = process.env.CODEX_HOME ? expand(process.env.CODEX_HOME) : join(homedir(), ".codex");
  for (const needed of [await real(REPO), await real(tmpdir()), await real(homedir()), await real(codexHome)]) {
    if (within(needed, parent)) return "OUT_DIR_PARENT_UNSAFE";
  }
  return null;
}

export function parseArgs(argv: string[], flags: ReadonlySet<string>, values: ReadonlySet<string>): Map<string, string> | null {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (flags.has(a) && !out.has(a)) out.set(a, "1");
    else if (values.has(a) && !out.has(a) && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) out.set(a, argv[++i]!);
    else return null;
  }
  return out;
}

export const say = (o: object) => process.stdout.write(`${JSON.stringify(o)}\n`);

/**
 * The stop signals, installed at once so a signal that arrives during the checks is never lost (the call then
 * does not start): the first aborts the call (it records itself as aborted), a second one or 20 s later kills
 * every process and exits.
 */
export function stopSignals(o: { cleanup?: () => Promise<void> } = {}): { controller: AbortController; stop: () => void } {
  const controller = new AbortController();
  let stopping = false;
  // a hard stop still removes what a running call left (its session log and image dirs), for at most 10 s
  // (watchdog + 20 s + 10 s stays inside what the plan clock counts for a call without a result)
  const hardExit = (): void => {
    killAllBoundedChildren();
    const done = o.cleanup ? Promise.race([o.cleanup().catch(() => undefined), new Promise((r) => setTimeout(r, 10_000).unref())]) : Promise.resolve();
    void done.then(() => process.exit(1));
  };
  const stop = (): void => {
    if (stopping) return hardExit();
    stopping = true;
    controller.abort();
    setTimeout(hardExit, 20_000).unref();
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, stop);
  return { controller, stop };
}

/** DEV-150: what the owner approved about the Codex CLI and the earlier calls of the same pilot (see the header). */
export type GenerationPin = { expectCliVersion: string; previousSteps: string[] };
const CLI_VERSION = /^[0-9A-Za-z.+-]{1,40}$/;

/**
 * The generation pin from the flags: null when neither flag is given and it is not required; "USAGE" when required and
 * missing, or malformed (--previous-steps without --expect-cli-version is malformed too).
 */
export function generationPinOf(args: Map<string, string>, required: boolean): GenerationPin | null | "USAGE" {
  const version = args.get("--expect-cli-version");
  const previous = args.get("--previous-steps");
  if (version === undefined) return required || previous !== undefined ? "USAGE" : null;
  if (!CLI_VERSION.test(version) || !/\d/.test(version)) return "USAGE";
  const previousSteps = (previous ?? "").split(",").filter(Boolean);
  if (previous !== undefined && previousSteps.length === 0) return "USAGE";
  return { expectCliVersion: version, previousSteps };
}

/**
 * DEV-150: the generation pin's check (a stop code, or null and the earlier calls' model). Each earlier step is read
 * through readStep and must have succeeded with a known version and model; `probe` reads the CLI version now.
 */
export async function checkGeneration(o: { pin: GenerationPin; ledger: Ledger; probe: () => Promise<string | null> }): Promise<{ code: string } | { code: null; model: string | null }> {
  const models = new Set<string>();
  for (const d of o.pin.previousSteps) {
    const dir = resolve(d);
    const call = await readFile(join(dir, "call.json"), "utf8").then((t) => JSON.parse(t) as { receipt?: { kind?: CallKind; route?: Route } }, () => null);
    if (!call?.receipt?.kind || !call.receipt.route) return { code: "PREVIOUS_STEP_INVALID" };
    let step;
    try {
      step = await readStep(dir, o.ledger, { kind: call.receipt.kind, route: call.receipt.route });
    } catch (error) {
      return { code: error instanceof StepStop ? error.code : "PREVIOUS_STEP_INVALID" };
    }
    if (step.call.status !== "succeeded" || !step.generation) return { code: "PREVIOUS_STEP_NOT_SUCCEEDED" };
    if (step.generation.tool_version === null || step.generation.model_reported === null) return { code: "PREVIOUS_GENERATION_UNKNOWN" };
    if (step.generation.tool_version !== o.pin.expectCliVersion) return { code: "CODEX_CLI_VERSION_CHANGED" };
    models.add(step.generation.model_reported);
  }
  if (models.size > 1) return { code: "CODEX_MODEL_CHANGED" };
  const now = await o.probe().catch(() => null);
  if (now === null) return { code: "CODEX_CLI_VERSION_UNKNOWN" };
  if (now !== o.pin.expectCliVersion) return { code: "CODEX_CLI_VERSION_MISMATCH" };
  return { code: null, model: [...models][0] ?? null };
}

/** DEV-150: one sandboxed `codex --version` (no model call), in a private temporary work dir removed afterwards. */
export async function probeCliVersion(sandbox: CodexSandbox): Promise<string | null> {
  const workDir = await mkdtemp(join(tmpdir(), "sr-design-codex-version-"));
  try {
    const r = await sandbox.run(["--version"], { workDir, timeoutMs: 30_000 }).catch(() => null);
    return r && r.code === 0 && !r.timedOut ? parseCliVersion(r.stdout) : null;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** DEV-150: the warning a CLI prints when a call's model differs from the earlier calls' (the next call is refused by --previous-steps). */
export const modelWarning = (before: string | null, now: string | null) => (before !== null && now !== before ? ["generation_model_changed: stop before the next call (owner decision 5)"] : []);

export type LiveContext = {
  outDir: string;
  ledgerDir: string;
  env: NodeJS.ProcessEnv;
  commit: () => Promise<CommitState>;
  preflight: () => Promise<string | null>;
  /** The sandbox the preflight prepared (null before it ran or when it refused). */
  sandbox: () => CodexSandbox | null;
  /** DEV-150: the earlier calls' model when a generation pin was checked (null otherwise). */
  previousModel: () => string | null;
};

/** Checks the places and builds what a real call needs; a stop code when a place is refused (nothing used). */
export async function liveContext(out: string, stop: () => void, pin: GenerationPin | null = null): Promise<LiveContext | { code: string }> {
  if (!isAbsolute(out)) return { code: "USAGE" };
  if (await insideRepo(out)) return { code: "OUT_DIR_INSIDE_REPO" };
  const parentProblem = await outParentProblem(out);
  if (parentProblem) return { code: parentProblem };
  const stateDir = join(expand(process.env.XDG_STATE_HOME ?? "~/.local/state"), "sr-design-worker");
  const ledgerDir = resolve(defaultLedgerDir(process.env, homedir()));
  if (await insideRepo(ledgerDir)) return { code: "LEDGER_INSIDE_REPO" };
  const workerPaths = { stateDir, queueRoot: expand(process.env.SR_DESIGN_JOBS ?? "~/sr-design-jobs"), outRoot: expand("~/.local/share/second-root-design") };
  const env = childEnvironment(process.env);
  // the call's own 15 minutes are enforced by the process runner around Codex; this only ends a run that does not
  // stop by itself (it also covers the sign-in check, the version and the sandbox probes before the call)
  setTimeout(stop, WATCHDOG_MS).unref();
  // the output dir under its parent's real path (a linked parent such as ~/runs -> /mnt/d/runs is fine)
  const outDir = join(await realpath(dirname(resolve(out))), basename(resolve(out)));
  // Codex never sees the worker's directories, the ledger or where the results go
  const protectedPaths = [...new Set([...workerProtectedPaths({ ...workerPaths, env: process.env }), ledgerDir, dirname(outDir)])];
  const codexHome = process.env.CODEX_HOME ? expand(process.env.CODEX_HOME) : join(homedir(), ".codex");
  let sandbox: CodexSandbox | null = null;
  let previousModel: string | null = null;
  return {
    outDir,
    ledgerDir,
    env,
    commit: async () => {
      const git = (a: string[]) => runBounded("git", a, { cwd: REPO, env, timeoutMs: 60_000 }).then((r) => (r.code === 0 ? r.stdout : null), () => null);
      const [head, base, status] = await Promise.all([git(["rev-parse", "HEAD"]), git(["rev-parse", "origin/develop"]), git(["status", "--porcelain", "--untracked-files=all"])]);
      return { head: head?.trim() ?? null, base: base?.trim() ?? null, clean: status === "" };
    },
    preflight: async () => {
      if (await codexDotenvPresent(codexHome)) return "CODEX_DOTENV_PRESENT";
      try {
        sandbox = await prepareCodexSandbox({ env, protectedPaths });
      } catch (error) {
        return error instanceof SandboxError ? error.code : "CODEX_SANDBOX_UNAVAILABLE";
      }
      if (pin === null) return null;
      // DEV-150: the generation pin, before the approval is used
      const prepared = sandbox;
      const g = await checkGeneration({ pin, ledger: openLedger(ledgerDir), probe: () => probeCliVersion(prepared) });
      if (g.code !== null) {
        sandbox = null;
        return g.code;
      }
      previousModel = g.model;
      return null;
    },
    sandbox: () => sandbox,
    previousModel: () => previousModel,
  };
}

/**
 * DEV-150: whether every given file is inside the repository and tracked by git there (a page's picture is bound to
 * the page's bytes at the approved commit). The same bounded git as the commit pin (60 s); pathspecs are literal.
 */
export async function trackedInRepo(paths: readonly string[]): Promise<boolean> {
  const repo = await real(REPO);
  const rels: string[] = [];
  for (const p of paths) {
    const rel = relative(repo, await real(p));
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
    rels.push(rel);
  }
  if (rels.length === 0) return false;
  const r = await runBounded("git", ["--literal-pathspecs", "ls-files", "--error-unmatch", "--", ...rels], { cwd: REPO, env: childEnvironment(process.env), timeoutMs: 60_000 }).catch(() => null);
  if (r?.code !== 0) return false;
  const listed = new Set(r.stdout.split("\n").filter(Boolean));
  return rels.every((rel) => listed.has(rel));
}

/** Runs a CLI's main: its exit code, or 1 after killing every process when something unexpected happened. */
export function runMain(main: () => Promise<number>): void {
  main().then(
    (code) => process.exit(code),
    () => {
      say({ status: "stopped", code: "UNEXPECTED" });
      killAllBoundedChildren();
      process.exit(1);
    },
  );
}
