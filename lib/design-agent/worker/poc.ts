// The photo PoC's own checks (DEV-029 stage 5), around one normal worker run:
//
//   preflight  before enqueue: the job id is unused (no second run of the
//              same job), no other job waits or runs, the asset store is safe, the job's manifest and
//              every photo verify, the photos are generated_concept only (the
//              first real PoC), the Codex sandbox prepares with the asset store
//              hidden, and Codex is signed in with ChatGPT.
//   report     after the run: outcome, per-call Codex timing and a runtime
//              estimate for revision 0 / 1 / 2 against the run budget, the
//              artifact lineage verified from the store, and that no image
//              copy, temp root or Codex session log was left.
//
// Output is codes, counts and milliseconds only: no path of the store, no
// prompt, no Codex text, no shop fact.
import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ImageDirection } from "../assets/direction";
import { assetStoreRoot, checkStoreRoot, loadManifest } from "../assets/intake";
import { AnalysesArtifactSchema, verifyAnalyses, verifyImages } from "../assets/lineage";
import { loadPhotoInputs } from "../assets/photo-codex";
import { runAssets } from "../assets/serve";
import { assertChatGptSignIn, CodexError, fromSandboxError, listDesignAgentSessions } from "../codex";
import { checkProfile } from "../profile";
import type { CodexSandbox } from "../sandbox";
import { queueDirs } from "./queue";
import type { CallTiming, TimingStage } from "./timing";

export type Check = { check: string; ok: boolean; code?: string };

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

const readJson = (path: string): Promise<unknown> => readFile(path, "utf8").then((t) => JSON.parse(t) as unknown, () => undefined);

const codeOf = (error: unknown): string => {
  const e = error instanceof CodexError ? error : fromSandboxError(error);
  return e instanceof CodexError ? e.code : "ERROR";
};

export async function pocPreflight(o: {
  jobId: string;
  queueRoot: string;
  outRoot: string;
  env: Record<string, string | undefined>;
  repoDir: string;
  prepareSandbox: () => Promise<CodexSandbox>;
}): Promise<{ ready: boolean; photos: number; checks: Check[] }> {
  const checks: Check[] = [];
  const add = (check: string, ok: boolean, code?: string) => checks.push({ check, ok, ...(ok || !code ? {} : { code }) });

  // ---- the same job is never run twice
  const dirs = queueDirs(o.queueRoot);
  const queued: string[] = [];
  for (const [state, dir] of Object.entries({ inbox: dirs.inbox, processing: dirs.processing, done: dirs.done, failed: dirs.failed })) {
    const names = await readdir(dir).catch(() => [] as string[]);
    if (names.some((n) => n === `${o.jobId}.json` || n.startsWith(`${o.jobId}.`))) queued.push(state);
  }
  if (await exists(join(o.outRoot, o.jobId))) queued.push("results");
  add("job_id_unused", queued.length === 0, queued.length ? `JOB_ALREADY_${queued[0]!.toUpperCase()}` : undefined);
  // The worker takes the oldest waiting job: with others waiting (or one running) the PoC would not be the run's job.
  const others = [
    ...(await readdir(dirs.inbox).catch(() => [] as string[])),
    ...(await readdir(dirs.processing).catch(() => [] as string[])),
  ].filter((n) => n.endsWith(".json") && !n.startsWith(`${o.jobId}.`));
  add("queue_idle", others.length === 0, "OTHER_JOBS_WAITING");

  // ---- the photos
  let photos = 0;
  const store = assetStoreRoot(o.env);
  const storeOk = checkStoreRoot(store, { repoDir: o.repoDir, env: o.env });
  add("asset_store_safe", storeOk, "ASSET_STORE_UNSAFE");
  const manifest = storeOk ? await loadManifest(store, o.jobId) : null;
  add("manifest", manifest !== null && manifest.assets.length > 0, manifest ? "NO_PHOTOS" : "MANIFEST_INVALID");
  if (manifest && manifest.assets.length > 0) {
    const loaded = await loadPhotoInputs({ store, jobId: o.jobId, manifest });
    add("photos_verified", loaded.ok, loaded.ok ? undefined : loaded.code);
    if (loaded.ok) photos = loaded.value.length;
    add("generated_concept_only", manifest.assets.every((a) => a.sourceKind === "generated_concept"), "NOT_GENERATED_CONCEPT");
    add("no_people", manifest.assets.every((a) => a.people === "none"), "PEOPLE");
  }

  // ---- Codex: the sandbox (its probe checks every protected path, the asset store included) and the sign-in
  try {
    const sandbox = await o.prepareSandbox();
    add("sandbox_store_hidden", true);
    try {
      await assertChatGptSignIn({ sandbox });
      add("codex_chatgpt_sign_in", true);
    } catch (error) {
      add("codex_chatgpt_sign_in", false, codeOf(error));
    }
  } catch (error) {
    add("sandbox_store_hidden", false, codeOf(error));
  }
  return { ready: checks.every((c) => c.ok), photos, checks };
}

