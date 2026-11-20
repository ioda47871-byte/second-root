/**
 * Issue #302 P1 test fixture: stands in for scripts/sales-design-worker/imagefirst-worker.ts in the automatic start's
 * fake WSL (autostart.test.ts). The fake clone's scripts/sales-design-worker/imagefirst-worker.ts imports this file (it is
 * started as `node --import tsx scripts/sales-design-worker/imagefirst-worker.ts`, as the real one), with
 * the same arguments and environment the wrapper gives the real one. It does what the real worker's main() does — the
 * same stop signals and timings (WORKER_STOP), the same grant from the environment, the same cycle
 * (runImagefirstCycle) over the clone it was started in, the same places under HOME — except that the entry is played
 * in-process against the fake Codex (./support), at the fixed test clock. No Codex, no model, no network.
 *
 * Settings, files in HOME written by the test: fake-codex-mode (six | fail | hang), fake-codex-stop-delay-ms (hang: how long the stop takes), fake-codex-stop-hold (hang: the stop waits while it exists), fake-worker-hold (wait while it
 * exists). Records: fake-worker-starts.log (one line per start, prechecks included), codex-execs.log (one line per fake Codex run).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { exitCodeOf, gitCommitState, grantFromEnv, precheckExitOf, precheckImagefirstCycle, runImagefirstCycle, WORKER_STOP } from "../../../../../lib/design-agent/imagefirst-worker/cycle";
import { openLedger } from "../../../../../lib/design-agent/phase2f-live/ledger";
import { fileAtCommit, runMain, say, stopSignals } from "../../../../../scripts/design-artifact/phase2f-live-cli";
import { ENV, entryInProcess, fakeCodex, NOW } from "../support";

process.umask(0o077);
let recordInterrupted: (() => Promise<void>) | null = null;
const { controller } = stopSignals({ hardStopMs: WORKER_STOP.hardStopMs, cleanup: async () => recordInterrupted?.(), repeatGraceMs: WORKER_STOP.repeatGraceMs });

async function main(): Promise<number> {
  const home = homedir();
  // argv as the wrapper gave it: the script (relative to the clone) and its arguments; execArgv shows how node was started
  const args = [relative(process.cwd(), process.argv[1] ?? ""), ...process.argv.slice(2)];
  appendFileSync(join(home, "fake-worker-starts.log"), `${JSON.stringify({ argv: args, grant: process.env.SR_IMAGEFIRST_EXPECT_APPROVAL_ID ?? null, execArgv: process.execArgv })}\n`);
  const precheck = args.length === 2 && args[1] === "--precheck";
  if ((args.length !== 1 && !precheck) || args[0] !== "scripts/sales-design-worker/imagefirst-worker.ts") return (say({ status: "refused", code: "USAGE", invoked: false }), 2);
  const grant = grantFromEnv(process.env);
  if (grant === null) return (say({ status: "refused", code: "GRANT_INVALID", invoked: false }), 2);
  const stateDir = join(home, ".local", "state", "sr-design-worker", "imagefirst-worker");
  const ledgerDir = join(home, ".local", "state", "sr-design-worker", "phase2f-live");
  const repo = process.cwd();
  if (precheck) {
    const r = await precheckImagefirstCycle({ repoRoot: repo, stateDir, runsDir: join(home, "sr-runs"), ...(grant ? { expectApprovalId: grant } : {}) }, { commit: () => gitCommitState(repo, ENV), fileAt: (commit, rel) => fileAtCommit(commit, rel, repo), ledger: openLedger(ledgerDir), now: () => NOW });
    say(r);
    return precheckExitOf(r.status);
  }
  for (let i = 0; existsSync(join(home, "fake-worker-hold")) && i < 600; i++) await new Promise((r) => setTimeout(r, 50));
  const mode = readFileSync(join(home, "fake-codex-mode"), "utf8").trim() as "six" | "fail" | "hang";
  const codexRoot = join(home, "fake-codex");
  mkdirSync(codexRoot, { recursive: true });
  const delay = existsSync(join(home, "fake-codex-stop-delay-ms")) ? Number(readFileSync(join(home, "fake-codex-stop-delay-ms"), "utf8")) : 0;
  const fake = fakeCodex(mode, codexRoot, () => appendFileSync(join(home, "codex-execs.log"), "exec\n"), delay, join(home, "fake-codex-stop-hold"));
  const report = await runImagefirstCycle(
    { repoRoot: repo, stateDir, runsDir: join(home, "sr-runs"), signal: controller.signal, onInvoking: (record) => (recordInterrupted = record), ...(grant ? { expectApprovalId: grant } : {}) },
    {
      commit: () => gitCommitState(repo, ENV),
      fileAt: (commit, rel) => fileAtCommit(commit, rel, repo),
      ledger: openLedger(ledgerDir),
      now: () => NOW,
      invoke: (argv, signal) => entryInProcess(argv, { repo, ledgerDir, fake, ...(signal ? { signal } : {}) }),
    },
  );
  say(report);
  return exitCodeOf(report.status);
}

runMain(main);
