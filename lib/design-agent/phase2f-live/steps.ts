/**
 * Phase 2f-2: what the real-call steps share (DEV-116 design step, DEV-117 image step and the offline steps that
 * read their outputs).
 *
 * - checkBeforeApproval: everything that can stop a call is checked before its approval is used.
 * - readStep: a later step reads an earlier step's output only through here. The output folder (call.json,
 *   generation.json) and the ledger (receipt, result) must tell the same story: same approval, run, prompt and
 *   commit, and the same ending. An answer or a picture is used only when BOTH say "succeeded".
 *
 * No process, no network.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { LedgerStop, type CallKind, type CallResult, type Ledger, type Receipt, type Route } from "./ledger";

export type CommitState = { head: string | null; base: string | null; clean: boolean };

/** The generation facts a step records (the Design Artifact's `generation`, minus the image outcome). */
export type Generation = {
  status: "succeeded";
  tool: "codex_cli";
  tool_version: string | null;
  model_reported: string | null;
  approval_id: string;
  prompt_sha256: string;
  worker_commit: string;
  run_id: string;
  started_at: string;
  finished_at: string;
};

export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const COMMIT = /^[0-9a-f]{40}$/;

/** Creates a file once (never follows a link, never replaces anything). */
export async function writeOnce(path: string, data: unknown): Promise<void> {
  const h = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await h.writeFile(Buffer.isBuffer(data) ? data : `${JSON.stringify(data, null, 2)}\n`);
  } finally {
    await h.close();
  }
}

export type BeforeApproval = {
  humanApprovalConfirmed: boolean;
  prompt: string;
  expected: { promptSha256: string; promptChars: number; commit: string };
  outDir: string;
  signal?: AbortSignal;
  approvalId: string;
  planId: string;
  route: Route;
  retryOf: string | null;
};
export type BeforeApprovalDeps = { ledger: Ledger; commit: () => Promise<CommitState>; preflight?: () => Promise<string | null> };

/**
 * The owner's confirmation, the prompt pin (SHA-256 and length), the output place (new, its parent a real
 * directory), the commit pin (HEAD = origin/develop = the approved commit, clean tree), the machine (preflight:
 * sandbox set-up and the .env rule), the caller's stop signal, and the ledger (approval unused, retry valid, a free
 * slot, time left). Nothing is used by any of these. Returns the call's time limit, or the stop.
 */
export async function checkBeforeApproval(i: BeforeApproval, kind: CallKind, d: BeforeApprovalDeps): Promise<{ ok: true; timeoutMs: number } | { ok: false; code: string; aborted: boolean }> {
  const refuse = (code: string) => ({ ok: false as const, code, aborted: false });
  if (!i.humanApprovalConfirmed) return refuse("HUMAN_APPROVAL_REQUIRED");
  if (sha256(Buffer.from(i.prompt, "utf8")) !== i.expected.promptSha256 || i.prompt.length !== i.expected.promptChars) return refuse("PROMPT_PIN_MISMATCH");
  if (!isAbsolute(i.outDir)) return refuse("OUT_DIR_INVALID");
  if (await lstat(i.outDir).then(() => true, () => false)) return refuse("OUT_DIR_EXISTS");
  // the output dir is created after the approval is used: its parent must already be a real directory
  // (the CLIs pass it under its parent's real path, so a linked parent is resolved before this)
  const parent = await lstat(dirname(i.outDir)).catch(() => null);
  if (!parent || !parent.isDirectory() || parent.isSymbolicLink()) return refuse("OUT_DIR_PARENT_MISSING");
  if (!COMMIT.test(i.expected.commit)) return refuse("COMMIT_PIN_MISMATCH");
  const commit = await d.commit().catch(() => null);
  if (!commit || commit.head !== i.expected.commit || commit.base !== i.expected.commit || !commit.clean) return refuse("COMMIT_PIN_MISMATCH");
  if (i.signal?.aborted) return { ok: false, code: "CODEX_ABORTED", aborted: true };
  if (d.preflight) {
    const problem = await d.preflight().catch(() => "PREFLIGHT_FAILED");
    if (problem !== null) return refuse(problem);
  }
  let timeoutMs: number;
  try {
    ({ timeoutMs } = await d.ledger.precheck({ approvalId: i.approvalId, planId: i.planId, route: i.route, kind, retryOf: i.retryOf }));
  } catch (error) {
    return refuse(error instanceof LedgerStop ? error.code : "LEDGER_UNREADABLE");
  }
  // stopped while the checks ran: nothing is used
  if (i.signal?.aborted) return { ok: false, code: "CODEX_ABORTED", aborted: true };
  return { ok: true, timeoutMs };
}

export type StepCall = {
  schema: "phase2f_live_call_v1";
  status: "succeeded" | "failed" | "aborted";
  code: string | null;
  receipt: Receipt;
  warnings?: string[];
  [k: string]: unknown;
};
export type Step = { dir: string; call: StepCall; receipt: Receipt; result: CallResult; generation: Generation | null };

export class StepStop extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "StepStop";
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

const RECEIPT_KEYS = ["approval_id", "plan_id", "route", "kind", "slot", "retry_of", "prompt_sha256", "prompt_chars", "commit", "run_id"] as const;

/**
 * Reads an earlier step's output and checks it against the ledger. `need` names what the step must have been.
 * Throws StepStop for anything that does not agree (never a success): RECORD_MISSING, RECORD_MISMATCH,
 * RECORD_UNFINISHED (no result in the ledger: crashed or still running), RECORD_WRONG_STEP.
 */
export async function readStep(dir: string, ledger: Ledger, need: { kind: CallKind; route: Route }): Promise<Step> {
  const call = await readJson<StepCall>(join(dir, "call.json"));
  if (!call?.receipt || typeof call.receipt.approval_id !== "string") throw new StepStop("RECORD_MISSING");
  const entry = await ledger.get(call.receipt.approval_id);
  if (!entry) throw new StepStop("RECORD_MISMATCH");
  const { receipt, result } = entry;
  // the copy in the output folder is the ledger's own receipt, field for field
  if (RECEIPT_KEYS.some((k) => JSON.stringify(receipt[k]) !== JSON.stringify(call.receipt[k]))) throw new StepStop("RECORD_MISMATCH");
  if (receipt.kind !== need.kind || receipt.route !== need.route) throw new StepStop("RECORD_WRONG_STEP");
  if (!result) throw new StepStop("RECORD_UNFINISHED");
  // the same ending on both sides
  if (result.status !== call.status || result.code !== call.code) throw new StepStop("RECORD_MISMATCH");
  let generation: Generation | null = null;
  if (call.status === "succeeded") {
    generation = await readJson<Generation>(join(dir, "generation.json"));
    if (
      !generation ||
      generation.status !== "succeeded" ||
      generation.approval_id !== receipt.approval_id ||
      generation.run_id !== receipt.run_id ||
      generation.prompt_sha256 !== receipt.prompt_sha256 ||
      generation.worker_commit !== receipt.commit
    )
      throw new StepStop("RECORD_MISMATCH");
  }
  return { dir, call, receipt, result, generation };
}
