/**
 * Phase 2f-2 (DEV-117): ONE real image call under one owner approval — route C's picture (asked for by a design run
 * after its pre-render) or route A's concept image.
 *
 * Route C: the request comes from the pre-render step and names the design run it belongs to. That design run must
 * have succeeded in its output folder AND in the ledger (readStep), and the request must be the one the owner saw:
 * its prompt's SHA-256 and length, its asset and the design run. Route A: the prompt is the concept prompt; its SHA
 * and length must be the approved ones.
 *
 * Then, as for the design step: everything is checked before the approval is used (steps.ts), the approval is
 * reserved (never reusable), the image tool is called once (the injected `image` function), and the ending is
 * recorded as it was. Only a saved picture is a success; any other outcome keeps its image outcome and stop code
 * (never filled in, never rewritten) and is never retried here.
 *
 * Output folder:
 *   image.png        only when the image tool saved one (fully checked PNG)
 *   report.json      { png_sha256, width, height } of that picture (route A packages it with the 2f-1 runner)
 *   generation.json  the call's facts (CLI version, model, approval, prompt SHA, commit, run, times)
 *   call.json        how it ended: outcome, stop code, the request it answered, the ledger receipt, warnings
 * call.json is written last, the ledger's result after it.
 *
 * DEV-150 (Issue #180): route "claude_page" (kind page_image) — a picture asked for by a page CLAUDE wrote for the
 * three-method study (LAYOUT_FIRST / DIRECTION_FIRST). There is no design run to bind to: the request
 * (three_method_asset_request_v0, made offline by scripts/design-artifact/three-methods-steps.ts --page-request) is
 * bound to the page. Before the approval is used: the request's schema and its own prompt hash; its placement was
 * measured (runnableAssetRequests, else ASSET_PLACEMENT_UNMEASURED); the page file and its style.css are regular files
 * under the given root (no link, no "..") and tracked by git, and the page's SHA-256 is the request's; the request
 * rebuilt from that page (the three-method lane's page-assets) has the same asset, alt and prompt; and the page passes
 * the existing DOM prototype safety check, whose alt for the picture is the request's. The DOM check (Chromium) and
 * the tracked check (git) are functions the image CLI passes in: this module still starts no process.
 *
 * No process and no network here: the image CLI passes the sandboxed image call.
 */
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { buildPageAssetRequests, runnableAssetRequests, type PageAssetRequest } from "../three-methods/page-assets";
import { CodexAbortedError, CodexError } from "../codex";
import { LedgerStop, type Ledger, type Receipt } from "./ledger";
import { checkBeforeApproval, readStep, sha256, StepStop, writeOnce, type CommitState, type Generation } from "./steps";

/** What the image tool did (as the image CLI reports it). */
export type ImageToolResult = {
  png: Buffer | null;
  width: number | null;
  height: number | null;
  outcome: string;
  stopCode: string | null;
  cliVersion: string | null;
  model: string | null;
  threadId: string | null;
};
export type ImageTool = (o: { prompt: string; timeoutMs: number; signal?: AbortSignal }) => Promise<ImageToolResult>;

/** The pre-render step's request for one picture of a route C design run (what the owner approves). */
export type ImageRequest = {
  schema: "phase2f_image_request_v1";
  route: "C_hybrid";
  design: { dir: string; approval_id: string; run_id: string; prompt_sha256: string; commit: string; plan_id: string };
  asset_id: string;
  alt: string;
  prompt: string;
  prompt_sha256: string;
  prompt_chars: number;
  placement: unknown;
  essential: boolean;
};

/** The facts pack the page's request is rebuilt with (the image CLI parses it with the facts pack schema). */
export type PageFacts = Parameters<typeof buildPageAssetRequests>[0]["facts"];

export type ImageCallInput =
  | { route: "C_hybrid"; request: ImageRequest; common: Common }
  | { route: "A_image"; prompt: string; common: Common }
  /** DEV-150: a picture for a page Claude wrote; `page.root` is the directory the request's page path is relative to. */
  | { route: "claude_page"; request: PageAssetRequest; page: { root: string }; facts: PageFacts; common: Common };
