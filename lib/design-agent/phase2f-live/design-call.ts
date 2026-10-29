/**
 * Phase 2f-2 (DEV-116): ONE real design call to Codex for route B or C, under one owner approval.
 *
 * Everything that can stop the call is checked before the approval is used: the owner's confirmation, the prompt
 * (SHA-256 and length must be the ones the owner approved), the commit (HEAD = origin/develop = the approved
 * commit, clean tree), a fresh output directory, the approval ID, the plan's call limits and time. Then the
 * approval is reserved (never reusable) and Codex is called once, with the call's time limit and the caller's
 * AbortSignal. Nothing here retries.
 *
 * The output directory holds what the next steps use instead of calling Codex again:
 *   answer.json      Codex's answer as received (after the usual secret redaction), not yet checked
 *   generation.json  the call's facts for the Design Artifact (CLI version, model, approval, prompt SHA, commit, run, times)
 *   call.json        how the call ended, warnings (unknown model, redactions with their JSON paths), the ledger receipt
 * A stopped call writes call.json only: no answer, never a success. call.json is written last, and the ledger's result
 * after it: a later step uses an answer only when call.json AND the ledger both say "succeeded" (a crash in between
 * leaves the ledger without a result, which is never a success).
 *
 * Codex is reached only through the injected `codex` function (the CLI passes the sandboxed JSON call of codex.ts);
 * this module starts no process and opens no network connection.
 */
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { CodexAbortedError, CodexError, type CodexRunMeta } from "../codex";
import { LedgerStop, type Ledger, type Receipt } from "./ledger";

export type DesignCodex = (o: { prompt: string; schema: object; timeoutMs: number; signal?: AbortSignal }) => Promise<{ answer: unknown; meta: CodexRunMeta }>;
export type CommitState = { head: string | null; base: string | null; clean: boolean };

export type DesignCallInput = {
  route: "B_html_prototype" | "C_hybrid";
  prompt: string;
  schema: object;
  humanApprovalConfirmed: boolean;
  approvalId: string;
  planId: string;
  retryOf: string | null;
  expected: { promptSha256: string; promptChars: number; commit: string };
  outDir: string;
  signal?: AbortSignal;
};

export type DesignCallDeps = {
  ledger: Ledger;
  codex: DesignCodex;
  commit: () => Promise<CommitState>;
  /**
   * Optional checks that need the machine (the CLI prepares the OS sandbox here, which starts no Codex): a stop
   * code, or null when the call can go ahead. Runs before the approval is used, so a predictable refusal of the
   * sandbox never uses up an approval.
   */
  preflight?: () => Promise<string | null>;
  now?: () => number;
};

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

export type DesignCallResult =
  | { status: "succeeded"; outDir: string; generation: Generation; warnings: string[]; receipt: Receipt }
  /** precheck: nothing was used. call: the approval was used and the call did not succeed (never retried here). */
  | { status: "stopped"; code: string; stage: "precheck" | "call"; aborted: boolean };

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const COMMIT = /^[0-9a-f]{40}$/;

async function writeOnce(path: string, data: unknown): Promise<void> {
  const h = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await h.writeFile(`${JSON.stringify(data, null, 2)}\n`);
  } finally {
    await h.close();
  }
}

