/**
 * Issue #293 P3 (prepared, NOT approved): ONE real IMAGE_FIRST generation under one owner approval — the PC and SP
 * section pictures of one direction, in ONE Codex run (one batch of at most 6 pictures; kind full_page_comp, route
 * image_first in the ledger). Nothing here runs without the owner's per-run approval packet: every pin below must hold
 * before the approval is used, and the approval is used once whatever happens.
 *
 * Before the approval is used (nothing is created, nothing is called):
 *   - the run directory is outside the repository (RUN_DIR_IN_REPO);
 *   - the approval id names this direction (APPROVAL_ID_DIRECTION_MISMATCH) and is not past its expiry (APPROVAL_EXPIRED);
 *   - the plan rebuilt from the pinned inputs is the approved plan (PLAN_PIN_MISMATCH), the approval packet's bytes are
 *     the approved ones (PACKET_PIN_MISMATCH);
 *   - steps.ts checkBeforeApproval: the owner's flag, the batch prompt's SHA-256 and length, the output place, the
 *     commit pin (HEAD = origin/develop = the approved commit, clean), the preflight (sandbox, .env) and the ledger
 *     (approval unused, a free slot, time left: 15 min a call, 2 h a plan).
 *
 * Then: the approval is reserved, the private run directory is created (0700), the inputs and every prompt are written
 * into it, and the batch is called ONCE (the injected `batch`: the CLI passes the one-run batch call of image-once.ts, in the sandbox).
 * The first failure ends the run: no retry, here or by the caller (a new approval and a new packet are needed).
 * Only a batch with no stop code, the IMAGE_SAVED outcome and exactly the planned number of pictures is a success; it
 * writes parts/<name>.png (in the planned order) and run-plan.json, the shape `image-first-check --assemble` reads.
 * A stopped batch writes call.json with its stop code and keeps any picture it returned under stopped/ (never as a part).
 *
 * No process and no network here.
 */
import { randomBytes } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { CodexAbortedError, CodexError } from "../codex";
import { REQUIRED_GENERATION, REQUIRED_RIGHTS, REQUIRED_STORAGE, OUTPUT_KIND, RECORD_SCHEMA, ROUTE, VIEWPORTS } from "../image-first/record";
import type { PromptInputs, PromptPlan } from "../image-first/prompt";
import { LedgerStop, type Ledger, type Receipt } from "./ledger";
import { checkBeforeApproval, sha256, writeOnce, type CommitState } from "./steps";

/** What the batch did, as the CLI reports it from the one-run batch call (fixed facts only). */
export type FullPageBatchResult = {
  images: { png: Buffer; width: number; height: number }[];
  outcome: string;
  stopCode: string | null;
  imageCalls: number;
  imageFailed: number;
  imageCallIds: string[];
  threadId: string | null;
  cliVersion: string | null;
  model: string | null;
};
export type FullPageBatch = (o: { prompt: string; timeoutMs: number; maxImages: number; signal?: AbortSignal }) => Promise<FullPageBatchResult>;

export type FullPageCallInput = {
  plan: PromptPlan;
  inputs: Pick<PromptInputs, "factsBytes" | "directionBytes">;
  /** The approval packet's bytes as they are at the approved commit (null: unreadable). */
  packetBytes: Buffer | null;
  humanApprovalConfirmed: boolean;
  approvalId: string;
  planId: string;
  /** YYYY-MM-DD, the last day the approval may be used (the owner's packet). */
  approvalExpires: string;
  expected: { promptSha256: string; promptChars: number; commit: string; planSha256: string; packetSha256: string };
  outDir: string;
  /** The repository (its real path): the run directory must be outside it. */
  repoRoot: string;
  signal?: AbortSignal;
};
export type FullPageCallDeps = { ledger: Ledger; batch: FullPageBatch; commit: () => Promise<CommitState>; preflight?: () => Promise<string | null>; now?: () => number };

export type FullPageCallResult =
  | { status: "succeeded"; outDir: string; receipt: Receipt; runId: string; images: number; warnings: string[] }
  | { status: "stopped"; code: string; stage: "precheck" | "call"; aborted: boolean; outcome?: string };

export const FULL_PAGE_KIND = "full_page_comp" as const;
export const FULL_PAGE_ROUTE = "image_first" as const;
/** <shop words>-imagefirst-<d1|d3>-<YYYYMMDD>-<NN>: the direction is in the id, so an approval cannot run the other one. */
const APPROVAL_FORMAT = /^[a-z0-9][a-z0-9-]{2,40}-imagefirst-(d[0-9])-(\d{8})-(\d{2})$/;

const within = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

