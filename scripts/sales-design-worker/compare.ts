/**
 * The local 3-shop comparison (DEV-073). Runs only under
 * scripts/sales-design-worker/compare-local.sh (the human's WSL machine, inside
 * the jail), which holds the worker's run lock, pins the checkout, allowlists
 * the environment and gives this process its time budget; it sets
 * SR_DESIGN_COMPARE_LOCKED for this process, and without it this refuses
 * (exit 2, nothing started). Never start it directly. See
 * docs/operations/design-compare-local.md.
 *
 * Paths (outside the repository; the repository is public):
 *   comparison  $SR_DESIGN_COMPARE_ROOT or ~/sr-design-compare/<compare id>/
 *               (runs/<run id>/ = what /design-preview/<run id> shows with
 *                SR_DESIGN_PREVIEW_ROOT=<that>/runs, compare-report.json / .md, contact-sheet.png)
 *
 * Output: codes and fixed messages only. Exit: 0 done, 1 stopped, 2 refused / usage.
 */
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { chromium } from "playwright";
import { killAllBoundedChildren, runBounded, RunDeadline } from "../../lib/design-agent/bounded-process";
import { COMPARE_ID, COMPARE_MODES, runComparison, type CompareMode } from "../../lib/design-agent/compare/run";
import { writeCompareReport } from "../../lib/design-agent/compare/report";
import { loadHandWritten, loadShops, selectShops } from "../../lib/design-agent/compare/shops";
import { killPreviewServers } from "../../lib/design-agent/preview-server";
import { childEnvironment } from "../../lib/design-agent/worker/env";
import { productionPreview } from "../../lib/design-agent/worker/preview";
import { removeActiveTempRootsSync } from "../../lib/design-agent/worker/temp";

const REPO = resolve(__dirname, "../..");
const FIXTURES = join(REPO, "scripts/sales-design-worker/compare");
process.umask(0o077);
const WATCHDOG_GRACE_MS = 60 * 1000;
/** The jail's one run (admin.sh run: RuntimeMaxSec=3500) holds the whole comparison, as run.sh's 3300 s. */
const MAX_BUDGET_SECONDS = 3300;
/** Set when the report can be written so far (after the comparison started). */
let compareDir: string | null = null;
let stopping = false;

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : undefined;
};
const expand = (p: string) => resolve(p.replace(/^~(?=$|\/)/, homedir()));
const insideRepo = (p: string) => !relative(REPO, p).startsWith("..");
const say = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);
const usage = (message: string): never => {
  process.stderr.write(`usage: ${message}\n`);
  process.exit(2);
};

/** Stops the children, writes the report of what was done so far (no contact sheet; at most 20 s), then exits 1. */
function stopNow(code: string): void {
  if (stopping) return;
  stopping = true;
  killPreviewServers();
  killAllBoundedChildren();
  removeActiveTempRootsSync();
  const dir = compareDir;
  const report = dir ? Promise.race([writeCompareReport(dir).then(() => true, () => false), new Promise<boolean>((r) => setTimeout(() => r(false), 20_000))]) : Promise.resolve(false);
  void report.then((written) => {
    process.stdout.write(`${JSON.stringify({ status: "stopped", code, report_so_far: written })}\n`);
    process.exit(1);
  });
}

