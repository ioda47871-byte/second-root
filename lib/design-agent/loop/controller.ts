/**
 * Phase 2g (DEV-129, MOCK ONLY): the deterministic controller of one design-to-implementation run, with explicit
 * stops, approval requests and a bounded repair loop. Issue #159 approves it with mock ports only: nothing here can
 * call Codex, an image tool, a paid API or a process; every step is a port the caller injects.
 *
 * The order: design (a paid call) → package (offline) → checks (identity, structure; offline) → owner selection
 * (a person) → implement (Claude) → compare (offline) → repair loop → owner review.
 *
 * Rules (from docs/operations/claude-autonomy.md and docs/AI_WORKFLOW.md):
 * - A paid step (design) runs only with an approval the ApprovalPort grants for exactly that request; otherwise the run
 *   stops as `awaiting_approval`. A failed paid step is never retried here: a new run needs a new approval.
 * - Identity REJECT / HOLD and any safety or policy stop go to the owner (`stopped`, owner_check), never repaired.
 * - Only the implementation is repaired, offline: at most 3 implementation attempts per task, and at most 2 fixes for
 *   the same cause; then the run stops (`retry_budget_exhausted`).
 * - A run that gets through ends at `owner_review`: a passing comparison is never a design approval.
 * - Anything a port answers outside its expected values (or a port that throws) stops the run for the owner: every
 *   gate is "expected value or stop", never "known bad value or go".
 * Deterministic: the same port answers give the same events. Cost: in this mock, the only cost limit is one paid call
 * per approval; the plan's money limits belong to the real ports (a separate approval).
 */

export type StopClass = "environment" | "output" | "safety" | "policy" | "unknown";
export type PortResult<T> = { ok: true; value: T } | { ok: false; code: string; stopClass: StopClass };

export type ApprovalRequest = { kind: "design_call"; run_id: string; summary: string };
export type Ports = {
  /** Grants an approval for exactly this request, or leaves it pending. Never inferred by the controller. */
  approval: (r: ApprovalRequest) => "approved" | "pending" | "denied";
  design: (approvalRunId: string) => PortResult<{ design_id: string }>;
  package: (designId: string) => PortResult<{ artifact_id: string; state: "render_pair_complete" | "concept_only" | "incomplete" }>;
  identity: (artifactId: string) => PortResult<"PASS_IDENTITY_ONLY" | "HOLD" | "REJECT">;
  structure: (artifactId: string) => PortResult<string[]>;
  /** A person picks the design (G2/G3). "pending" stops the run until they do. */
  ownerSelection: (artifactId: string) => "selected" | "rejected" | "pending";
  implement: (artifactId: string, fixFor: string | null) => PortResult<{ build_id: string }>;
  /** Compares the implementation with the selected design at PC 1440 / SP 390; the differences are cause codes. */
  compare: (buildId: string) => PortResult<{ differences: string[] }>;
};

export type LoopStatus = "owner_review" | "awaiting_approval" | "awaiting_owner_selection" | "stopped";
export type LoopResult = {
  status: LoopStatus;
  code: string | null;
  owner_check: boolean;
  events: string[];
  implementation_attempts: number;
  /** Never a design approval: a passing run still needs the owner's review. */
  design_approved: false;
};

/**
 * 3 implementation attempts per task (the first and two fixes), at most 2 fixes for one cause (AI_WORKFLOW: 3 failures
 * → blocked; same problem → 2 proposals). Under 3 attempts there can be only 2 fixes in all, so the per-cause limit only
 * names the stop when the third result shows the same cause again: kept as a second guard.
 */
export const LIMITS = { implementationAttempts: 3, fixesPerCause: 2 } as const;
const CAUSE = /^[A-Z][A-Z0-9_]{0,60}$/;

export function runLoop(runId: string, ports: Ports): LoopResult {
  const log = { events: [] as string[], attempts: 0 };
  try {
    return run(runId, ports, log);
  } catch {
    // a port that throws is recorded as a stop for the owner (with everything recorded so far), never retried
    log.events.push("end:stopped:PORT_THREW");
    return { status: "stopped", code: "PORT_THREW", owner_check: true, events: log.events, implementation_attempts: log.attempts, design_approved: false };
  }
}

/** IDs a port returns are names, never free text (no separators, no line breaks). */
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const STOP_CLASSES = new Set<StopClass>(["environment", "output", "safety", "policy", "unknown"]);
const STATES = new Set(["render_pair_complete", "concept_only", "incomplete"]);
const IDENTITY = new Set(["PASS_IDENTITY_ONLY", "HOLD", "REJECT"]);
const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {});
const id = (v: unknown) => typeof v === "string" && ID.test(v);

const isResult = (r: unknown): r is PortResult<unknown> =>
  r !== null &&
  typeof r === "object" &&
  (((r as { ok: unknown }).ok === true && "value" in r) ||
    ((r as { ok: unknown }).ok === false && typeof (r as { code: unknown }).code === "string" && CAUSE.test((r as { code: string }).code) && STOP_CLASSES.has((r as { stopClass: StopClass }).stopClass)));

