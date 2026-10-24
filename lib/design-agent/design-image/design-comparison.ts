/**
 * DEV-104. Offline comparative design critique, not a numeric design scorer.
 *
 * One desktop comp is evidence of that desktop comp, NOT evidence of mobile
 * rendering, CSS fidelity, source-asset approval, or a human quality verdict.
 * Nothing in this module is connected to the worker, image generation, the
 * comp-to-site evaluation gate, or publication.
 */
import { z } from "zod";

export const DESIGN_COMPARE_DIMENSIONS = [
  "hero", "product_presentation", "brand_identity", "section_rhythm",
  "information_readability", "mobile", "implementation",
] as const;

const SHA = z.string().regex(/^[0-9a-f]{64}$/);
const SafeText = z.string().trim().min(12).max(800).refine(
  (s) => !/[\u0000-\u001f\u007f]|<<<|>>>|<\s*\/?\s*(script|iframe)/i.test(s),
  "unsafe review text",
);

const Image = z.strictObject({
  direction: z.enum(["v2", "v3"]),
  /** SHA in the original local WSL report; not necessarily equal to the uploaded preview. */
  original_report_sha256: SHA,
  /** Actual SHA of the file the reviewer examined. */
  viewed_sha256: SHA,
  viewed_kind: z.enum(["uploaded_preview", "verified_original"]),
  viewed_size: z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive() }),
}).superRefine((img, ctx) => {
  if (img.viewed_kind === "verified_original" && img.original_report_sha256 !== img.viewed_sha256)
    ctx.addIssue({ code: "custom", message: "original image SHA not verified" });
});

const Observation = z.strictObject({
  /** Directly observed desktop image or actual recorded implementation evidence. */
  basis: z.enum(["desktop_comp", "render_verified", "not_checked"]),
  evidence: SafeText.nullable(),
  /** Required only for a separately verified implementation/render screenshot. */
  render_ref: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{2,140}$/).nullable(),
}).superRefine((item, ctx) => {
  if (item.basis === "not_checked" && (item.evidence !== null || item.render_ref !== null))
    ctx.addIssue({ code: "custom", message: "unobserved evidence" });
  if (item.basis !== "not_checked" && item.evidence === null)
    ctx.addIssue({ code: "custom", message: "missing observation" });
  if (item.basis === "render_verified" && item.render_ref === null)
    ctx.addIssue({ code: "custom", message: "render requires evidence reference" });
  if (item.basis === "desktop_comp" && item.render_ref !== null)
    ctx.addIssue({ code: "custom", message: "desktop comp does not prove render" });
});

const Row = z.strictObject({
  dimension: z.enum(DESIGN_COMPARE_DIMENSIONS),
  preference: z.enum(["v2", "v3", "mixed", "unknown"]),
  v2: Observation,
  v3: Observation,
  rationale: SafeText,
}).superRefine((row, ctx) => {
  if (row.v2.basis === "not_checked" || row.v3.basis === "not_checked") {
    if (row.preference !== "unknown") ctx.addIssue({ code: "custom", message: "unobserved dimension cannot prefer a design" });
  }
  if (row.dimension === "mobile" && (row.v2.basis === "desktop_comp" || row.v3.basis === "desktop_comp"))
    ctx.addIssue({ code: "custom", message: "desktop comp cannot prove mobile quality" });
  if (row.dimension === "implementation" && (row.v2.basis === "desktop_comp" || row.v3.basis === "desktop_comp"))
    ctx.addIssue({ code: "custom", message: "desktop comp cannot prove implementation fidelity" });
});

const Risk = z.strictObject({
  issue: SafeText,
  proposed_remedy: SafeText,
  how_to_verify: SafeText,
  state: z.literal("open"),
});
const Review = z.strictObject({
  schema_version: z.literal(1),
  kind: z.literal("design_comparison_advisory"),
  confirmation: z.literal("assistant_provisional"),
  original_source: z.literal("human_supplied_images"),
  images: z.tuple([Image, Image]),
  dimensions: z.array(Row).length(DESIGN_COMPARE_DIMENSIONS.length),
  unresolved_risks: z.array(Risk).min(1).max(12),
  next_art_direction: z.strictObject({
    keep_from_v2: z.array(SafeText).min(1).max(6),
    keep_from_v3: z.array(SafeText).min(1).max(6),
    improve: z.array(SafeText).min(2).max(8),
    proof_before_implementation: z.array(SafeText).min(2).max(8),
  }),
});
export type DesignComparison = z.infer<typeof Review>;

export class DesignComparisonError extends Error {
  readonly code = "DESIGN_COMPARISON_INVALID";
  constructor(reason: string) { super(reason); this.name = "DesignComparisonError"; }
}
export function parseDesignComparison(value: unknown): DesignComparison {
  const result = Review.safeParse(value);
  if (!result.success) throw new DesignComparisonError("schema_or_evidence");
  const data = result.data;
  if (data.images[0].direction !== "v2" || data.images[1].direction !== "v3")
    throw new DesignComparisonError("image_order");
  if (new Set(data.dimensions.map((d) => d.dimension)).size !== DESIGN_COMPARE_DIMENSIONS.length)
    throw new DesignComparisonError("dimension_coverage");
  return data;
}

/**
 * Honest, deterministic summary. This intentionally produces NO score,
 * winner or pass; only a human-confirmed rubric from the existing evaluation
 * template can approve a real comp for intake. No implicit imagegen approval.
 */
export function summarizeDesignComparison(value: unknown) {
  const review = parseDesignComparison(value);
  return {
    kind: "design_comparison_advisory" as const,
    candidate_status: "unconfirmed" as const,
    owner_approved: false as const,
    image_generation_approved: false as const,
    implementation_approved: false as const,
    formal_rubric_evaluation: "not_performed" as const,
    unverified_dimensions: review.dimensions.filter((d) => d.preference === "unknown").map((d) => d.dimension),
    tradeoffs: review.dimensions.map((d) => ({ dimension: d.dimension, preference: d.preference })),
    open_risks: review.unresolved_risks.length,
  };
}
