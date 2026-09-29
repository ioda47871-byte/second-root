/**
 * Second Root design worker entry (DEV-028 worker). Started by
 * scripts/sales-design-worker/run.sh (the supported entry point), which pins
 * the checkout to origin/<ref>, installs dependencies and gives this process
 * a time budget. See docs/operations/design-worker-wsl.md.
 *
 *   tsx scripts/sales-design-worker/worker.ts [--max=1] [--budget-seconds=<n>]
 *   tsx scripts/sales-design-worker/worker.ts enqueue --job-id <id> --facts <file.json> --instagram <profile url>
 *
 * Paths (all outside the repository; the repository is public):
 *   queue    $SR_DESIGN_JOBS or ~/sr-design-jobs
 *   results  ~/.local/share/second-root-design/<job_id>/   (the record)
 *   state    $XDG_STATE_HOME/sr-design-worker (lock, ledger)
 *   Windows  $SR_DESIGN_EXPORT_DIR (best-effort copy; optional)
 *
 * Output is codes and fixed messages only: no source URL, no Codex text, no
 * child stderr. Exit: 0 = every job reached a recorded outcome (or nothing to
 * do), 1 = a job failed or will be retried, 3 = stopped (environment).
 */
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { chromium } from "playwright";
import { killAllBoundedChildren, runBounded, RunDeadline } from "../../lib/design-agent/bounded-process";
import { factsToDemoView } from "../../lib/design-agent/preview";
import { killPreviewServers } from "../../lib/design-agent/preview-server";
import { childEnvironment } from "../../lib/design-agent/worker/env";
import { publicMessage } from "../../lib/design-agent/worker/messages";
import { productionPreview } from "../../lib/design-agent/worker/preview";
import { ensureQueue, JOB_ID, pickFacts, queueDirs } from "../../lib/design-agent/worker/queue";
import { DEFAULT_MAX_JOBS, RUN_TIME_BUDGET_MS, runDesignWorker, type WorkerReport } from "../../lib/design-agent/worker/run";
import { parseInstagramProfileUrl } from "../../lib/design-agent/worker/source-url";
import { removeActiveTempRootsSync } from "../../lib/design-agent/worker/temp";

const REPO = resolve(__dirname, "../..");
// Everything the worker writes (results, queue, screenshots) is private to the worker user.
process.umask(0o077);
const WATCHDOG_GRACE_MS = 60 * 1000;

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

const paths = {
  queue: expand(process.env.SR_DESIGN_JOBS ?? "~/sr-design-jobs"),
  out: expand("~/.local/share/second-root-design"),
  state: join(expand(process.env.XDG_STATE_HOME ?? "~/.local/state"), "sr-design-worker"),
};
for (const p of Object.values(paths)) if (insideRepo(p)) usage("queue, results and state must be outside the repository.");

// ------------------------------------------------------------------ enqueue

