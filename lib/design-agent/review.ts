import { z } from "zod";
import { DesignProfileAnswerSchema, DesignProfileCodexSchema, withoutMeta } from "./profile";

// Visual review (DEV-028): Codex looks at screenshots of the rendered demo
// and scores it. It may propose a whole revised profile (still limited to the
// profile's own values). When the renderer itself would need a new ability,
// it says so in `needs_renderer_change`; the pipeline then stops as BLOCKED
// instead of changing code. No chain of thought: scores, short notes only.

const score = z.number().int().min(1).max(5);

export const REVIEW_AREAS = ["hero", "typography", "palette", "layout", "spacing", "mobile", "motif", "information", "footer", "other"] as const;

/**
 * The review's fields with the given revised-profile schema. DEV-071b: the JSON
 * Schema for Codex requires the revised profile's layout (DesignProfileCodexSchema);
 * the answer is parsed with DesignProfileAnswerSchema (layout optional: a missing
 * one means the page before Stage 1; repeated section kinds allowed, collapsed and
 * checked by the pipeline).
 */
export function reviewShape<P extends z.ZodType>(profile: P) {
  return {
    verdict: z.enum(["accept", "revise"]),
    brand_fit: score,
    visual_quality: score,
    hierarchy: score,
    mobile_quality: score,
    /** 5 = looks like a generic template (bad), 1 = clearly designed for this shop. */
    generic_template_feel: score,
    problems: z
      .array(
        z.strictObject({
          area: z.enum(REVIEW_AREAS),
          severity: z.enum(["high", "medium", "low"]),
          note: z.string().max(200),
        }),
      )
      .max(6),
    recommended_profile_changes: z.strictObject({
      summary: z.array(z.string().max(160)).max(5),
      revised_profile: z.union([profile, z.null()]),
    }),
    needs_renderer_change: z.boolean(),
    renderer_change_note: z.string().max(300),
  };
}

export const VisualReviewSchema = z.strictObject(reviewShape(DesignProfileAnswerSchema));
/** What Codex is asked to answer (JSON Schema only): the revised profile's layout is required. */
export const VisualReviewCodexSchema = z.strictObject(reviewShape(DesignProfileCodexSchema));

export type VisualReview = z.infer<typeof VisualReviewSchema>;

export function visualReviewJsonSchema(): object {
  return withoutMeta(z.toJSONSchema(VisualReviewCodexSchema));
}

/** One number to compare rounds: higher is better. */
export function reviewScore(r: VisualReview): number {
  return r.brand_fit + r.visual_quality + r.hierarchy + r.mobile_quality + (6 - r.generic_template_feel);
}
