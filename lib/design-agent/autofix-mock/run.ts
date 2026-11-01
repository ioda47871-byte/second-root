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
 * - One cause per attempt, in a fixed order; a patch is kept only when the SP checks no longer name its cause, nothing
 *   got worse, nothing was blocked and the PC 1440 render did not change beyond PC_CHANGE_MAX. Otherwise it is
 *   reverted (the CSS before it is kept) and recorded. "Nothing got worse" is checked per instance, not per code: no
 *   (code, text) pair that was not there before, no rise in the text nodes with problems, and (for a cause other than
 *   the tap targets) no rise in the small tap targets. A code already on the page (a known false positive, an
 *   out-of-scope finding) therefore never hides a new instance of it, and the pairs are counted, so a text that
 *   appears twice cannot hide a new problem on one of them. Only a true swap stays unseen: one node resolves while
 *   another with the same text prefix breaks under the same code. When the check's examples may be cut off (its
 *   cap of 10), the instances cannot all be compared and the run stops for the owner.
 * - At most AUTOFIX_LIMITS.attempts patches tried and AUTOFIX_LIMITS.fixesPerCause per cause (the same limits as the
 *   mock run controller of DEV-129, pinned by the tests). Past either, or with no further variant, the run stops for
 *   the owner and keeps the original CSS.
 * - A run that resolves what it could ends at `owner_review` with a PROPOSED CSS: it is never applied, never a pass and
 *   never a design approval.
 */
import { applyPatch, candidatePatch, causeOf, OVERFLOW_CODE, SP_WIDTH, isSelector, unifiedDiff, type Cause } from "./patches";

/** 3 patches tried per run, at most 2 for one cause (as DEV-129's LIMITS: implementationAttempts 3, fixesPerCause 2). */
export const AUTOFIX_LIMITS = { attempts: 3, fixesPerCause: 2 } as const;
/**
 * MOCK PARAMETER, not an adopted threshold: the largest share of differing PC 1440 pixels a kept patch may cause (its
 * media query should make it 0). Any real use needs the owner's decision (docs/design/limited-autofix.md §6).
 */
export const PC_CHANGE_MAX = 0.001;
/** The SP check keeps at most this many examples (MobileFindings.examples); a list this long may be cut off. */
export const INSTANCE_CAP = 10;