export async function runFullPageCall(i: FullPageCallInput, d: FullPageCallDeps): Promise<FullPageCallResult> {
  const now = d.now ?? Date.now;
  const refuse = (code: string): FullPageCallResult => ({ status: "stopped", code, stage: "precheck", aborted: false });
  const plan = i.plan;

  // ---- before the approval is used: this route's own pins -------------------------------------
  if (!isAbsolute(i.outDir)) return refuse("OUT_DIR_INVALID");
  const repo = await realpath(i.repoRoot).catch(() => null);
  const parent = await realpath(dirname(i.outDir)).catch(() => null);
  if (!repo) return refuse("REPO_UNRESOLVABLE");
  if (within(i.outDir, i.repoRoot) || within(i.outDir, repo) || (parent !== null && within(parent, repo))) return refuse("RUN_DIR_IN_REPO");
  const m = APPROVAL_FORMAT.exec(i.approvalId);
  if (!m || m[1] !== plan.direction_key) return refuse("APPROVAL_ID_DIRECTION_MISMATCH");
  const expires = /^\d{4}-\d{2}-\d{2}$/.test(i.approvalExpires) ? Date.parse(`${i.approvalExpires}T23:59:59+09:00`) : Number.NaN;
  if (!Number.isFinite(expires) || now() > expires) return refuse("APPROVAL_EXPIRED");
  if (plan.plan_sha256 !== i.expected.planSha256) return refuse("PLAN_PIN_MISMATCH");
  if (plan.batch.sha256 !== sha256(Buffer.from(plan.batch.prompt, "utf8")) || plan.batch.chars !== plan.batch.prompt.length) return refuse("PLAN_PIN_MISMATCH");
  if (!i.packetBytes || !/^[a-f0-9]{64}$/.test(i.expected.packetSha256) || sha256(i.packetBytes) !== i.expected.packetSha256) return refuse("PACKET_PIN_MISMATCH");
  if (sha256(i.inputs.factsBytes) !== plan.facts_sha256 || sha256(i.inputs.directionBytes) !== plan.direction_sha256) return refuse("PLAN_PIN_MISMATCH");
  const parts = VIEWPORTS.flatMap((v) => plan.viewports[v].parts.map((p) => ({ v, p })));
  if (parts.length !== plan.batch.images || parts.length < 2 || parts.length > 6) return refuse("PLAN_PIN_MISMATCH");

  // ---- before the approval is used: the shared checks (steps.ts) -------------------------------
  const checked = await checkBeforeApproval(
    { humanApprovalConfirmed: i.humanApprovalConfirmed, prompt: plan.batch.prompt, expected: { promptSha256: i.expected.promptSha256, promptChars: i.expected.promptChars, commit: i.expected.commit }, outDir: i.outDir, approvalId: i.approvalId, planId: i.planId, route: FULL_PAGE_ROUTE, retryOf: null, ...(i.signal === undefined ? {} : { signal: i.signal }) },
    FULL_PAGE_KIND,
    d,
  );
  if (!checked.ok) return { status: "stopped", code: checked.code, stage: "precheck", aborted: checked.aborted };

  // ---- the approval is used from here on ------------------------------------------------------
  const runId = `if-${randomBytes(8).toString("hex")}`;
  let receipt: Receipt;
  try {
    receipt = await d.ledger.reserve({ approval_id: i.approvalId, plan_id: i.planId, route: FULL_PAGE_ROUTE, kind: FULL_PAGE_KIND, retry_of: null, prompt_sha256: i.expected.promptSha256, prompt_chars: i.expected.promptChars, commit: i.expected.commit, run_id: runId });
  } catch (error) {
    return { status: "stopped", code: error instanceof LedgerStop ? error.code : "LEDGER_UNWRITABLE", stage: "call", aborted: false };
  }
  const started = now();
  const end = async (status: "succeeded" | "failed" | "aborted", code: string | null) => d.ledger.finish(i.approvalId, { status, code, finished_at: new Date(now()).toISOString(), elapsed_ms: now() - started });
  const out = (rel: string) => join(i.outDir, rel);
  const record = (status: "failed" | "aborted", code: string, extra: Record<string, unknown> = {}) => writeOnce(out("call.json"), { schema: "image_first_call_v0", status, code, receipt, plan_sha256: plan.plan_sha256, ...extra }).catch(() => undefined);
  try {
    await mkdir(i.outDir, { mode: 0o700 });
    for (const sub of ["parts", "prompts"]) await mkdir(out(sub), { mode: 0o700 });
    // the inputs and every prompt first: the private run keeps what was asked even if the call fails
    await writeOnce(out("facts-pack.json"), i.inputs.factsBytes);
    await writeOnce(out("direction.json"), i.inputs.directionBytes);
    for (const { p } of parts) await writeOnce(out(p.prompt_file), Buffer.from(p.prompt, "utf8"));
    await writeOnce(out("prompts/batch.txt"), Buffer.from(plan.batch.prompt, "utf8"));
  } catch {
    await end("failed", "OUT_DIR_UNWRITABLE").catch(() => undefined);
    return { status: "stopped", code: "OUT_DIR_UNWRITABLE", stage: "call", aborted: false };
  }

  let res: FullPageBatchResult;
  try {
    res = await d.batch({ prompt: plan.batch.prompt, timeoutMs: checked.timeoutMs, maxImages: parts.length, ...(i.signal === undefined ? {} : { signal: i.signal }) });
    if (i.signal?.aborted) throw new CodexAbortedError();
  } catch (error) {
    const aborted = error instanceof CodexAbortedError;
    const code = aborted ? "CODEX_ABORTED" : error instanceof CodexError ? error.code : "CODEX_UNEXPECTED";
    await record(aborted ? "aborted" : "failed", code);
    await end(aborted ? "aborted" : "failed", code).catch(() => undefined);
    return { status: "stopped", code, stage: "call", aborted };
  }
  const finished = now();

  // hard stop: anything but a complete batch ends here (no retry; the approval stays used)
  const complete = res.stopCode === null && res.outcome === "IMAGE_SAVED" && res.images.length === parts.length && res.imageFailed === 0 && res.imageCalls === parts.length;
  if (!complete) {
    const code = res.stopCode ?? (res.outcome === "IMAGE_SAVED" ? "CODEX_IMAGE_COUNT_MISMATCH" : "IMAGE_TOOL_RESULT_INVALID");
    const stopped: { file: string; sha256: string; width: number; height: number }[] = [];
    if (res.images.length > 0) await mkdir(out("stopped"), { mode: 0o700 }).catch(() => undefined);
    for (const [n, img] of res.images.slice(0, 6).entries()) {
      const file = `stopped/image-${n + 1}.png`;
      if (await writeOnce(out(file), img.png).then(() => true, () => false)) stopped.push({ file, sha256: sha256(img.png), width: img.width, height: img.height });
    }
    await record("failed", code, { outcome: res.outcome, stop_code: res.stopCode, image_calls: res.imageCalls, image_failed: res.imageFailed, images: res.images.length, thread_id: res.threadId, stopped });
    await end("failed", code).catch(() => undefined);
    return { status: "stopped", code, stage: "call", aborted: false, outcome: res.outcome };
  }

  // the pictures in the order they were saved = the order asked for (PC 1..n, then SP 1..m); the visual read checks it
  const ids = res.imageCallIds.length === parts.length ? res.imageCallIds : null;
  const warnings = [...(res.model === null ? ["session_model_unknown"] : []), ...(res.cliVersion === null ? ["cli_version_unknown"] : []), ...(ids === null ? ["image_call_ids_incomplete"] : [])];
  const viewports = Object.fromEntries(
    VIEWPORTS.map((v) => {
      const vp = plan.viewports[v];
      const offset = v === "desktop_1440" ? 0 : plan.viewports.desktop_1440.parts.length;
      return [
        v,
        {
          target_css_width: vp.target_css_width,
          mode: vp.mode,
          section_order: vp.section_order,
          parts: vp.parts.map((p, n) => ({ index: p.index, file: p.file, rendered_from: "image_tool", prompt_file: p.prompt_file, call: { thread_id: res.threadId, item_id: ids?.[offset + n] ?? null, approval_id: i.approvalId }, sections: p.sections })),
          seams: vp.seams,
        },
      ];
    }),
  );
  const runPlan = {
    schema: RECORD_SCHEMA,
    output_kind: OUTPUT_KIND,
    route: ROUTE,
    run_id: runId,
    shop: plan.shop,
    direction: { direction_id: plan.direction_id, set_sha256: plan.direction_set_sha256 },
    viewports,
    generation: {
      tool: REQUIRED_GENERATION.tool,
      cli_version: res.cliVersion,
      session_model: res.model,
      image_tool: REQUIRED_GENERATION.image_tool,
      // known from the CLI source only (rust-v0.159.0); not reported by the run: unknown is a warning, never guessed
      image_model: null,
      repo_commit: i.expected.commit,
      plan_id: i.planId,
      approval_ids: [i.approvalId],
      approval_packet_sha256: i.expected.packetSha256,
      started_at: new Date(started).toISOString(),
      finished_at: new Date(finished).toISOString(),
      image_calls: res.imageCalls,
      image_completed: res.images.length,
      image_failed: res.imageFailed,
      outcome: res.outcome,
      stop_code: null,
    },
    rights: { ...REQUIRED_RIGHTS },
    storage: { ...REQUIRED_STORAGE },
    generated_at: new Date(finished).toISOString(),
  };
  try {
    for (const [n, { p }] of parts.entries()) await writeOnce(out(p.file), res.images[n]!.png);
    await writeOnce(out("run-plan.json"), runPlan);
    await writeOnce(out("call.json"), { schema: "image_first_call_v0", status: "succeeded", code: null, receipt, plan_sha256: plan.plan_sha256, outcome: res.outcome, thread_id: res.threadId, images: parts.map(({ p }, n) => ({ file: p.file, sha256: sha256(res.images[n]!.png), width: res.images[n]!.width, height: res.images[n]!.height })), warnings });
  } catch {
    await end("failed", "OUT_WRITE_FAILED").catch(() => undefined);
    return { status: "stopped", code: "OUT_WRITE_FAILED", stage: "call", aborted: false };
  }
  await end("succeeded", null);
  return { status: "succeeded", outDir: i.outDir, receipt, runId, images: parts.length, warnings };
}
