/**
 * Issue #302 P1 test fixture: stands in for scripts/sales-design-worker/imagefirst-worker.ts in the automatic start's
 * fake WSL (autostart.test.ts). The fake clone's node_modules/.bin/tsx runs this file instead of the real worker, with
 * the same arguments and environment the wrapper gives the real one. It does what the real worker's main() does — the
 * same stop signals and timings (WORKER_STOP), the same grant from the environment, the same cycle
 * (runImagefirstCycle) over the clone it was started in, the same places under HOME — except that the entry is played
 * in-process against the fake Codex (./support), at the fixed test clock. No Codex, no model, no network.
 *
 * Settings, files in HOME written by the test: fake-codex-mode (six | fail | hang), fake-worker-hold (wait while it
 * exists). Records: fake-worker-starts.log (one line per start), codex-execs.log (one line per fake Codex run).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { exitCodeOf, gitCommitState, grantFromEnv, runImagefirstCycle, WORKER_STOP } from "../../../../../lib/design-agent/imagefirst-worker/cycle";
import { openLedger } from "../../../../../lib/design-agent/phase2f-live/ledger";
import { fileAtCommit, runMain, say, stopSignals } from "../../../../../scripts/design-artifact/phase2f-live-cli";
import { ENV, entryInProcess, fakeCodex, NOW } from "../support";

process.umask(0o077);
let recordInterrupted: (() => Promise<void>) | null = null;
const { controller } = stopSignals({ hardStopMs: WORKER_STOP.hardStopMs, cleanup: async () => recordInterrupted?.() });

async function main(): Promise<number> {
  const home = homedir();
  appendFileSync(join(home, "fake-worker-starts.log"), `${JSON.stringify({ argv: process.argv.slice(2), grant: process.env.SR_IMAGEFIRST_EXPECT_APPROVAL_ID ?? null })}\n`);
  if (process.argv.length !== 3 || process.argv[2] !== "scripts/sales-design-worker/imagefirst-worker.ts") return (say({ status: "refused", code: "USAGE", invoked: false }), 2);
  const grant = grantFromEnv(process.env);
  if (grant === null) return (say({ status: "refused", code: "GRANT_INVALID", invoked: false }), 2);
  for (let i = 0; existsSync(join(home, "fake-worker-hold")) && i < 600; i++) await new Promise((r) => setTimeout(r, 50));
  const repo = process.cwd();
  const mode = readFileSync(join(home, "fake-codex-mode"), "utf8").trim() as "six" | "fail" | "hang";
  const codexRoot = join(home, "fake-codex");
  mkdirSync(codexRoot, { recursive: true });
  const fake = fakeCodex(mode, codexRoot, () => appendFileSync(join(home, "codex-execs.log"), "exec\n"));
  const stateDir = join(home, ".local", "state", "sr-design-worker", "imagefirst-worker");
  const ledgerDir = join(home, ".local", "state", "sr-design-worker", "phase2f-live");
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