// ------------------------------------------------------------------ the runtime estimate

export type RuntimeEstimate = {
  budget_ms: number;
  /** Revision 0 / 1 / 2: measured means; and with the slowest call of each stage (conservative). */
  mean_ms: [number, number, number];
  conservative_ms: [number, number, number];
  /** OK: conservative revision 2 within 80 % of the budget; AT_RISK: within it; OVER: beyond it. */
  verdict: "OK" | "AT_RISK" | "OVER" | "NO_DATA";
};

type Timing = { capture_ms: number; pipeline_ms: number; codex_ms: number; call_list: CallTiming[] };

/**
 * Revision r costs: capture + the brief + the analysis + (r + 1) × (direction + review)
 * + the pipeline's own time besides Codex (renders), scaled by the rounds.
 * A revision stage never measured takes its round-0 stage's figure.
 */
export function estimateRuntime(timing: Timing | null, budgetMs: number): RuntimeEstimate {
  const none: RuntimeEstimate = { budget_ms: budgetMs, mean_ms: [0, 0, 0], conservative_ms: [0, 0, 0], verdict: "NO_DATA" };
  if (!timing || timing.call_list.length === 0) return none;
  // Means from the calls that answered; the conservative figure also counts failed calls (a timeout took its whole time).
  const of = (stages: TimingStage[], all: boolean) => timing.call_list.filter((c) => stages.includes(c.stage) && (all || c.result === "ok")).map((c) => c.duration_ms);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const max = (xs: number[]) => (xs.length ? Math.max(...xs) : 0);
  const reviews = timing.call_list.filter((c) => c.stage === "visual_review" || c.stage === "visual_review_revision").length;
  // The pipeline's own time (renders) happens once before the first round and once per round (the final render).
  const overheadPerRender = Math.max(0, timing.pipeline_ms - timing.codex_ms) / (Math.max(1, reviews) + 1);
  const est = (f: (xs: number[]) => number, all: boolean) =>
    [0, 1, 2].map((r) =>
      Math.round(
        timing.capture_ms +
          f(of(["profile_brief"], all)) +
          f(of(["photo_analysis"], all)) +
          (r + 1) * (f(of(["image_direction", "image_direction_revision"], all)) + f(of(["visual_review", "visual_review_revision"], all))) +
          (r + 2) * overheadPerRender,
      ),
    ) as [number, number, number];
  const mean_ms = est(mean, false);
  const conservative_ms = est(max, true);
  const worst = conservative_ms[2];
  const verdict = worst <= budgetMs * 0.8 ? "OK" : worst <= budgetMs ? "AT_RISK" : "OVER";
  return { budget_ms: budgetMs, mean_ms, conservative_ms, verdict };
}

// ------------------------------------------------------------------ the report

async function findFiles(root: string, test: (name: string) => boolean, depth = 6): Promise<number> {
  if (depth < 0) return 0;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  let n = 0;
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    if (e.isFile() && test(e.name)) n += 1;
    else if (e.isDirectory()) n += await findFiles(join(root, e.name), test, depth - 1);
  }
  return n;
}