type Common = {
  humanApprovalConfirmed: boolean;
  approvalId: string;
  planId: string;
  retryOf: string | null;
  expected: { promptSha256: string; promptChars: number; commit: string };
  outDir: string;
  signal?: AbortSignal;
  /**
   * DEV-150 (owner approval A′): the generation pin the CLI checks in its preflight (--expect-cli-version and the
   * resolved --previous-steps), or null when none was given. Route C requires it when the named design run is a
   * three-method pilot design (its call.json says prompt_version "tm0"), and the previous steps must include that
   * design run. Any other route C design (v1 / v1.1 / v2, or a record without the field) is unchanged.
   */
  generationPin?: { previousSteps: readonly string[] } | null;
};

/** DEV-150: the existing DOM prototype safety check on Claude's page (the CLI runs it in Chromium): the alts it read, or the stop. */
export type PageDomCheck = (page: { html: string; css: string }, assetPaths: readonly string[]) => Promise<{ ok: true; alts: Record<string, string> } | { ok: false; code: string }>;

export type ImageCallDeps = {
  ledger: Ledger;
  image: ImageTool;
  commit: () => Promise<CommitState>;
  preflight?: () => Promise<string | null>;
  now?: () => number;
  /** DEV-150, route claude_page only (required there). */
  pageDom?: PageDomCheck;
  /** DEV-150, route claude_page only (required there): every given file is tracked by git in the repository. */
  tracked?: (paths: readonly string[]) => Promise<boolean>;
};

/** A regular file (never a link) at exactly root/rel: no "..", no absolute part, no link anywhere on the way. */
async function fileUnder(root: string, rel: string): Promise<string | null> {
  if (!isAbsolute(root) || isAbsolute(rel) || normalize(rel) !== rel || rel.split("/").includes("..") || rel.startsWith(".")) return null;
  const path = join(root, rel);
  const st = await lstat(path).catch(() => null);
  if (!st?.isFile() || st.isSymbolicLink()) return null;
  const [r, f] = await Promise.all([realpath(root).catch(() => null), realpath(path).catch(() => null)]);
  return r !== null && f === join(r, rel) ? path : null;
}

/**
 * DEV-150: the checks 0-4 of a page's picture request (docs/design/three-methods-entries.md §8), before anything is
 * used. Exported so the image CLI's --print-pin runs exactly the same checks offline.
 */
export async function checkPageImageRequest(i: Pick<Extract<ImageCallInput, { route: "claude_page" }>, "request" | "page" | "facts">, d: Pick<ImageCallDeps, "pageDom" | "tracked">): Promise<{ ok: true } | { ok: false; code: string }> {
  const r = i.request;
  const no = (code: string) => ({ ok: false as const, code });
  // 1. the request is the one the owner saw: its schema and its own prompt hash
  if (r?.schema !== "three_method_asset_request_v0" || (r.method !== "LAYOUT_FIRST" && r.method !== "DIRECTION_FIRST") || typeof r.prompt !== "string" || typeof r.asset_id !== "string" || typeof r.page?.path !== "string") return no("IMAGE_REQUEST_INVALID");
  if (sha256(Buffer.from(r.prompt, "utf8")) !== r.prompt_sha256 || r.prompt.length !== r.prompt_chars) return no("IMAGE_REQUEST_INVALID");
  // 4. measured where the picture sits (owner's provisional policy, Issue #180)
  const runnable = runnableAssetRequests([r]);
  if (!runnable.ok) return no(runnable.code);
  if (!d.pageDom || !d.tracked) return no("PAGE_CHECKS_NOT_GIVEN");
  // 2. the page and its stylesheet: regular files under the root, tracked, the page's bytes the request's
  const htmlPath = await fileUnder(i.page.root, r.page.path);
  const cssRel = join(dirname(r.page.path), "style.css");
  const cssPath = htmlPath ? await fileUnder(i.page.root, cssRel) : null;
  if (!htmlPath || !cssPath) return no("PAGE_FILE_INVALID");
  const html = await readFile(htmlPath, "utf8");
  const css = await readFile(cssPath, "utf8");
  if (sha256(html) !== r.page.html_sha256) return no("PAGE_SHA_MISMATCH");
  if (!(await d.tracked([htmlPath, cssPath]).catch(() => false))) return no("PAGE_NOT_TRACKED");
  // 3. the request rebuilt from that page: the same picture, description and prompt (a hand-edited request is refused)
  const rebuilt = buildPageAssetRequests({ method: r.method, page: { path: r.page.path, html }, facts: i.facts, placement: { [r.asset_id]: r.placement! }, heroSections: [] });
  if (!rebuilt.ok) return no(rebuilt.code);
  const q = rebuilt.requests.find((x) => x.asset_id === r.asset_id);
  // without the hero sections the rebuilt "essential" is a lower bound: a request may only be more essential
  if (!q || q.alt !== r.alt || q.prompt !== r.prompt || q.prompt_sha256 !== r.prompt_sha256 || q.prompt_chars !== r.prompt_chars || (q.essential && r.essential !== true)) return no("IMAGE_REQUEST_MISMATCH");
  // 0. the existing DOM safety check (network shut, JavaScript off); the picture's alt as the DOM reads it
  const dom = await d.pageDom({ html, css }, rebuilt.requests.map((x) => `assets/${x.asset_id}.png`)).catch(() => ({ ok: false as const, code: "PAGE_DOM_CHECK_FAILED" }));
  if (!dom.ok) return no(dom.code);
  if ((dom.alts[`assets/${r.asset_id}.png`] ?? "").replace(/\s+/g, " ").trim() !== r.alt) return no("ASSET_DOM_ALT_MISMATCH");
  return { ok: true };
}

