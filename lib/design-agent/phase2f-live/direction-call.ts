/**
 * DEV-150 (Issue #180): ONE real DIRECTION_FIRST call to Codex (the three-method study), under one owner approval.
 * Codex gives the visual direction in words (three_method_direction_v0): no page, no image.
 *
 * The same order as the design step (design-call.ts): everything that can stop the call is checked before the approval
 * is used (steps.ts checkBeforeApproval: the owner's confirmation, the prompt pin, the output place, the commit pin, the
 * machine, the ledger), then the approval is reserved (kind "direction", route "direction_text"; never reusable) and
 * Codex is called once, with the call's time limit and the caller's AbortSignal. Nothing here retries.
 *
 * The answer is checked strictly (the lane's checkDirection: exactly the schema, only this shop's fact ids). An answer
 * that does not check is a FAILED call (DIRECTION_ANSWER_INVALID / DIRECTION_FACT_UNKNOWN): it is kept in answer.json
 * for the record, the approval stays used, and it is never retried or repaired here.
 *
 * Output directory: answer.json (as received, after the usual secret redaction), generation.json (only when the
 * answer checked), call.json (written last; the ledger's result after it), as the design step writes them. A later step
 * reads the direction only through readStep (output folder AND ledger both "succeeded").
 *
 * Codex is reached only through the injected `codex` function (the CLI passes the sandboxed JSON call of codex.ts);
 * this module starts no process and opens no network connection.
 */
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { checkDirection, type ThreeMethodDirection } from "../three-methods/direction";
import { CodexAbortedError, CodexError, type CodexRunMeta } from "../codex";
import { LedgerStop, type Ledger, type Receipt } from "./ledger";
import { checkBeforeApproval, writeOnce, type CommitState, type Generation } from "./steps";

export type DirectionCodex = (o: { prompt: string; schema: object; timeoutMs: number; signal?: AbortSignal }) => Promise<{ answer: unknown; meta: CodexRunMeta }>;

export type DirectionCallInput = {
  prompt: string;
  schema: object;
  /** The facts pack the answer's fact ids are checked against. */
  facts: Parameters<typeof checkDirection>[1];
  humanApprovalConfirmed: boolean;
  approvalId: string;
  planId: string;
  retryOf: string | null;
  expected: { promptSha256: string; promptChars: number; commit: string };
  outDir: string;
  signal?: AbortSignal;
};

export type DirectionCallDeps = {
  ledger: Ledger;
  codex: DirectionCodex;
  commit: () => Promise<CommitState>;
  preflight?: () => Promise<string | null>;
  now?: () => number;
};

export type DirectionCallResult =
  | { status: "succeeded"; outDir: string; generation: Generation; warnings: string[]; receipt: Receipt; direction: ThreeMethodDirection }
  | { status: "stopped"; code: string; stage: "precheck" | "call"; aborted: boolean; diagnostic?: { exit_code: number | null; class: string } };

export async function runDirectionCall(i: DirectionCallInput, d: DirectionCallDeps): Promise<DirectionCallResult> {
  const now = d.now ?? Date.now;

  // ---- before the approval is used (steps.ts) --------------------------------------------------
  const checked = await checkBeforeApproval({ ...i, route: "direction_text" }, "direction", d);
  if (!checked.ok) return { status: "stopped", code: checked.code, stage: "precheck", aborted: checked.aborted };
  const { timeoutMs } = checked;

  // ---- the approval is used from here on ------------------------------------------------------
  const runId = `p2f-${randomBytes(8).toString("hex")}`;
  let receipt: Receipt;
  try {
    receipt = await d.ledger.reserve({ approval_id: i.approvalId, plan_id: i.planId, route: "direction_text", kind: "direction", retry_of: i.retryOf, prompt_sha256: i.expected.promptSha256, prompt_chars: i.expected.promptChars, commit: i.expected.commit, run_id: runId });
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
    if (i.signal?.aborted) throw new CodexAbortedError();
  } catch (error) {
    const aborted = error instanceof CodexAbortedError;
    const code = aborted ? "CODEX_ABORTED" : error instanceof CodexError ? error.code : "CODEX_UNEXPECTED";
    const diag = !aborted && error instanceof CodexError && error.diagnostic ? { diagnostic: { exit_code: error.diagnostic.exit_code, class: error.diagnostic.class } } : {};
    await writeOnce(join(i.outDir, "call.json"), { schema: "phase2f_live_call_v1", status: aborted ? "aborted" : "failed", code, receipt, warnings: [], ...diag }).catch(() => undefined);
    await end(aborted ? "aborted" : "failed", code).catch(() => undefined);
    return { status: "stopped", code, stage: "call", aborted, ...diag };
  }

  const warnings = [
    ...(meta.modelReported === null ? ["generation_model_unknown"] : []),
    ...(meta.cliVersion === null ? ["generation_tool_version_unknown"] : []),
    ...meta.redactions.map((r) => `answer_redacted:${r.path}`),
  ];
  const direction = checkDirection(answer, i.facts);
  if (!direction.ok) {
    // the call was made and its answer does not check: a failure, kept as received, never repaired or retried
    try {
      await writeOnce(join(i.outDir, "answer.json"), answer);
      await writeOnce(join(i.outDir, "call.json"), { schema: "phase2f_live_call_v1", status: "failed", code: direction.code, receipt, thread_id: meta.threadId, redactions: meta.redactions, warnings, cli_version: meta.cliVersion, model_reported: meta.modelReported });
    } catch {
      await end("failed", "OUT_WRITE_FAILED").catch(() => undefined);
      return { status: "stopped", code: "OUT_WRITE_FAILED", stage: "call", aborted: false };
    }
    await end("failed", direction.code).catch(() => undefined);
    return { status: "stopped", code: direction.code, stage: "call", aborted: false };
  }

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
    finished_at: new Date(now()).toISOString(),
  };
  try {
    await writeOnce(join(i.outDir, "answer.json"), answer);
    await writeOnce(join(i.outDir, "generation.json"), generation);
    await writeOnce(join(i.outDir, "call.json"), { schema: "phase2f_live_call_v1", status: "succeeded", code: null, receipt, thread_id: meta.threadId, redactions: meta.redactions, warnings });
  } catch {
    await end("failed", "OUT_WRITE_FAILED").catch(() => undefined);
    return { status: "stopped", code: "OUT_WRITE_FAILED", stage: "call", aborted: false };
  }
  await end("succeeded", null);
  return { status: "succeeded", outDir: i.outDir, generation, warnings, receipt, direction: direction.direction };
}