async function main(): Promise<number> {
  // The human's explicit approval comes first: without it nothing is read, built or started.
  if (!argv.includes("--human-approval-confirmed")) {
    process.stderr.write("STOP: --human-approval-confirmed is missing. The comparison runs only with the human's explicit approval of this run. Nothing was started.\n");
    return 2;
  }
  // Only under compare-local.sh: the worker's run lock, the pinned checkout and the allowlisted environment.
  if (process.env.SR_DESIGN_COMPARE_LOCKED !== "run.lock") {
    process.stderr.write("STOP: start the comparison with scripts/sales-design-worker/compare-local.sh (it holds the worker's run lock). Nothing was started.\n");
    return 2;
  }
  const compareId = flag("compare-id") ?? "";
  if (!COMPARE_ID.test(compareId)) usage("--compare-id cmp-<lowercase letters, digits, -> (never a shop's name).");
  const mode = (flag("mode") ?? "design") as CompareMode;
  if (!COMPARE_MODES.includes(mode)) usage(`--mode ${COMPARE_MODES.join(" | ")}`);
  const budgetFlag = flag("budget-seconds");
  if (budgetFlag !== undefined && !/^[1-9][0-9]{1,5}$/.test(budgetFlag)) usage("--budget-seconds: a positive integer.");
  const budgetMs = Math.min(MAX_BUDGET_SECONDS, Number(budgetFlag ?? MAX_BUDGET_SECONDS)) * 1000;

  const root = expand(process.env.SR_DESIGN_COMPARE_ROOT ?? "~/sr-design-compare");
  const workerPaths = {
    queueRoot: expand(process.env.SR_DESIGN_JOBS ?? "~/sr-design-jobs"),
    outRoot: expand("~/.local/share/second-root-design"),
    stateDir: join(expand(process.env.XDG_STATE_HOME ?? "~/.local/state"), "sr-design-worker"),
  };
  for (const p of [root, ...Object.values(workerPaths)]) if (insideRepo(p)) usage("the comparison and the worker's directories must be outside the repository.");

  const shops = selectShops(await loadShops(join(FIXTURES, "shops")), flag("shops"));
  if (!shops) return usage("--shops: keys of scripts/sales-design-worker/compare/shops/*.json, comma separated, each once.");
  const handWritten = mode === "hand_written" ? await loadHandWritten(join(FIXTURES, "hand-written"), shops.map((s) => s.key)) : undefined;

  const env = childEnvironment(process.env);
  const head = await runBounded("git", ["rev-parse", "HEAD"], { cwd: REPO, env, timeoutMs: 60_000 });
  const workerSha = head.code === 0 ? head.stdout.trim() : "unknown";
  const launch = (e: NodeJS.ProcessEnv) =>
    chromium.launch({ headless: true, env: e, ...(e.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: e.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });

  setTimeout(() => stopNow("COMPARE_RUN_TIME_BUDGET"), budgetMs + WATCHDOG_GRACE_MS).unref();
  compareDir = join(root, compareId);
  say(`comparison ${compareId} (${mode}, ${shops.length} shops, commit ${workerSha.slice(0, 12)}, budget ${Math.round(budgetMs / 60000)} min)`);
  const result = await runComparison({
    humanApprovalConfirmed: true,
    compareId,
    mode,
    shops,
    handWritten,
    root,
    workerPaths,
    tmpBase: tmpdir(),
    env: process.env,
    workerSha,
    deadline: new RunDeadline(Date.now() + budgetMs),
    launchBrowser: launch,
    startPreview: productionPreview(REPO, launch),
    log: say,
  });
  process.stdout.write(`${JSON.stringify(result.status === "done" ? { status: result.status, runs: result.runs } : result, null, 2)}\n`);
  if (result.status === "refused") {
    compareDir = null;
    return 2;
  }
  const dir = join(root, compareId);
  say(`report: ${join(dir, "compare-report.md")}`);
  say(`pages: ${join(dir, "contact-sheet.png")} and runs/<run id>/page-{desktop,mobile}.png (a live preview: docs/operations/design-compare-local.md, never in the worker's checkout)`);
  return result.status === "done" ? 0 : 1;
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => stopNow("COMPARE_STOPPED_BY_SIGNAL"));
process.on("unhandledRejection", () => stopNow("COMPARE_UNEXPECTED"));

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    const code = (error as { code?: unknown } | null)?.code;
    stopNow(typeof code === "string" && /^[A-Z_]{3,40}$/.test(code) ? code : "COMPARE_UNEXPECTED");
  },
);
