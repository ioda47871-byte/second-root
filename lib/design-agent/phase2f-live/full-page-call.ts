/**
 * Issue #293 P3 (prepared, NOT approved): ONE real IMAGE_FIRST generation under one owner approval — the PC and SP
 * section pictures of one direction, in ONE Codex run (one batch of at most 6 pictures; kind full_page_comp, route
 * image_first in the ledger). Nothing here runs without the owner's per-run approval packet: every pin below must hold
 * before the approval is used, and the approval is used once whatever happens.
 *
 * Before the approval is used (nothing is created, nothing is called):
 *   - the run directory is outside the repository (RUN_DIR_IN_REPO);
 *   - the approval id names this direction (APPROVAL_ID_DIRECTION_MISMATCH); the expiry is a real UTC instant written
 *     YYYY-MM-DDTHH:MM:SSZ (APPROVAL_EXPIRY_INVALID), not past (APPROVAL_EXPIRED) and at most 24 hours ahead
 *     (APPROVAL_EXPIRY_TOO_FAR);
 *   - the plan rebuilt from the pinned inputs is the approved plan (PLAN_PIN_MISMATCH);
 *   - the packet is exactly this direction's own packet of the repository (approval-packets.ts: d1 / d3 the P3 packet
 *     APPROVAL_PACKET_PATH, d4 its own; PACKET_PATH_NOT_ALLOWED: never a test fixture, never another direction's packet);
 *   - the packet itself is read: its header and its §10 say 承認済み, §10 is filled in (PACKET_NOT_APPROVED), and its direction,
 *     approval id, expiry and plan id are the ones given to this run (PACKET_APPROVAL_MISMATCH). The commit is not in
 *     the packet (the packet is part of that commit): it is pinned by the expected commit = HEAD check below;
 *   - steps.ts checkBeforeApproval: the owner's flag, the batch prompt's SHA-256 and length, the output place, the
 *     commit pin (HEAD = origin/develop = the approved commit, clean), the preflight (sandbox, .env) and the ledger
 *     (approval unused, a free slot, time left: 15 min a call, 2 h a plan);
 *   - then the packet's bytes are read AS COMMITTED at the approved commit (deps.packetAt; never the working tree) and
 *     must be the approved ones (PACKET_PIN_MISMATCH) and approve this run (below).
 *
 * Then: the approval is reserved, the private run directory is created (0700), the inputs and every prompt are written
 * into it, and the batch is called ONCE (the injected `batch`: the CLI passes the one-run batch call of image-once.ts, in the sandbox).
 * The first failure ends the run: no retry, here or by the caller (a new approval and a new packet are needed).
 * Only a batch with no stop code, the IMAGE_SAVED outcome and exactly the planned number of pictures is a success; it
 * writes parts/<name>.png (in the planned order) and run-plan.json, the shape `image-first-check --assemble` reads.
 * A stopped batch writes call.json with its stop code and keeps any picture it returned under stopped/ (never as a part);
 * so does a batch that returned after the stop signal (recorded as aborted, CODEX_ABORTED).
 *
 * No process and no network here.
 */
import { randomBytes } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { CodexAbortedError, CodexError } from "../codex";
import { REQUIRED_GENERATION, REQUIRED_RIGHTS, REQUIRED_STORAGE, OUTPUT_KIND, RECORD_SCHEMA, ROUTE, VIEWPORTS } from "../image-first/record";
import type { PromptInputs, PromptPlan } from "../image-first/prompt";
import { isRequestId, type PhotoInputs, type PhotoPlan, type PlanReference } from "../image-first/request-prompt";
import { D4_PACKET, P3_PACKET, packetOfDirection, type ApprovalPacketSpec } from "./approval-packets";
import { LedgerStop, type Ledger, type Receipt } from "./ledger";
import { checkBeforeApproval, sha256, writeOnce, type CommitState } from "./steps";

/**
 * The image tool's reference limit per call. This module may not import outside its allowed list (phase2f-live
 * isolation test), so the value is restated; whole-page.test.ts asserts it equals image-tool-limits.ts IMAGE_TOOL_MAX_REFS.
 */
export const FULL_PAGE_MAX_REFERENCES = 5;

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
  /** Issue #335 (additive): the run's fixed session facts (image-once.ts ImageRunDiagnostics); absent before Codex ran. */
  diagnostics?: FullPageBatchDiagnostics;
};
/** Issue #335: image-once.ts ImageRunDiagnostics, by shape (this module never imports the image call). */
export type FullPageBatchDiagnostics = {
  exec_cells: number;
  cell_named_image_tool: boolean;
  arg_error: boolean;
  arg_error_kind: string | null;
  other_tool_calls: number;
  tool_mode: string;
  model: string | null;
  cli_version: string | null;
  image_failure_reasons: readonly string[];
  answer: string;
};
const SLUG = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,59}$/;
/**
 * Issue #335 follow-up: the fixed value lists of the diagnostics' code fields, kept here because this module never
 * imports the image PoC's code (tests/unit/design-agent/phase2f-live/isolation.test.ts). They are the image PoC's own
 * lists (TOOL_MODES, ANSWER_TEXT_CODES, CODE_MODE_ARG_ERROR_KINDS, IMAGE_FAILURE_REASONS); the full-page-call test keeps
 * them in step with those.
 */
