import type { DemoView } from "@/lib/sales/demo-content";
import { CodexError, isEnvironmentFailure } from "./codex";
import { CATEGORY_DEFAULT_PROFILES, LOW_CONFIDENCE } from "./defaults";
import { checkProfile, designProfileJsonSchema, looseJsonSchema, type DesignProfile } from "./profile";
import { buildBriefPrompt, buildReviewPrompt } from "./prompts";
import { reviewScore, visualReviewJsonSchema, VisualReviewSchema, type VisualReview } from "./review";

// The design agent's loop for one shop (DEV-028):
//   before shots → brief (Codex) → candidate-0 → shots → review (Codex)
//   → at most 2 revised profiles → final
// Only the design profile ever changes. When the reviewer says the renderer
// itself needs a new ability, the run stops as BLOCKED for a person. Any
// failure of the brief falls back to the existing template; a low-confidence
// brief uses the category's calm default profile.

export const MAX_REVISIONS = 2;

export type Shots = { desktop: string; mobile: string };

export interface PipelineDeps {
  /** One Codex JSON call (runCodexJson with the run's options). */
  askCodex(request: { kind: "brief" | "review"; prompt: string; images: string[]; schema: object }): Promise<unknown>;
  /** Writes a candidate profile (or the final one) where the preview route reads it. */
  writeProfile(name: string, profile: DesignProfile): Promise<void>;
  /** Writes a run record (review, report) into the run directory. */
  writeRecord(name: string, value: unknown): Promise<void>;
  /** Renders the preview for a candidate ("none" = existing template) and returns screenshot paths. */
  render(candidate: string): Promise<Shots>;
  log(line: string): void;
}

export type RoundRecord = {
  candidate: string;
  scores: Pick<VisualReview, "brand_fit" | "visual_quality" | "hierarchy" | "mobile_quality" | "generic_template_feel"> & { total: number };
  verdict: VisualReview["verdict"];
  problems: Array<{ area: string; severity: string }>;
};

export type PipelineReport = {
  status: "done" | "blocked" | "fallback_template" | "environment_failure";
  /** Codes only (never Codex's words). */
  notes: string[];
  profileSource: "codex" | "category_default" | null;
  rounds: RoundRecord[];
  finalCandidate: string | null;
  before: Shots;
  after: Shots | null;
};

export interface PipelineInput {
  demo: DemoView;
  references: string[];
  hint?: string;
  maxRevisions?: number;
  schemaMode?: "strict" | "loose";
}

export async function runDesignPipeline(input: PipelineInput, deps: PipelineDeps): Promise<PipelineReport> {
  const maxRevisions = Math.min(MAX_REVISIONS, Math.max(0, input.maxRevisions ?? MAX_REVISIONS));
  const schema = (s: object) => (input.schemaMode === "loose" ? looseJsonSchema(s) : s);
  const notes: string[] = [];
  const before = await deps.render("none");
  const report = (status: PipelineReport["status"], extra: Partial<PipelineReport> = {}): PipelineReport => ({
    status,
    notes,
    profileSource: null,
    rounds: [],
    finalCandidate: null,
    before,
    after: null,
    ...extra,
  });

  // ---- brief
  let profile: DesignProfile;
  let profileSource: PipelineReport["profileSource"] = "codex";
  try {
    const answer = await deps.askCodex({
      kind: "brief",
      prompt: buildBriefPrompt({ demo: input.demo, referenceCount: input.references.length, currentDemoCount: 2, hint: input.hint }),
      images: [...input.references, before.desktop, before.mobile],
      schema: schema(designProfileJsonSchema()),
    });
    const check = checkProfile(answer);
    if (!check.ok) {
      notes.push("BRIEF_PROFILE_INVALID");
      await deps.writeRecord("brief-rejected.json", { problems: check.problems });
      deps.log("brief: profile rejected by the validator → existing template");
      return report("fallback_template");
    }
    profile = check.profile;
  } catch (error) {
    if (error instanceof CodexError) {
      notes.push(error.code);
      deps.log(`brief: ${error.code}`);
      return report(isEnvironmentFailure(error.code) ? "environment_failure" : "fallback_template");
    }
    throw error;
  }
  if (profile.confidence < LOW_CONFIDENCE) {
    notes.push("LOW_CONFIDENCE_CATEGORY_DEFAULT");
    deps.log(`brief: confidence ${profile.confidence} < ${LOW_CONFIDENCE} → category default profile`);
    await deps.writeRecord("brief-low-confidence.json", profile);
    profile = CATEGORY_DEFAULT_PROFILES[input.demo.category];
    profileSource = "category_default";
  }

  // ---- review / revise
  const rounds: RoundRecord[] = [];
  const candidates: Array<{ name: string; profile: DesignProfile; score: number }> = [];
  let status: PipelineReport["status"] = "done";
  let revisions = 0;
  let current = { name: "candidate-0", profile };
  for (;;) {
    await deps.writeProfile(current.name, current.profile);
    const shots = await deps.render(current.name);
    let review: VisualReview;
    try {
      const answer = await deps.askCodex({
        kind: "review",
        prompt: buildReviewPrompt({ demo: input.demo, profile: current.profile, referenceCount: input.references.length, round: revisions, maxRevisions }),
        images: [...input.references, shots.desktop, shots.mobile],
        schema: schema(visualReviewJsonSchema()),
      });
      const parsed = VisualReviewSchema.safeParse(answer);
      if (!parsed.success) {
        notes.push(`REVIEW_INVALID_${current.name}`);
        candidates.push({ ...current, score: -1 });
        break;
      }
      review = parsed.data;
    } catch (error) {
      if (!(error instanceof CodexError)) throw error;
      notes.push(`REVIEW_${error.code}`);
      candidates.push({ ...current, score: -1 });
      if (isEnvironmentFailure(error.code)) status = "environment_failure";
      break;
    }
    await deps.writeRecord(`review-${current.name}.json`, review);
    const total = reviewScore(review);
    candidates.push({ ...current, score: total });
    rounds.push({
      candidate: current.name,
      scores: {
        brand_fit: review.brand_fit,
        visual_quality: review.visual_quality,
        hierarchy: review.hierarchy,
        mobile_quality: review.mobile_quality,
        generic_template_feel: review.generic_template_feel,
        total,
      },
      verdict: review.verdict,
      problems: review.problems.map((p) => ({ area: p.area, severity: p.severity })),
    });
    deps.log(`review ${current.name}: ${review.verdict}, total ${total}/25`);
    if (review.needs_renderer_change) {
      notes.push("RENDERER_CHANGE_NEEDED");
      status = "blocked";
      break;
    }
    if (review.verdict === "accept" || revisions >= maxRevisions) break;
    const revised = review.recommended_profile_changes.revised_profile;
    if (revised === null) {
      notes.push("NO_REVISED_PROFILE");
      break;
    }
    const check = checkProfile(revised);
    if (!check.ok) {
      notes.push(`REVISION_INVALID_${revisions + 1}`);
      await deps.writeRecord(`revision-${revisions + 1}-rejected.json`, { problems: check.problems });
      break;
    }
    revisions += 1;
    current = { name: `candidate-${revisions}`, profile: check.profile };
  }

  // ---- final: the best-scored candidate (later wins a tie); unreviewed ones rank last
  const best = candidates.reduce((a, b) => (b.score >= a.score ? b : a));
  await deps.writeProfile("final", best.profile);
  const after = await deps.render("final");
  return { status, notes, profileSource, rounds, finalCandidate: best.name, before, after };
}