export type IdentityVerdict = "PASS_IDENTITY_ONLY" | "HOLD" | "REJECT";
export type Target = { code: string; selector: string };
/** One finding on one text: the SP check's example (code, the first 40 characters of the text). */
export type Instance = { code: string; text: string };
export type Measurement = {
  /** The SP 390 checks' codes (DEV-134), as recorded. */
  sp_findings: readonly string[];
  /** The SP 390 document's scrollWidth. */
  sp_scroll_width: number;
  /** The SP check's examples (MobileFindings.examples), one per finding and text. */
  instances: readonly Instance[];
  /** The SP check's counts (MobileFindings.counts). */
  counts: { text_nodes_with_problems: number; tap_targets_below_recommended: number; tap_targets_below_minimum: number };
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
  /** What got worse: new codes, new (code, text) instances as "CODE:text", and risen counts as "COUNT:name". */
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
type Read = { findings: string[]; instances: string[]; counts: { text: number; tapRec: number; tapMin: number }; targets: Target[]; png: Uint8Array };
const count = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0;
function read(m: unknown): Read {
  const o = (m !== null && typeof m === "object" ? m : {}) as Record<string, unknown>;
  const sp = o.sp_findings;
  const width = o.sp_scroll_width;
  const targets = o.targets;
  const png = o.pc_png;
  const blocked = o.blocked;
  const inst = o.instances;
  const c = (o.counts !== null && typeof o.counts === "object" ? o.counts : {}) as Record<string, unknown>;
  if (!Array.isArray(inst) || !count(c.text_nodes_with_problems) || !count(c.tap_targets_below_recommended) || !count(c.tap_targets_below_minimum)) throw new Stop("PORT_ANSWER_INVALID", "measure:malformed");
  const instances = [...(inst as unknown[])].map((i) => ({ code: (i as Instance)?.code, text: (i as Instance)?.text }));
  if (!instances.every((i) => typeof i.code === "string" && CODE.test(i.code) && typeof i.text === "string" && i.text.length <= 200)) throw new Stop("PORT_ANSWER_INVALID", "measure:malformed");
  if (!Array.isArray(sp) || !Array.isArray(targets) || typeof width !== "number" || !Number.isFinite(width) || !(png instanceof Uint8Array) || typeof blocked !== "number" || !Number.isInteger(blocked) || blocked < 0)
    throw new Stop("PORT_ANSWER_INVALID", "measure:malformed");
  const codes = [...(sp as unknown[])];
  if (!codes.every((c): c is string => typeof c === "string" && CODE.test(c))) throw new Stop("PORT_ANSWER_INVALID", "measure:malformed");
  const list = [...(targets as unknown[])].map((t) => ({ code: (t as Target)?.code, selector: (t as Target)?.selector }));
  if (!list.every((t) => typeof t.code === "string" && CODE.test(t.code) && isSelector(t.selector))) throw new Stop("PORT_ANSWER_INVALID", "measure:malformed");
  if (blocked > 0) throw new Stop("RENDER_BLOCKED_REQUEST", `measure:blocked:${blocked}`);
  if (codes.some((c) => CHECK_FAILED.has(c))) throw new Stop("SP_CHECK_UNAVAILABLE", "measure:check_failed");
  // a list at the cap may be cut off: the instances could not all be compared
  if (instances.length >= INSTANCE_CAP) throw new Stop("INSTANCES_TRUNCATED", "measure:instances_truncated");
  const findings = [...new Set([...codes, ...(width > SP_WIDTH ? [OVERFLOW_CODE] : [])])].sort();
  return {
    findings,
    // a multiset: the check keeps one example per (node, code), so the same text on two nodes is two entries
    instances: instances.map((i) => `${i.code}:${i.text}`).sort(),
    counts: { text: c.text_nodes_with_problems as number, tapRec: c.tap_targets_below_recommended as number, tapMin: c.tap_targets_below_minimum as number },
    targets: list as Target[],
    png: Uint8Array.from(png),
  };
}

/** What got worse between the two measurements, by code, by instance and by count (see the header). */
function worse(a: Read, b: Read, cause: Cause): string[] {
  const codes = b.findings.filter((f) => !a.findings.includes(f) && causeOf(f) !== cause);
  // per (code, text), any rise in how many there are (a repeated text cannot hide a new one)
  const tally = (l: readonly string[]) => l.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>());
  const was = tally(a.instances);
  const instances = [...tally(b.instances)].filter(([k, n]) => n > (was.get(k) ?? 0)).map(([k]) => k);
  const counts = [
    ...(b.counts.text > a.counts.text ? ["COUNT:text_nodes_with_problems"] : []),
    ...(cause !== "TAP_TARGET" && b.counts.tapRec > a.counts.tapRec ? ["COUNT:tap_targets_below_recommended"] : []),
    ...(cause !== "TAP_TARGET" && b.counts.tapMin > a.counts.tapMin ? ["COUNT:tap_targets_below_minimum"] : []),
  ];
  return [...codes, ...instances, ...counts];
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
      proposed_diff: proposed === null || typeof original !== "string" || typeof path !== "string" ? "" : unifiedDiff(path, original, proposed),
      applied: false,
      mock: true,
      design_approved: false,
    };
  };
  // the input is read once; the ports always get these exact strings
  const source: unknown = input?.source;
  const html: unknown = input?.html;
  const original: unknown = input?.css;
  const path: unknown = input?.css_path;
  if (source !== "implementation") {
    events.push("input:not_implementation");
    return end("stopped", "NOT_IMPLEMENTATION_CSS", null);
  }
  if (typeof html !== "string" || typeof original !== "string" || typeof path !== "string" || !/^[A-Za-z0-9._/-]{1,120}$/.test(path)) {
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
      const diff = unifiedDiff(path, css, next);
      events.push(`patch:${attempts.length + 1}:${cause}:v${n}`);
      await identity(next);
      const after = await measure(next);
      const fresh = worse(current, after, cause);
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
