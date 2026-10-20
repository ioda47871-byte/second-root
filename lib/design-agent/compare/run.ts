// The local 3-shop comparison (DEV-073, Stage 1 §8-3 of design-spec-stage1.md):
// fictional test shops through the design worker's own pipeline, on the
// human's WSL machine, with the human's explicit approval per run.
//
//   design        per shop: the worker's pipeline (runJobPipeline: Codex brief
//                 → render → screenshots → Codex review → at most 2 revisions,
//                 the same prompts, schemas, timeouts and quality gate), plus
//                 the baseline
//   baseline      per shop: the category default profile without its layout
//                 (the page before Stage 1), rendered on the same preview; no Codex
//   hand_written  per shop: a hand-written Stage 1 spec (a labelled renderer
//                 demo, never Codex's work), plus the baseline; no Codex
//
// Every run directory has the layout the local /design-preview/<runId> route
// reads (facts.json, <candidate>.json), under <root>/<compareId>/runs. No queue,
// no ledger, no database, no bridge, no Staging, no reference capture: the
// shops are fictional, so the pipeline runs without reference screenshots (the
// prompts say so). Records hold fixed codes and numbers only.
import { copyFile, lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser } from "playwright";
import { DeadlineError, killAllBoundedChildren, RunDeadline } from "../bounded-process";
import { assertChatGptSignIn, fromSandboxError, removeStaleCodexSessions } from "../codex";
import { CATEGORY_DEFAULT_PROFILES } from "../defaults";
import { profileAsDrawn } from "../layout";
import type { DesignProfile } from "../profile";
import { workerProtectedPaths } from "../protected-paths";
import { prepareCodexSandbox, type CodexSandbox } from "../sandbox";
import { childEnvironment } from "../worker/env";
import { codeOf, ENVIRONMENT_CODES } from "../worker/messages";
import { copyPipelineShots, environmentCode, pipelineRecord, RUN_TIME_BUDGET_MS, runJobPipeline, type PreviewSession } from "../worker/run";
import { acquireLock, writeJsonAtomic } from "../worker/state";
import { cleanStaleTemp, createTempRoot, removeTempRoot } from "../worker/temp";
import { writeCompareReport } from "./report";
import { checkPageSafety, type Safety } from "./safety";
import type { CompareShop } from "./shops";

export const COMPARE_ID = /^cmp-[a-z0-9-]{1,30}$/;
export const COMPARE_MODES = ["design", "baseline", "hand_written"] as const;
export type CompareMode = (typeof COMPARE_MODES)[number];
/** Per shop, the worker's own run budget (its timeouts are unchanged). */
export const SHOP_BUDGET_MS = RUN_TIME_BUDGET_MS;

export const runIdFor = (compareId: string, key: string, kind: "design" | "baseline" | "hand_written") =>
  kind === "design" ? `${compareId}-${key}` : `${compareId}-${key}-${kind === "baseline" ? "base" : "hand"}`;

export type CompareOptions = {
  /** The human's explicit approval of this run (--human-approval-confirmed). Without it nothing starts. */
  humanApprovalConfirmed: boolean;
  compareId: string;
  mode: CompareMode;
  shops: CompareShop[];
  /** hand_written mode: the specs by shop key. */
  handWritten?: Record<string, DesignProfile>;
  /** <root>/<compareId>/ holds runs/, state/ and the report. */
  root: string;
  /** The design worker's own directories: hidden from Codex like the comparison's. */
  workerPaths: { stateDir: string; queueRoot: string; outRoot: string };
  tmpBase: string;
  env: Record<string, string | undefined>;
  workerSha: string;
  deadline: RunDeadline;
  codexBin?: string;
  /** Tests only: the fake Codex's sandbox. Production: prepareCodexSandbox with every protected path. */
  prepareSandbox?: (env: NodeJS.ProcessEnv, protectedPaths: string[]) => Promise<CodexSandbox>;
  launchBrowser: (env: NodeJS.ProcessEnv) => Promise<Browser>;
  startPreview: (options: { previewRoot: string; env: NodeJS.ProcessEnv; deadline: RunDeadline }) => Promise<PreviewSession>;
  now?: () => Date;
  log?: (line: string) => void;
};

export type CompareRunOutcome = { runId: string; shop: string; kind: "design" | "baseline" | "hand_written"; outcome: string };
export type CompareResult =
  | { status: "refused"; code: string }
  | { status: "stopped"; code: string; runs: CompareRunOutcome[] }
  | { status: "done"; runs: CompareRunOutcome[]; report: string; contactSheet: string | null };

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

