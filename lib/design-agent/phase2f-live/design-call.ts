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
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CodexAbortedError, CodexError, type CodexRunMeta } from "../codex";
import { LedgerStop, type Ledger, type Receipt } from "./ledger";
import { checkBeforeApproval, writeOnce, type CommitState, type Generation } from "./steps";

export type { CommitState, Generation } from "./steps";

export type DesignCodex = (o: { prompt: string; schema: object; timeoutMs: number; signal?: AbortSignal; images?: readonly string[] }) => Promise<{ answer: unknown; meta: CodexRunMeta }>;

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
  /** DEV-124: PNG sheets of the success-case references the prompt names (their SHA-256 is in the prompt). */
  images?: readonly string[];
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

export type DesignCallResult =
  | { status: "succeeded"; outDir: string; generation: Generation; warnings: string[]; receipt: Receipt }
  /** precheck: nothing was used. call: the approval was used and the call did not succeed (never retried here). */
  | { status: "stopped"; code: string; stage: "precheck" | "call"; aborted: boolean; diagnostic?: { exit_code: number | null; class: string } };

export async function runDesignCall(i: DesignCallInput, d: DesignCallDeps): Promise<DesignCallResult> {
  const now = d.now ?? Date.now;

  // ---- before the approval is used: shared with the image step (steps.ts) --------------------
  const checked = await checkBeforeApproval(i, "design", d);
  if (!checked.ok) return { status: "stopped", code: checked.code, stage: "precheck", aborted: checked.aborted };
  const { timeoutMs } = checked;

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
    ({ answer, meta } = await d.codex({ prompt: i.prompt, schema: i.schema, timeoutMs, ...(i.signal === undefined ? {} : { signal: i.signal }), ...(i.images?.length ? { images: i.images } : {}) }));
    // stopped while the answer was on its way back: not an answer either
    if (i.signal?.aborted) throw new CodexAbortedError();
  } catch (error) {
    const aborted = error instanceof CodexAbortedError;
    const code = aborted ? "CODEX_ABORTED" : error instanceof CodexError ? error.code : "CODEX_UNEXPECTED";
    // DEV-119: a failed `codex exec` leaves only its exit code and a fixed class (never the CLI's output)
    const diag = !aborted && error instanceof CodexError && error.diagnostic ? { diagnostic: { exit_code: error.diagnostic.exit_code, class: error.diagnostic.class } } : {};
    await writeOnce(join(i.outDir, "call.json"), { schema: "phase2f_live_call_v1", status: aborted ? "aborted" : "failed", code, receipt, warnings: [], ...diag }).catch(() => undefined);
    await end(aborted ? "aborted" : "failed", code).catch(() => undefined);
    return { status: "stopped", code, stage: "call", aborted, ...diag };
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
