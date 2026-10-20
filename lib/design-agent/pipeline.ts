import type { DemoView } from "@/lib/sales/demo-content";
import type { PlacedPhoto } from "./assets/render-check";
import { DeadlineError } from "./bounded-process";
import { CodexError, isEnvironmentFailure } from "./codex";
import { briefStructureOnDefault, CATEGORY_DEFAULT_PROFILES, LOW_CONFIDENCE } from "./defaults";
import { checkProfile, designProfileJsonSchema, looseJsonSchema, type DesignProfile } from "./profile";
import { runPhotoLoop, timeForSecondLook, type PhotoPipelineInput, type PhotoStats } from "./photo-pipeline";
import { buildBriefPrompt, buildReviewPrompt } from "./prompts";
import { reviewScore, visualReviewJsonSchema, VisualReviewSchema, type VisualReview } from "./review";
import { visibleChanges } from "./visible-profile";

// The design agent's loop for one shop (DEV-028):
//   before shots → brief (Codex) → candidate-0 → shots → review (Codex)
//   → at most 2 revised profiles → final
// Only the design profile ever changes. When the reviewer says the renderer
// itself needs a new ability, the run stops as BLOCKED for a person. Any
// failure of the brief falls back to the existing template; a low-confidence
// brief uses the category's calm default profile. A final candidate the
// reviewer never accepted is BLOCKED too (DEV-053, the quality gate).

export const MAX_REVISIONS = 2;

/**
 * DEV-053: the quality gate. The final candidate is still the best-scored one,
 * but it is only shipped (status "done", bridge outcome "ready") when its own
 * latest review said `accept`. A final the reviewer never accepted (revision
 * limit reached, no usable revised profile, the clock ran out, a later review
 * unusable) is BLOCKED with this code: the demo keeps the existing template
 * and a person reads the record. The gate reads the verdict only: no score
 * bar of its own (the scores, the verdict and the revision limit are unchanged).
 */
export const QUALITY_NOT_ACCEPTED = "QUALITY_NOT_ACCEPTED";

type Verdicts = ReadonlyArray<{ candidate: string; verdict: string }>;

/** Whether the final candidate's latest review (a second look counts) said accept. */
export function finalAccepted(rounds: Verdicts, finalCandidate: string): boolean {
  for (let i = rounds.length - 1; i >= 0; i -= 1) {
    const round = rounds[i]!;
    if (round.candidate === finalCandidate) return round.verdict === "accept";
  }
  return false;
}

/** The gate on a finished loop: only a "done" run changes, to "blocked" with QUALITY_NOT_ACCEPTED in the notes. */
function qualityGate(status: PipelineReport["status"], rounds: Verdicts, finalCandidate: string | null, notes: string[], log: (line: string) => void): PipelineReport["status"] {
  if (status !== "done" || finalCandidate === null || finalAccepted(rounds, finalCandidate)) return status;
  notes.push(QUALITY_NOT_ACCEPTED);
  log(`final ${finalCandidate}: no review accepted it → BLOCKED (${QUALITY_NOT_ACCEPTED})`);
  return "blocked";
}

export type Shots = { desktop: string; mobile: string };

export interface PipelineDeps {
  /** One Codex JSON call (runCodexJson with the run's options). */
  askCodex(request: { kind: "brief" | "review" | "photo_review"; prompt: string; images: string[]; schema: object }): Promise<unknown>;
  /** One Codex call with photo copies attached (PhotoAnalysis / ImageDirection, DEV-029). */
  askPhotoCodex?(request: { kind: "photo_analysis" | "image_direction"; prompt: string; schema: object; imageBytes: readonly Buffer[] }): Promise<unknown>;
  /** Writes a candidate profile (or the final one) where the preview route reads it. */
  writeProfile(name: string, profile: DesignProfile): Promise<void>;
  /** Writes a run record (review, report) into the run directory. */
  writeRecord(name: string, value: unknown): Promise<void>;
  /** Renders the preview for a candidate ("none" = existing template) and returns screenshot paths. */
  render(candidate: string): Promise<Shots>;
  /** Renders a candidate with photos: screenshots, crops of photo sections the full shots cut off, and the photos the page shows. */
  renderPhotos?(candidate: string): Promise<{ shots: Shots; sections: string[]; placed: PlacedPhoto[] }>;
  /** Reads a run record back (a stored PhotoAnalysis is reused when it matches the asset set). */
  readRecord?(name: string): Promise<unknown>;
  /** Time left in the run (ms), checked before a second look at the best candidate (DEV-034). */
  timeLeftMs?(): number;
  log(line: string): void;
}