/** The category default without its layout: the page as it is drawn before Stage 1 (today's page). */
export function baselineProfile(category: keyof typeof CATEGORY_DEFAULT_PROFILES): DesignProfile {
  const { layout: _layout, ...rest } = CATEGORY_DEFAULT_PROFILES[category];
  void _layout;
  return rest;
}

export async function runComparison(o: CompareOptions): Promise<CompareResult> {
  if (o.humanApprovalConfirmed !== true) return { status: "refused", code: "HUMAN_APPROVAL_MISSING" };
  if (!COMPARE_ID.test(o.compareId)) return { status: "refused", code: "COMPARE_ID_INVALID" };
  if (!COMPARE_MODES.includes(o.mode)) return { status: "refused", code: "COMPARE_MODE_INVALID" };
  if (o.shops.length === 0) return { status: "refused", code: "COMPARE_NO_SHOPS" };
  if (o.mode === "hand_written" && o.shops.some((s) => !o.handWritten?.[s.key])) return { status: "refused", code: "COMPARE_SPEC_MISSING" };
  const now = o.now ?? (() => new Date());
  const log = o.log ?? (() => undefined);
  const compareDir = join(o.root, o.compareId);
  // a comparison id is never run twice (its records stay as they are)
  if (await exists(compareDir)) return { status: "refused", code: "COMPARE_ID_USED" };
  await mkdir(o.root, { recursive: true, mode: 0o700 });
  await mkdir(compareDir, { mode: 0o700 });
  const runsDir = join(compareDir, "runs");
  const stateDir = join(compareDir, "state");
  await mkdir(runsDir, { mode: 0o700 });
  const lock = await acquireLock(stateDir, now(), "compare.lock");
  if (!lock) return { status: "stopped", code: "COMPARE_LOCKED", runs: [] };

  const previousTmp = process.env.TMPDIR;
  let tempRoot: string | undefined;
  let session: PreviewSession | undefined;
  let browser: Browser | undefined;
  const runs: CompareRunOutcome[] = [];
  let stop: string | null = null;
  try {
    await cleanStaleTemp(o.tmpBase, now());
    await removeStaleCodexSessions(o.env).catch(() => 0);
    tempRoot = await createTempRoot(o.tmpBase, lock.holder);
    process.env.TMPDIR = tempRoot;
    const root = tempRoot;
    const childEnv = () => childEnvironment({ ...o.env, TMPDIR: root });

    // ---- Codex (design mode only): the worker's sandbox, hiding the comparison's and the worker's own directories
    let sandbox: CodexSandbox | null = null;
    if (o.mode === "design") {
      const protectedPaths = [
        ...new Set([
          ...workerProtectedPaths({ stateDir, queueRoot: compareDir, outRoot: runsDir, env: o.env }),
          ...workerProtectedPaths({ ...o.workerPaths, env: o.env }),
        ]),
      ];
      const codexBin = o.codexBin ?? "codex";
      const prepare = o.prepareSandbox ?? ((env: NodeJS.ProcessEnv, paths: string[]) => prepareCodexSandbox({ env, codexBin, protectedPaths: paths }));
      try {
        sandbox = await prepare(childEnv(), protectedPaths).catch((error: unknown) => {
          throw fromSandboxError(error);
        });
        await assertChatGptSignIn({ sandbox });
      } catch (error) {
        return { status: "stopped", code: codeOf(error), runs };
      }
    }

    try {
      session = await o.startPreview({ previewRoot: runsDir, env: childEnv(), deadline: o.deadline });
    } catch (error) {
      const code = codeOf(error);
      return { status: "stopped", code: code === "RUN_TIME_BUDGET" || ENVIRONMENT_CODES.has(code) ? code : "WORKER_BUILD_FAILED", runs };
    }
    browser = await o.launchBrowser(childEnv());
    const ctx: ShopContext = { o, runsDir, session, browser, sandbox, tempRoot: root, now, log };

    for (const shop of o.shops) {
      runs.push(await runBaseline(ctx, shop));
      if (o.mode === "hand_written") runs.push(await runHandWritten(ctx, shop, o.handWritten![shop.key]!));
      if (o.mode === "design") {
        if (o.deadline.remainingMs() < 10 * 60 * 1000) {
          stop = "COMPARE_RUN_TIME_BUDGET";
          log("not enough time left for another shop");
          break;
        }
        const r = await runDesignShop(ctx, shop);
        runs.push(r.run);
        if (r.stop) {
          stop = r.stop;
          log(`comparison stopped: ${r.stop}`);
          break;
        }
      }
    }
    const report = await writeCompareReport(compareDir, { browser });
    if (stop) return { status: "stopped", code: stop, runs };
    return { status: "done", runs, report: report.json, contactSheet: report.contactSheet };
  } catch (error) {
    const code = error instanceof DeadlineError ? "COMPARE_RUN_TIME_BUDGET" : codeOf(error);
    log(`comparison stopped: ${code}`);
    return { status: "stopped", code, runs };
  } finally {
    await browser?.close().catch(() => undefined);
    await session?.stop().catch(() => undefined);
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    killAllBoundedChildren();
    if (tempRoot) await removeTempRoot(tempRoot);
    await lock.release().catch(() => undefined);
  }
}

