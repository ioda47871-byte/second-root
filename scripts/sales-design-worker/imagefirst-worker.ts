/**
 * Issue #298 P1: one cycle of the IMAGE_FIRST worker adapter (lib/design-agent/imagefirst-worker/cycle.ts). Started by
 * hand by the owner as the worker user (sr-designgen) in the worker's clone, after that clone was put on origin/develop
 * (docs/operations/imagefirst-worker-port.md §5). Issue #302 P1: or once by root's wrapper imagefirst-autostart.sh (pull
 * model, OFF by default; its unit and timer are NOT installed or enabled by anything in this repository), which passes
 * the approval id of root's one-use run marker in GRANT_ENV: the packet's d3 approval id must then be exactly that one
 * (APPROVAL_NOT_GRANTED). A malformed grant is refused (GRANT_INVALID) before anything. Nothing else changes.
 *
 *   node --import tsx scripts/sales-design-worker/imagefirst-worker.ts
 *
 * (node with the tsx loader, not the tsx CLI: the CLI relays Ctrl-C / SIGTERM a second time, which would be a hard stop.)
 *
 * Takes no arguments: the job is the approval packet as committed at HEAD (= origin/develop), within the fixed
 * allowlist (ほし窯 d3). When it is approved and unused, the existing owner entry (GENERATE_ENTRY) is started
 * ONCE in its own process group, with the allowlisted environment (no API key or token), bounded by the entry's own
 * watchdog plus a margin. SIGTERM / SIGINT / SIGHUP are passed on (the entry records the call as aborted), and an
 * interrupted run always ends with a receipt (stop code WORKER_INTERRUPTED) and an audit line (WORKER_STOP in cycle.ts):
 * the entry gets its own 20 s + 10 s to stop, the worker kills it only after 35 s, and only if the worker itself is still
 * waiting at 50 s (or gets a second signal) does it kill everything and record the receipt from what is on disk.
 * The claim stays used either way; nothing is retried.
 *
 * Places (outside the repository, 0700): state ~/.local/state/sr-design-worker/imagefirst-worker (lock, claims,
 * audit.jsonl), runs ~/sr-runs/<approval>-<UTC> (+ .receipt.json), the entry's ledger (phase2f, unchanged).
 *
 * One JSON line on stdout. Exit: 0 no job / locked / succeeded, 2 refused (nothing invoked), 1 invoked and stopped.
 * `--precheck`: every check of the cycle up to, not including, the claim, with no lock, audit line or write; exit 0 = it
 * would run now ("would_run"), 3 = no job, 2 = refused.
 *
 * Issue #302 P3 follow-up (docs/operations/imagefirst-review-handoff.md §4): after a cycle that ended "succeeded", the
 * same process hands that run to the local review inbox (~/sr-runs/review-inbox) with deliverAfterRun
 * (lib/design-agent/imagefirst-worker/deliver-review.ts: receipt checked against the packet at its commit → sealed private
 * bundle → inbox → previews + INDEX). Its result is the `review` field of the one JSON line; it never changes the exit
 * code (the run's result stands) and it can start nothing. A failed hand-off leaves the sealed bundle; the owner re-sends
 * the SAME bundle with
 *
 *   node --import tsx scripts/sales-design-worker/imagefirst-worker.ts --deliver-review <approval id>
 *
 * which runs no cycle, claims nothing and starts nothing, and refuses unless the jailed Claude (sr-jail-claude.service)
 * is stopped and disabled or masked (as the automatic start requires). Exit: 0 delivered / duplicate, 1 not delivered
 * (the bundle stays sealed for another re-send), 2 refused.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { runBounded } from "../../lib/design-agent/bounded-process";
import { deliverAfterRun, deliverReview, ReviewStop } from "../../lib/design-agent/imagefirst-worker/deliver-review";
import { checkRealApprovalId, exitCodeOf, GENERATE_ENTRY, gitCommitState, grantFromEnv, precheckExitOf, precheckImagefirstCycle, runImagefirstCycle, tsEntry, WORKER_STOP } from "../../lib/design-agent/imagefirst-worker/cycle";
import { defaultLedgerDir, openLedger, WATCHDOG_MS } from "../../lib/design-agent/phase2f-live/ledger";
import { childEnvironment } from "../../lib/design-agent/worker/env";
import { expand, fileAtCommit, insideRepo, REPO, runMain, say, stopSignals } from "../design-artifact/phase2f-live-cli";

process.umask(0o077);
/** Set once the approval is claimed: ends the run with a WORKER_INTERRUPTED receipt and audit line (never invokes). */
let recordInterrupted: (() => Promise<void>) | null = null;
const { controller } = stopSignals({ hardStopMs: WORKER_STOP.hardStopMs, cleanup: async () => recordInterrupted?.(), repeatGraceMs: WORKER_STOP.repeatGraceMs });
/**
 * The entry's own watchdog plus a 2 min margin. When it is reached (or a stop signal arrives) the entry's group gets
 * SIGTERM, then WORKER_STOP.graceMs (35 s, more than the entry's 20 s hard stop + 10 s clean-up) to record the stop
 * itself before SIGKILL.
 */
