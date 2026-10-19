import { describe, expect, it } from "vitest";
import { z } from "zod";
import { reviewSummaryFromReport, buildReviewSummary, REVIEW_SCORE_KEYS, REVIEW_VERDICTS, ReviewSummarySchema, scoresTotal, type ReviewSummary } from "@/lib/design-agent/review-summary";
import { reviewScore, VisualReviewSchema, type VisualReview } from "@/lib/design-agent/review";
import { designBridgeRequest, workerJobIdFor } from "@/lib/sales/design-bridge-schema";
import { reviewAxisLines, reviewSummaryLine } from "@/lib/sales/design";

// DEV-058: the review summary a worker sends with a ready or a
// QUALITY_NOT_ACCEPTED result: fixed keys, numbers and enums only, derived
// from the review schema (which it does not change).

const round = (candidate: string, verdict: "accept" | "revise", s: [number, number, number, number, number], extra: Record<string, unknown> = {}) => ({
  candidate,
  scores: { brand_fit: s[0], visual_quality: s[1], hierarchy: s[2], mobile_quality: s[3], generic_template_feel: s[4], total: s[0] + s[1] + s[2] + s[3] + 6 - s[4] },
  verdict,
  problems: [{ area: "hero", severity: "high" }],
  ...extra,
});

const ACCEPTED: ReviewSummary = {
  version: 1,
  verdict: "accept",
  total: 19,
  max: 25,
  scores: { brand_fit: 4, visual_quality: 4, hierarchy: 4, mobile_quality: 4, generic_template_feel: 3 },
  rounds: 2,
  confidence: 0.72,
  qualityNotAccepted: false,
};

describe("the summary's axes and verdicts come from the review schema", () => {
  it("every integer 1-5 field of VisualReviewSchema is an axis, and nothing else", () => {
    const scoreFields = Object.entries(VisualReviewSchema.shape)
      .filter(([, s]) => s instanceof z.ZodNumber && s.safeParse(1).success && s.safeParse(5).success && !s.safeParse(6).success && !s.safeParse(1.5).success)
      .map(([k]) => k);
    expect([...REVIEW_SCORE_KEYS].sort()).toEqual(scoreFields.sort());
    expect(REVIEW_VERDICTS).toEqual(VisualReviewSchema.shape.verdict.options);
  });

  it("the total is the pipeline's reviewScore", () => {
    const review = { verdict: "revise", brand_fit: 2, visual_quality: 5, hierarchy: 3, mobile_quality: 4, generic_template_feel: 4 } as VisualReview;
    expect(scoresTotal(review)).toBe(reviewScore(review));
  });
});

describe("buildReviewSummary", () => {
  it("reads the final candidate's latest round (the round the DEV-053 gate reads)", () => {
    const rounds = [round("initial", "revise", [3, 3, 3, 3, 4]), round("rev1", "revise", [4, 4, 4, 4, 3]), round("rev2", "revise", [2, 2, 2, 2, 5]), round("rev1", "accept", [4, 4, 4, 4, 3], { again: true })];
    expect(buildReviewSummary({ rounds, finalCandidate: "rev1", confidence: 0.7234, qualityNotAccepted: false })).toEqual({ ...ACCEPTED, rounds: 4 });
  });

  it("a quality-gate block: the final's latest verdict is revise", () => {
    const rounds = [round("initial", "revise", [3, 4, 3, 3, 3]), round("rev1", "revise", [2, 2, 2, 2, 5])];
    expect(buildReviewSummary({ rounds, finalCandidate: "initial", confidence: 0.5, qualityNotAccepted: true })).toEqual({
      version: 1, verdict: "revise", total: 16, max: 25, scores: { brand_fit: 3, visual_quality: 4, hierarchy: 3, mobile_quality: 3, generic_template_feel: 3 }, rounds: 2, confidence: 0.5, qualityNotAccepted: true,
    });
  });

  it("carries nothing of Codex's words: problems, notes and extra fields are dropped", () => {
    const rounds = [round("initial", "accept", [5, 5, 5, 5, 1], { note: "Codex said something", problems: [{ area: "hero", severity: "high", note: "too dark" }] })];
    const summary = buildReviewSummary({ rounds, finalCandidate: "initial", confidence: 0.9, qualityNotAccepted: false })!;
    expect(JSON.stringify(summary)).not.toMatch(/Codex|dark|hero|initial|problems/);
    expect(Object.keys(summary).sort()).toEqual(["confidence", "max", "qualityNotAccepted", "rounds", "scores", "total", "verdict", "version"]);
  });

  it.each([
    ["no rounds", { rounds: [], finalCandidate: "initial" }],
    ["rounds not an array", { rounds: "x", finalCandidate: "initial" }],
    ["no final candidate", { rounds: [round("initial", "accept", [4, 4, 4, 4, 2])], finalCandidate: null }],
    ["the final never reviewed", { rounds: [round("initial", "accept", [4, 4, 4, 4, 2])], finalCandidate: "rev1" }],
    ["a malformed round", { rounds: [{ verdict: "accept" }], finalCandidate: "initial" }],
    ["a score out of range", { rounds: [round("initial", "accept", [6, 4, 4, 4, 2])], finalCandidate: "initial" }],
    ["an unknown verdict", { rounds: [{ ...round("initial", "accept", [4, 4, 4, 4, 2]), verdict: "maybe" }], finalCandidate: "initial" }],
    ["a gate flag that contradicts the verdict", { rounds: [round("initial", "accept", [4, 4, 4, 4, 2])], finalCandidate: "initial", qualityNotAccepted: true }],
  ])("null for %s", (_label, input) => {
    expect(buildReviewSummary({ confidence: 0.5, qualityNotAccepted: false, ...input })).toBeNull();
  });

  it("an unrecorded or out-of-range confidence is null; it is rounded to two decimals", () => {
    const rounds = [round("initial", "accept", [4, 4, 4, 4, 3])];
    for (const confidence of [null, undefined, "0.8", 1.5, -0.1]) {
      expect(buildReviewSummary({ rounds, finalCandidate: "initial", confidence, qualityNotAccepted: false })?.confidence).toBeNull();
    }
    expect(buildReviewSummary({ rounds, finalCandidate: "initial", confidence: 0.666, qualityNotAccepted: false })?.confidence).toBe(0.67);
  });

  it("from report.json's codex section (as the worker writes it)", () => {
    const codex = { rounds: [round("initial", "revise", [4, 4, 4, 4, 3]), round("rev1", "accept", [4, 4, 4, 4, 3])], final_candidate: "rev1", confidence: 0.72, quality_not_accepted: false, notes: ["X"] };
    expect(reviewSummaryFromReport({ outcome: "done", codex })).toEqual(ACCEPTED);
    expect(reviewSummaryFromReport({ outcome: "done" })).toBeNull();
    expect(reviewSummaryFromReport(null)).toBeNull();
  });
});

