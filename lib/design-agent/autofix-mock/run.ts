/**
 * DEV-146 (Issue #177 D, MOCK ONLY, opt-in, unwired): the bounded apply → re-render → re-test loop of the limited
 * automatic fixes (docs/design/limited-autofix.md). Nothing imports it but its tests. It renders, measures and checks
 * identity only through ports the caller injects; it reads and writes no file, starts no process and calls nothing.
 *
 * Rules:
 * - Only the implementation's CSS is patched (`source: "implementation"`); a Codex prototype is refused. HTML, text and
 *   facts are never changed: the ports always get the original HTML bytes.
 * - Identity is checked first and before every re-test: anything but PASS_IDENTITY_ONLY stops the run at once, with
 *   no patch. A blocked request, a check that could not run, a malformed answer or a port that throws stops it too.
 * - One cause per attempt, in a fixed order; a patch is kept only when the SP checks no longer name its cause, no new
 *   finding appears, nothing was blocked and the PC 1440 render did not change beyond PC_CHANGE_MAX. Otherwise it is
 *   reverted (the CSS before it is kept) and recorded.
 * - At most AUTOFIX_LIMITS.attempts patches tried and AUTOFIX_LIMITS.fixesPerCause per cause (the same limits as the
 *   mock run controller of DEV-129, pinned by the tests). Past either, or with no further variant, the run stops for
 *   the owner and keeps the original CSS.
 * - A run that resolves what it could ends at `owner_review` with a PROPOSED CSS: it is never applied, never a pass and
 *   never a design approval.
 */
import { applyPatch, candidatePatch, causeOf, OVERFLOW_CODE, SP_WIDTH, isSelector, unifiedDiff, type Cause } from "./patches";

/** 3 patches tried per run, at most 2 for one cause (as DEV-129's LIMITS: implementationAttempts 3, fixesPerCause 2). */
export const AUTOFIX_LIMITS = { attempts: 3, fixesPerCause: 2 } as const;
/** The largest share of differing PC 1440 pixels a kept patch may cause (its media query should make it 0). */
export const PC_CHANGE_MAX = 0.001;

export type IdentityVerdict = "PASS_IDENTITY_ONLY" | "HOLD" | "REJECT";
export type Target = { code: string; selector: string };
export type Measurement = {
  /** The SP 390 checks' codes (DEV-134), as recorded. */
  sp_findings: readonly string[];
  /** The SP 390 document's scrollWidth. */
  sp_scroll_width: number;
  /** Where the in-scope findings sit (LOCATE_SCRIPT). */
  targets: readonly Target[];
  /** The PC 1440 screenshot, for the regression check. */
  pc_png: Uint8Array;
  /** Requests the page tried that were not its own files (any is a safety stop). */
  blocked: number;
};
export type AutofixPorts = {
  identity: (html: string, css: string) => Promise<IdentityVerdict>;
  measure: (html: string, css: string) => Promise<Measurement>;
  /** Share (0–1) of differing pixels between two PC screenshots. */
  pcChange: (before: Uint8Array, after: Uint8Array) => number;
};
export type AutofixInput = { source: "implementation"; html: string; css: string; css_path: string };

export type AttemptRecord = {
  attempt: number;
  cause: Cause;
  variant: number;
  selectors: string[];
  diff: string;
  kept: boolean;
  /** Why it was reverted; null when kept. */
  reverted_because: "NOT_RESOLVED" | "NEW_FINDING" | "PC_CHANGED" | null;
  findings_before: string[];
  findings_after: string[];
  new_findings: string[];
  pc_change: number;
};
export type AutofixStatus = "no_change" | "owner_review" | "stopped";
export type AutofixResult = {
  status: AutofixStatus;
  code: string | null;
  owner_check: boolean;
  events: string[];
  attempts: AttemptRecord[];
  findings_before: string[];
  findings_after: string[];
  /** The original CSS with the kept patches; null unless owner_review. Never written anywhere by this lane. */
  proposed_css: string | null;
  /** Diff from the original CSS to proposed_css; "" unless owner_review. */
  proposed_diff: string;
  applied: false;
  mock: true;
  design_approved: false;
};

const CODE = /^[A-Z][A-Z0-9_]{0,60}$/;
const CHECK_FAILED = new Set(["SP_CHECK_FAILED", "SP_CHECK_SCOPE_CONFLICT"]);
const VERDICTS = new Set<IdentityVerdict>(["PASS_IDENTITY_ONLY", "HOLD", "REJECT"]);

class Stop extends Error {
  constructor(
    readonly code: string,
    readonly event: string,
  ) {
    super(code);
  }
}

/** The measurement, checked and copied once (codes sorted and distinct; the page-width code added from scrollWidth). */
function read(m: unknown): { findings: string[]; targets: Target[]; png: Uint8Array } {
  const o = (m !== null && typeof m === "object" ? m : {}) as Record<string, unknown>;
  const sp = o.sp_findings;
  const width = o.sp_scroll_width;
  const targets = o.targets;
  const png = o.pc_png;
  const blocked = o.blocked;
  if (!Array.isArray(sp) || !Array.isArray(targets) || typeof width !== "number" || !Number.isFinite(width) || !(png instanceof Uint8Array) || typeof blocked !== "number" || !Number.isInteger(blocked) || blocked < 0)
    throw new Stop("PORT_ANSWER_INVALID", "measure:malformed");
  const codes = [...(sp as unknown[])];
  if (!codes.every((c): c is string => typeof c === "string" && CODE.test(c))) throw new Stop("PORT_ANSWER_INVALID", "measure:malformed");
  const list = [...(targets as unknown[])].map((t) => ({ code: (t as Target)?.code, selector: (t as Target)?.selector }));
  if (!list.every((t) => typeof t.code === "string" && CODE.test(t.code) && isSelector(t.selector))) throw new Stop("PORT_ANSWER_INVALID", "measure:malformed");
  if (blocked > 0) throw new Stop("RENDER_BLOCKED_REQUEST", `measure:blocked:${blocked}`);
  if (codes.some((c) => CHECK_FAILED.has(c))) throw new Stop("SP_CHECK_UNAVAILABLE", "measure:check_failed");
  const findings = [...new Set([...codes, ...(width > SP_WIDTH ? [OVERFLOW_CODE] : [])])].sort();
  return { findings, targets: list as Target[], png: Uint8Array.from(png) };
}

