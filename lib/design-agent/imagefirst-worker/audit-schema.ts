/**
 * Issue #302: the strict shapes of the IMAGE_FIRST Claude CLI audit — the model's answer for one viewport, its coherence
 * checks, the advisory verdict computed in code, and the private record claude-audit.ts writes. Pure (zod only).
 *
 * The record is advisory and nothing else: it carries `advisory_only: true`, `human_confirmed: false`,
 * `registers_success_case: false` and `not_owner_evaluation: true` as literals (the schema refuses any other value).
 * Only the owner adopts, revises or rejects a design, confirms a rubric sheet or registers a success case.
 */
import { z } from "zod";
import { GENERIC } from "../structure/descriptor";
import { AUDIT_THRESHOLDS, CHECK_IDS, CRITERION_IDS, HARD_FAIL_IDS, STRUCTURE_WORDS, VIEWPORT_IDS, type AuditViewport, type CheckId, type CriterionId, type HardFailId, type SentImage } from "./audit-rubric";

export const AUDIT_SCHEMA = "imagefirst_claude_audit_v1";
const Line = (max: number) => z.string().trim().min(1).max(max);
const Viewport = z.enum(VIEWPORT_IDS as [AuditViewport, ...AuditViewport[]]);
const keyed = <K extends string, T extends z.ZodType>(ids: readonly K[], t: T) => z.strictObject(Object.fromEntries(ids.map((k) => [k, t])) as Record<K, T>);

export const Loc = z.strictObject({ image: z.string().min(1).max(200), area: Line(160), y0: z.number().int().min(0).nullable(), y1: z.number().int().min(1).nullable() });
export type Loc = z.infer<typeof Loc>;
const Scored = z.strictObject({ score: z.number().int().min(1).max(5), reason: Line(300) });
const HardFail = z.strictObject({ hit: z.boolean(), where: Loc.nullable(), note: z.string().max(300) });
const TARGETS = [...CRITERION_IDS, ...CHECK_IDS, ...HARD_FAIL_IDS] as [string, ...string[]];
export const Finding = z.strictObject({ target: z.enum(TARGETS), severity: z.enum(["major", "minor"]), where: Loc, problem: Line(400), suggestion: Line(300), protect: Line(200) });

/** The model's answer for one viewport (strict: no extra key, no verdict field). */
export const ViewportAnswer = z.strictObject({
  viewport: Viewport,
  hard_fails: keyed(HARD_FAIL_IDS, HardFail),
  scores: keyed(CRITERION_IDS, Scored),
  checks: keyed(CHECK_IDS, Scored),
  structure_seen: z.strictObject({
    hero: z.enum(STRUCTURE_WORDS.hero),
    flow: z.enum(STRUCTURE_WORDS.flow),
    section_layouts: z.array(z.enum(STRUCTURE_WORDS.section_layout)).min(1).max(12),
  }),
  findings: z.array(Finding).max(20),
});
export type ViewportAnswer = z.infer<typeof ViewportAnswer>;

/** Why an answer that parsed is still unusable (fixed codes; the answer is never quoted). */
export type IncoherentCode = "WRONG_VIEWPORT" | "LOW_SCORE_WITHOUT_FINDING" | "HARD_FAIL_WITHOUT_PLACE" | "UNKNOWN_IMAGE_LABEL" | "ROWS_OUT_OF_RANGE";

/** Coherence of a parsed answer with what was sent; null = usable. */
export function incoherence(a: ViewportAnswer, viewport: AuditViewport, sent: readonly SentImage[]): IncoherentCode | null {
  if (a.viewport !== viewport) return "WRONG_VIEWPORT";
  const byLabel = new Map(sent.map((s) => [s.label, s]));
  const places: Loc[] = [...a.findings.map((f) => f.where), ...HARD_FAIL_IDS.flatMap((k) => (a.hard_fails[k].where ? [a.hard_fails[k].where!] : []))];
  for (const p of places) {
    const s = byLabel.get(p.image);
    if (!s) return "UNKNOWN_IMAGE_LABEL";
    if ((p.y0 !== null && (p.y0 < s.y0 || p.y0 >= s.y1)) || (p.y1 !== null && (p.y1 <= s.y0 || p.y1 > s.y1)) || (p.y0 !== null && p.y1 !== null && p.y1 <= p.y0)) return "ROWS_OUT_OF_RANGE";
  }
  const targeted = new Set(a.findings.map((f) => f.target));
  for (const k of CRITERION_IDS) if (a.scores[k].score <= 3 && !targeted.has(k)) return "LOW_SCORE_WITHOUT_FINDING";
  for (const k of CHECK_IDS) if (a.checks[k].score <= 3 && !targeted.has(k)) return "LOW_SCORE_WITHOUT_FINDING";
  for (const k of HARD_FAIL_IDS) if (a.hard_fails[k].hit && !a.hard_fails[k].where) return "HARD_FAIL_WITHOUT_PLACE";
  return null;
}

export const VERDICTS = ["show_owner", "revise", "drop"] as const;
export type Verdict = (typeof VERDICTS)[number];
export const Derived = z.strictObject({
  total: z.number().int().min(5).max(25),
  lowest: z.number().int().min(1).max(5),
  low_criteria: z.array(z.enum(CRITERION_IDS as [CriterionId, ...CriterionId[]])),
  low_checks: z.array(z.enum(CHECK_IDS as [CheckId, ...CheckId[]])),
  hard_fail_hits: z.array(z.enum(HARD_FAIL_IDS as [HardFailId, ...HardFailId[]])),
  generic_patterns_seen: z.array(z.string().max(40)),
  verdict: z.enum(VERDICTS),
});
export type Derived = z.infer<typeof Derived>;