export const DIAGNOSTIC_TOOL_MODES = ["direct", "code_mode", "code_mode_only", "unknown"] as const;
export const DIAGNOSTIC_ANSWERS = ["TEXT_NONE", "TEXT_TOOL_UNAVAILABLE", "TEXT_TOOL_ERROR", "TEXT_USAGE_LIMIT", "TEXT_REFUSAL", "TEXT_OTHER"] as const;
export const DIAGNOSTIC_ARG_ERROR_KINDS = ["REF_PATHS_TOO_MANY", "REF_PATH_NOT_ABSOLUTE", "REF_UNAVAILABLE", "REF_UNREADABLE", "NUM_LAST_RANGE", "CONV_IMAGES_SHORT", "BOTH_GIVEN", "ARGS_PARSE"] as const;
export const DIAGNOSTIC_FAILURE_REASONS = ["USAGE_LIMIT", "HTTP_429", "HTTP_5XX", "TIMEOUT", "NETWORK", "AUTH", "NOT_SUPPORTED", "POLICY", "BAD_REQUEST", "INVALID_ARGS", "NO_IMAGE_DATA", "BAD_RESPONSE", "OTHER", "NO_TEXT"] as const;
/**
 * Issue #335: the diagnostics written into call.json on every stop, re-checked field by field so that only counts,
 * booleans, values of the fixed lists above and validated slugs can reach the record (anything else is null, or left
 * out of the reasons list; never a text).
 */
function diagnosticsOf(d: FullPageBatchDiagnostics | undefined): Record<string, unknown> | null {
  if (!d || typeof d !== "object") return null;
  const count = (n: unknown) => (Number.isInteger(n) && (n as number) >= 0 ? n : null);
  const bool = (b: unknown) => (typeof b === "boolean" ? b : null);
  const oneOf = (list: readonly string[]) => (c: unknown) => (typeof c === "string" && list.includes(c) ? c : null);
  const slug = (c: unknown) => (typeof c === "string" && SLUG.test(c) ? c : null);
  const reason = oneOf(DIAGNOSTIC_FAILURE_REASONS);
  return {
    exec_cells: count(d.exec_cells),
    cell_named_image_tool: bool(d.cell_named_image_tool),
    arg_error: bool(d.arg_error),
    arg_error_kind: oneOf(DIAGNOSTIC_ARG_ERROR_KINDS)(d.arg_error_kind),
    other_tool_calls: count(d.other_tool_calls),
    tool_mode: oneOf(DIAGNOSTIC_TOOL_MODES)(d.tool_mode),
    model: slug(d.model),
    cli_version: slug(d.cli_version),
    image_failure_reasons: Array.isArray(d.image_failure_reasons) ? d.image_failure_reasons.filter((r) => reason(r) !== null).slice(0, 20) : [],
    answer: oneOf(DIAGNOSTIC_ANSWERS)(d.answer),
  };
}
/**
 * inputImages (DEV-303, owner decision 2026-11-24): a design request's photo inputs, handed to the ONE Codex run as
 * `--image` attachments (staged in the run's temporary work dir by image-once.ts, never in the private run directory).
 */
/**
 * referenceImages (DEV-303 §6.1 row 3): a whole_page design's success-case reference pictures (ref-N.<ext>), staged and
 * attached the same way; the prompt names them by the reference token, which image-once.ts replaces with the absolute
 * staged directory (image-once.ts ReferenceImage, by shape).
 */
export type FullPageBatch = (o: { prompt: string; timeoutMs: number; maxImages: number; inputImages?: readonly Buffer[]; referenceImages?: readonly { name: string; bytes: Buffer }[]; signal?: AbortSignal }) => Promise<FullPageBatchResult>;

export type FullPageCallInput = {
  plan: PromptPlan;
  /** The packet path as given (absolute, or relative to the working directory): its real path must be this direction's packet in the repository (approval-packets.ts). */
  packetPath: string;
  inputs: Pick<PromptInputs, "factsBytes" | "directionBytes">;
  humanApprovalConfirmed: boolean;
  approvalId: string;
  planId: string;
  /** YYYY-MM-DDTHH:MM:SSZ (UTC), the last instant the approval may be used; must equal the packet's §10 期限. */
  approvalExpires: string;
  expected: { promptSha256: string; promptChars: number; commit: string; planSha256: string; packetSha256: string };
  outDir: string;
  /** The repository (its real path): the run directory must be outside it. */
  repoRoot: string;
  signal?: AbortSignal;
};
export type FullPageCallDeps = {
  ledger: Ledger;
  batch: FullPageBatch;
  commit: () => Promise<CommitState>;
  /**
   * The packet's bytes as committed at the approved commit (the CLI: `git show <commit>:<path>`; null: unreadable).
   * Asked only after the commit pin and the clean-tree check held, and only for this direction's packet path.
   */
  packetAt: (commit: string, repoRelativePath: string) => Promise<Buffer | null>;
  preflight?: () => Promise<string | null>;
  now?: () => number;
};

export type FullPageCallResult =
  | { status: "succeeded"; outDir: string; receipt: Receipt; runId: string; images: number; warnings: string[] }
  | { status: "stopped"; code: string; stage: "precheck" | "call"; aborted: boolean; outcome?: string };