export async function pocReport(o: {
  jobId: string;
  outRoot: string;
  queueRoot: string;
  tmpBase: string;
  env: Record<string, string | undefined>;
  repoDir: string;
  budgetMs: number;
}) {
  const runDir = join(o.outRoot, o.jobId);
  const report = (await readJson(join(runDir, "report.json"))) as Record<string, unknown> | undefined;
  if (!report) return { job_id: o.jobId, status: "NO_REPORT" as const };
  const codex = (report.codex ?? null) as Record<string, unknown> | null;
  const timing = (report.timing ?? null) as (Timing & Record<string, unknown>) | null;
  const started = Date.parse(String(report.started_at));
  const finished = Date.parse(String(report.finished_at));

  // ---- lineage, from the store as it is now
  const lineage: Check[] = [];
  const run = await runAssets(runDir, { env: o.env, repoDir: o.repoDir });
  lineage.push({ check: "assets", ok: run !== null });
  if (run && basename(runDir) === o.jobId) {
    const analysesRaw = await readJson(join(runDir, "photo-analyses.json"));
    const analyses = verifyAnalyses(analysesRaw, o.jobId, run.manifest);
    lineage.push({ check: "photo_analyses", ok: analyses !== null });
    const analysesArt = analyses ? AnalysesArtifactSchema.parse(analysesRaw) : null;
    const names = (await readdir(runDir)).filter((n) => /^(candidate-[0-9]{1,2}|final)\.images\.json$/.test(n)).sort();
    for (const name of names) {
      const candidate = name.replace(/\.images\.json$/, "");
      const profile = checkProfile(await readJson(join(runDir, `${candidate}.json`)));
      const direction: ImageDirection | null =
        analysesArt && profile.ok ? verifyImages(await readJson(join(runDir, name)), o.jobId, candidate, run.manifest, analysesArt, profile.profile) : null;
      lineage.push({ check: `images_${candidate}`, ok: direction !== null });
    }
  }

  // ---- cleanup
  const tmpNames = await readdir(o.tmpBase).catch(() => [] as string[]);
  const cleanup = {
    worker_temp_roots: tmpNames.filter((n) => /^sr-design-worker-/.test(n)).length,
    codex_work_dirs: tmpNames.filter((n) => /^sr-design-codex-/.test(n)).length,
    photo_copies: (await findFiles(o.tmpBase, (n) => /^photo-\d+\.png$/.test(n))) + (await findFiles(runDir, (n) => /^photo-\d+\.png$/.test(n))) + (await findFiles(o.queueRoot, (n) => /^photo-\d+\.png$/.test(n))),
    codex_session_logs: (await listDesignAgentSessions(o.env)).length,
  };

  return {
    job_id: o.jobId,
    status: "REPORT" as const,
    outcome: report.outcome,
    worker_commit: (report.worker as { commit?: string } | undefined)?.commit ?? null,
    visual_source: report.visual_source ?? null,
    total_ms: Number.isFinite(finished - started) ? finished - started : null,
    codex: codex
      ? {
          status: codex.status,
          profile_source: codex.profile_source,
          final_candidate: codex.final_candidate,
          revisions: codex.revisions,
          rounds: codex.rounds,
          blocked: codex.blocked,
          renderer_change_needed: codex.renderer_change_needed,
          schema_mode: codex.schema_mode,
          notes: codex.notes,
        }
      : null,
    photos: report.photos ?? null,
    timing: timing
      ? { capture_ms: timing.capture_ms, pipeline_ms: timing.pipeline_ms, codex_ms: timing.codex_ms, calls: timing.calls, slowest: timing.slowest, by_stage: timing.by_stage, call_list: timing.call_list }
      : null,
    estimate: estimateRuntime(timing, o.budgetMs),
    lineage,
    lineage_ok: lineage.length > 0 && lineage.every((c) => c.ok),
    cleanup,
    cleanup_ok: Object.values(cleanup).every((n) => n === 0),
  };
}