/**
 * The advisory verdict of one viewport, computed here (never read from the model): any hard fail → "drop"; else a total
 * of at least 22/25 with every criterion at least 4 and every Issue #302 check at least 4 → "show_owner"; else "revise".
 */
export function deriveViewport(a: ViewportAnswer): Derived {
  const scores = CRITERION_IDS.map((k) => a.scores[k].score);
  const total = scores.reduce((n, s) => n + s, 0);
  const low_criteria = CRITERION_IDS.filter((k) => a.scores[k].score < AUDIT_THRESHOLDS.minCriterion);
  const low_checks = CHECK_IDS.filter((k) => a.checks[k].score < AUDIT_THRESHOLDS.minCheck);
  const hard_fail_hits = HARD_FAIL_IDS.filter((k) => a.hard_fails[k].hit);
  const s = a.structure_seen;
  const generic_patterns_seen = [
    ...(GENERIC.hero.has(s.hero) ? [`hero:${s.hero}`] : []),
    ...(GENERIC.flow.has(s.flow) ? [`flow:${s.flow}`] : []),
    ...[...new Set(s.section_layouts)].filter((l) => GENERIC.section_layout.has(l)).map((l) => `section_layout:${l}`),
  ];
  const verdict: Verdict = hard_fail_hits.length > 0 ? "drop" : total >= AUDIT_THRESHOLDS.passTotal && low_criteria.length === 0 && low_checks.length === 0 ? "show_owner" : "revise";
  return { total, lowest: Math.min(...scores), low_criteria, low_checks, hard_fail_hits, generic_patterns_seen, verdict };
}

/** The whole audit's advisory verdict: the worst of the two viewports. */
export const overallVerdict = (vs: readonly Verdict[]): Verdict => (vs.includes("drop") ? "drop" : vs.includes("revise") ? "revise" : "show_owner");

const Sha = z.string().regex(/^[0-9a-f]{64}$/);
const Iso = z.string().datetime();
const Code = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/);
export const AuditImage = z.strictObject({
  viewport: Viewport,
  label: z.string().min(1).max(200),
  preview_file: z.string().regex(/^[a-z0-9.-]{1,80}\.png$/),
  /** The verified preview (PNG, INDEX.json's SHA) and the audit-tier bytes derived from it, which were sent. */
  preview_sha256: Sha,
  preview_bytes: z.number().int().min(1),
  audit_sha256: Sha,
  audit_bytes: z.number().int().min(1),
  media_type: z.enum(["image/jpeg", "image/png"]),
  /** false = some pixel of the preview is not fully opaque (filled white in the audit tier). */
  opaque: z.boolean(),
  kind: z.enum(["full", "tile", "overview"]),
  source: z.string().regex(/^(parts|composites)\/[a-z0-9-]{1,40}\.png$/),
  source_sha256: Sha,
  y0: z.number().int().min(0),
  y1: z.number().int().min(1),
});
const PerViewport = <T extends z.ZodType>(t: T) => z.strictObject({ desktop_1440: t, mobile_390: t });

/** The private record (<inbox>/audits/<approval id>/audit.json). Every binding value is computed by the worker. */
export const AuditRecord = z.strictObject({
  schema: z.literal(AUDIT_SCHEMA),
  status: z.enum(["completed", "stopped"]),
  stop_code: Code.nullable(),
  binding: z.strictObject({
    approval_id: z.string().min(1).max(80),
    bundle_id: z.string().min(1).max(80),
    bundle_sha256: Sha,
    plan_id: z.string().min(1).max(80),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    previews_index_sha256: Sha,
    rubric_version: z.string().min(1).max(40),
    rubric_sha256: Sha,
    audit_tier: z.string().regex(/^[a-z0-9-]{1,40}$/),
    request_sha256: PerViewport(Sha.nullable()),
    images: z.array(AuditImage).min(1).max(40),
  }),
  auditor: z.strictObject({
    via: z.literal("claude_cli_print_no_tools"),
    cli_version: z.string().max(40).nullable(),
    model_reported: z.string().max(80).nullable(),
    started_at: Iso,
    finished_at: Iso,
    calls: z.number().int().min(0).max(3),
    reasks: z.number().int().min(0).max(1),
  }),
  viewports: PerViewport(ViewportAnswer.nullable()),
  derived: z.strictObject({ desktop_1440: Derived.nullable(), mobile_390: Derived.nullable(), verdict: z.enum(VERDICTS).nullable() }),
  advisory_only: z.literal(true),
  human_confirmed: z.literal(false),
  registers_success_case: z.literal(false),
  not_owner_evaluation: z.literal(true),
}).superRefine((r, ctx) => {
  const done = r.viewports.desktop_1440 !== null && r.viewports.mobile_390 !== null && r.derived.verdict !== null;
  if (r.status === "completed" ? r.stop_code !== null || !done : r.stop_code === null || r.derived.verdict !== null) ctx.addIssue({ code: "custom", message: "status" });
});
export type AuditRecord = z.infer<typeof AuditRecord>;