export const FULL_PAGE_KIND = "full_page_comp" as const;
export const FULL_PAGE_ROUTE = "image_first" as const;
/** <shop words>-imagefirst-<d1|d3|d4>-<YYYYMMDD>-<NN>: the direction is in the id, so an approval cannot run the other one. */
const APPROVAL_FORMAT = /^[a-z0-9][a-z0-9-]{2,40}-imagefirst-(d[0-9])-(\d{8})-(\d{2})$/;
/** An approval is used within a day of being given: an expiry further ahead than this is refused. */
export const MAX_APPROVAL_WINDOW_MS = 24 * 60 * 60 * 1000;

/** A real UTC instant written exactly YYYY-MM-DDTHH:MM:SSZ (no offset, no fraction; 2026-02-31 or 24:00 refuse), or null. */
export function parseUtcInstant(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(text);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const ms = Date.UTC(y, mo - 1, d, h, mi, se);
  const t = new Date(ms);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d || t.getUTCHours() !== h || t.getUTCMinutes() !== mi || t.getUTCSeconds() !== se) return null;
  return ms;
}

/** The §10 rows of the P3 approval packet (the label is the text before any （…） note). */
export const PACKET_FIELDS = { status: "状態", directions: "承認する方向性", d1: "d1 の承認 ID", d3: "d3 の承認 ID", expires: "期限", planId: "計画 ID", approvedBy: "承認日・承認者" } as const;
/** The §10 rows of a packet: the same rows as PACKET_FIELDS, with one approval ID row per direction of that packet. */
export function packetFieldsOf(spec: ApprovalPacketSpec): Readonly<Record<string, string>> {
  return { status: PACKET_FIELDS.status, directions: PACKET_FIELDS.directions, ...Object.fromEntries(spec.keys.map((k) => [k, `${k} の承認 ID`])), expires: PACKET_FIELDS.expires, planId: PACKET_FIELDS.planId, approvedBy: PACKET_FIELDS.approvedBy };
}
export const PACKET_APPROVED = "承認済み";
export const PACKET_PLACEHOLDER = "未記入";
export const PACKET_NONE = "なし";
/** approvalIds: one entry per direction of the packet read (the P3 packet: d1 and d3; the d4 packet: d4). */
export type ApprovalPacket = { status: string; directions: string[]; approvalIds: Record<string, string>; expires: string; planId: string; approvedBy: string };

export { D4_PACKET, P3_PACKET, packetOfDirection, type ApprovalPacketSpec };
/** The P3 packet (d1 / d3), repository-relative. Each direction's one packet: approval-packets.ts PACKET_OF_DIRECTION. */
export const APPROVAL_PACKET_PATH = P3_PACKET.path;

/**
 * Reads an approval packet (default: the P3 packet's rows). null (PACKET_NOT_APPROVED) when:
 *   - the header (the text before the first `## ` heading) still says 未承認, or does not say exactly once 状態: 承認済み;
 *   - there is not exactly one `## 10.` heading outside code fences (a fenced example never counts);
 *   - a §10 row is missing, repeated or extra, a value is empty or still 未記入, the §10 status is not 承認済み, or the
 *     direction list is not one of the packet's own (P3: d1 / d3 / d1,d3; d4: d4) with an id for each approved
 *     direction and なし for the other.
 */