async function enqueue(): Promise<number> {
  const jobId = flag("job-id") ?? "";
  if (!JOB_ID.test(jobId)) usage("--job-id: lowercase letters, digits and - (3–63). Do not use the shop's name.");
  const factsPath = expand(flag("facts") ?? usage("--facts <file.json> is required."));
  if (insideRepo(factsPath)) usage("--facts must be outside the repository.");
  if (!parseInstagramProfileUrl(flag("instagram"))) usage("--instagram must be https://www.instagram.com/<profile>/ (a public profile page).");
  const facts = pickFacts(JSON.parse(await readFile(factsPath, "utf8")) as Record<string, unknown>);
  if (!factsToDemoView(facts)) usage("the facts do not pass the demo fact filter (name and a valid category are required).");
  const dirs = queueDirs(paths.queue);
  await ensureQueue(dirs);
  for (const dir of [dirs.inbox, dirs.processing, dirs.done]) {
    if ((await readdir(dir)).includes(`${jobId}.json`)) usage(`a job with id ${jobId} is already queued or done; use a new id.`);
  }
  const temp = join(dirs.inbox, `.tmp-${jobId}-${process.pid}`);
  await writeFile(temp, `${JSON.stringify({ version: 1, job_id: jobId, facts, source: { instagram_url: flag("instagram") } }, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, join(dirs.inbox, `${jobId}.json`));
  say(`queued job ${jobId}`);
  return 0;
}

// ------------------------------------------------------------------ run

async function git(args: string[]): Promise<string> {
  const result = await runBounded("git", args, { cwd: REPO, env: childEnvironment(process.env), timeoutMs: 60_000 });
  if (result.code !== 0) throw Object.assign(new Error("git"), { code: "WORKER_NOT_ON_REF" });
  return result.stdout.trim();
}

/** The code that runs is exactly origin/<ref>, unchanged, with no .env file. */
async function checkCheckout(): Promise<string | { stop: string }> {
  const head = await git(["rev-parse", "HEAD"]);
  const ref = process.env.SR_DESIGN_WORKER_REF;
  if (ref !== undefined) {
    if (!/^[A-Za-z0-9._/-]{1,100}$/.test(ref)) return { stop: "WORKER_NOT_ON_REF" };
    const expected = await git(["rev-parse", `refs/remotes/origin/${ref}`]).catch(() => "");
    if (expected !== head) return { stop: "WORKER_NOT_ON_REF" };
  }
  if ((await git(["status", "--porcelain", "--untracked-files=normal"])) !== "") return { stop: "WORKER_TREE_DIRTY" };
  if ((await readdir(REPO)).some((n) => /^\.env/.test(n) && n !== ".env.local.example")) return { stop: "WORKER_ENV_FILE_PRESENT" };
  return head;
}

function exitCodeFor(report: WorkerReport): number {
  if (report.status === "stopped") return 3;
  if (report.status === "finished" && report.jobs.some((j) => j.status !== "done")) return 1;
  return 0;
}

async function run(): Promise<number> {
  const max = Number(flag("max") ?? DEFAULT_MAX_JOBS);
  if (!Number.isInteger(max) || max < 1 || max > 5) usage("--max: 1–5.");
  const budgetSeconds = flag("budget-seconds");
  if (budgetSeconds !== undefined && !/^[1-9][0-9]{0,5}$/.test(budgetSeconds)) usage("--budget-seconds: a positive integer.");
  const runBudgetMs = Math.min(RUN_TIME_BUDGET_MS, budgetSeconds === undefined ? RUN_TIME_BUDGET_MS : Number(budgetSeconds) * 1000);
  const deadline = new RunDeadline(Date.now() + runBudgetMs);

  // Last resort: never outlive the budget (systemd / timeout(1) come after).
  setTimeout(() => stopNow("WORKER_RUN_TIME_BUDGET"), runBudgetMs + WATCHDOG_GRACE_MS).unref();

  const checkout = await checkCheckout();
  if (typeof checkout !== "string") {
    say(`stopped: ${checkout.stop} — ${publicMessage(checkout.stop)}`);
    return 3;
  }
  const exportDir = process.env.SR_DESIGN_EXPORT_DIR ? expand(process.env.SR_DESIGN_EXPORT_DIR) : undefined;
  if (exportDir && insideRepo(exportDir)) usage("SR_DESIGN_EXPORT_DIR must be outside the repository.");
  await mkdir(paths.state, { recursive: true, mode: 0o700 });
  const launch = (env: NodeJS.ProcessEnv) =>
    chromium.launch({ headless: true, env, ...(env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  say(`design worker ${checkout.slice(0, 12)} (max ${max}, budget ${Math.round(runBudgetMs / 60000)} min)`);
  const report = await runDesignWorker({
    stateDir: paths.state,
    queueRoot: paths.queue,
    outRoot: paths.out,
    tmpBase: tmpdir(),
    exportDir,
    workerSha: checkout,
    maxJobs: max,
    deadline,
    env: process.env,
    launchBrowser: launch,
    startPreview: productionPreview(REPO, launch),
    log: say,
  });
  const summary =
    report.status === "finished"
      ? { status: report.status, worker_commit: report.workerSha, jobs: report.jobs }
      : report;
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (report.status === "finished") for (const j of report.jobs) if (j.status === "done") say(`result: ${join(paths.out, j.jobId)}`);
  return exitCodeFor(report);
}

function stopNow(code: string): never {
  killPreviewServers();
  killAllBoundedChildren();
  removeActiveTempRootsSync();
  process.stdout.write(`${JSON.stringify({ status: "stopped", code, message: publicMessage(code) })}\n`);
  process.exit(3);
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => stopNow("WORKER_STOPPED_BY_SIGNAL"));
// A stray rejection must not print a stack with someone else's words in it.
process.on("unhandledRejection", () => stopNow("WORKER_UNEXPECTED"));

(argv[0] === "enqueue" ? enqueue() : run()).then(
  (code) => process.exit(code),
  () => stopNow("WORKER_UNEXPECTED"),
);