describe("ReviewSummarySchema", () => {
  it("accepts a summary", () => {
    expect(ReviewSummarySchema.safeParse(ACCEPTED).success).toBe(true);
    expect(ReviewSummarySchema.safeParse({ ...ACCEPTED, confidence: null }).success).toBe(true);
  });

  it.each([
    ["an extra key", { ...ACCEPTED, note: "x" }],
    ["an extra score key", { ...ACCEPTED, scores: { ...ACCEPTED.scores, layout: 3 } }],
    ["a missing score", { ...ACCEPTED, scores: { ...ACCEPTED.scores, hierarchy: undefined } }],
    ["a string score", { ...ACCEPTED, scores: { ...ACCEPTED.scores, hierarchy: "4" } }],
    ["a string total", { ...ACCEPTED, total: "19" }],
    ["free text as the verdict", { ...ACCEPTED, verdict: "looks good" }],
    ["a total that does not match", { ...ACCEPTED, total: 20 }],
    ["another max", { ...ACCEPTED, max: 30 }],
    ["another version", { ...ACCEPTED, version: 2 }],
    ["more than two decimals", { ...ACCEPTED, confidence: 0.723 }],
    ["zero rounds", { ...ACCEPTED, rounds: 0 }],
    ["a gate flag with accept", { ...ACCEPTED, qualityNotAccepted: true }],
  ])("refuses %s", (_label, value) => {
    expect(ReviewSummarySchema.safeParse(value).success).toBe(false);
  });
});

describe("the submit body (design-bridge-schema)", () => {
  const JOB = "6f1c2e7a-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
  const blocked = { action: "submit", jobId: JOB, outcome: "blocked", profile: null, errorCode: "QUALITY_NOT_ACCEPTED", workerCommit: "0123abcd", lineage: { workerJobId: workerJobIdFor(JOB) } };
  const REVISE: ReviewSummary = { ...ACCEPTED, verdict: "revise", qualityNotAccepted: true };

  it("review is optional (an older bridge) and goes with QUALITY_NOT_ACCEPTED", () => {
    expect(designBridgeRequest.safeParse(blocked).success).toBe(true);
    expect(designBridgeRequest.safeParse({ ...blocked, review: REVISE }).success).toBe(true);
  });

  it("refuses a review with another outcome or code, an accepted one with the gate's code, and any extra key", () => {
    expect(designBridgeRequest.safeParse({ ...blocked, errorCode: "DESIGN_BLOCKED", review: REVISE }).success).toBe(false);
    expect(designBridgeRequest.safeParse({ ...blocked, outcome: "failed", errorCode: "WORKER_FAILED", review: REVISE }).success).toBe(false);
    expect(designBridgeRequest.safeParse({ ...blocked, review: ACCEPTED }).success).toBe(false);
    expect(designBridgeRequest.safeParse({ ...blocked, review: { ...REVISE, problems: ["too dark"] } }).success).toBe(false);
  });
});

describe("the admin's words", () => {
  it("one line and the axes, numbers and enums only", () => {
    expect(reviewSummaryLine(ACCEPTED)).toBe("AI レビュー: accept 19/25（2 回）");
    expect(reviewAxisLines(ACCEPTED)).toEqual(["店らしさ 4/5", "見た目 4/5", "情報の階層 4/5", "スマホ 4/5", "テンプレ感（低いほど良い） 3/5", "確信度 0.72"]);
    expect(reviewAxisLines({ ...ACCEPTED, confidence: null })).toHaveLength(5);
  });
});
