/**
 * DEV-138 (Issue #175): the structure observation of a Phase 2f prototype, REPORT-ONLY and OFFLINE.
 *
 * After a design was rendered and packaged, its prototype is drawn again here (JS off, closed origin: measure.ts) at
 * PC 1440 and SP 390, described from the geometry alone, and compared with the declared reference set (success
 * cases and rejected versions, references.ts).
 *
 * What it never does:
 * - feed anything back: the reference set never reaches a prompt or a design port; this module is not imported by the
 *   Phase 2f runner, the prompt builders or any generator (the structure module's isolation test)
 * - guess: the candidate's aspects are MEASURED only. Hero and flow come only from what geometry can tell (the generic
 *   signs); nothing is declared for the candidate, nothing is inferred from a picture or a text. A reference that cannot
 *   be compared (too few aspects known on both sides) is `undecided`, never "not close"
 * - decide: no gate, no retry, no threshold of its own (it reuses the provisional thresholds of descriptor.ts). A
 *   failure is recorded as `check_failed`, never as a clean result
 *
 * The vocabulary, the thresholds and the reference labels are PROVISIONAL (Issue #159).
 */
import type { Browser } from "playwright";
import { ASPECTS, structureFindings, type StructureDescriptor } from "./descriptor";
import { describe, MeasureRefused, measurePage, VIEWPORTS } from "./measure";
import { compareWithReferences, type ReferenceDescriptors, type ReferenceMatch } from "./references";

export type ViewportObservation = {
  /** The aspects geometry could tell, all `measured`; the others are listed in `unknown_aspects`. */
  measured: Partial<Record<(typeof ASPECTS)[number], unknown>>;
  unknown_aspects: string[];
  /** The generic landing-page signs that add up to GENERIC_SKELETON (two or more), else null. */
  generic_skeleton: string[] | null;
  too_close_to_success: ReferenceMatch[];
  close_to_rejected: ReferenceMatch[];
  /** References too sparse to compare with this candidate (not "not close"). */
  undecided: string[];
  /** DEV-144: those of `undecided` whose own record can never be decided, whatever the candidate (a thin record). */
  undecided_too_thin: string[];
  /** Requests the page tried outside its own files (refused; a packaged prototype should make none). */
  blocked_requests: number;
};

export type StructureObservation = {
  schema: "structure_observation_v0";
  vocabulary: "structure_descriptor_v0";
  scope: "offline_report_only";
  advisory: true;
  status: "observed" | "check_failed";
  /** Why the check could not run (a fixed code and the first line of the cause, at most 160 characters). */
  check_failed: { code: "MEASURE_PAGE_REFUSED" | "MEASURE_FAILED" | "BROWSER_LAUNCH_FAILED"; detail: string } | null;
  viewports: { desktop_1440: ViewportObservation; mobile_390: ViewportObservation } | null;
  notes: string[];
};

const NOTES = [
  "Advisory only: no gate, no stop, no approval. The owner decides.",
  "Vocabulary, thresholds and reference labels are provisional (Issue #159).",
  "The candidate is measured only; hero and flow are known only when geometry shows a generic sign.",
  "The references are declared from research records, not measured; most originals are not in the repository.",
  "An undecided reference is not a negative finding.",
  "undecided_too_thin: references whose own record is too thin to be decided against any candidate (DEV-144).",
];

export const firstLine = (e: unknown) =>
  (e instanceof Error ? e.message : String(e))
    .split("\n")[0]!
    .replace(/(?:\/[^\s/:]+)+\/?/g, "<path>")
    .replace(/[^\x20-\x7e]/g, "?")
    .slice(0, 160) || "unknown";

/** Keeps only measured aspects: a candidate never carries a declaration into the comparison. */
function measuredOnly(d: StructureDescriptor): StructureDescriptor {
  const out = { ...d } as Record<string, unknown>;
  for (const k of ASPECTS) {
    const v = d[k] as { source: string } | null;
    if (v && v.source !== "measured") out[k] = null;
  }
  return out as StructureDescriptor;
}

function observeOne(d: StructureDescriptor, set: ReferenceDescriptors, blocked: number): ViewportObservation {
  const m = measuredOnly(d);
  const r = compareWithReferences(m, set);
  const generic = structureFindings(m).find((f) => f.code === "GENERIC_SKELETON");
  return {
    measured: Object.fromEntries(ASPECTS.filter((k) => m[k] !== null).map((k) => [k, (m[k] as { value: unknown }).value])),
    unknown_aspects: ASPECTS.filter((k) => m[k] === null),
    generic_skeleton: generic && generic.code === "GENERIC_SKELETON" ? generic.reasons : null,
    too_close_to_success: r.too_close_to_success,
    close_to_rejected: r.close_to_rejected,
    undecided: r.undecided,
    undecided_too_thin: r.too_thin,
    blocked_requests: blocked,
  };
}

const BASE = { schema: "structure_observation_v0", vocabulary: "structure_descriptor_v0", scope: "offline_report_only", advisory: true, notes: NOTES } as const;

/** A check that could not run (e.g. the browser did not start): recorded as such, never as a clean result. */
export function failedObservation(code: NonNullable<StructureObservation["check_failed"]>["code"], cause: unknown): StructureObservation {
  return { ...BASE, status: "check_failed", check_failed: { code, detail: firstLine(cause) }, viewports: null };
}

/**
 * Observes one prototype at both widths. Never throws for a page that cannot be measured: the result is then
 * `check_failed` with its reason (a closed browser, a refused page, a timeout).
 */
export async function observeStructure(browser: Browser, page: { html: string; css: string; assets?: Record<string, Buffer> }, set: ReferenceDescriptors): Promise<StructureObservation> {
  try {
    const pc = await measurePage(browser, page, VIEWPORTS.desktop);
    const sp = await measurePage(browser, page, VIEWPORTS.mobile);
    return {
      ...BASE,
      status: "observed",
      check_failed: null,
      viewports: { desktop_1440: observeOne(describe(pc), set, pc.blocked), mobile_390: observeOne(describe(sp), set, sp.blocked) },
    };
  } catch (e) {
    return failedObservation(e instanceof MeasureRefused ? "MEASURE_PAGE_REFUSED" : "MEASURE_FAILED", e);
  }
}
