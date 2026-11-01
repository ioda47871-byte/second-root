// DEV-147 (Issue #177 E, MOCK ONLY, offline, report-only): the combined report of the integration check. A test helper,
// never lib: nothing in lib, app, components or scripts imports it. It only summarises what the existing phases
// returned (Phase A impl-compare, Phase B SP checks, Phase C structure observation, Phase D limited autofix mock); it
// runs no check of its own, adds no threshold, decides nothing and is never a pass, an adoption or an approval.
// Live runs (run_kind "live") are not built: they need the owner's separate approval (docs/design/integration-check.md).
import { createHash } from "node:crypto";
import type { AutofixResult } from "@/lib/design-agent/autofix-mock/run";
import type { ImplCompareReport } from "@/lib/design-agent/impl-lane/impl-compare";
import type { MobileFindings } from "@/lib/design-agent/phase2f/mobile-quality";

export const REPORT_SCHEMA = "integration_check_report_v0" as const;
export const sha256 = (b: Buffer | Uint8Array | string) => createHash("sha256").update(b).digest("hex");

type Viewport = "desktop_1440" | "mobile_390";
const VIEWPORTS: readonly Viewport[] = ["desktop_1440", "mobile_390"];
export type Identity = "REJECT" | "HOLD" | "PASS_IDENTITY_ONLY";
export type Stop = { code: string; stage: "implementation" | "a_impl_compare" | "b_mobile_quality" | "c_structure" | "d_autofix"; reason: string };
type NotRun = { status: "not_run"; reason: string };

/** Phase A in short: the report's own status and codes, and per width what was compared (hashes, not the PNGs). */
export function summariseCompare(r: ImplCompareReport) {
  return {
    status: "ran" as const,
    report_schema: r.schema,
    compare_status: r.status,
    differences: [...r.differences],
    viewports: Object.fromEntries(
      VIEWPORTS.map((v) => {
        const x = r.viewports[v];
        return [v, { design_state: x.design.state, box_source: x.design.box_source, implementation_state: x.implementation.state, implementation_png_sha256: x.implementation.png_sha256, blocked_requests: x.implementation.blocked_requests, page: x.compare?.page ?? null, differences: [...x.differences] }];
      }),
    ) as Record<Viewport, { design_state: string; box_source: string | null; implementation_state: string; implementation_png_sha256: string | null; blocked_requests: number | null; page: unknown; differences: string[] }>,
    passing: r.passing,
  };
}
export type CompareSummary = ReturnType<typeof summariseCompare>;

/** Phase B in short: the SP 390 checks as recorded (a missing measurement is never read as "no findings"). */
export function summariseMobile(rendered: { desktop_1440: { png: Buffer; blocked: number; scrollWidth: number }; mobile_390: { png: Buffer; blocked: number; scrollWidth: number; mobileQuality?: MobileFindings } }) {
  const q = rendered.mobile_390.mobileQuality;
  if (!q) throw new Error("the SP checks did not run: never read as no findings");
  return {
    status: "ran" as const,
    findings: [...q.findings],
    counts: { ...q.counts },
    examples: (q.examples ?? []).map((e) => `${e.code}:${e.text}`),
    scroll_width: { desktop_1440: rendered.desktop_1440.scrollWidth, mobile_390: rendered.mobile_390.scrollWidth },
    blocked_requests: rendered.desktop_1440.blocked + rendered.mobile_390.blocked,
    png_sha256: { desktop_1440: sha256(rendered.desktop_1440.png), mobile_390: sha256(rendered.mobile_390.png) },
    advisory: q.advisory,
  };
}
export type MobileSummary = ReturnType<typeof summariseMobile>;

/** The parts of the structure observation the summary reads (its type is not imported: see the header). */
type Observed = { id: string };
type ObservationLike = {
  schema: string;
  status: "observed" | "check_failed";
  advisory: true;
  check_failed: { code: string; detail: string } | null;
  viewports: Record<Viewport, { generic_skeleton: string[] | null; too_close_to_success: Observed[]; close_to_rejected: Observed[]; undecided: string[]; undecided_too_thin: string[]; unknown_aspects: string[]; blocked_requests: number }> | null;
};
/**
 * Phase C in short, advisory only. `undecided` is not "not close", and `undecided_too_thin` (DEV-144) is the part of it
 * whose own reference record is too thin to decide against any candidate; both are kept apart from the matches.
 */
export function summariseStructure(o: ObservationLike) {
  return {
    status: "ran" as const,
    report_schema: o.schema,
    observation_status: o.status,
    check_failed: o.check_failed ? { ...o.check_failed } : null,
    advisory: o.advisory,
    viewports: o.viewports
      ? (Object.fromEntries(
          VIEWPORTS.map((v) => {
            const x = o.viewports![v];
            return [v, { generic_skeleton: x.generic_skeleton, too_close_to_success: x.too_close_to_success.map((m) => m.id), close_to_rejected: x.close_to_rejected.map((m) => m.id), undecided: x.undecided.length, undecided_too_thin: x.undecided_too_thin.length, undecided_candidate_side: x.undecided.length - x.undecided_too_thin.length, unknown_aspects: [...x.unknown_aspects], blocked_requests: x.blocked_requests }];
          }),
        ) as Record<Viewport, { generic_skeleton: string[] | null; too_close_to_success: string[]; close_to_rejected: string[]; undecided: number; undecided_too_thin: number; undecided_candidate_side: number; unknown_aspects: string[]; blocked_requests: number }>)
      : null,
  };
}
export type StructureSummary = ReturnType<typeof summariseStructure>;