export type RoundRecord = {
  candidate: string;
  /** DEV-034: the best candidate reviewed again after a lower-scoring revision. */
  again?: true;
  scores: Pick<VisualReview, "brand_fit" | "visual_quality" | "hierarchy" | "mobile_quality" | "generic_template_feel"> & { total: number };
  verdict: VisualReview["verdict"];
  problems: Array<{ area: string; severity: string }>;
  /** DEV-066: for a revised candidate, the visible settings it changed from the profile it was revised from. */
  changed?: string[];
};

export type PipelineReport = {
  status: "done" | "blocked" | "fallback_template" | "environment_failure";
  /** Codes only (never Codex's words). */
  notes: string[];
  /** DEV-044: "category_default_brief_structure" = a low-confidence brief's structure on the category default. */
  profileSource: "codex" | "category_default" | "category_default_brief_structure" | null;
  rounds: RoundRecord[];
  finalCandidate: string | null;
  /** Revised profiles that were rendered (0–2). */
  revisions: number;
  /** Codex's own confidence in its brief (null when there was no valid brief). */
  briefConfidence: number | null;
  before: Shots;
  after: Shots | null;
  /** Only for a job with photos (DEV-029). */
  photos?: PhotoStats;
};

export interface PipelineInput {
  demo: DemoView;
  references: string[];
  /** What the references show (the prompt says so). */
  referenceKind?: "website" | "instagram";
  hint?: string;
  maxRevisions?: number;
  schemaMode?: "strict" | "loose";
  /** The job's verified photos (DEV-029). None or empty: the DEV-028 loop alone. */
  photos?: PhotoPipelineInput;
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
    revisions: 0,
    briefConfidence: null,
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
      prompt: buildBriefPrompt({ demo: input.demo, referenceCount: input.references.length, referenceKind: input.referenceKind, currentDemoCount: 2, hint: input.hint }),
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
  const briefConfidence = profile.confidence;
  if (profile.confidence < LOW_CONFIDENCE) {
    notes.push("LOW_CONFIDENCE_CATEGORY_DEFAULT");
    await deps.writeRecord("brief-low-confidence.json", profile);
    // DEV-044: keep the brief's structure, take the styling from the category default.
    const combined = briefStructureOnDefault(profile, input.demo.category);
    if (combined) {
      notes.push("BRIEF_STRUCTURE_KEPT");
      deps.log(`brief: confidence ${profile.confidence} < ${LOW_CONFIDENCE} → category default styling, brief structure`);
      profile = combined;
      profileSource = "category_default_brief_structure";
    } else {
      notes.push("BRIEF_STRUCTURE_REJECTED");
      deps.log(`brief: confidence ${profile.confidence} < ${LOW_CONFIDENCE} → category default profile`);
      profile = CATEGORY_DEFAULT_PROFILES[input.demo.category];
      profileSource = "category_default";
    }
  }

  // ---- with photos (DEV-029): its own loop; unusable photos mean the page without them
  let photoStats: PhotoStats | undefined;
  if (input.photos && input.photos.inputs.length > 0 && deps.askPhotoCodex && deps.renderPhotos) {
    const { askPhotoCodex, renderPhotos } = deps;
    const result = await runPhotoLoop({
      demo: input.demo,
      references: input.references,
      referenceKind: input.referenceKind,
      photos: input.photos,
      profile,
      maxRevisions,
      schema,
      notes,
      deps: { askCodex: (r) => deps.askCodex(r), askPhotoCodex, writeProfile: deps.writeProfile, writeRecord: deps.writeRecord, readRecord: deps.readRecord, renderPhotos, ...(deps.timeLeftMs ? { timeLeftMs: deps.timeLeftMs } : {}), log: deps.log },
    });
    photoStats = result.stats;
    if (result.kind === "environment") return report("environment_failure", { profileSource, briefConfidence, photos: photoStats });
    if (result.kind === "done") {
      const { rounds, finalCandidate, revisions, after } = result;
      const status = qualityGate(result.status, rounds, finalCandidate, notes, deps.log);
      return { status, notes, profileSource, rounds, finalCandidate, revisions, briefConfidence, before, after, photos: photoStats };
    }
  }
  const withPhotos = photoStats ? { photos: photoStats } : {};