export function readApprovalPacket(bytes: Buffer, spec: ApprovalPacketSpec = P3_PACKET): ApprovalPacket | null {
  const fields = packetFieldsOf(spec);
  // every line outside a code fence, with its index (a fence line itself is dropped)
  const lines: string[] = [];
  let fence: string | null = null;
  for (const line of bytes.toString("utf8").split(/\r?\n/)) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === null) fence = f[1]![0]!;
      else if (f[1]![0] === fence) fence = null;
      continue;
    }
    if (fence === null) lines.push(line);
  }
  if (fence !== null) return null;
  const firstH2 = lines.findIndex((l) => /^## /.test(l));
  const header = (firstH2 < 0 ? lines : lines.slice(0, firstH2)).join("\n");
  const headerStatus = [...header.matchAll(/状態[:：]\s*([^。*\s]+)/g)].map((m) => m[1]);
  if (header.includes("未承認") || headerStatus.length !== 1 || headerStatus[0] !== PACKET_APPROVED) return null;
  const starts = lines.flatMap((l, n) => (/^## 10\.\s/.test(l) ? [n] : []));
  if (starts.length !== 1) return null;
  const rest = lines.slice(starts[0]! + 1);
  const stop = rest.findIndex((l) => /^#{1,2} /.test(l));
  const rows = new Map<string, string>();
  for (const line of stop < 0 ? rest : rest.slice(0, stop)) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length !== 2 || /^-+$/.test(cells[0]!) || cells[0] === "項目") continue;
    const label = cells[0]!.split("（")[0]!.trim();
    if (rows.has(label)) return null;
    rows.set(label, cells[1]!);
  }
  const value = (label: string): string | null => {
    const v = rows.get(label);
    if (v === undefined || v.includes(PACKET_PLACEHOLDER)) return null;
    const bare = v.replace(/^`([^`]*)`$/, "$1").trim();
    return bare === "" ? null : bare;
  };
  const got = Object.fromEntries(Object.entries(fields).map(([k, label]) => [k, value(label)])) as Record<string, string | null>;
  if (Object.values(got).some((v) => v === null) || rows.size !== Object.keys(fields).length) return null;
  if (got.status !== PACKET_APPROVED) return null;
  const directions = got.directions!.split(",").map((d) => d.trim());
  if (!spec.directionSets.includes(directions.join(","))) return null;
  for (const k of spec.keys) if ((got[k] === PACKET_NONE) === directions.includes(k)) return null;
  return { status: got.status, directions, approvalIds: Object.fromEntries(spec.keys.map((k) => [k, got[k]!])), expires: got.expires!, planId: got.planId!, approvedBy: got.approvedBy! };
}

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
  const expires = parseUtcInstant(i.approvalExpires);
  if (expires === null) return refuse("APPROVAL_EXPIRY_INVALID");
  if (now() > expires) return refuse("APPROVAL_EXPIRED");
  if (expires - now() > MAX_APPROVAL_WINDOW_MS) return refuse("APPROVAL_EXPIRY_TOO_FAR");
  if (plan.plan_sha256 !== i.expected.planSha256) return refuse("PLAN_PIN_MISMATCH");
  if (plan.batch.sha256 !== sha256(Buffer.from(plan.batch.prompt, "utf8")) || plan.batch.chars !== plan.batch.prompt.length) return refuse("PLAN_PIN_MISMATCH");
  // exactly one packet path, this direction's own (approval-packets.ts): a tracked test fixture, another direction's
  // packet or any other file is never an approval
  const spec = packetOfDirection(plan.direction_key);
  const packetReal = await realpath(i.packetPath).catch(() => null);
  if (spec === null || packetReal === null || relative(repo, packetReal) !== spec.path) return refuse("PACKET_PATH_NOT_ALLOWED");
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

  // ---- before the approval is used: the packet, as committed at the approved commit (pinned and clean just above) ----
  const packetBytes = await d.packetAt(i.expected.commit, spec.path).catch(() => null);
  if (!packetBytes || !/^[a-f0-9]{64}$/.test(i.expected.packetSha256) || sha256(packetBytes) !== i.expected.packetSha256) return refuse("PACKET_PIN_MISMATCH");
  // the packet's own header and §10 (read with this direction's packet rows): the owner's approval, for exactly this run
  // (never only a SHA typed on the same command line)
  const packet = readApprovalPacket(packetBytes, spec);
  if (!packet) return refuse("PACKET_NOT_APPROVED");
  const key = plan.direction_key;
  if (!spec.keys.includes(key) || !packet.directions.includes(key) || packet.approvalIds[key] !== i.approvalId || packet.expires !== i.approvalExpires || packet.planId !== i.planId) return refuse("PACKET_APPROVAL_MISMATCH");

  return executeFullPageRun({ plan, inputs: i.inputs, approvalId: i.approvalId, planId: i.planId, expected: i.expected, outDir: i.outDir, ...(i.signal === undefined ? {} : { signal: i.signal }) }, d, checked.timeoutMs);
}

export type RequestCallInput = {
  plan: RunnablePlan;
  inputs: Pick<PromptInputs, "factsBytes" | "directionBytes">;
  /** The request id (= approval id and plan id in the ledger: one request, one use, ever). */
  requestId: string;
  /** SHA-256 of the request bytes root validated (recorded where a pinned run records its packet's). */
  requestSha256: string;
  expected: { promptSha256: string; promptChars: number; commit: string; planSha256: string };
  outDir: string;
  repoRoot: string;
  /** DEV-303 (owner decision 2026-11-24): the resolved photo inputs, exactly the plan's photo_inputs (names, SHA-256). */
  photos?: readonly { name: string; sha256: string; bytes: Buffer }[];
  /** DEV-303 §6.1 row 3: a whole_page plan's reference pictures, exactly its references (ids, names, SHA-256), with bytes. */
  references?: readonly (PlanReference & { bytes: Buffer })[];
  signal?: AbortSignal;
};

/** The photo inputs handed to the run are exactly the plan's (same names, same order, bytes with those SHA-256s). */
function photosMatch(planned: PhotoInputs | undefined, photos: RequestCallInput["photos"]): boolean {
  if (!planned) return photos === undefined || photos.length === 0;
  if (!photos || photos.length !== planned.files.length || photos.length > 6) return false;
  return planned.files.every((f, n) => photos[n]!.name === f.name && photos[n]!.sha256 === f.sha256 && sha256(photos[n]!.bytes) === f.sha256);
}

/** The reference pictures handed to the run are exactly the plan's (same ids, names, order, bytes with those SHA-256s). */
function referencesMatch(planned: readonly PlanReference[] | undefined, refs: RequestCallInput["references"]): boolean {
  if (!planned) return refs === undefined || refs.length === 0;
  if (!refs || refs.length !== planned.length || refs.length === 0 || refs.length > FULL_PAGE_MAX_REFERENCES) return false;
  return planned.every((p, n) => refs[n]!.id === p.id && refs[n]!.name === p.name && refs[n]!.case_id === p.case_id && refs[n]!.sha256 === p.sha256 && sha256(refs[n]!.bytes) === p.sha256);
}
/** The pictures one run of this plan makes: PC 2 + SP 4, or (DEV-303 §6.1 row 3) a whole_page plan's PC 1 + SP 1. */
const planImages = (plan: RunnablePlan) => (plan.layout === "whole_page" ? 2 : 6);

/**
 * DEV-303 (owner direction 2026-11-23, first-client-pipeline.md §2 A/B): ONE IMAGE_FIRST batch for a request root
 * accepted under the owner's standing permission (root enforces the quota, one attempt per id, the timeout, no retry).
 * There is no per-run packet: the request (bound by its SHA-256) is the approval, and its id is the ledger's approval id
 * and plan id, so it is used at most once, ever. Before it is used: the run directory outside the repository, the id's
 * form (never an approval id's), the plan the caller rebuilt from the request and the facts = the pinned plan, and the
 * shared checks (steps.ts checkBeforeApproval: prompt pin, output place, commit pin, sandbox preflight, ledger). Then
 * exactly the same run as a pinned direction's (executeFullPageRun).
 */
export async function runRequestFullPageCall(i: RequestCallInput, d: Omit<FullPageCallDeps, "packetAt">): Promise<FullPageCallResult> {
  const refuse = (code: string): FullPageCallResult => ({ status: "stopped", code, stage: "precheck", aborted: false });
  const plan = i.plan;
  if (!isAbsolute(i.outDir)) return refuse("OUT_DIR_INVALID");
  const repo = await realpath(i.repoRoot).catch(() => null);
  const parent = await realpath(dirname(i.outDir)).catch(() => null);
  if (!repo) return refuse("REPO_UNRESOLVABLE");
  if (within(i.outDir, i.repoRoot) || within(i.outDir, repo) || (parent !== null && within(parent, repo))) return refuse("RUN_DIR_IN_REPO");
  if (!isRequestId(i.requestId)) return refuse("REQUEST_ID_INVALID");
  // DEV-303 §6.1 row 3: a real shop's design runs only as a whole page (parseRequest refuses the section split too)
  if (plan.kind === "real_shop" && plan.layout !== "whole_page") return refuse("REAL_SHOP_WHOLE_PAGE_REQUIRED");
  if (!/^[a-f0-9]{64}$/.test(i.requestSha256) || plan.direction_key !== "request" || plan.direction_set_sha256 !== i.requestSha256) return refuse("PLAN_PIN_MISMATCH");
  if (plan.plan_sha256 !== i.expected.planSha256) return refuse("PLAN_PIN_MISMATCH");
  if (plan.batch.sha256 !== sha256(Buffer.from(plan.batch.prompt, "utf8")) || plan.batch.chars !== plan.batch.prompt.length) return refuse("PLAN_PIN_MISMATCH");
  if (sha256(i.inputs.factsBytes) !== plan.facts_sha256 || sha256(i.inputs.directionBytes) !== plan.direction_sha256) return refuse("PLAN_PIN_MISMATCH");
  const parts = VIEWPORTS.flatMap((v) => plan.viewports[v].parts.map((p) => ({ v, p })));
  if (parts.length !== plan.batch.images || parts.length !== planImages(plan)) return refuse("PLAN_PIN_MISMATCH");
  if (plan.layout === "whole_page" && (plan.photo_inputs !== undefined || VIEWPORTS.some((v) => plan.viewports[v].mode !== "whole_page" || plan.viewports[v].parts.length !== 1))) return refuse("PLAN_PIN_MISMATCH");
  if (!photosMatch(plan.photo_inputs, i.photos)) return refuse("PHOTO_INPUTS_MISMATCH");
  if (!referencesMatch(plan.references, i.references)) return refuse("REFERENCE_IMAGES_MISMATCH");
  // the owner's standing permission (root's quota and one-use marker) stands in for the per-run flag
  const checked = await checkBeforeApproval(
    { humanApprovalConfirmed: true, prompt: plan.batch.prompt, expected: { promptSha256: i.expected.promptSha256, promptChars: i.expected.promptChars, commit: i.expected.commit }, outDir: i.outDir, approvalId: i.requestId, planId: i.requestId, route: FULL_PAGE_ROUTE, retryOf: null, ...(i.signal === undefined ? {} : { signal: i.signal }) },
    FULL_PAGE_KIND,
    d,
  );
  if (!checked.ok) return { status: "stopped", code: checked.code, stage: "precheck", aborted: checked.aborted };
  const photoInputs = plan.photo_inputs && i.photos ? { meta: plan.photo_inputs, bytes: i.photos.map((p) => p.bytes) } : undefined;
  const references = plan.references && i.references ? i.references.map((r) => ({ id: r.id, case_id: r.case_id, name: r.name, sha256: r.sha256, bytes: r.bytes })) : undefined;
  return executeFullPageRun({ plan, inputs: i.inputs, approvalId: i.requestId, planId: i.requestId, expected: { promptSha256: i.expected.promptSha256, promptChars: i.expected.promptChars, commit: i.expected.commit, packetSha256: i.requestSha256 }, outDir: i.outDir, ...(photoInputs ? { photoInputs } : {}), ...(references ? { references } : {}), ...(i.signal === undefined ? {} : { signal: i.signal }) }, d, checked.timeoutMs);
}

/** What the run after the checks needs of a plan (a pinned direction's PromptPlan, or DEV-303 a request's plan). */
export type RunnablePlan = Pick<PromptPlan, "viewports" | "batch" | "plan_sha256" | "shop" | "direction_id" | "direction_set_sha256" | "facts_sha256" | "direction_sha256"> & { direction_key: string; photo_inputs?: PhotoInputs; kind?: "real_shop" | "fictional"; layout?: "whole_page"; references?: PlanReference[]; ja_renderings_sha256?: string };
type ExecuteInput = {
  plan: RunnablePlan;
  inputs: Pick<PromptInputs, "factsBytes" | "directionBytes">;
  approvalId: string;
  planId: string;
  /** packetSha256: the approval packet's (a pinned direction) or the request bytes' (DEV-303). */
  expected: { promptSha256: string; promptChars: number; commit: string; packetSha256: string };
  outDir: string;
  /** DEV-303: the photo inputs attached to the one batch (metadata recorded as photo-inputs.json; the pictures are never written here). */
  photoInputs?: { meta: PhotoInputs; bytes: Buffer[] };
  /** DEV-303 §6.1 row 3: a whole_page run's reference pictures (recorded as reference-inputs.json: ids, cases, SHA-256; never a path or the bytes). */
  references?: { id: string; case_id: string; name: string; sha256: string; bytes: Buffer }[];
  signal?: AbortSignal;
};

/**
 * The approval is used from here on: reserve it in the ledger, write the private run directory, call the batch ONCE and
 * record how it ended. Only after every check before the approval held (the caller's).
 */
async function executeFullPageRun(i: ExecuteInput, d: Pick<FullPageCallDeps, "ledger" | "batch" | "now">, timeoutMs: number): Promise<FullPageCallResult> {
  const now = d.now ?? Date.now;
  const plan = i.plan;
  const parts = VIEWPORTS.flatMap((v) => plan.viewports[v].parts.map((p) => ({ v, p })));
  const checked = { timeoutMs };
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
    // names and SHA-256 only: an attached photo is never copied into this run (root counts parts/ and the inbox copy)
    if (i.photoInputs) await writeOnce(out("photo-inputs.json"), { schema: "image_first_photo_inputs_v0", ...i.photoInputs.meta });
    // DEV-303 §6.1 row 3: the reference pictures by id, case and SHA-256 only (never copied here, never a path)
    if (i.references) await writeOnce(out("reference-inputs.json"), { schema: "image_first_reference_inputs_v0", layout: "whole_page", references: i.references.map((r) => ({ id: r.id, case_id: r.case_id, sha256: r.sha256 })) });
    // DEV-303 §6.1 change 4 (review L4): the owner-approved Japanese renderings the prompt used, by their SHA-256 only
    if (plan.ja_renderings_sha256) await writeOnce(out("ja-renderings-input.json"), { schema: "image_first_ja_renderings_input_v0", ja_renderings_sha256: plan.ja_renderings_sha256 });
  } catch {
    await end("failed", "OUT_DIR_UNWRITABLE").catch(() => undefined);
    return { status: "stopped", code: "OUT_DIR_UNWRITABLE", stage: "call", aborted: false };
  }

  // a returned picture of a run that did not complete is kept under stopped/ (never as a part), with its facts
  const keepStopped = async (images: FullPageBatchResult["images"]) => {
    const stopped: { file: string; sha256: string; width: number; height: number }[] = [];
    if (images.length > 0) await mkdir(out("stopped"), { mode: 0o700 }).catch(() => undefined);
    for (const [n, img] of images.slice(0, 6).entries()) {
      const file = `stopped/image-${n + 1}.png`;
      if (await writeOnce(out(file), img.png).then(() => true, () => false)) stopped.push({ file, sha256: sha256(img.png), width: img.width, height: img.height });
    }
    return stopped;
  };
  const facts = (r: FullPageBatchResult) => ({ outcome: r.outcome, stop_code: r.stopCode, image_calls: r.imageCalls, image_failed: r.imageFailed, images: r.images.length, thread_id: r.threadId, diagnostics: diagnosticsOf(r.diagnostics) });

  let res: FullPageBatchResult;
  try {
    res = await d.batch({ prompt: plan.batch.prompt, timeoutMs: checked.timeoutMs, maxImages: parts.length, ...(i.photoInputs ? { inputImages: i.photoInputs.bytes } : {}), ...(i.references ? { referenceImages: i.references.map((r) => ({ name: r.name, bytes: r.bytes })) } : {}), ...(i.signal === undefined ? {} : { signal: i.signal }) });
  } catch (error) {
    const aborted = error instanceof CodexAbortedError;
    const code = aborted ? "CODEX_ABORTED" : error instanceof CodexError ? error.code : "CODEX_UNEXPECTED";
    await record(aborted ? "aborted" : "failed", code);
    await end(aborted ? "aborted" : "failed", code).catch(() => undefined);
    return { status: "stopped", code, stage: "call", aborted };
  }
  if (i.signal?.aborted) {
    // the batch returned, but the run was stopped meanwhile: aborted (never a success); what it returned is kept
    const stopped = await keepStopped(res.images);
    await record("aborted", "CODEX_ABORTED", { ...facts(res), stopped });
    await end("aborted", "CODEX_ABORTED").catch(() => undefined);
    return { status: "stopped", code: "CODEX_ABORTED", stage: "call", aborted: true };
  }
  const finished = now();

  // hard stop: anything but a complete batch ends here (no retry; the approval stays used)
  const complete = res.stopCode === null && res.outcome === "IMAGE_SAVED" && res.images.length === parts.length && res.imageFailed === 0 && res.imageCalls === parts.length;
  if (!complete) {
    const code = res.stopCode ?? (res.outcome === "IMAGE_SAVED" ? "CODEX_IMAGE_COUNT_MISMATCH" : "IMAGE_TOOL_RESULT_INVALID");
    const stopped = await keepStopped(res.images);
    await record("failed", code, { ...facts(res), stopped });
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

export type PhotoCallInput = Omit<RequestCallInput, "plan" | "photos"> & { plan: PhotoPlan };

/**
 * DEV-303 (owner decision 2026-11-24): ONE photo-materials batch for a request root (stage photo_materials): the same
 * checks before use as runRequestFullPageCall (run directory outside the repository, the request id's form, the plan
 * pins, steps.ts checkBeforeApproval: prompt pin, output place, commit pin, sandbox preflight, ledger with the request id
 * as approval and plan id: one use, ever), then ONE Codex run of 1..6 pictures, never retried. Success writes
 * parts/photo-N.png, photo-plan.json and call.json (the shape the worker's settleRun reads); a stopped batch keeps what
 * it returned under stopped/ only. The ledger kind and route are the full-page ones (one request = one use there).
 */
export async function runRequestPhotoCall(i: PhotoCallInput, d: Omit<FullPageCallDeps, "packetAt">): Promise<FullPageCallResult> {
  const refuse = (code: string): FullPageCallResult => ({ status: "stopped", code, stage: "precheck", aborted: false });
  const plan = i.plan;
  if (!isAbsolute(i.outDir)) return refuse("OUT_DIR_INVALID");
  const repo = await realpath(i.repoRoot).catch(() => null);
  const parent = await realpath(dirname(i.outDir)).catch(() => null);
  if (!repo) return refuse("REPO_UNRESOLVABLE");
  if (within(i.outDir, i.repoRoot) || within(i.outDir, repo) || (parent !== null && within(parent, repo))) return refuse("RUN_DIR_IN_REPO");
  if (!isRequestId(i.requestId) || plan.request_id !== i.requestId) return refuse("REQUEST_ID_INVALID");
  if (!/^[a-f0-9]{64}$/.test(i.requestSha256) || plan.stage !== "photo_materials" || plan.direction_set_sha256 !== i.requestSha256) return refuse("PLAN_PIN_MISMATCH");
  if (plan.plan_sha256 !== i.expected.planSha256) return refuse("PLAN_PIN_MISMATCH");
  if (plan.batch.sha256 !== sha256(Buffer.from(plan.batch.prompt, "utf8")) || plan.batch.chars !== plan.batch.prompt.length) return refuse("PLAN_PIN_MISMATCH");
  if (sha256(i.inputs.factsBytes) !== plan.facts_sha256 || sha256(i.inputs.directionBytes) !== plan.direction_sha256) return refuse("PLAN_PIN_MISMATCH");
  if (plan.photos.length !== plan.batch.images || plan.photos.length < 1 || plan.photos.length > 6) return refuse("PLAN_PIN_MISMATCH");
  const checked = await checkBeforeApproval(
    { humanApprovalConfirmed: true, prompt: plan.batch.prompt, expected: { promptSha256: i.expected.promptSha256, promptChars: i.expected.promptChars, commit: i.expected.commit }, outDir: i.outDir, approvalId: i.requestId, planId: i.requestId, route: FULL_PAGE_ROUTE, retryOf: null, ...(i.signal === undefined ? {} : { signal: i.signal }) },
    FULL_PAGE_KIND,
    d,
  );
  if (!checked.ok) return { status: "stopped", code: checked.code, stage: "precheck", aborted: checked.aborted };

  // ---- the request is used from here on ----
  const now = d.now ?? Date.now;
  const runId = `if-${randomBytes(8).toString("hex")}`;
  let receipt: Receipt;
  try {
    receipt = await d.ledger.reserve({ approval_id: i.requestId, plan_id: i.requestId, route: FULL_PAGE_ROUTE, kind: FULL_PAGE_KIND, retry_of: null, prompt_sha256: i.expected.promptSha256, prompt_chars: i.expected.promptChars, commit: i.expected.commit, run_id: runId });
  } catch (error) {
    return { status: "stopped", code: error instanceof LedgerStop ? error.code : "LEDGER_UNWRITABLE", stage: "call", aborted: false };
  }
  const started = now();
  const end = async (status: "succeeded" | "failed" | "aborted", code: string | null) => d.ledger.finish(i.requestId, { status, code, finished_at: new Date(now()).toISOString(), elapsed_ms: now() - started });
  const out = (rel: string) => join(i.outDir, rel);
  const record = (status: "failed" | "aborted", code: string, extra: Record<string, unknown> = {}) => writeOnce(out("call.json"), { schema: "image_first_call_v0", status, code, receipt, plan_sha256: plan.plan_sha256, ...extra }).catch(() => undefined);
  try {
    await mkdir(i.outDir, { mode: 0o700 });
    for (const sub of ["parts", "prompts"]) await mkdir(out(sub), { mode: 0o700 });
    await writeOnce(out("facts-pack.json"), i.inputs.factsBytes);
    await writeOnce(out("photo-brief.json"), i.inputs.directionBytes);
    for (const p of plan.photos) await writeOnce(out(p.prompt_file), Buffer.from(p.prompt, "utf8"));
    await writeOnce(out("prompts/batch.txt"), Buffer.from(plan.batch.prompt, "utf8"));
  } catch {
    await end("failed", "OUT_DIR_UNWRITABLE").catch(() => undefined);
    return { status: "stopped", code: "OUT_DIR_UNWRITABLE", stage: "call", aborted: false };
  }
  const keepStopped = async (images: FullPageBatchResult["images"]) => {
    const stopped: { file: string; sha256: string; width: number; height: number }[] = [];
    if (images.length > 0) await mkdir(out("stopped"), { mode: 0o700 }).catch(() => undefined);
    for (const [n, img] of images.slice(0, 6).entries()) {
      const file = `stopped/image-${n + 1}.png`;
      if (await writeOnce(out(file), img.png).then(() => true, () => false)) stopped.push({ file, sha256: sha256(img.png), width: img.width, height: img.height });
    }
    return stopped;
  };
  const facts = (r: FullPageBatchResult) => ({ outcome: r.outcome, stop_code: r.stopCode, image_calls: r.imageCalls, image_failed: r.imageFailed, images: r.images.length, thread_id: r.threadId, diagnostics: diagnosticsOf(r.diagnostics) });
  const total = plan.photos.length;
  let res: FullPageBatchResult;
  try {
    res = await d.batch({ prompt: plan.batch.prompt, timeoutMs: checked.timeoutMs, maxImages: total, ...(i.signal === undefined ? {} : { signal: i.signal }) });
  } catch (error) {
    const aborted = error instanceof CodexAbortedError;
    const code = aborted ? "CODEX_ABORTED" : error instanceof CodexError ? error.code : "CODEX_UNEXPECTED";
    await record(aborted ? "aborted" : "failed", code);
    await end(aborted ? "aborted" : "failed", code).catch(() => undefined);
    return { status: "stopped", code, stage: "call", aborted };
  }
  if (i.signal?.aborted) {
    const stopped = await keepStopped(res.images);
    await record("aborted", "CODEX_ABORTED", { ...facts(res), stopped });
    await end("aborted", "CODEX_ABORTED").catch(() => undefined);
    return { status: "stopped", code: "CODEX_ABORTED", stage: "call", aborted: true };
  }
  const finished = now();
  const complete = res.stopCode === null && res.outcome === "IMAGE_SAVED" && res.images.length === total && res.imageFailed === 0 && res.imageCalls === total;
  if (!complete) {
    const code = res.stopCode ?? (res.outcome === "IMAGE_SAVED" ? "CODEX_IMAGE_COUNT_MISMATCH" : "IMAGE_TOOL_RESULT_INVALID");
    const stopped = await keepStopped(res.images);
    await record("failed", code, { ...facts(res), stopped });
    await end("failed", code).catch(() => undefined);
    return { status: "stopped", code, stage: "call", aborted: false, outcome: res.outcome };
  }
  const warnings = [...(res.model === null ? ["session_model_unknown"] : []), ...(res.cliVersion === null ? ["cli_version_unknown"] : [])];
  try {
    for (const [n, p] of plan.photos.entries()) await writeOnce(out(p.file), res.images[n]!.png);
    await writeOnce(out("photo-plan.json"), {
      schema: "image_first_photo_run_v0",
      stage: "photo_materials",
      use: "proposal_demo_image_material_not_a_shop_record",
      run_id: runId,
      request_id: i.requestId,
      shop_id: plan.shop.shop_id,
      photos: plan.photos.map((p, n) => ({ index: p.index, file: p.file, aspect: p.aspect, prompt_file: p.prompt_file, width: res.images[n]!.width, height: res.images[n]!.height })),
      generation: { cli_version: res.cliVersion, session_model: res.model, repo_commit: i.expected.commit, request_sha256: i.requestSha256, started_at: new Date(started).toISOString(), finished_at: new Date(finished).toISOString(), image_calls: res.imageCalls, outcome: res.outcome },
    });
    await writeOnce(out("call.json"), { schema: "image_first_call_v0", status: "succeeded", code: null, receipt, plan_sha256: plan.plan_sha256, outcome: res.outcome, thread_id: res.threadId, images: plan.photos.map((p, n) => ({ file: p.file, sha256: sha256(res.images[n]!.png), width: res.images[n]!.width, height: res.images[n]!.height })), warnings });
  } catch {
    await end("failed", "OUT_WRITE_FAILED").catch(() => undefined);
    return { status: "stopped", code: "OUT_WRITE_FAILED", stage: "call", aborted: false };
  }
  await end("succeeded", null);
  return { status: "succeeded", outDir: i.outDir, receipt, runId, images: total, warnings };
}
