/**
 * Issue #298 P1: one cycle of the IMAGE_FIRST worker adapter (lib/design-agent/imagefirst-worker/cycle.ts). Started by
 * hand by the owner as the worker user (sr-designgen) in the worker's clone, after that clone was put on origin/develop
 * (docs/operations/imagefirst-worker-port.md §5). No timer or unit starts it.
 *
 *   ./node_modules/.bin/tsx scripts/sales-design-worker/imagefirst-worker.ts
 *
 * Takes no arguments: the job is the approval packet as committed at HEAD (= origin/develop), within the fixed
 * allowlist (ほし窯 d3). When it is approved and unused, the existing owner entry (GENERATE_ENTRY) is started
 * ONCE in its own process group, with the allowlisted environment (no API key or token), bounded by the entry's own
 * watchdog plus a margin. SIGTERM / SIGINT / SIGHUP are passed on (the entry records the call as aborted).
 *
 * Places (outside the repository, 0700): state ~/.local/state/sr-design-worker/imagefirst-worker (lock, claims,
 * audit.jsonl), runs ~/sr-runs/<approval>-<UTC> (+ .receipt.json), the entry's ledger (phase2f, unchanged).
 *
 * One JSON line on stdout. Exit: 0 no job / locked / succeeded, 2 refused (nothing invoked), 1 invoked and stopped.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { runBounded } from "../../lib/design-agent/bounded-process";
import { exitCodeOf, GENERATE_ENTRY, gitCommitState, runImagefirstCycle } from "../../lib/design-agent/imagefirst-worker/cycle";
import { defaultLedgerDir, openLedger, WATCHDOG_MS } from "../../lib/design-agent/phase2f-live/ledger";
import { childEnvironment } from "../../lib/design-agent/worker/env";
import { expand, fileAtCommit, insideRepo, REPO, runMain, say, stopSignals } from "../design-artifact/phase2f-live-cli";

process.umask(0o077);
const { controller } = stopSignals();
/** The entry's watchdog, its 20 s hard stop and 10 s clean-up, and a margin; then the whole group is killed (SIGTERM, 25 s for the entry to record the stop, SIGKILL). */
const INVOKE_TIMEOUT_MS = WATCHDOG_MS + 2 * 60_000;

async function main(): Promise<number> {
  if (process.argv.length > 2) return (say({ status: "refused", code: "USAGE", invoked: false }), 2);
  const env = childEnvironment(process.env);
  const stateDir = join(expand(process.env.XDG_STATE_HOME ?? "~/.local/state"), "sr-design-worker", "imagefirst-worker");
  const runsDir = join(homedir(), "sr-runs");
  // the same ledger the entry opens (it sees only the allowlisted environment)
  const ledgerDir = defaultLedgerDir(env, homedir());
  for (const p of [stateDir, runsDir, ledgerDir]) if (await insideRepo(p)) return (say({ status: "refused", code: "PLACE_INSIDE_REPO", invoked: false }), 2);
  const report = await runImagefirstCycle(
    { repoRoot: REPO, stateDir, runsDir, signal: controller.signal },
    {
      commit: () => gitCommitState(REPO, env),
      fileAt: (commit, rel) => fileAtCommit(commit, rel),
      ledger: openLedger(ledgerDir),
      invoke: (argv, signal) => runBounded(join(REPO, "node_modules/.bin/tsx"), [join(REPO, GENERATE_ENTRY), ...argv], { cwd: REPO, env, timeoutMs: INVOKE_TIMEOUT_MS, graceMs: 25_000, ...(signal ? { signal } : {}) }),
    },
  );
  say(report);
  return exitCodeOf(report.status);
}

runMain(main);