  // ---- review / revise
  // DEV-034: each review is told the earlier rounds (scores and problem codes
  // only). The next revision always starts from the best-scored candidate so
  // far: when a revision scores lower than the leader, the leader is reviewed
  // again (with the history) and that review's revised profile is used, never
  // one made from the worse candidate. Tie: the later candidate counts as the
  // leader, the same rule as the final choice below. Scores, the verdict, the
  // revision limit and the renderer-change stop are unchanged.
  const rounds: RoundRecord[] = [];
  const candidates: Array<{ name: string; profile: DesignProfile; score: number }> = [];
  const state: { status: PipelineReport["status"] } = { status: "done" };
  let revisions = 0;
  let current = { name: "candidate-0", profile };
  let leader: { name: string; profile: DesignProfile; score: number; shots: Shots } | null = null;

  /** One review call; null when the answer is unusable (recorded in notes / status). */
  const review = async (
    target: { name: string; profile: DesignProfile },
    shots: Shots,
    again: { lower: string; lowerTotal: number } | null,
    notVisible = false,
  ): Promise<VisualReview | null> => {
    try {
      const answer = await deps.askCodex({
        kind: "review",
        prompt: buildReviewPrompt({
          demo: input.demo,
          profile: target.profile,
          referenceCount: input.references.length,
          referenceKind: input.referenceKind,
          round: revisions,
          maxRevisions,
          history: rounds,
          best: leader && rounds.length > 0 ? { candidate: leader.name, total: leader.score } : null,
          again: again ? { candidate: target.name, ...again } : null,
          notVisible: notVisible ? { candidate: target.name } : null,
        }),
        images: [...input.references, shots.desktop, shots.mobile],
        schema: schema(visualReviewJsonSchema()),
      });
      const parsed = VisualReviewSchema.safeParse(answer);
      if (!parsed.success) {
        notes.push(`REVIEW_INVALID_${target.name}${again ? "_AGAIN" : notVisible ? "_NOT_VISIBLE" : ""}`);
        return null;
      }
      return parsed.data;
    } catch (error) {
      // The run's clock ran out after a candidate was scored: the best scored candidate is the final one.
      if (error instanceof DeadlineError && leader) {
        notes.push(again ? "REVISION_FROM_BEST_NO_TIME" : notVisible ? "REVISION_NOT_VISIBLE_NO_TIME" : "REVIEW_NO_TIME");
        return null;
      }
      if (!(error instanceof CodexError)) throw error;
      notes.push(`REVIEW_${error.code}`);
      if (isEnvironmentFailure(error.code)) state.status = "environment_failure";
      return null;
    }
  };
  // DEV-066: the visible settings each revised candidate changed (recorded on its first review).
  const changedBy = new Map<string, string[]>();
  const record = (name: string, r: VisualReview, again: boolean): number => {
    const total = reviewScore(r);
    const changed = again ? undefined : changedBy.get(name);
    rounds.push({
      candidate: name,
      ...(again ? { again: true as const } : {}),
      ...(changed ? { changed } : {}),
      scores: { brand_fit: r.brand_fit, visual_quality: r.visual_quality, hierarchy: r.hierarchy, mobile_quality: r.mobile_quality, generic_template_feel: r.generic_template_feel, total },
      verdict: r.verdict,
      problems: r.problems.map((p) => ({ area: p.area, severity: p.severity })),
    });
    deps.log(`review ${name}${again ? " (again)" : ""}: ${r.verdict}, total ${total}/25`);
    return total;
  };

