/**
 * DEV-185: the つぐ手 (fictional) AI demo photos — ONE Codex run, at most 6 image calls, owner-approved once
 * (approval id tsugute-photos-20261106-01). HUMAN-APPROVED LOCAL RUN ONLY. Never invoked by the worker, a timer, cron,
 * Vercel or CI.
 *
 * Runs only under scripts/sales-design-worker/tsugute-photos-gate.sh (started by run-tsugute-photos-once.sh), which
 * checks the user and cgroup, holds the worker's run lock, pins the commit and the prompt, consumes the one-use
 * approval marker and gives this process its time budget; it sets SR_TSUGUTE_PHOTOS_LOCKED=run.lock, and without it
 * (or without the reserved receipt) this refuses (exit 2, nothing started).
 *
 *   --check-pin-only                         offline: the prompt's SHA-256 and length against SR_TSUGUTE_EXPECTED_*
 *   --human-approval-confirmed --budget-seconds=N   the one real run
 *
 * Output: ~/sr-tsugute-photos/tsugute-photos-XXXXXX/ (0700): <slot>.png (0600) and manifest.json. Printed: codes,
 * numbers and that path only. Exit: 0 all 6 saved, 1 stopped (never retried), 2 refused before anything started.
 */
import { createHash } from "node:crypto";
import { mkdir, chmod, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { killAllBoundedChildren, runBounded } from "../../lib/design-agent/bounded-process";
import { cleanupActiveImageCalls, generateImagesInOneRun } from "../../lib/design-agent/design-image/image-once";
import { buildTsugutePhotosPrompt, TSUGUTE_PHOTOS_APPROVAL_ID, TSUGUTE_PHOTOS_DIRECTION, TSUGUTE_PHOTOS_MAX_IMAGES, writeTsugutePhotos } from "../../lib/design-agent/design-image/tsugute-photos";
import { isInsidePath } from "../../lib/design-agent/design-image/run";
import { workerProtectedPaths } from "../../lib/design-agent/protected-paths";
import { prepareCodexSandbox } from "../../lib/design-agent/sandbox";
import { childEnvironment } from "../../lib/design-agent/worker/env";

/** The owner-approved prompt (DEV-185): any other text is refused before the approval is used. */
import { TSUGUTE_PROMPT_CHARS, TSUGUTE_PROMPT_SHA256 } from "../../lib/design-agent/quality-pipeline/tsugute-ai-photos";
export { TSUGUTE_PROMPT_CHARS, TSUGUTE_PROMPT_SHA256 };
const CANONICAL_HOME = "/home/sr-designgen";
const REPO = resolve(__dirname, "../..");
const MAX_BUDGET_SECONDS = 3300;
/** the existing limit of one Codex image run (as the PoC and image-once callers): 15 minutes */
const CODEX_TIMEOUT_MS = 15 * 60 * 1000;
process.umask(0o077);
let stopping = false;
const say = (line: string) => process.stdout.write(`${line}\n`);

function stopNow(code: string): void {
  if (stopping) return;
  stopping = true;
  killAllBoundedChildren();
  void Promise.race([cleanupActiveImageCalls(), new Promise((r) => setTimeout(r, 20_000))]).then(() => {
    say(`POC_STOP: ${code}`);
    process.exit(1);
  });
}

async function main(argv: string[]): Promise<number> {
  if (process.env.SR_TSUGUTE_PHOTOS_LOCKED !== "run.lock") {
    say("STOP: start with scripts/sales-design-worker/run-tsugute-photos-once.sh (it holds the worker's run lock). Nothing was started.");
    return 2;
  }
  const prompt = buildTsugutePhotosPrompt();
  const sha = createHash("sha256").update(prompt, "utf8").digest("hex");
  if (argv.length === 1 && argv[0] === "--check-pin-only") {
    if (process.env.SR_TSUGUTE_EXPECTED_SHA !== sha || process.env.SR_TSUGUTE_EXPECTED_CHARS !== String(prompt.length) || sha !== TSUGUTE_PROMPT_SHA256 || prompt.length !== TSUGUTE_PROMPT_CHARS) {
      say("STOP: POC_PIN_MISMATCH");
      return 23;
    }
    say(`POC_PIN_OK direction=${TSUGUTE_PHOTOS_DIRECTION} sha256=${sha} chars=${prompt.length}`);
    return 0;
  }
  const budgetArg = argv.find((a) => a.startsWith("--budget-seconds="))?.slice("--budget-seconds=".length);
  if (argv.length !== 2 || !argv.includes("--human-approval-confirmed") || !budgetArg || !/^[1-9][0-9]{2,4}$/.test(budgetArg)) {
    say("usage: --human-approval-confirmed --budget-seconds=<n> | --check-pin-only");
    return 2;
  }
  // the pins and the canonical identity again (a forged SR_TSUGUTE_PHOTOS_LOCKED alone never reaches Codex)
  if (sha !== TSUGUTE_PROMPT_SHA256 || prompt.length !== TSUGUTE_PROMPT_CHARS || process.env.SR_TSUGUTE_EXPECTED_SHA !== sha || process.env.SR_TSUGUTE_EXPECTED_CHARS !== String(prompt.length) || process.env.SR_DESIGN_WORKER_NO_UPDATE !== "1" || process.env.HOME !== CANONICAL_HOME) {
    say("STOP: POC_TSUGUTE_APPROVAL_PIN_REQUIRED");
    return 2;
  }
  const head = await runBounded("git", ["rev-parse", "HEAD"], { cwd: REPO, env: childEnvironment(process.env), timeoutMs: 60_000 }).catch(() => null);
  const commit = head?.code === 0 ? head.stdout.trim() : "";
  const receipt = join(CANONICAL_HOME, ".local/state/sr-design-worker/poc-approval-used", TSUGUTE_PHOTOS_APPROVAL_ID, "receipt");
  const text = await readFile(receipt, "utf8").catch(() => "");
  if (!/^[a-f0-9]{40}$/.test(commit) || text !== `direction=${TSUGUTE_PHOTOS_DIRECTION}\nsha256=${sha}\ncommit=${commit}\n`) {
    say("STOP: POC_TSUGUTE_APPROVAL_NOT_RESERVED");
    return 2;
  }
  const outRoot = join(homedir(), "sr-tsugute-photos");
  const workerPaths = { queueRoot: join(homedir(), "sr-design-jobs"), outRoot: join(homedir(), ".local/share/second-root-design"), stateDir: join(homedir(), ".local/state/sr-design-worker") };
  if ([outRoot, ...Object.values(workerPaths)].some((p) => isInsidePath(p, REPO))) {
    say("STOP: output and worker directories must be outside the repository");
    return 2;
  }
  await mkdir(outRoot, { recursive: true, mode: 0o700 });
  await chmod(outRoot, 0o700);
  const budgetMs = Math.min(MAX_BUDGET_SECONDS, Number(budgetArg)) * 1000;
  setTimeout(() => stopNow("POC_RUN_TIME_BUDGET"), budgetMs + 30_000).unref();
  // Codex never sees the worker's directories or where the pictures go
  const protectedPaths = [...new Set([...workerProtectedPaths({ ...workerPaths, env: process.env }), outRoot])];
  let sandbox;
  try {
    sandbox = await prepareCodexSandbox({ env: childEnvironment(process.env), protectedPaths });
  } catch {
    say("POC_STOP: CODEX_SANDBOX_UNAVAILABLE (approval already consumed; do not retry)");
    return 1;
  }
  say(`${new Date().toISOString()} tsugute photos (commit ${commit.slice(0, 12)}, max ${TSUGUTE_PHOTOS_MAX_IMAGES} image calls, Codex ${CODEX_TIMEOUT_MS / 60000} min)`);
  const batch = await generateImagesInOneRun({ sandbox, prompt, timeoutMs: Math.min(CODEX_TIMEOUT_MS, budgetMs), tmpBase: tmpdir(), maxImages: TSUGUTE_PHOTOS_MAX_IMAGES });
  const { dir, manifest } = await writeTsugutePhotos({ outRoot, batch, commit, prompt, generatedAt: new Date().toISOString() });
  say(JSON.stringify({ status: manifest.status, stop_code: manifest.stop_code, images: manifest.slots.length, image_tool_calls: manifest.image_tool_calls, image_tool_failed: manifest.image_tool_failed, model: manifest.model, codex_ms: manifest.codex_ms, sizes: manifest.slots.map((s) => `${s.slot_id}=${s.width}x${s.height}${s.meets_target_2x ? "" : s.meets_floor_1_5x ? "(<2x)" : "(<1.5x)"}`) }));
  say(`POC_MANIFEST: ${join(dir, "manifest.json")}`);
  if (manifest.status === "complete") {
    say(`POC_IMAGES_READY: ${dir}`);
    return 0;
  }
  say(`POC_STOP: ${manifest.stop_code}`);
  return 1;
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => stopNow("POC_STOPPED_BY_SIGNAL"));
process.on("unhandledRejection", () => stopNow("POC_UNEXPECTED"));
main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  () => stopNow("POC_UNEXPECTED"),
);