export type ImageCallResult =
  | { status: "succeeded"; outDir: string; generation: Generation; warnings: string[]; receipt: Receipt; width: number; height: number }
  | { status: "stopped"; code: string; stage: "precheck" | "call"; aborted: boolean; outcome?: string };

export async function runImageCall(i: ImageCallInput, d: ImageCallDeps): Promise<ImageCallResult> {
  const now = d.now ?? Date.now;
  const c = i.common;
  const refuse = (code: string): ImageCallResult => ({ status: "stopped", code, stage: "precheck", aborted: false });
  const kind = i.route === "C_hybrid" ? "image" : i.route === "claude_page" ? "page_image" : "concept_image";
  let prompt: string;
  let link: Record<string, unknown> = {};
  if (i.route === "C_hybrid") {
    const r = i.request;
    // the request is the one the owner saw: its own prompt hash, and a picture of a design run that succeeded
    if (r?.schema !== "phase2f_image_request_v1" || r.route !== "C_hybrid" || typeof r.prompt !== "string") return refuse("IMAGE_REQUEST_INVALID");
    if (sha256(Buffer.from(r.prompt, "utf8")) !== r.prompt_sha256 || r.prompt.length !== r.prompt_chars) return refuse("IMAGE_REQUEST_INVALID");
    if (r.design.plan_id !== c.planId) return refuse("IMAGE_REQUEST_OTHER_PLAN");
    try {
      const design = await readStep(r.design.dir, d.ledger, { kind: "design", route: "C_hybrid" });
      if (design.call.status !== "succeeded") return refuse("DESIGN_RUN_NOT_SUCCEEDED");
      // DEV-150 (owner approval A′): a pilot design's picture needs the generation pin, naming that design run as a previous step
      if (design.call.prompt_version === "tm0" && !c.generationPin?.previousSteps.some((d) => resolve(d) === resolve(r.design.dir))) return refuse("GENERATION_PIN_REQUIRED");
      if (design.receipt.approval_id !== r.design.approval_id || design.receipt.plan_id !== r.design.plan_id || design.receipt.run_id !== r.design.run_id || design.receipt.prompt_sha256 !== r.design.prompt_sha256 || design.receipt.commit !== r.design.commit) return refuse("RECORD_MISMATCH");
    } catch (error) {
      return refuse(error instanceof StepStop ? error.code : "RECORD_UNREADABLE");
    }
    prompt = r.prompt;
    link = { design_run_id: r.design.run_id, design_approval_id: r.design.approval_id, asset_id: r.asset_id, essential: r.essential };
  } else if (i.route === "claude_page") {
    const checkedPage = await checkPageImageRequest(i, d);
    if (!checkedPage.ok) return refuse(checkedPage.code);
    prompt = i.request.prompt;
    link = { page_path: i.request.page.path, page_sha256: i.request.page.html_sha256, asset_id: i.request.asset_id, essential: i.request.essential };
  } else {
    prompt = i.prompt;
  }

  // ---- before the approval is used (steps.ts) --------------------------------------------------
  const checked = await checkBeforeApproval({ ...c, prompt, route: i.route }, kind, d);
  if (!checked.ok) return { status: "stopped", code: checked.code, stage: "precheck", aborted: checked.aborted };

  // ---- the approval is used from here on ------------------------------------------------------
  const runId = `p2f-${randomBytes(8).toString("hex")}`;
  let receipt: Receipt;
  try {
    receipt = await d.ledger.reserve({ approval_id: c.approvalId, plan_id: c.planId, route: i.route, kind, retry_of: c.retryOf, prompt_sha256: c.expected.promptSha256, prompt_chars: c.expected.promptChars, commit: c.expected.commit, run_id: runId });
  } catch (error) {
    return { status: "stopped", code: error instanceof LedgerStop ? error.code : "LEDGER_UNWRITABLE", stage: "call", aborted: false };
  }
  const started = now();
  const end = async (status: "succeeded" | "failed" | "aborted", code: string | null) =>
    d.ledger.finish(c.approvalId, { status, code, finished_at: new Date(now()).toISOString(), elapsed_ms: now() - started });
  const record = (status: "failed" | "aborted", code: string, extra: Record<string, unknown> = {}) =>
    writeOnce(join(c.outDir, "call.json"), { schema: "phase2f_live_call_v1", status, code, receipt, request: link, warnings: [], ...extra }).catch(() => undefined);
  try {
    await mkdir(c.outDir, { mode: 0o700 });
  } catch {
    await end("failed", "OUT_DIR_UNWRITABLE").catch(() => undefined);
    return { status: "stopped", code: "OUT_DIR_UNWRITABLE", stage: "call", aborted: false };
  }

  let res: ImageToolResult;
  try {
    res = await d.image({ prompt, timeoutMs: checked.timeoutMs, ...(c.signal === undefined ? {} : { signal: c.signal }) });
    if (c.signal?.aborted) throw new CodexAbortedError();
  } catch (error) {
    const aborted = error instanceof CodexAbortedError;
    const code = aborted ? "CODEX_ABORTED" : error instanceof CodexError ? error.code : "CODEX_UNEXPECTED";
    await record(aborted ? "aborted" : "failed", code);
    await end(aborted ? "aborted" : "failed", code).catch(() => undefined);
    return { status: "stopped", code, stage: "call", aborted };
  }

  // only a saved picture is a success; any other outcome is kept exactly as it came
  if (res.outcome !== "IMAGE_SAVED" || !res.png || res.width === null || res.height === null) {
    // a "saved" outcome without its file, or a failure without a stop code, is a fault of the tool adapter: never filled in
    const code = res.outcome === "IMAGE_SAVED" || !res.stopCode ? "IMAGE_TOOL_RESULT_INVALID" : res.stopCode;
    await record("failed", code, { outcome: res.outcome, stop_code: res.stopCode, thread_id: res.threadId });
    await end("failed", code).catch(() => undefined);
    return { status: "stopped", code, stage: "call", aborted: false, outcome: res.outcome };
  }

  const generation: Generation = {
    status: "succeeded",
    tool: "codex_cli",
    tool_version: res.cliVersion,
    model_reported: res.model,
    approval_id: c.approvalId,
    prompt_sha256: c.expected.promptSha256,
    worker_commit: c.expected.commit,
    run_id: runId,
    started_at: new Date(started).toISOString(),
    finished_at: new Date(now()).toISOString(),
  };
  const warnings = [...(res.model === null ? ["generation_model_unknown"] : []), ...(res.cliVersion === null ? ["generation_tool_version_unknown"] : [])];
  try {
    await writeOnce(join(c.outDir, "image.png"), res.png);
    await writeOnce(join(c.outDir, "report.json"), { png_sha256: sha256(res.png), width: res.width, height: res.height });
    await writeOnce(join(c.outDir, "generation.json"), generation);
    await writeOnce(join(c.outDir, "call.json"), { schema: "phase2f_live_call_v1", status: "succeeded", code: null, receipt, request: link, outcome: res.outcome, stop_code: null, thread_id: res.threadId, png_sha256: sha256(res.png), warnings });
  } catch {
    await end("failed", "OUT_WRITE_FAILED").catch(() => undefined);
    return { status: "stopped", code: "OUT_WRITE_FAILED", stage: "call", aborted: false };
  }
  await end("succeeded", null);
  return { status: "succeeded", outDir: c.outDir, generation, warnings, receipt, width: res.width, height: res.height };
}