const causesIn = (findings: readonly string[]) => [...new Set(findings.map(causeOf).filter((c): c is Cause => c !== null))].sort();

export async function runAutofixMock(input: AutofixInput, ports: AutofixPorts): Promise<AutofixResult> {
  const events: string[] = [];
  const attempts: AttemptRecord[] = [];
  let before: string[] = [];
  let now: string[] = [];
  const end = (status: AutofixStatus, code: string | null, css: string | null): AutofixResult => {
    events.push(`end:${status}${code ? `:${code}` : ""}`);
    const proposed = status === "owner_review" ? css : null;
    return {
      status,
      code,
      owner_check: status === "stopped",
      events,
      attempts,
      findings_before: before,
      findings_after: status === "stopped" ? before : now,
      proposed_css: proposed,
      proposed_diff: proposed === null ? "" : unifiedDiff(input.css_path, input.css, proposed),
      applied: false,
      mock: true,
      design_approved: false,
    };
  };
  // the input is read once; the ports always get these exact strings
  const source: unknown = input?.source;
  const html: unknown = input?.html;
  const original: unknown = input?.css;
  if (source !== "implementation") {
    events.push("input:not_implementation");
    return end("stopped", "NOT_IMPLEMENTATION_CSS", null);
  }
  if (typeof html !== "string" || typeof original !== "string" || typeof input.css_path !== "string" || !/^[A-Za-z0-9._/-]{1,120}$/.test(input.css_path)) {
    events.push("input:malformed");
    return end("stopped", "INPUT_INVALID", null);
  }

  const identity = async (css: string) => {
    const v: unknown = await ports.identity(html, css);
    if (typeof v !== "string" || !VERDICTS.has(v as IdentityVerdict)) throw new Stop("PORT_ANSWER_INVALID", "identity:malformed");
    events.push(`identity:${v}`);
    if (v !== "PASS_IDENTITY_ONLY") throw new Stop(`IDENTITY_${v}`, "identity:stop");
  };
  const measure = async (css: string) => read(await ports.measure(html, css));

  try {
    await identity(original);
    const first = await measure(original);
    before = first.findings;
    now = first.findings;
    events.push(`measure:0:${before.length ? before.join(",") : "none"}`);
    let css = original;
    let current = first;
    const fixes = new Map<Cause, number>();
    const skipped = new Set<Cause>();
    for (;;) {
      // only causes the SP checks name AND the locator could place; the rest stay report-only findings
      const located = causesIn(current.findings).filter((cause) => {
        const ok = current.targets.some((t) => causeOf(t.code) === cause);
        if (!ok && !skipped.has(cause)) {
          skipped.add(cause);
          events.push(`skip:${cause}:not_located`);
        }
        return ok;
      });
      if (!located.length) return attempts.some((a) => a.kept) ? end("owner_review", null, css) : end("no_change", null, null);
      const cause = located[0]!;
      const n = (fixes.get(cause) ?? 0) + 1;
      if (n > AUTOFIX_LIMITS.fixesPerCause) return end("stopped", "SAME_CAUSE_FIX_LIMIT", null);
      if (attempts.length >= AUTOFIX_LIMITS.attempts) return end("stopped", "RETRY_BUDGET_EXHAUSTED", null);
      const patch = candidatePatch(
        cause,
        current.targets.filter((t) => causeOf(t.code) === cause).map((t) => t.selector),
        n,
      );
      if (!patch) return end("stopped", "NO_FURTHER_PATCH", null);
      fixes.set(cause, n);
      const next = applyPatch(css, patch);
      const diff = unifiedDiff(input.css_path, css, next);
      events.push(`patch:${attempts.length + 1}:${cause}:v${n}`);
      await identity(next);
      const after = await measure(next);
      const fresh = after.findings.filter((f) => !current.findings.includes(f) && causeOf(f) !== cause);
      const resolved = !after.findings.some((f) => causeOf(f) === cause);
      const pc = ports.pcChange(first.png, after.png);
      if (typeof pc !== "number" || !Number.isFinite(pc) || pc < 0 || pc > 1) throw new Stop("PORT_ANSWER_INVALID", "pc_change:malformed");
      const why = !resolved ? "NOT_RESOLVED" : fresh.length ? "NEW_FINDING" : pc > PC_CHANGE_MAX ? "PC_CHANGED" : null;
      attempts.push({ attempt: attempts.length + 1, cause, variant: n, selectors: patch.selectors, diff, kept: why === null, reverted_because: why, findings_before: current.findings, findings_after: after.findings, new_findings: fresh, pc_change: pc });
      events.push(`retest:${attempts.length}:${why === null ? "kept" : `reverted:${why}`}`);
      if (why === null) {
        css = next;
        current = after;
        now = after.findings;
      }
    }
  } catch (e) {
    if (e instanceof Stop) {
      events.push(e.event);
      return end("stopped", e.code, null);
    }
    // a port that throws is a stop for the owner, never retried
    events.push("port:threw");
    return end("stopped", "PORT_THREW", null);
  }
}