type ShopContext = {
  o: CompareOptions;
  runsDir: string;
  session: PreviewSession;
  browser: Browser;
  sandbox: CodexSandbox | null;
  tempRoot: string;
  now: () => Date;
  log: (line: string) => void;
};

async function newRunDir(ctx: ShopContext, runId: string, shop: CompareShop): Promise<string> {
  const runDir = join(ctx.runsDir, runId);
  await mkdir(join(runDir, "shots"), { recursive: true, mode: 0o700 });
  await writeFile(join(runDir, "facts.json"), JSON.stringify(shop.facts, null, 2), { mode: 0o600 });
  return runDir;
}

const baseRecord = (ctx: ShopContext, runId: string, shop: CompareShop, kind: CompareRunOutcome["kind"], startedAt: string) => ({
  version: 1,
  job_id: runId,
  run_id: runId,
  worker: { commit: ctx.o.workerSha },
  started_at: startedAt,
  finished_at: ctx.now().toISOString(),
  compare: { compare_id: ctx.o.compareId, shop: shop.key, category: shop.demo.category, richness: shop.richness, kind, references: 0 },
});

async function safetyOf(ctx: ShopContext, runId: string, candidate: string, shop: CompareShop): Promise<Safety | null> {
  if (!ctx.session.origin) return null;
  return checkPageSafety(ctx.browser, `${ctx.session.origin}/design-preview/${runId}?profile=${candidate}`, shop.demo).catch(() => null);
}

/** Renders one candidate and keeps its screenshots as the compared page (page-desktop.png / page-mobile.png). */
async function renderPage(ctx: ShopContext, runId: string, runDir: string, candidate: string): Promise<string[]> {
  const result = await ctx.session.renderer.render(runId, candidate, join(runDir, "shots"));
  await copyFile(result.shots.desktop, join(runDir, "page-desktop.png"));
  await copyFile(result.shots.mobile, join(runDir, "page-mobile.png"));
  return result.overflow;
}

async function runBaseline(ctx: ShopContext, shop: CompareShop): Promise<CompareRunOutcome> {
  const runId = runIdFor(ctx.o.compareId, shop.key, "baseline");
  const startedAt = ctx.now().toISOString();
  const runDir = await newRunDir(ctx, runId, shop);
  try {
    await writeFile(join(runDir, "default.json"), JSON.stringify(baselineProfile(shop.demo.category), null, 2), { mode: 0o600 });
    const overflow = await renderPage(ctx, runId, runDir, "default");
    const safety = await safetyOf(ctx, runId, "default", shop);
    await writeJsonAtomic(join(runDir, "report.json"), {
      ...baseRecord(ctx, runId, shop, "baseline", startedAt),
      outcome: "baseline",
      page_candidate: "default",
      profile: "category_default_without_layout",
      overflow,
      safety,
    });
    ctx.log(`${runId}: baseline rendered`);
    return { runId, shop: shop.key, kind: "baseline", outcome: "baseline" };
  } catch (error) {
    return failed(ctx, runId, runDir, shop, "baseline", startedAt, error);
  }
}

async function runHandWritten(ctx: ShopContext, shop: CompareShop, spec: DesignProfile): Promise<CompareRunOutcome> {
  const runId = runIdFor(ctx.o.compareId, shop.key, "hand_written");
  const startedAt = ctx.now().toISOString();
  const runDir = await newRunDir(ctx, runId, shop);
  try {
    // as the pipeline stores a Codex answer: the layout as drawn, its adjustments as fixed codes
    const drawn = profileAsDrawn(spec, shop.demo);
    await writeFile(join(runDir, "final.json"), JSON.stringify(drawn.profile, null, 2), { mode: 0o600 });
    const overflow = await renderPage(ctx, runId, runDir, "final");
    const safety = await safetyOf(ctx, runId, "final", shop);
    await writeJsonAtomic(join(runDir, "report.json"), {
      ...baseRecord(ctx, runId, shop, "hand_written", startedAt),
      outcome: "hand_written",
      // a labelled renderer demo: a person wrote this spec, Codex did not
      source: "hand_written_spec",
      page_candidate: "final",
      codex: null,
      layout: drawn.profile.layout ?? null,
      layout_adjustments: drawn.adjustments.length ? [{ candidate: "final", codes: drawn.adjustments }] : [],
      overflow,
      safety,
    });
    ctx.log(`${runId}: hand-written spec rendered`);
    return { runId, shop: shop.key, kind: "hand_written", outcome: "hand_written" };
  } catch (error) {
    return failed(ctx, runId, runDir, shop, "hand_written", startedAt, error);
  }
}

