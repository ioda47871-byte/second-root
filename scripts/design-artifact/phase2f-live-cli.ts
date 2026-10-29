/**
 * Phase 2f-2: what the two real-call CLIs share (design step, image step). Not an entry point.
 *
 * - argument parsing (exact flags only), the stop signals (SIGTERM / SIGINT / SIGHUP abort the call; a second
 *   signal or 20 s later every process is killed) and the watchdog;
 * - the places: the output dir (outside the repository, its parent a real directory that does not contain what
 *   the sandbox needs) and the ledger (outside the repository);
 * - the commit pin (git), and the preflight before an approval is used: the .env rule and the sandbox set-up
 *   (no Codex, no bubblewrap started; bubblewrap's own probe runs right before the call, as for every Codex call).
 */
import { realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { killAllBoundedChildren, runBounded } from "../../lib/design-agent/bounded-process";
import { codexDotenvPresent } from "../../lib/design-agent/codex";
import { defaultLedgerDir, WATCHDOG_MS } from "../../lib/design-agent/phase2f-live/ledger";
import type { CommitState } from "../../lib/design-agent/phase2f-live/steps";
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
export function stopSignals(): { controller: AbortController; stop: () => void } {
  const controller = new AbortController();
  let stopping = false;
  const stop = (): void => {
    if (stopping) {
      killAllBoundedChildren();
      process.exit(1);
    }
    stopping = true;
    controller.abort();
    setTimeout(() => {
      killAllBoundedChildren();
      process.exit(1);
    }, 20_000).unref();
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, stop);
  return { controller, stop };
}

export type LiveContext = {
  outDir: string;
  ledgerDir: string;
  env: NodeJS.ProcessEnv;
  commit: () => Promise<CommitState>;
  preflight: () => Promise<string | null>;
  /** The sandbox the preflight prepared (null before it ran or when it refused). */
  sandbox: () => CodexSandbox | null;
};

/** Checks the places and builds what a real call needs; a stop code when a place is refused (nothing used). */
export async function liveContext(out: string, stop: () => void): Promise<LiveContext | { code: string }> {
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
        return null;
      } catch (error) {
        return error instanceof SandboxError ? error.code : "CODEX_SANDBOX_UNAVAILABLE";
      }
    },
    sandbox: () => sandbox,
  };
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
