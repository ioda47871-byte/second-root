/**
 * The design-image PoC (DEV-074): one Codex image call for one original
 * web-design mockup PNG of the fictional wagashi shop 架空菓庵. HUMAN-APPROVED
 * LOCAL RUN ONLY (HUMAN-018). Never invoked by the worker, a timer, cron,
 * Vercel or CI.
 *
 * Runs only under scripts/sales-design-worker/design-image-poc.sh (the human's
 * WSL machine, inside the jail: admin.sh run sr-designgen), which holds the
 * worker's run lock, pins the checkout to origin/develop, allowlists the
 * environment and gives this process its time budget; it sets
 * SR_DESIGN_IMAGE_POC_LOCKED for this process, and without it this refuses
 * (exit 2, nothing started). See docs/operations/design-image-poc.md.
 *
 * Output (outside the repository): $SR_DESIGN_IMAGE_POC_ROOT or
 * ~/sr-design-image-poc/wagashi-XXXXXX/ (mockup.png, shop-facts.json,
 * design-spec.json, report.json). Printed: codes, numbers and that path only.
 * Direction: SR_DESIGN_IMAGE_POC_DIRECTION=v1|v2 (unset: v2, the 第2案 of
 * DEV-075); any other value is refused (POC_DIRECTION_INVALID, exit 2). The
 * v2 direction is read by this PoC only, never by the worker or the site.
 * Exit: 0 done, 1 stopped, 2 refused / usage.
 */
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { killAllBoundedChildren, runBounded } from "../../lib/design-agent/bounded-process";
import { parseDirectionVersion, PocDirectionError, type DirectionVersion } from "../../lib/design-agent/design-image/prompt";
import { cleanupActivePoc, isInsidePath, runDesignImagePoc } from "../../lib/design-agent/design-image/run";
import { prepareCodexSandbox } from "../../lib/design-agent/sandbox";
import { childEnvironment } from "../../lib/design-agent/worker/env";

const REPO = resolve(__dirname, "../..");
process.umask(0o077);
/** The jail's one run (admin.sh run: RuntimeMaxSec=3500) holds the whole PoC, as run.sh's 3300 s. */
const MAX_BUDGET_SECONDS = 3300;
const WATCHDOG_GRACE_MS = 30 * 1000;
let stopping = false;

const argv = process.argv.slice(2);
const expand = (p: string) => resolve(p.replace(/^~(?=$|\/)/, homedir()));
const insideRepo = (p: string) => isInsidePath(p, REPO);

/** Kills Codex, cleans up (session log, image dirs, work dir; at most 20 s), prints a fixed code, exits 1. */
function stopNow(code: string): void {
  if (stopping) return;
  stopping = true;
  killAllBoundedChildren();
  void Promise.race([cleanupActivePoc(), new Promise((r) => setTimeout(r, 20_000))]).then(() => {
    process.stdout.write(`${JSON.stringify({ status: "stopped", code })}\n`);
    process.stdout.write(`POC_STOP: ${code}\n`);
    process.exit(1);
  });
}

async function main(): Promise<number> {
  // The human's explicit approval comes first: without it nothing is read or started.
  if (!argv.includes("--human-approval-confirmed")) {
    process.stderr.write("STOP: --human-approval-confirmed is missing. The design-image PoC runs one Codex image call only with the human's explicit approval of this run (HUMAN-018). Nothing was started.\n");
    return 2;
  }
  // Only under design-image-poc.sh: the worker's run lock, the pinned checkout and the allowlisted environment.
  if (process.env.SR_DESIGN_IMAGE_POC_LOCKED !== "run.lock") {
    process.stderr.write("STOP: start the PoC with scripts/sales-design-worker/design-image-poc.sh (it holds the worker's run lock). Nothing was started.\n");
    return 2;
  }
  const budgetArg = argv.find((a) => a.startsWith("--budget-seconds="));
  const budgetText = budgetArg?.slice("--budget-seconds=".length);
  if (budgetText !== undefined && !/^[1-9][0-9]{1,5}$/.test(budgetText)) {
    process.stderr.write("usage: --budget-seconds=<positive integer>\n");
    return 2;
  }
  let directionVersion: DirectionVersion;
  try {
    directionVersion = parseDirectionVersion(process.env.SR_DESIGN_IMAGE_POC_DIRECTION);
  } catch (error) {
    if (!(error instanceof PocDirectionError)) throw error;
    process.stdout.write(`${JSON.stringify({ status: "refused", code: error.code })}\n`);
    process.stdout.write(`POC_STOP: ${error.code}\n`);
    return 2;
  }
  const budgetMs = Math.min(MAX_BUDGET_SECONDS, Number(budgetText ?? MAX_BUDGET_SECONDS)) * 1000;

  const outRoot = expand(process.env.SR_DESIGN_IMAGE_POC_ROOT ?? "~/sr-design-image-poc");
  const workerPaths = {
    queueRoot: expand(process.env.SR_DESIGN_JOBS ?? "~/sr-design-jobs"),
    outRoot: expand("~/.local/share/second-root-design"),
    stateDir: join(expand(process.env.XDG_STATE_HOME ?? "~/.local/state"), "sr-design-worker"),
  };
  for (const p of [outRoot, ...Object.values(workerPaths)]) {
    if (insideRepo(p)) {
      process.stderr.write("STOP: the PoC's and the worker's directories must be outside the repository. Nothing was started.\n");
      return 2;
    }
  }

  const head = await runBounded("git", ["rev-parse", "HEAD"], { cwd: REPO, env: childEnvironment(process.env), timeoutMs: 60_000 }).catch(() => null);
  const commit = head?.code === 0 ? head.stdout.trim() : null;
  setTimeout(() => stopNow("POC_RUN_TIME_BUDGET"), budgetMs + WATCHDOG_GRACE_MS).unref();
  const say = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);
  say(`design-image PoC (wagashi, direction ${directionVersion}, commit ${(commit ?? "unknown").slice(0, 12)}, budget ${Math.round(budgetMs / 60000)} min)`);
  const result = await runDesignImagePoc({
    humanApprovalConfirmed: true,
    repoDir: REPO,
    directionVersion,
    outRoot,
    workerPaths,
    tmpBase: tmpdir(),
    env: process.env,
    prepareSandbox: (e, protectedPaths) => prepareCodexSandbox({ env: e, protectedPaths }),
    timeoutMs: Math.min(15 * 60 * 1000, budgetMs),
    workerCommit: commit,
    log: say,
  });
  if (result.status === "done") {
    const r = result.report;
    process.stdout.write(`${JSON.stringify({ status: r.status, width: r.width, height: r.height, png_bytes: r.png_bytes, png_sha256: r.png_sha256, codex_ms: r.codex_ms })}\n`);
    process.stdout.write(`POC_IMAGE_READY: ${join(result.dir, "mockup.png")}\n`);
    return 0;
  }
  process.stdout.write(`${JSON.stringify({ status: result.status, code: result.code })}\n`);
  process.stdout.write(`POC_STOP: ${result.code}\n`);
  return result.status === "refused" ? 2 : 1;
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => stopNow("POC_STOPPED_BY_SIGNAL"));
process.on("unhandledRejection", () => stopNow("POC_UNEXPECTED"));

main().then(
  (code) => process.exit(code),
  () => stopNow("POC_UNEXPECTED"),
);