async function runDesignShop(ctx: ShopContext, shop: CompareShop): Promise<{ run: CompareRunOutcome; stop?: string }> {
  const runId = runIdFor(ctx.o.compareId, shop.key, "design");
  const startedAt = ctx.now().toISOString();
  const runDir = await newRunDir(ctx, runId, shop);
  // the worker's own per-job budget, inside the comparison's
  const deadline = new RunDeadline(Math.min(Date.now() + SHOP_BUDGET_MS, ctx.o.deadline.endsAt));
  const prompts: Array<{ kind: string; prompt_chars: number; approx_tokens: number; images: number }> = [];
  try {
    const run = await runJobPipeline({
      jobId: runId,
      runDir,
      demo: shop.demo,
      refs: [],
      referenceKind: undefined,
      observedColours: null,
      renderer: ctx.session.renderer,
      sandbox: ctx.sandbox!,
      deadline,
      env: ctx.o.env,
      tempRoot: ctx.tempRoot,
      log: ctx.log,
      onCodexRequest: (r) => prompts.push({ kind: r.kind, prompt_chars: r.promptChars, approx_tokens: Math.round(r.promptChars / 4), images: r.images }),
    });
    const pipeline = run.pipeline;
    if (pipeline.status === "environment_failure") {
      const code = environmentCode(pipeline);
      await writeJsonAtomic(join(runDir, "report.json"), { ...baseRecord(ctx, runId, shop, "design", startedAt), outcome: "environment_failure", code, prompt_sizes: prompts });
      return { run: { runId, shop: shop.key, kind: "design", outcome: "environment_failure" }, stop: code };
    }
    await copyPipelineShots(runDir, pipeline);
    const record = await pipelineRecord(runDir, run);
    // the compared page: the final candidate, or the existing template when there is none (fallback)
    const candidate = pipeline.finalCandidate ? "final" : "none";
    const shots = pipeline.after ?? pipeline.before;
    await copyFile(shots.desktop, join(runDir, "page-desktop.png"));
    await copyFile(shots.mobile, join(runDir, "page-mobile.png"));
    const safety = await safetyOf(ctx, runId, candidate, shop);
    await writeJsonAtomic(join(runDir, "report.json"), {
      ...baseRecord(ctx, runId, shop, "design", startedAt),
      outcome: pipeline.status,
      page_candidate: candidate,
      visual_source: null,
      references: { images: 0 },
      codex: record.codex,
      overflow: record.overflow,
      timing: { capture_ms: 0, ...record.timing },
      photos: record.photos,
      prompt_sizes: prompts,
      safety,
    });
    ctx.log(`${runId}: ${pipeline.status}`);
    return { run: { runId, shop: shop.key, kind: "design", outcome: pipeline.status } };
  } catch (error) {
    const run = await failed(ctx, runId, runDir, shop, "design", startedAt, error, prompts);
    const code = error instanceof DeadlineError ? "COMPARE_RUN_TIME_BUDGET" : codeOf(error);
    return { run, ...(ENVIRONMENT_CODES.has(code) || code === "COMPARE_RUN_TIME_BUDGET" ? { stop: code } : {}) };
  }
}

async function failed(
  ctx: ShopContext,
  runId: string,
  runDir: string,
  shop: CompareShop,
  kind: CompareRunOutcome["kind"],
  startedAt: string,
  error: unknown,
  prompts: unknown[] = [],
): Promise<CompareRunOutcome> {
  const code = error instanceof DeadlineError ? "COMPARE_RUN_TIME_BUDGET" : codeOf(error);
  ctx.log(`${runId}: failed (${code})`);
  await writeJsonAtomic(join(runDir, "report.json"), { ...baseRecord(ctx, runId, shop, kind, startedAt), outcome: "error", code, ...(kind === "design" ? { prompt_sizes: prompts } : {}) }).catch(() => undefined);
  return { runId, shop: shop.key, kind, outcome: "error" };
}