const INVOKE_TIMEOUT_MS = WATCHDOG_MS + 2 * 60_000;

/**
 * The manual re-send's mutual exclusion, the automatic start's rule (imagefirst-autostart.sh busy()): the jailed Claude is
 * idle only when its ActiveState is inactive or failed AND it is disabled or masked. Anything else, an error included, is
 * not idle (false) or cannot be told (null): refused either way.
 */
async function jailIdle(env: NodeJS.ProcessEnv): Promise<boolean | null> {
  const systemctl = (a: string[]) => runBounded("systemctl", a, { cwd: "/", env, timeoutMs: 30_000 }).catch(() => null);
  const active = await systemctl(["show", "-p", "ActiveState", "--value", "sr-jail-claude.service"]);
  if (!active || active.code !== 0 || active.stdout.trim() === "") return null;
  if (!/^(inactive|failed)$/.test(active.stdout.trim())) return false;
  const enabled = await systemctl(["is-enabled", "sr-jail-claude.service"]);
  if (!enabled) return null;
  return /^(disabled|masked)$/.test(enabled.stdout.trim());
}

async function main(): Promise<number> {
  // the arguments: none, --precheck (Issue #302 P1, the automatic start asks before it uses root's marker), or
  // --deliver-review <approval id> (Issue #302 P3 follow-up: re-send a finished run's sealed bundle to the review inbox)
  const precheck = process.argv.length === 3 && process.argv[2] === "--precheck";
  const deliver = process.argv[2] === "--deliver-review";
  if (deliver && process.argv.length !== 4) return (say({ status: "refused", code: "USAGE", invoked: false }), 2);
  if (process.argv.length > 2 && !precheck && !deliver) return (say({ status: "refused", code: "USAGE", invoked: false }), 2);
  const deliverId = deliver ? process.argv[3]! : null;
  if (deliverId !== null && checkRealApprovalId(deliverId) !== "ok") return (say({ status: "refused", code: checkRealApprovalId(deliverId), invoked: false }), 2);
  const grant = grantFromEnv(process.env);
  if (grant === null) return (say({ status: "refused", code: "GRANT_INVALID", invoked: false }), 2);
  const env = childEnvironment(process.env);
  const stateDir = join(expand(process.env.XDG_STATE_HOME ?? "~/.local/state"), "sr-design-worker", "imagefirst-worker");
  const runsDir = join(homedir(), "sr-runs");
  // the same ledger the entry opens (it sees only the allowlisted environment)
  const ledgerDir = defaultLedgerDir(env, homedir());
  for (const p of [stateDir, runsDir, ledgerDir]) if (await insideRepo(p)) return (say({ status: "refused", code: "PLACE_INSIDE_REPO", invoked: false }), 2);
  if (deliver) {
    // the manual re-send: no cycle, no claim, no ledger, nothing started; the same sealed bundle only
    try {
      const r = await deliverReview({ approvalId: deliverId!, runsDir, stateDir, jailIdle: () => jailIdle(env) }, { fileAt: (commit, rel) => fileAtCommit(commit, rel) });
      say({ ...r, invoked: false });
      return r.status === "not_delivered" ? 1 : 0;
    } catch (error) {
      say({ status: "refused", code: error instanceof ReviewStop ? error.code : "REVIEW_UNEXPECTED", invoked: false });
      return 2;
    }
  }
  if (precheck) {
    // every check up to the claim; no lock, no audit, no write, nothing invoked
    const r = await precheckImagefirstCycle({ repoRoot: REPO, stateDir, runsDir, ...(grant ? { expectApprovalId: grant } : {}) }, { commit: () => gitCommitState(REPO, env), fileAt: (commit, rel) => fileAtCommit(commit, rel), ledger: openLedger(ledgerDir) });
    say(r);
    return precheckExitOf(r.status);
  }
  const report = await runImagefirstCycle(
    { repoRoot: REPO, stateDir, runsDir, signal: controller.signal, onInvoking: (record) => (recordInterrupted = record), ...(grant ? { expectApprovalId: grant } : {}) },
    {
      commit: () => gitCommitState(REPO, env),
      fileAt: (commit, rel) => fileAtCommit(commit, rel),
      ledger: openLedger(ledgerDir),
      invoke: (argv, signal) => runBounded(tsEntry(join(REPO, GENERATE_ENTRY), argv).bin, tsEntry(join(REPO, GENERATE_ENTRY), argv).args, { cwd: REPO, env, timeoutMs: INVOKE_TIMEOUT_MS, graceMs: WORKER_STOP.graceMs, ...(signal ? { signal } : {}) }),
    },
  );
  const review = await deliverAfterRun(report, { runsDir, stateDir }, { fileAt: (commit, rel) => fileAtCommit(commit, rel) });
  say(review ? { ...report, review } : report);
  return exitCodeOf(report.status);
}

runMain(main);
