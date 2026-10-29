/**
 * Phase 2f-2 (DEV-116): the one-use approval ledger and the plan's limits for real Codex calls.
 *
 * Every real call (a design call now; an image call in DEV-117) needs its own approval ID from the owner.
 * The ledger lives outside the repository, in the worker user's state directory:
 *
 *   <state>/approvals/<approval_id>/receipt.json   reserved by an atomic mkdir: an ID is used at most once, ever
 *   <state>/approvals/<approval_id>/result.json    how the call ended (written once; missing = unknown, never a success)
 *   <state>/plans/<plan_id>/plan.json              the plan's limits, fixed on its first call
 *   <state>/plans/<plan_id>/slots/first-N|retry-N  one atomic mkdir per call: at most 4 first calls and 2 retries
 *
 * An approval, once reserved, is never used again, whatever the call's outcome (success, failure, abort, crash).
 * A retry is a new approval that names the failed call it replaces; nothing here retries by itself and nothing
 * raises a limit. Time: each call gets at most 15 minutes, and the plan's calls together at most 2 hours, counted by the
 * time each call really took (a call without a result counts as a full 15 minutes). The owner's waits between steps are not counted.
 *
 * This is accident prevention, like the v4 image PoC's ledger: a process of the same user can still edit its own
 * state. It is a separate ledger: the image PoC's own one, and its v4 approval, stay as they are.
 */
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export const LIVE_LIMITS = { firstCalls: 4, retries: 2, callTimeoutMs: 15 * 60 * 1000, planBudgetMs: 2 * 60 * 60 * 1000 } as const;
/** Less than this left in the plan: no call is started. */
export const MIN_CALL_MS = 60_000;

export const APPROVAL_ID = /^[a-z0-9][a-z0-9._-]{3,95}$/;
export const PLAN_ID = /^[a-z0-9][a-z0-9._-]{3,63}$/;
export type CallKind = "design" | "image" | "concept_image";
export type Route = "A_image" | "B_html_prototype" | "C_hybrid";

export type Receipt = {
  schema: "phase2f_live_receipt_v1";
  approval_id: string;
  plan_id: string;
  route: Route;
  kind: CallKind;
  slot: string;
  retry_of: string | null;
  prompt_sha256: string;
  prompt_chars: number;
  commit: string;
  run_id: string;
  reserved_at: string;
};
export type CallResult = {
  schema: "phase2f_live_result_v1";
  status: "succeeded" | "failed" | "aborted" | "refused";
  code: string | null;
  finished_at: string;
  elapsed_ms: number;
};

export class LedgerStop extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "LedgerStop";
  }
}

const exists = (p: string) => lstat(p).then(() => true, () => false);

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Creates a file once (never follows or replaces anything). */
async function writeOnce(path: string, data: unknown): Promise<void> {
  const h = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await h.writeFile(`${JSON.stringify(data, null, 2)}\n`);
  } finally {
    await h.close();
  }
}

/** A directory of ours that is not a link (created if missing). */
async function ownDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new LedgerStop("LEDGER_UNSAFE");
}

export type Ledger = ReturnType<typeof openLedger>;

