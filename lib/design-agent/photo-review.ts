import { z } from "zod";
import { withoutMeta } from "./profile";
import { reviewScore, VisualReviewSchema } from "./review";

// The review of a candidate with photos (DEV-029 stage 4). The DEV-028 review
// (review.ts) stays as it is for pages without photos. This one adds photo
// scores, photo issues from a fixed list, and a structured revision target.
// It cannot propose a photo placement of its own: a new placement only ever
// comes from the image-direction call, inside its schema and checks.

const score = z.number().int().min(1).max(5);

export const PHOTO_ISSUES = ["selection", "placement", "crop", "focal_lost", "text_collision", "repetition", "quality", "mobile_crop", "brand_mismatch"] as const;
export const REVISION_TARGETS = ["none", "profile", "images", "both"] as const;

export const PhotoReviewSchema = z.strictObject({
  ...VisualReviewSchema.shape,
  photo_scores: z.strictObject({
    image_selection: score,
    crop: score,
    focal_visibility: score,
    /** 5 = no photo gets in the way of the name, headings or facts. */
    text_image_collision: score,
    /** 5 = no photo repeats another. */
    image_repetition: score,
    image_quality: score,
    mobile_crop: score,
    photo_brand_fit: score,
  }),
  photo_issues: z.array(z.strictObject({ issue: z.enum(PHOTO_ISSUES), severity: z.enum(["high", "medium", "low"]) })).max(6),
  /** What a revision changes: nothing, the profile (then a new direction for it), the photos only, or both. */
  revision_target: z.enum(REVISION_TARGETS),
});

export type PhotoReview = z.infer<typeof PhotoReviewSchema>;
export type RevisionTarget = (typeof REVISION_TARGETS)[number];
export type PhotoIssue = PhotoReview["photo_issues"][number];

export function photoReviewJsonSchema(): object {
  return withoutMeta(z.toJSONSchema(PhotoReviewSchema));
}

/** One number to compare photo rounds: the DEV-028 total plus the photo scores (higher is better). */
export function photoReviewScore(r: PhotoReview): number {
  return reviewScore(r) + Object.values(r.photo_scores).reduce((a, b) => a + b, 0);
}

/**
 * The revision state machine. One budget for the whole job (at most 2 rounds);
 * PhotoAnalysis is never redone. images: same profile, new direction (with the
 * photo issues); profile: revised profile, then a new direction for it; both:
 * revised profile, then a new direction with the photo issues; none: stop.
 */
export function revisionPlan(target: RevisionTarget): { revise: boolean; profile: boolean; images: boolean; imageFeedback: boolean } {
  switch (target) {
    case "none":
      return { revise: false, profile: false, images: false, imageFeedback: false };
    case "images":
      return { revise: true, profile: false, images: true, imageFeedback: true };
    case "profile":
      return { revise: true, profile: true, images: true, imageFeedback: false };
    case "both":
      return { revise: true, profile: true, images: true, imageFeedback: true };
  }
}
