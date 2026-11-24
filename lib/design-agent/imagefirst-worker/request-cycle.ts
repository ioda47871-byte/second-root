/**
 * DEV-303 (owner direction 2026-11-23, docs/operations/first-client-pipeline.md §2 A/B): one cycle of the IMAGE_FIRST
 * worker in REQUEST mode — the same adapter as cycle.ts, for a request root accepted under the owner's standing permission
 * instead of a per-run packet. Offline code: it calls nothing by itself.
 *
 *   exclusive lock (the same imagefirst.lock) → HEAD = origin/develop and a clean tree → the request root placed in the
 *   run's private directory (`--request-file`), its SHA-256 = `--request-sha256`, its id = `--request`, strict schema
 *   (request.ts / request-prompt.ts) → the facts pack it names (outside git, no link, its SHA-256) and the shop's kind
 *   (real_shop: the pack is that shop's and not fictional; fictional: the research log's fictional-shop check) → the plan
 *   built from the facts and the direction (PC 2 + SP 4 = 6 pictures, one Codex run) → the request id never claimed here
 *   and unused in the entry's ledger → the one-use claim (claims/<id>.used, O_EXCL) → the EXISTING entry
 *   (cycle.ts GENERATE_ENTRY, its `--request-file` mode) invoked ONCE; it rebuilds and re-checks everything itself, uses
 *   the request id once in the phase2f ledger and runs the one Codex batch → the private run directory read back
 *   (cycle.ts settleRun): a receipt with codes and the SHA-256 of every picture → unlock.
 *
 * A request id never runs twice: the claim marker and the ledger's approval entry are both keyed by it and never removed,
 * whatever happened. A request id never has an IMAGE_FIRST approval id's form (request-prompt.ts isReservedRequestId), so
 * it can never claim, deliver or audit as one. Outputs only under the private runs directory (~/sr-runs, 0700, outside
 * the repository). Root enforces the quota, one attempt per id, the timeout and no retry; this cycle never retries.
 */
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BoundedResult } from "../bounded-process";
import { PromptStop } from "../image-first/prompt";
import { isPhotoRequest, isRequestId, REQUEST_IMAGES, type ImagefirstRequest } from "../image-first/request-prompt";
import { FULL_PAGE_KIND, FULL_PAGE_ROUTE } from "../phase2f-live/full-page-call";
import { LedgerStop, type Ledger } from "../phase2f-live/ledger";
import type { CommitState } from "../phase2f-live/steps";
import { acquireLock, WorkerStepError } from "../worker/state";
import { claimApproval, claimed, privateDir, privateOrMissing, settleRun, stamp, type ApprovalIdCheck, type CycleReport } from "./cycle";
import { loadRequestRun, type RequestRunInputs } from "./request";

/** A request id's claim rule: a request id (never an approval id's form). */
export const requestIdCheck = (id: string): ApprovalIdCheck => (isRequestId(id) ? "ok" : "APPROVAL_ID_INVALID");

export type RequestCycleOptions = {
  /** The worker's clone (its real path). */
  repoRoot: string;
  stateDir: string;
  runsDir: string;
  /** The worker user's home: ~/second-root-shops is under it. */
  home: string;
  requestId: string;
  requestSha256: string;
  /** Root's validated copy, placed in the run's private directory: <dir>/<request id>.json. */
  requestFile: string;
  signal?: AbortSignal;
  /** As cycle.ts CycleOptions.onInvoking: a function that ends a claimed run with a WORKER_INTERRUPTED receipt. */
  onInvoking?: (recordInterrupted: () => Promise<void>) => void;
};
export type RequestCycleDeps = {
  commit: () => Promise<CommitState>;
  ledger: Ledger;
  invoke: (argv: string[], signal?: AbortSignal) => Promise<BoundedResult>;
  now?: () => number;
};
/** The report (the CLI's one stdout line) and, once the request was read, what the CLI needs for the hand-off and record. */
export type RequestCycleResult = {
  /** photo_files: DEV-303 a succeeded photo-materials run's pictures (names and SHA-256), what a design request's photo_inputs names. */
  report: CycleReport & { mode: "request"; kind?: ImagefirstRequest["kind"]; stage?: "photo_materials"; photo_files?: { name: string; sha256: string }[] };
  /** caseStudySha256: Issue #336 the checked case study's SHA-256 (request.ts readRequestCaseStudy), null when the run has none. */
  run: { request: ImagefirstRequest; requestSha256: string; factsSha256: string; planSha256: string; commit: string; caseStudySha256: string | null } | null;
};