function run(runId: string, ports: Ports, log: { events: string[]; attempts: number }): LoopResult {
  const events = log.events;
  const end = (status: LoopStatus, code: string | null, ownerCheck = false): LoopResult => {
    events.push(`end:${status}${code ? `:${code}` : ""}`);
    return { status, code, owner_check: ownerCheck, events, implementation_attempts: log.attempts, design_approved: false };
  };
  const malformed = (step: string) => {
    events.push(`${step}:malformed`);
    return end("stopped", "PORT_ANSWER_INVALID", true);
  };
  const failed = (step: string, r: { code: string; stopClass: StopClass }) => {
    events.push(`${step}:failed:${r.code}:${r.stopClass}`);
    // safety / policy / unknown go to the owner; environment waits; output of a paid or offline step is not repaired here
    return end("stopped", r.code, r.stopClass !== "environment");
  };

  // 1. the paid design call: only with an approval for exactly this run
  const decision = ports.approval({ kind: "design_call", run_id: runId, summary: "one design call (Codex), counted against the plan's limits" });
  events.push(`approval:design_call:${String(decision)}`);
  if (decision === "denied") return end("stopped", "DESIGN_CALL_DENIED", true);
  if (decision !== "approved") return end("awaiting_approval", "DESIGN_CALL_NOT_APPROVED");
  const design = ports.design(runId);
  if (!isResult(design)) return malformed("design");
  if (!design.ok) return failed("design", design);
  if (!id(obj(design.value).design_id)) return malformed("design");
  events.push(`design:ok:${design.value.design_id}`);

  // 2. package + checks (offline)
  const pkg = ports.package(design.value.design_id);
  if (!isResult(pkg)) return malformed("package");
  if (!pkg.ok) return failed("package", pkg);
  if (!id(obj(pkg.value).artifact_id) || !STATES.has(obj(pkg.value).state as string)) return malformed("package");
  events.push(`package:${pkg.value.state}`);
  if (pkg.value.state !== "render_pair_complete") return end("stopped", `ARTIFACT_${pkg.value.state.toUpperCase()}`, true);
  const identity = ports.identity(pkg.value.artifact_id);
  if (!isResult(identity)) return malformed("identity");
  if (!identity.ok) return failed("identity", identity);
  if (!IDENTITY.has(identity.value as string)) return malformed("identity");
  events.push(`identity:${identity.value}`);
  if (identity.value !== "PASS_IDENTITY_ONLY") return end("stopped", `IDENTITY_${identity.value}`, true);
  const structure = ports.structure(pkg.value.artifact_id);
  if (!isResult(structure)) return malformed("structure");
  if (!structure.ok) return failed("structure", structure);
  if (!Array.isArray(structure.value) || !structure.value.every((c) => typeof c === "string" && CAUSE.test(c))) return malformed("structure");
  // advisory: shown to the owner with the design, never a stop and never a pass
  events.push(`structure:${structure.value.length ? structure.value.join(",") : "none"}`);

  // 3. a person selects the design before anything is implemented
  const selection = ports.ownerSelection(pkg.value.artifact_id);
  events.push(`owner_selection:${String(selection)}`);
  if (selection === "pending") return end("awaiting_owner_selection", null);
  if (selection === "rejected") return end("stopped", "DESIGN_NOT_SELECTED", true);
  // only an explicit selection lets implementation start
  if (selection !== "selected") return end("stopped", "OWNER_SELECTION_INVALID", true);

  // 4. implement → compare → bounded repair (offline only)
  const fixes = new Map<string, number>();
  let fixFor: string | null = null;
  for (;;) {
    log.attempts++;
    const attempts = log.attempts;
    const build = ports.implement(pkg.value.artifact_id, fixFor);
    if (!isResult(build)) return malformed("implement");
    if (!build.ok) return failed("implement", build);
    if (!id(obj(build.value).build_id)) return malformed("implement");
    const cmp = ports.compare(build.value.build_id);
    if (!isResult(cmp)) return malformed("compare");
    if (!cmp.ok) return failed("compare", cmp);
    if (!Array.isArray(obj(cmp.value).differences) || !cmp.value.differences.every((c) => typeof c === "string" && CAUSE.test(c))) return malformed("compare");
    const diffs = [...new Set(cmp.value.differences)].sort();
    events.push(`compare:${attempts}:${diffs.length ? diffs.join(",") : "match"}`);
    if (!diffs.length) return end("owner_review", null);
    // one cause per attempt, in a fixed order; a cause fixed twice already stops the run
    const cause = diffs[0]!;
    const n = (fixes.get(cause) ?? 0) + 1;
    if (n > LIMITS.fixesPerCause) return end("stopped", "SAME_CAUSE_FIX_LIMIT", true);
    // a fix that would not be tried is never recorded as one
    if (attempts >= LIMITS.implementationAttempts) return end("stopped", "RETRY_BUDGET_EXHAUSTED", true);
    fixes.set(cause, n);
    fixFor = cause;
    events.push(`fix:${cause}:${n}`);
  }
}