export function openLedger(stateDir: string, now: () => number = Date.now) {
  if (!isAbsolute(stateDir)) throw new LedgerStop("LEDGER_UNSAFE");
  const approvals = join(stateDir, "approvals");
  const plans = join(stateDir, "plans");
  const planDir = (planId: string) => join(plans, planId);

  /** The plan's calls that were started or may have been (an approval refused for want of a slot is not one). */
  async function calls(planId: string): Promise<{ receipt: Receipt; result: CallResult | null }[]> {
    const out: { receipt: Receipt; result: CallResult | null }[] = [];
    for (const id of await readdir(approvals).catch(() => [] as string[])) {
      const receipt = await readJson<Receipt>(join(approvals, id, "receipt.json"));
      if (receipt?.plan_id !== planId) continue;
      const result = await readJson<CallResult>(join(approvals, id, "result.json"));
      if (result?.status !== "refused") out.push({ receipt, result });
    }
    return out;
  }

  /** Plan time used so far: a finished call by the time it really took, a call without a result (running, crashed) as a full call. */
  async function usedMs(planId: string): Promise<number> {
    return (await calls(planId)).reduce((sum, c) => sum + (c.result ? Math.max(0, Number(c.result.elapsed_ms) || 0) : LIVE_LIMITS.callTimeoutMs), 0);
  }

  return {
    calls,
    usedMs,

    /**
     * Checks everything that can be checked without using the approval: the ID's format and that it is unused,
     * the retry it claims to be, a free slot and the time left. Returns the call's time limit.
     */
    async precheck(o: { approvalId: string; planId: string; route: Route; kind: CallKind; retryOf: string | null }): Promise<{ timeoutMs: number }> {
      if (!APPROVAL_ID.test(o.approvalId)) throw new LedgerStop("APPROVAL_ID_INVALID");
      if (!PLAN_ID.test(o.planId)) throw new LedgerStop("PLAN_ID_INVALID");
      if (await exists(join(approvals, o.approvalId))) throw new LedgerStop("APPROVAL_ALREADY_USED");
      const done = await calls(o.planId);
      if (o.retryOf !== null) {
        const original = done.find((c) => c.receipt.approval_id === o.retryOf);
        // a retry replaces one call of this plan, same route and kind, that did not succeed; each call is replaced once
        if (!original || original.receipt.route !== o.route || original.receipt.kind !== o.kind) throw new LedgerStop("RETRY_OF_UNKNOWN");
        if (original.result?.status === "succeeded") throw new LedgerStop("RETRY_OF_SUCCEEDED");
        if (done.some((c) => c.receipt.retry_of === o.retryOf)) throw new LedgerStop("RETRY_ALREADY_MADE");
        if (done.filter((c) => c.receipt.retry_of !== null).length >= LIVE_LIMITS.retries) throw new LedgerStop("RUN_LIMIT_RETRIES");
      } else if (done.filter((c) => c.receipt.retry_of === null).length >= LIVE_LIMITS.firstCalls) {
        throw new LedgerStop("RUN_LIMIT_FIRST_CALLS");
      }
      const left = LIVE_LIMITS.planBudgetMs - (await usedMs(o.planId));
      if (left < MIN_CALL_MS) throw new LedgerStop("RUN_TIME_BUDGET");
      return { timeoutMs: Math.min(LIVE_LIMITS.callTimeoutMs, left) };
    },

    /** Uses the approval (atomic mkdir; never twice), then takes a slot. A refused slot still uses the approval. */
    async reserve(r: Omit<Receipt, "schema" | "slot" | "reserved_at">): Promise<Receipt> {
      await ownDir(stateDir);
      await ownDir(approvals);
      await ownDir(planDir(r.plan_id));
      const plan = join(planDir(r.plan_id), "plan.json");
      if (!(await exists(plan))) await writeOnce(plan, { schema: "phase2f_live_plan_v1", plan_id: r.plan_id, created_at: new Date(now()).toISOString(), limits: LIVE_LIMITS }).catch(() => undefined);
      const dir = join(approvals, r.approval_id);
      try {
        await mkdir(dir, { mode: 0o700 });
      } catch {
        throw new LedgerStop("APPROVAL_ALREADY_USED");
      }
      const kind = r.retry_of === null ? "first" : "retry";
      const max = kind === "first" ? LIVE_LIMITS.firstCalls : LIVE_LIMITS.retries;
      const take = (path: string) => mkdir(path, { mode: 0o700 }).then(() => true, () => false);
      let refused: string | null = null;
      // a failed call is replaced at most once, even by two retries started at the same moment (atomic mkdir)
      if (r.retry_of !== null) {
        await ownDir(join(planDir(r.plan_id), "retried"));
        if (!(await take(join(planDir(r.plan_id), "retried", r.retry_of)))) refused = "RETRY_ALREADY_MADE";
      }
      await ownDir(join(planDir(r.plan_id), "slots"));
      let slot: string | null = null;
      for (let i = 1; i <= max && slot === null && refused === null; i++) {
        const name = `${kind}-${i}`;
        if (await take(join(planDir(r.plan_id), "slots", name))) slot = name;
      }
      if (slot === null && refused === null) refused = kind === "first" ? "RUN_LIMIT_FIRST_CALLS" : "RUN_LIMIT_RETRIES";
      const receipt: Receipt = { schema: "phase2f_live_receipt_v1", ...r, slot: slot ?? "none", reserved_at: new Date(now()).toISOString() };
      await writeOnce(join(dir, "receipt.json"), receipt);
      if (refused !== null) {
        // the approval stays used (never reusable), but no call was made and it counts toward no limit
        await writeOnce(join(dir, "result.json"), { schema: "phase2f_live_result_v1", status: "refused", code: refused, finished_at: new Date(now()).toISOString(), elapsed_ms: 0 } satisfies CallResult);
        throw new LedgerStop(refused);
      }
      return receipt;
    },

    /** Records how a reserved call ended (once). */
    async finish(approvalId: string, result: Omit<CallResult, "schema">): Promise<void> {
      await writeOnce(join(approvals, approvalId, "result.json"), { schema: "phase2f_live_result_v1", ...result });
    },
  };
}