/** The entry's arguments in request mode (its REQUEST_VALUES): the request and the pins to re-check. */
export function requestArgv(o: { requestFile: string; requestId: string; requestSha256: string; outDir: string; commit: string; plan: RequestRunInputs["plan"] }): string[] {
  return [
    "--request-file", o.requestFile,
    "--request-id", o.requestId,
    "--request-sha256", o.requestSha256,
    "--out", o.outDir,
    "--expected-commit", o.commit,
    "--expected-plan-sha256", o.plan.plan_sha256,
    "--expected-prompt-sha256", o.plan.batch.sha256,
    "--expected-prompt-chars", String(o.plan.batch.chars),
  ];
}

/** A succeeded photo-materials run's pictures from its receipt (names and SHA-256 only), for the report line. */
async function photoFilesOf(report: CycleReport): Promise<{ photo_files?: { name: string; sha256: string }[] }> {
  if (report.status !== "succeeded" || !report.receipt) return {};
  const r = await readFile(report.receipt, "utf8").then((t) => JSON.parse(t) as { images?: { file?: unknown; sha256?: unknown }[] }, () => null);
  const files = (r?.images ?? []).flatMap((i) => (typeof i.file === "string" && /^parts\/photo-[1-6]\.png$/.test(i.file) && typeof i.sha256 === "string" ? [{ name: i.file.slice("parts/".length), sha256: i.sha256 }] : []));
  return files.length ? { photo_files: files } : {};
}

export async function runRequestCycle(o: RequestCycleOptions, d: RequestCycleDeps): Promise<RequestCycleResult> {
  const now = d.now ?? Date.now;
  const audited = new WeakSet<object>();
  const audit = async (r: RequestCycleResult) => {
    if (audited.has(r.report)) return r;
    audited.add(r.report);
    await appendFile(join(o.stateDir, "audit.jsonl"), `${JSON.stringify({ at: new Date(now()).toISOString(), request_id: o.requestId, ...r.report })}\n`, { mode: 0o600 }).catch(() => undefined);
    return r;
  };
  let lock: Awaited<ReturnType<typeof acquireLock>>;
  try {
    lock = await acquireLock(o.stateDir, new Date(now()), "imagefirst.lock");
  } catch (error) {
    return audit({ report: { mode: "request", status: "refused", code: error instanceof WorkerStepError ? error.code : "WORKER_LOCK_FAILED", invoked: false }, run: null });
  }
  if (lock === undefined) return audit({ report: { mode: "request", status: "locked", code: "WORKER_LOCKED", invoked: false }, run: null });
  try {
    return await audit(await lockedRequest(o, d, now, audit));
  } finally {
    await lock.release().catch(() => undefined);
  }
}

/** Every check up to, not including, the claim; no lock, no audit line, no write. "would_run" when the run would start now. */
export async function precheckRequestCycle(o: Omit<RequestCycleOptions, "signal" | "onInvoking">, d: Omit<RequestCycleDeps, "invoke">): Promise<RequestCycleResult> {
  return lockedRequest(o, { ...d, invoke: async () => Promise.reject(new Error("the precheck never invokes")) }, d.now ?? Date.now, async (r) => r, true);
}