/** Phase D in short: the mock's own result, with the proposed CSS and diff as hashes (the diff text is kept: it is the owner's to read). */
export function summariseAutofix(r: AutofixResult) {
  return {
    status: "ran" as const,
    autofix_status: r.status,
    code: r.code,
    owner_check: r.owner_check,
    events: [...r.events],
    attempts: r.attempts.map((a) => ({ attempt: a.attempt, cause: a.cause, variant: a.variant, selectors: [...a.selectors], kept: a.kept, reverted_because: a.reverted_because, new_findings: [...a.new_findings], pc_change: a.pc_change, diff_sha256: sha256(a.diff) })),
    findings_before: [...r.findings_before],
    findings_after: [...r.findings_after],
    proposed_css_sha256: r.proposed_css === null ? null : sha256(r.proposed_css),
    proposed_diff: r.proposed_diff,
    applied: r.applied,
    mock: r.mock,
    design_approved: r.design_approved,
  };
}
export type AutofixSummary = ReturnType<typeof summariseAutofix>;

const delta = (before: readonly string[], after: readonly string[]) => ({ added: after.filter((x) => !before.includes(x)), removed: before.filter((x) => !after.includes(x)) });

/**
 * Phase A and B again on the PROPOSED CSS, in memory only (nothing is written or applied): whether the proposal changed
 * what the existing phases report. A record of both sides, never a judgement that the proposal is better.
 */
export function proposalRecheck(o: { compareBefore: CompareSummary; compareAfter: CompareSummary; mobileBefore: MobileSummary; mobileAfter: MobileSummary }) {
  return {
    status: "ran" as const,
    in_memory_only: true as const,
    applied: false as const,
    a_impl_compare: { before: o.compareBefore.differences, after: o.compareAfter.differences, ...delta(o.compareBefore.differences, o.compareAfter.differences), page: Object.fromEntries(VIEWPORTS.map((v) => [v, { before: o.compareBefore.viewports[v].page, after: o.compareAfter.viewports[v].page }])) },
    b_mobile_quality: { before: o.mobileBefore.findings, after: o.mobileAfter.findings, ...delta(o.mobileBefore.findings, o.mobileAfter.findings), counts: { before: o.mobileBefore.counts, after: o.mobileAfter.counts }, scroll_width: { before: o.mobileBefore.scroll_width, after: o.mobileAfter.scroll_width } },
  };
}
export type Recheck = ReturnType<typeof proposalRecheck>;

export type ReportInput = {
  run_kind: string;
  case_id: string;
  shop: { shop_id: string; facts_pack_sha256: string; identity_lock_sha256: string };
  design: { artifact_id: string; verification_state: string; implementation_handoff_allowed: boolean; artifact_json_sha256: string; lane_json_sha256: string; design_calls: number; mock_note: string };
  implementation: { html_sha256: string; css_sha256: string; note: string };
  identity: { status: Identity; desktop_1440: Identity; mobile_390: Identity };
  phases: {
    a_impl_compare: CompareSummary | NotRun;
    b_mobile_quality: MobileSummary | NotRun;
    c_structure: StructureSummary | NotRun;
    d_autofix: AutofixSummary | NotRun;
    d_proposal_recheck: Recheck | NotRun;
  };
  stops: Stop[];
};

const NOTES = [
  "MOCK: fictional shop, hand-written fixtures, fake design port; no Codex, image generation, network, paid API or WSL.",
  "Report-only: no gate, no pass/fail, no adoption, no approval. The owner decides.",
  "Each phase's thresholds stay what they are (DEV-131 provisional, DEV-134/140 SP checks with known false positives, descriptor.ts provisional); none was added.",
  "Phase C is advisory: undecided is not 'not close'; undecided_too_thin counts references too thin to decide (DEV-144).",
  "Phase D only proposes CSS (owner_review); nothing is applied. The recheck renders the proposal in memory only.",
];

/**
 * Puts the phases into one report. It refuses what the report must never say: a run_kind other than "mock" (a live
 * run is a separate approval), a phase that claims a pass or an applied fix, or a phase after an identity stop.
 */
export function buildReport(i: ReportInput) {
  if (i.run_kind !== "mock") throw new Error(`run_kind ${JSON.stringify(i.run_kind)}: only "mock" exists; a live run needs the owner's separate approval`);
  const p = i.phases;
  if (p.a_impl_compare.status === "ran" && p.a_impl_compare.passing !== false) throw new Error("Phase A must never pass");
  const d = p.d_autofix;
  if (d.status === "ran" && (d.applied !== false || d.design_approved !== false || d.mock !== true)) throw new Error("Phase D must never apply or approve");
  if (p.d_proposal_recheck.status === "ran" && (d.status !== "ran" || d.autofix_status !== "owner_review")) throw new Error("a recheck exists only for an owner_review proposal");
  if (i.identity.status !== "PASS_IDENTITY_ONLY") {
    if (Object.values(p).some((x) => x.status !== "not_run")) throw new Error("an identity stop ends the chain: no phase may run after it");
    if (!i.stops.some((s) => s.code === `IDENTITY_${i.identity.status}` && s.stage === "implementation")) throw new Error("an identity stop must be recorded");
  }
  return {
    schema: REPORT_SCHEMA,
    run_kind: "mock" as const,
    scope: "offline_report_only" as const,
    advisory: true as const,
    passing: false as const,
    design_approved: false as const,
    applied: false as const,
    case_id: i.case_id,
    shop: { ...i.shop },
    design: { ...i.design },
    implementation: { ...i.implementation },
    identity: { ...i.identity },
    phases: p,
    stops: i.stops.map((s) => ({ ...s })),
    notes: NOTES,
  };
}
export type IntegrationReport = ReturnType<typeof buildReport>;
