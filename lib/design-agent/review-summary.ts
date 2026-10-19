import { z } from "zod";
import { VisualReviewSchema, type VisualReview } from "./review";

// DEV-058: a compact summary of a design job's visual reviews, sent by the
// worker (through the bridge) with a ready or a QUALITY_NOT_ACCEPTED result
// and stored on the demo (sales_demos.design_review) for the admin.
//
// Fixed keys, numbers and enums only: never Codex's words (no problems,
// notes, summaries or renderer notes). The verdict and the score axes come
// from the review schema (VisualReviewSchema), which this module does not
// change. The database bounds the same shape (migration 20261020120000).

/** The review's score axes (each an integer 1–5 in VisualReviewSchema). */
export const REVIEW_SCORE_KEYS = ["brand_fit", "visual_quality", "hierarchy", "mobile_quality", "generic_template_feel"] as const satisfies ReadonlyArray<keyof VisualReview>;
export type ReviewScoreKey = (typeof REVIEW_SCORE_KEYS)[number];

/** The review's verdicts ("accept" / "revise"). */
export const REVIEW_VERDICTS = VisualReviewSchema.shape.verdict.options;

/** The best possible total (reviewScore: four axes + the inverted generic_template_feel, 5 × 5). */
export const REVIEW_MAX_TOTAL = 25;
/** More reviews than one job can have (the first, 2 revisions, a second look at the best after each). */
export const REVIEW_MAX_ROUNDS = 10;

const scoreSchema = VisualReviewSchema.shape.brand_fit;

export const ReviewScoresSchema = z.strictObject(
  Object.fromEntries(REVIEW_SCORE_KEYS.map((k) => [k, scoreSchema])) as Record<ReviewScoreKey, typeof scoreSchema>,
);
export type ReviewScores = z.infer<typeof ReviewScoresSchema>;

/** The same total as reviewScore (higher is better; generic_template_feel counts inverted). */
export function scoresTotal(s: ReviewScores): number {
  return s.brand_fit + s.visual_quality + s.hierarchy + s.mobile_quality + (6 - s.generic_template_feel);
}

const twoDecimals = (n: number) => Math.round(n * 100) / 100 === n;

export const ReviewSummarySchema = z
  .strictObject({
    version: z.literal(1),
    /** The final candidate's latest verdict. */
    verdict: z.enum(REVIEW_VERDICTS),
    total: z.number().int().min(5).max(REVIEW_MAX_TOTAL),
    max: z.literal(REVIEW_MAX_TOTAL),
    scores: ReviewScoresSchema,
    /** How many reviews the job had. */
    rounds: z.number().int().min(1).max(REVIEW_MAX_ROUNDS),
    /** The final profile's own confidence (0–1, two decimals); null when the run did not record one. */
    confidence: z.number().min(0).max(1).refine(twoDecimals, { message: "two decimals" }).nullable(),
    /** DEV-053: the final candidate was never accepted (the demo is blocked QUALITY_NOT_ACCEPTED). */
    qualityNotAccepted: z.boolean(),
  })
  .refine((r) => r.total === scoresTotal(r.scores), { message: "total must match the scores" })
  .refine((r) => r.qualityNotAccepted === (r.verdict !== "accept"), { message: "qualityNotAccepted must match the verdict" });
export type ReviewSummary = z.infer<typeof ReviewSummarySchema>;

// One round as the pipeline records it (RoundRecord in report.json's
// codex.rounds); only the fields the summary uses are read.
const RecordedRound = z.object({ candidate: z.string(), verdict: z.enum(REVIEW_VERDICTS), scores: z.object(ReviewScoresSchema.shape) });

/**
 * The summary of a finished run, from what the pipeline recorded: its rounds,
 * the final candidate, the final profile's confidence and the quality gate.
 * The final candidate's latest round gives the verdict and the scores (the
 * same round the DEV-053 gate reads). Null when anything is missing or not
 * the recorded shape: then no summary is sent at all.
 */
export function buildReviewSummary(input: { rounds: unknown; finalCandidate: unknown; confidence: unknown; qualityNotAccepted: unknown }): ReviewSummary | null {
  if (!Array.isArray(input.rounds) || input.rounds.length === 0 || typeof input.finalCandidate !== "string") return null;
  const rounds = z.array(RecordedRound).safeParse(input.rounds);
  if (!rounds.success) return null;
  const last = rounds.data.findLast((r) => r.candidate === input.finalCandidate);
  if (!last) return null;
  const scores = Object.fromEntries(REVIEW_SCORE_KEYS.map((k) => [k, last.scores[k]])) as ReviewScores;
  const confidence = typeof input.confidence === "number" && input.confidence >= 0 && input.confidence <= 1 ? Math.round(input.confidence * 100) / 100 : null;
  const summary = {
    version: 1 as const,
    verdict: last.verdict,
    total: scoresTotal(scores),
    max: REVIEW_MAX_TOTAL,
    scores,
    rounds: rounds.data.length,
    confidence,
    qualityNotAccepted: input.qualityNotAccepted === true,
  };
  const checked = ReviewSummarySchema.safeParse(summary);
  return checked.success ? checked.data : null;
}

/** The summary of a worker run's report.json (its `codex` section). */
export function reviewSummaryFromReport(report: Record<string, unknown> | null): ReviewSummary | null {
  const codex = report?.codex;
  if (!codex || typeof codex !== "object") return null;
  const c = codex as Record<string, unknown>;
  return buildReviewSummary({ rounds: c.rounds, finalCandidate: c.final_candidate, confidence: c.confidence, qualityNotAccepted: c.quality_not_accepted });
}