export async function runDesignCall(i: DesignCallInput, d: DesignCallDeps): Promise<DesignCallResult> {
  const now = d.now ?? Date.now;
  const refuse = (code: string): DesignCallResult => ({ status: "stopped", code, stage: "precheck", aborted: false });

  // ---- before the approval is used -----------------------------------------------------------
  if (!i.humanApprovalConfirmed) return refuse("HUMAN_APPROVAL_REQUIRED");
  if (sha256(i.prompt) !== i.expected.promptSha256 || i.prompt.length !== i.expected.promptChars) return refuse("PROMPT_PIN_MISMATCH");
  if (!isAbsolute(i.outDir)) return refuse("OUT_DIR_INVALID");
  if (await lstat(i.outDir).then(() => true, () => false)) return refuse("OUT_DIR_EXISTS");
  // the output dir is created after the approval is used: its parent must already be a real directory
  // (the CLI passes it under its parent's real path, so a linked parent is resolved before this)
  const parent = await lstat(dirname(i.outDir)).catch(() => null);
  if (!parent || !parent.isDirectory() || parent.isSymbolicLink()) return refuse("OUT_DIR_PARENT_MISSING");
  if (!COMMIT.test(i.expected.commit)) return refuse("COMMIT_PIN_MISMATCH");
  const commit = await d.commit().catch(() => null);
  if (!commit || commit.head !== i.expected.commit || commit.base !== i.expected.commit || !commit.clean) return refuse("COMMIT_PIN_MISMATCH");
  if (i.signal?.aborted) return { status: "stopped", code: "CODEX_ABORTED", stage: "precheck", aborted: true };
  if (d.preflight) {
    const problem = await d.preflight().catch(() => "PREFLIGHT_FAILED");
    if (problem !== null) return refuse(problem);
  }
  let timeoutMs: number;
  try {
    ({ timeoutMs } = await d.ledger.precheck({ approvalId: i.approvalId, planId: i.planId, route: i.route, kind: "design", retryOf: i.retryOf }));
  } catch (error) {
    return refuse(error instanceof LedgerStop ? error.code : "LEDGER_UNREADABLE");
  }

  // stopped while the checks ran: nothing is used
  if (i.signal?.aborted) return { status: "stopped", code: "CODEX_ABORTED", stage: "precheck", aborted: true };

  // ---- the approval is used from here on ------------------------------------------------------
  const runId = `p2f-${randomBytes(8).toString("hex")}`;
  let receipt: Receipt;
  try {
    receipt = await d.ledger.reserve({ approval_id: i.approvalId, plan_id: i.planId, route: i.route, kind: "design", retry_of: i.retryOf, prompt_sha256: i.expected.promptSha256, prompt_chars: i.expected.promptChars, commit: i.expected.commit, run_id: runId });
  } catch (error) {
    return { status: "stopped", code: error instanceof LedgerStop ? error.code : "LEDGER_UNWRITABLE", stage: "call", aborted: false };
  }
  const started = now();
  const end = async (status: "succeeded" | "failed" | "aborted", code: string | null) =>
    d.ledger.finish(i.approvalId, { status, code, finished_at: new Date(now()).toISOString(), elapsed_ms: now() - started });
  try {
    await mkdir(i.outDir, { mode: 0o700 });
  } catch {
    await end("failed", "OUT_DIR_UNWRITABLE").catch(() => undefined);
    return { status: "stopped", code: "OUT_DIR_UNWRITABLE", stage: "call", aborted: false };
  }

  let answer: unknown;
  let meta: CodexRunMeta;
  try {
    ({ answer, meta } = await d.codex({ prompt: i.prompt, schema: i.schema, timeoutMs, ...(i.signal === undefined ? {} : { signal: i.signal }) }));
    // stopped while the answer was on its way back: not an answer either
    if (i.signal?.aborted) throw new CodexAbortedError();
  } catch (error) {
    const aborted = error instanceof CodexAbortedError;
    const code = aborted ? "CODEX_ABORTED" : error instanceof CodexError ? error.code : "CODEX_UNEXPECTED";
    await writeOnce(join(i.outDir, "call.json"), { schema: "phase2f_live_call_v1", status: aborted ? "aborted" : "failed", code, receipt, warnings: [] }).catch(() => undefined);
    await end(aborted ? "aborted" : "failed", code).catch(() => undefined);
    return { status: "stopped", code, stage: "call", aborted };
  }

  const finished = now();
  const generation: Generation = {
    status: "succeeded",
    tool: "codex_cli",
    tool_version: meta.cliVersion,
    model_reported: meta.modelReported,
    approval_id: i.approvalId,
    prompt_sha256: i.expected.promptSha256,
    worker_commit: i.expected.commit,
    run_id: runId,
    started_at: new Date(started).toISOString(),
    finished_at: new Date(finished).toISOString(),
  };
  // facts that could not be read are warnings: the answer itself is kept and checked by the next steps
  const warnings = [
    ...(meta.modelReported === null ? ["generation_model_unknown"] : []),
    ...(meta.cliVersion === null ? ["generation_tool_version_unknown"] : []),
    ...meta.redactions.map((r) => `answer_redacted:${r.path}`),
  ];
  try {
    await writeOnce(join(i.outDir, "answer.json"), answer);
    await writeOnce(join(i.outDir, "generation.json"), generation);
    await writeOnce(join(i.outDir, "call.json"), { schema: "phase2f_live_call_v1", status: "succeeded", code: null, receipt, thread_id: meta.threadId, redactions: meta.redactions, warnings });
  } catch {
    await end("failed", "OUT_WRITE_FAILED").catch(() => undefined);
    return { status: "stopped", code: "OUT_WRITE_FAILED", stage: "call", aborted: false };
  }
  await end("succeeded", null);
  return { status: "succeeded", outDir: i.outDir, generation, warnings, receipt };
}