  for (;;) {
    await deps.writeProfile(current.name, current.profile);
    const shots = await deps.render(current.name);
    const r = await review(current, shots, null);
    if (!r) {
      candidates.push({ ...current, score: -1 });
      break;
    }
    await deps.writeRecord(`review-${current.name}.json`, r);
    const total = record(current.name, r, false);
    candidates.push({ ...current, score: total });
    if (!leader || total >= leader.score) leader = { ...current, score: total, shots };
    if (r.needs_renderer_change) {
      notes.push("RENDERER_CHANGE_NEEDED");
      state.status = "blocked";
      break;
    }
    if (r.verdict === "accept" || revisions >= maxRevisions) break;

    let next = r;
    let base: { name: string; profile: DesignProfile; shots: Shots } = { name: current.name, profile: current.profile, shots };
    if (leader.name !== current.name) {
      // This revision scored lower than the best so far: revise from the best instead.
      notes.push(`REVISION_FROM_BEST_${revisions + 1}`);
      if (!timeForSecondLook(deps.timeLeftMs)) {
        notes.push("REVISION_FROM_BEST_NO_TIME");
        break;
      }
      const again = await review(leader, leader.shots, { lower: current.name, lowerTotal: total });
      if (!again) break;
      await deps.writeRecord(`review-${leader.name}-again-${revisions + 1}.json`, again);
      record(leader.name, again, true);
      if (again.needs_renderer_change) {
        notes.push("RENDERER_CHANGE_NEEDED");
        state.status = "blocked";
        break;
      }
      if (again.verdict === "accept") break;
      next = again;
      base = { name: leader.name, profile: leader.profile, shots: leader.shots };
    }
    let revised = next.recommended_profile_changes.revised_profile;
    if (revised === null) {
      notes.push("NO_REVISED_PROFILE");
      break;
    }
    let check = checkProfile(revised);
    if (!check.ok) {
      notes.push(`REVISION_INVALID_${revisions + 1}`);
      await deps.writeRecord(`revision-${revisions + 1}-rejected.json`, { problems: check.problems });
      break;
    }
    let changed = visibleChanges(base.profile, check.profile);
    if (changed.length === 0) {
      // DEV-066: the revision changes only settings the screenshots cannot show
      // (or nothing): it would render the same page. Ask the same review once
      // more for a revision that changes something visible; the scores, the
      // verdict and the revision limit are unchanged.
      notes.push(`REVISION_NOT_VISIBLE_${revisions + 1}`);
      if (!timeForSecondLook(deps.timeLeftMs)) {
        notes.push("REVISION_NOT_VISIBLE_NO_TIME");
        break;
      }
      const retry = await review(base, base.shots, null, true);
      if (!retry) break;
      await deps.writeRecord(`review-${base.name}-not-visible-${revisions + 1}.json`, retry);
      const retryTotal = record(base.name, retry, true);
      if (base.name === leader.name && retryTotal >= leader.score) leader = { ...leader, score: retryTotal };
      if (retry.needs_renderer_change) {
        notes.push("RENDERER_CHANGE_NEEDED");
        state.status = "blocked";
        break;
      }
      if (retry.verdict === "accept") break;
      revised = retry.recommended_profile_changes.revised_profile;
      if (revised === null) {
        notes.push("NO_REVISED_PROFILE");
        break;
      }
      check = checkProfile(revised);
      if (!check.ok) {
        notes.push(`REVISION_INVALID_${revisions + 1}`);
        await deps.writeRecord(`revision-${revisions + 1}-rejected.json`, { problems: check.problems });
        break;
      }
      changed = visibleChanges(base.profile, check.profile);
      if (changed.length === 0) {
        notes.push("NO_VISIBLE_REVISION");
        break;
      }
    }
    revisions += 1;
    current = { name: `candidate-${revisions}`, profile: check.profile };
    changedBy.set(current.name, changed);
    deps.log(`${current.name}: changes ${changed.join(", ")}`);
  }

  // ---- final: the best-scored candidate (later wins a tie). A design no
  // review has scored is not shipped: the demo keeps the existing template.
  // One that no review accepted is rendered and recorded, but BLOCKED (DEV-053).
  const best = candidates.reduce((a, b) => (b.score >= a.score ? b : a));
  if (best.score < 0) {
    notes.push("NO_REVIEWED_CANDIDATE");
    return report(state.status === "environment_failure" ? "environment_failure" : "fallback_template", { profileSource, rounds, revisions, briefConfidence, ...withPhotos });
  }
  await deps.writeProfile("final", best.profile);
  const after = await deps.render("final");
  const status = qualityGate(state.status, rounds, best.name, notes, deps.log);
  return { status, notes, profileSource, rounds, finalCandidate: best.name, revisions, briefConfidence, before, after, ...withPhotos };
}