async function lockedRequest(o: RequestCycleOptions, d: RequestCycleDeps, now: () => number, audit: (r: RequestCycleResult) => Promise<RequestCycleResult>, precheckOnly = false): Promise<RequestCycleResult> {
  const id = o.requestId;
  let run: RequestCycleResult["run"] = null;
  const seen: { kind?: ImagefirstRequest["kind"] } = {};
  const refuse = (code: string): RequestCycleResult => ({ report: { mode: "request", status: "refused", code, invoked: false, ...(isRequestId(id) ? { approval_id: id } : {}), ...(seen.kind ? { kind: seen.kind } : {}) }, run });
  if (!isRequestId(id)) return refuse("REQUEST_ID_INVALID");

  // ---- the reviewed code: HEAD = origin/develop, nothing changed ----
  const c = await d.commit().catch(() => null);
  if (!c?.head || !c.base || !/^[0-9a-f]{40}$/.test(c.head)) return refuse("COMMIT_UNREADABLE");
  if (c.head !== c.base) return refuse("NOT_ON_ORIGIN_DEVELOP");
  if (!c.clean) return refuse("TREE_DIRTY");
  const commit = c.head;

  // ---- the request, the facts pack, the shop's kind, the plan ----
  let inputs: RequestRunInputs;
  try {
    inputs = await loadRequestRun({ requestFile: o.requestFile, requestSha256: o.requestSha256, requestId: id, home: o.home, repo: o.repoRoot });
  } catch (error) {
    return refuse(error instanceof PromptStop ? error.code : "REQUEST_UNREADABLE");
  }
  const kind = (seen.kind = inputs.request.kind);
  run = { request: inputs.request, requestSha256: inputs.requestSha256, factsSha256: inputs.plan.facts_sha256, planSha256: inputs.plan.plan_sha256, commit, caseStudySha256: inputs.caseStudy?.sha256 ?? null };
  const photoStage = isPhotoRequest(inputs.request);
  // one Codex run; a design run makes PC 2 + SP 4, a photo-materials run 1..6 pictures (one per subject)
  const images = photoStage ? { pc: 0, sp: 0, photo: inputs.request.max_images } : REQUEST_IMAGES;
  const want = photoStage ? inputs.request.max_images : REQUEST_IMAGES.total;
  if (inputs.plan.batch.images !== want || want < 1 || want > REQUEST_IMAGES.total || inputs.request.codex_runs !== 1) return refuse("REQUEST_IMAGES_MISMATCH");
  if (inputs.photos === "unchecked") return refuse("PHOTO_INPUT_RUN_MISSING");

  // ---- one use: never claimed here, unused in the entry's ledger (read only) ----
  if (await claimed(o.stateDir, id)) return refuse("REQUEST_ALREADY_CLAIMED");
  try {
    await d.ledger.precheck({ approvalId: id, planId: id, route: FULL_PAGE_ROUTE, kind: FULL_PAGE_KIND, retryOf: null });
  } catch (error) {
    return refuse(error instanceof LedgerStop ? (error.code === "APPROVAL_ALREADY_USED" ? "REQUEST_ALREADY_USED" : error.code) : "LEDGER_UNREADABLE");
  }
  if (precheckOnly) {
    if (!(await privateOrMissing(o.stateDir)) || !(await privateOrMissing(join(o.stateDir, "claims")))) return refuse("CLAIMS_DIR_UNSAFE");
    if (!(await privateOrMissing(o.runsDir))) return refuse("RUNS_DIR_UNSAFE");
    return { report: { mode: "request", status: "would_run", code: null, invoked: false, approval_id: id, kind }, run };
  }
  if (!(await privateDir(o.stateDir)) || !(await privateDir(join(o.stateDir, "claims")))) return refuse("CLAIMS_DIR_UNSAFE");
  if (!(await privateDir(o.runsDir))) return refuse("RUNS_DIR_UNSAFE");
  if (o.signal?.aborted) return refuse("WORKER_ABORTED");

  // ---- the claim, then ONE invocation (never retried, whatever it returns) ----
  const started = now();
  const runDir = join(o.runsDir, `${id}-${stamp(started)}`);
  const plan = inputs.plan;
  const settle = (res: BoundedResult | null, interrupted: boolean) =>
    settleRun(
      {
        runsDir: o.runsDir,
        runDir,
        receiptName: `${id}-${stamp(started)}`,
        started,
        now,
        images,
        fields: { shop: inputs.request.shop_id, direction: "request", approval_id: id, plan_id: id, commit, packet_sha256: inputs.requestSha256, plan_sha256: plan.plan_sha256, prompt_sha256: plan.batch.sha256, prompt_chars: plan.batch.chars },
        extra: {
          mode: "request",
          kind: inputs.request.kind,
          request_id: id,
          request_sha256: inputs.requestSha256,
          facts_sha256: plan.facts_sha256,
          ...(photoStage ? { request_stage: "photo_materials" as const } : {}),
          ...(!isPhotoRequest(inputs.request) && inputs.request.photo_inputs ? { photo_inputs: inputs.request.photo_inputs } : {}),
          // Issue #336: the design stage's checked case study, by its SHA-256 only (never its path or content)
          ...(inputs.caseStudy ? { case_study_sha256: inputs.caseStudy.sha256 } : {}),
        },
      },
      res,
      interrupted,
    ).then(async (report): Promise<RequestCycleResult> => ({ report: { ...report, mode: "request", kind: inputs.request.kind, ...(photoStage ? { stage: "photo_materials" as const, ...(await photoFilesOf(report)) } : {}) }, run }));
  let ending: Promise<RequestCycleResult> | null = null;
  const end = (res: BoundedResult | null, interrupted: boolean) => (ending ??= settle(res, interrupted).then(audit));
  const claiming = claimApproval(o.stateDir, id, now(), requestIdCheck);
  o.onInvoking?.(async () => {
    if ((await claiming) === "claimed") await end(null, true);
  });
  const got = await claiming;
  if (got !== "claimed") return refuse(got === "APPROVAL_ALREADY_CLAIMED" ? "REQUEST_ALREADY_CLAIMED" : got);

  let res: BoundedResult | null;
  try {
    res = await d.invoke(requestArgv({ requestFile: o.requestFile, requestId: id, requestSha256: inputs.requestSha256, outDir: runDir, commit, plan }), o.signal);
  } catch {
    res = null;
  }
  return end(res, o.signal?.aborted === true || res?.aborted === true);
}
