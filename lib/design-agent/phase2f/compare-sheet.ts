/**
 * Phase 2f-1: the comparison sheet for routes A, B and C on the same fictional
 * shop. A technical pass is not a design success: every score, the "not
 * generic" judgement and the adoption are the owner's, filled in by hand (they
 * start null), and the verdict below only applies the owner's existing policy.
 *
 * Criteria: the five of the design-image rubric (docs/operations/design-image-eval-template.md:
 * beauty, fit with the shop, originality, structure as a website, implementability; 1–5 each)
 * plus PC/SP completeness (1–5). Pass = no hard fail, rubric total ≥ 22/25, every rubric
 * criterion ≥ 4, PC/SP completeness ≥ 4, the owner says it is not generic, and the owner
 * confirmed the scores. Route A is a concept image: it is judged as a concept, never as an
 * implementation-ready page.
 *
 * Every stop and warning of a run is listed with `stop_was_correct: null`, so the owner can
 * mark unnecessary stops (false positives) and the rate can be measured.
 */
import type { IntakeRecord } from "../artifact/intake";
import type { RunResult } from "./runner";

/** The owner's policy (same numbers as comp-impl's evaluationVerdict; a test keeps them equal). */
export const PASS_TOTAL = 22;
export const MIN_CRITERION = 4;
export const RUBRIC = ["beauty", "shop_fit", "originality", "web_structure", "implementability"] as const;

type Scores = Record<(typeof RUBRIC)[number], number | null>;
export type SheetEntry = {
  route: "A_image" | "B_html_prototype" | "C_hybrid";
  delivered_route: string | null;
  kind: "concept_image" | "browser_render";
  verification_state: IntakeRecord["verification_state"] | "stopped";
  images: { desktop_1440: string | null; mobile_390: string | null };
  hard_fails: string[] | null;
  scores: Scores;
  pc_sp_completeness: number | null;
  owner: { not_generic: boolean | null; adopt: boolean | null; confirmed: boolean; notes: string };
  stops_and_warnings: { code: string; source: "run" | "intake_warning" | "intake_reason"; stop_was_correct: boolean | null }[];
};

export function sheetEntry(route: SheetEntry["route"], result: RunResult): SheetEntry {
  const done = result.status === "done" ? result : null;
  const list: SheetEntry["stops_and_warnings"] = [];
  if (result.status === "stopped") list.push({ code: result.code, source: "run", stop_was_correct: null });
  for (const s of result.log.stops) list.push({ code: s.code, source: "run", stop_was_correct: null });
  if (done) {
    for (const w of done.record.warnings) list.push({ code: w, source: "intake_warning", stop_was_correct: null });
    for (const r of done.record.reasons) list.push({ code: r, source: "intake_reason", stop_was_correct: null });
  }
  const original = (k: "desktop_1440" | "mobile_390") => done?.record.files.find((f) => f.role === "original" && f.path.includes(k === "desktop_1440" ? "desktop" : "mobile"))?.path ?? null;
  return {
    route,
    delivered_route: done ? done.record.route : null,
    kind: route === "A_image" ? "concept_image" : "browser_render",
    verification_state: done ? done.record.verification_state : "stopped",
    images: { desktop_1440: original("desktop_1440"), mobile_390: original("mobile_390") },
    hard_fails: null,
    scores: { beauty: null, shop_fit: null, originality: null, web_structure: null, implementability: null },
    pc_sp_completeness: null,
    owner: { not_generic: null, adopt: null, confirmed: false, notes: "" },
    stops_and_warnings: list,
  };
}

export type SheetVerdict = "pending" | "pass" | "fail" | "concept_pass" | "concept_fail";

/** Applies the owner's policy to a filled-in entry. Anything not filled in is pending, never a pass. */
export function sheetVerdict(e: SheetEntry): SheetVerdict {
  const scores = RUBRIC.map((k) => e.scores[k]);
  if (!e.owner.confirmed || e.hard_fails === null || scores.some((s) => s === null) || e.owner.not_generic === null) return "pending";
  const total = (scores as number[]).reduce((a, b) => a + b, 0);
  const rubricOk = e.hard_fails.length === 0 && total >= PASS_TOTAL && (scores as number[]).every((s) => s >= MIN_CRITERION) && e.owner.not_generic === true;
  // a concept image is judged as a concept: it never passes as an implementation-ready page
  if (e.kind === "concept_image") return rubricOk ? "concept_pass" : "concept_fail";
  if (e.pc_sp_completeness === null) return "pending";
  // a browser render that is technically complete is still not a success unless the design itself passes
  return rubricOk && e.pc_sp_completeness >= MIN_CRITERION && e.verification_state === "render_pair_complete" ? "pass" : "fail";
}

/** Share of stops / warnings the owner marked unnecessary, over those already judged. */
export function unnecessaryStopRate(entries: readonly SheetEntry[]): { judged: number; unnecessary: number; rate: number | null } {
  const judged = entries.flatMap((e) => e.stops_and_warnings).filter((s) => s.stop_was_correct !== null);
  const unnecessary = judged.filter((s) => s.stop_was_correct === false).length;
  return { judged: judged.length, unnecessary, rate: judged.length ? unnecessary / judged.length : null };
}
