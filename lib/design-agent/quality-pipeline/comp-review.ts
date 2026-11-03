/**
 * DEV-159 (Issue #193 comment 6591440695): Claude's own review of a comp's PC and SP renders, tied to the
 * references it learned from.
 *
 * The review says which parts of each render Claude looked at, what it saw (located), which structural principle
 * from which VISUAL_VERIFIED reference read was applied and where in the comp, what each self-critique round
 * protected and changed (at most 2 rounds, one cause each, as the design-director skill says), what is still wrong,
 * and a verdict: show it to the owner, revise, or drop. A verdict is never a quality claim; the owner decides that.
 *
 * Pure: zod and the coverage measure. The caller supplies the renders' SHA and size and the reference reads.
 */
import { z } from "zod";
import { coverage, READ_THRESHOLDS } from "../reference-originals/visual-read";

const Line = (max: number) => z.string().trim().min(1).max(max);
const Box = z.strictObject({ x: z.number().int().min(0), y: z.number().int().min(0), w: z.number().int().min(1), h: z.number().int().min(1) });
const Seen = z.strictObject({ what: Line(300), box: Box });
const Render = (width: number, minHeight: number) => z.strictObject({ sha256: z.string().regex(/^[0-9a-f]{64}$/), width: z.literal(width), height: z.number().int().min(minHeight).max(16000) });
const VIEWS = ["desktop", "mobile"] as const;

export const CompReview = z.strictObject({
  schema: z.literal("comp_review_v1"),
  shop_id: z.string().min(1).max(80),
  direction_id: z.string().min(1).max(60),
  comp: z.strictObject({ html_sha256: z.string().regex(/^[0-9a-f]{64}$/), css_sha256: z.string().regex(/^[0-9a-f]{64}$/), copy_sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
  /** The renders the review is of (B-route, JS off, network shut). Fonts make the bytes machine-dependent. */
  renders: z.strictObject({ desktop: Render(1440, 900), mobile: Render(390, 844) }),
  reader: z.strictObject({ who: z.literal("claude"), session: z.string().url(), viewed_at: z.string().datetime({ offset: true }), how: Line(300) }),
  viewed_crops: z.strictObject({ desktop: z.array(Box).min(1).max(40), mobile: z.array(Box).min(1).max(40) }),
  observations: z.strictObject({ desktop: z.array(Seen).min(6).max(30), mobile: z.array(Seen).min(4).max(30) }),
  /** Principles learned from Claude's own reads of success cases, and where this comp applies each. */
  references: z
    .array(z.strictObject({ read: z.string().regex(/^design-library\/research\/quality-pipeline\/visual-reads\/CP-\d{3}\/(concept|desktop|mobile)\.read\.json$/), learn: Line(300), applied_at: z.strictObject({ view: z.enum(VIEWS), box: Box }) }))
    .min(1)
    .max(12),
  rounds: z
    .array(
      z.strictObject({
        n: z.number().int().min(1).max(2),
        cause: Line(300),
        protect: z.array(Line(200)).min(1).max(5),
        changed: z.array(Line(300)).min(1).max(12),
        /** Regressions the round itself introduced, fixed within the round (not a new cause). */
        regressions_fixed: z.array(Line(300)).max(6),
      }),
    )
    .max(2),
  remaining: z.array(Line(300)).max(12),
  failure_codes: z.array(z.string().regex(/^[A-Z_]+$/)).max(10),
  verdict: z.enum(["show_owner", "revise", "drop"]),
});
export type CompReview = z.infer<typeof CompReview>;

export type ReviewInputs = {
  /** The renders as found now (null: not rendered here, e.g. CI without the same fonts). */
  renders: { desktop: { sha256: string; width: number; height: number }; mobile: { sha256: string; width: number; height: number } } | null;
  /** read path -> its `learn` lines, for reads that are VISUAL_VERIFIED (passing and tied to in-repo bytes). */
  verifiedReads: Readonly<Record<string, readonly string[]>>;
  failureCodes: readonly string[];
  comp: { html_sha256: string; css_sha256: string; copy_sha256: string };
};

export function checkCompReview(raw: unknown, o: ReviewInputs): { ok: boolean; codes: string[] } {
  const p = CompReview.safeParse(raw);
  if (!p.success) return { ok: false, codes: ["REVIEW_SCHEMA"] };
  const r = p.data;
  const codes: string[] = [];
  if (r.comp.html_sha256 !== o.comp.html_sha256 || r.comp.css_sha256 !== o.comp.css_sha256 || r.comp.copy_sha256 !== o.comp.copy_sha256) codes.push("REVIEW_OF_ANOTHER_COMP");
  if (o.renders)
    for (const v of VIEWS) if (o.renders[v].sha256 !== r.renders[v].sha256 || o.renders[v].height !== r.renders[v].height) codes.push(`RENDER_MISMATCH_${v.toUpperCase()}`);
  for (const v of VIEWS) {
    const { width, height } = r.renders[v];
    if (coverage(r.viewed_crops[v], width, height) < READ_THRESHOLDS.coverage) codes.push(`CROPS_DO_NOT_COVER_${v.toUpperCase()}`);
    const inside = (b: { x: number; y: number; w: number; h: number }) => b.x + b.w <= width && b.y + b.h <= height;
    if (!r.viewed_crops[v].every(inside) || !r.observations[v].every((s) => inside(s.box))) codes.push(`BOX_OUTSIDE_${v.toUpperCase()}`);
    const bands = new Set(r.observations[v].map((s) => Math.min(2, Math.floor(((s.box.y + s.box.h / 2) / height) * 3))));
    if (bands.size < READ_THRESHOLDS.min_bands) codes.push(`OBSERVATIONS_NOT_SPREAD_${v.toUpperCase()}`);
  }
  for (const ref of r.references) {
    const learn = o.verifiedReads[ref.read];
    if (!learn) codes.push("REFERENCE_NOT_VISUAL_VERIFIED");
    else if (!learn.includes(ref.learn)) codes.push("REFERENCE_LEARN_NOT_IN_READ");
    const { width, height } = r.renders[ref.applied_at.view];
    if (ref.applied_at.box.x + ref.applied_at.box.w > width || ref.applied_at.box.y + ref.applied_at.box.h > height) codes.push("REFERENCE_BOX_OUTSIDE");
  }
  const ns = r.rounds.map((x) => x.n);
  if (new Set(ns).size !== ns.length || ns.some((n, i) => n !== i + 1)) codes.push("ROUNDS_OUT_OF_ORDER");
  for (const f of r.failure_codes) if (!o.failureCodes.includes(f)) codes.push("FAILURE_CODE_UNKNOWN");
  // a comp that still carries a known failure is not shown to the owner as ready
  if (r.verdict === "show_owner" && r.failure_codes.length > 0) codes.push("SHOW_WITH_KNOWN_FAILURE");
  return { ok: codes.length === 0, codes };
}
