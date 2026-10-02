import type { DemoView } from "@/lib/sales/demo-content";
import type { PhotoAnalysis } from "./assets/analysis";
import type { ImageDirection } from "./assets/direction";
import { analysesArtifact, assetsArtifact, imagesArtifact, reusableAnalyses, AnalysesArtifactSchema, type AnalysesArtifact } from "./assets/lineage";
import type { AssetManifest } from "./assets/manifest";
import { analyzePhotos, checkPhotoAnalyses, directImages, type CodexPhotoCall, type PhotoInput, type PhotoStep } from "./assets/photo-codex";
import { checkRenderedPhotos, type PlacedPhoto } from "./assets/render-check";
import { sectionsPresent } from "./assets/resolve";
import { CodexError, isEnvironmentFailure, type CodexFailureCode } from "./codex";
import { buildPhotoReviewPrompt } from "./photo-prompts";
import { photoReviewJsonSchema, PhotoReviewSchema, photoReviewScore, revisionPlan, type PhotoIssue, type PhotoReview } from "./photo-review";
import type { Shots } from "./pipeline";
import { checkProfile, type DesignProfile } from "./profile";

// The design loop for a job with photos (DEV-029 stage 4). Called by
// runDesignPipeline after the brief; without photos the DEV-028 loop runs
// unchanged.
//
//   PhotoAnalysis (once per verified asset set; reused when it still matches)
//   → candidate-0: ImageDirection → render → render check → photo review
//   → at most 2 revision rounds in all, by the review's revision_target:
//       images: same profile, new direction | profile: revised profile, then a
//       new direction | both: both | none: stop
//   → final: the best-reviewed candidate, its profile and direction.
//
// Every artifact is written with its lineage (assets/lineage.ts). An analysis
// or first direction that cannot be used means the page without photos (the
// caller continues with the DEV-028 loop); an environment failure stops the
// job like a failed brief; a page that does not show what its direction says
// is BLOCKED for a person.

export type PhotoPipelineInput = { runId: string; manifest: AssetManifest; inputs: PhotoInput[] };

export type PhotoStats = {
  assets: number;
  /** done | reused | a failure code (then the page has no photos). */
  analysis: string;
  finalLayout: ImageDirection["layout"] | null;
  calls: { photo_analysis: number; image_direction: number; photo_review: number };
};


export interface PhotoDeps {
  askCodex(request: { kind: "photo_review"; prompt: string; images: string[]; schema: object }): Promise<unknown>;
  askPhotoCodex(request: { kind: "photo_analysis" | "image_direction"; prompt: string; schema: object; imageBytes: readonly Buffer[] }): Promise<unknown>;
  writeProfile(name: string, profile: DesignProfile): Promise<void>;
  writeRecord(name: string, value: unknown): Promise<void>;
  readRecord?(name: string): Promise<unknown>;
  renderPhotos(candidate: string): Promise<{ shots: Shots; sections: string[]; placed: PlacedPhoto[] }>;
  log(line: string): void;
}

export type PhotoRound = {
  candidate: string;
  scores: { brand_fit: number; visual_quality: number; hierarchy: number; mobile_quality: number; generic_template_feel: number; total: number };
  verdict: PhotoReview["verdict"];
  problems: Array<{ area: string; severity: string }>;
  revisionTarget: PhotoReview["revision_target"];
};

export type PhotoLoopResult =
  | { kind: "fallback"; stats: PhotoStats }
  | { kind: "environment"; stats: PhotoStats }
  | {
      kind: "done";
      stats: PhotoStats;
      status: "done" | "blocked" | "fallback_template" | "environment_failure";
      rounds: PhotoRound[];
      finalCandidate: string | null;
      revisions: number;
      after: Shots | null;
    };

type Ctx = {
  demo: DemoView;
  references: string[];
  referenceKind?: "website" | "instagram";
  photos: PhotoPipelineInput;
  profile: DesignProfile;
  maxRevisions: number;
  schema: (s: object) => object;
  notes: string[];
  deps: PhotoDeps;
};

const environmental = (code: string) => code.startsWith("CODEX_") && isEnvironmentFailure(code as CodexFailureCode);

export async function runPhotoLoop(ctx: Ctx): Promise<PhotoLoopResult> {
  const { photos, deps, notes } = ctx;
  const { runId, manifest, inputs } = photos;
  const stats: PhotoStats = { assets: inputs.length, analysis: "done", finalLayout: null, calls: { photo_analysis: 0, image_direction: 0, photo_review: 0 } };
  const call =
    (kind: "photo_analysis" | "image_direction"): CodexPhotoCall =>
    async (r) => {
      stats.calls[kind] += 1;
      return deps.askPhotoCodex({ kind, prompt: r.prompt, schema: ctx.schema(r.schema), imageBytes: r.imageBytes });
    };
  const failed = (step: { code: string }): PhotoLoopResult => {
    notes.push(step.code);
    return environmental(step.code) ? { kind: "environment", stats } : { kind: "fallback", stats };
  };

  await deps.writeRecord("assets.json", assetsArtifact(runId, manifest));

  // ---- PhotoAnalysis: once per verified asset set
  let analyses: PhotoAnalysis[];
  let analysesArt: AnalysesArtifact;
  const stored = deps.readRecord ? await deps.readRecord("photo-analyses.json").catch(() => undefined) : undefined;
  const reused = reusableAnalyses(stored, runId, manifest);
  const reusedCheck = reused ? checkPhotoAnalyses(reused, inputs) : null;
  if (reusedCheck?.ok) {
    analyses = reusedCheck.value;
    analysesArt = AnalysesArtifactSchema.parse(stored);
    stats.analysis = "reused";
    deps.log("photos: analysis reused (same asset set)");
  } else {
    const step = await analyzePhotos({ call: call("photo_analysis"), inputs, category: ctx.demo.category });
    if (!step.ok) {
      stats.analysis = step.code;
      deps.log(`photos: analysis ${step.code} → page without photos`);
      return failed(step);
    }
    analyses = step.value;
    analysesArt = analysesArtifact(runId, manifest, { photos: analyses });
    await deps.writeRecord("photo-analyses.json", analysesArt);
  }

  const sections = sectionsPresent(ctx.demo);
  const direct = (profile: DesignProfile, feedback: readonly PhotoIssue[]): Promise<PhotoStep<ImageDirection>> =>
    directImages({ call: call("image_direction"), inputs, analyses, manifest, profile, demo: ctx.demo, feedback });

  // ---- candidate-0
  const first = await direct(ctx.profile, []);
  if (!first.ok) {
    deps.log(`photos: direction ${first.code} → page without photos`);
    return failed(first);
  }

  const rounds: PhotoRound[] = [];
  const candidates: Array<{ name: string; profile: DesignProfile; direction: ImageDirection; score: number }> = [];
  let status: "done" | "blocked" | "fallback_template" | "environment_failure" = "done";
  let revisions = 0;
  let current = { name: "candidate-0", profile: ctx.profile, direction: first.value };

  const show = async (name: string, profile: DesignProfile, direction: ImageDirection) => {
    await deps.writeProfile(name, profile);
    await deps.writeRecord(`${name}.images.json`, imagesArtifact(runId, name, manifest, analysesArt, profile, sections, direction));
    const rendered = await deps.renderPhotos(name);
    return { rendered, problems: checkRenderedPhotos(direction, manifest, rendered.placed) };
  };

  for (;;) {
    const { rendered, problems } = await show(current.name, current.profile, current.direction);
    if (problems.length > 0) {
      notes.push("PHOTO_RENDER_MISMATCH");
      await deps.writeRecord(`render-check-${current.name}.json`, { problems });
      deps.log(`photos: ${current.name} does not show what its direction says → BLOCKED`);
      candidates.push({ ...current, score: -1 });
      status = "blocked";
      break;
    }
    let review: PhotoReview;
    try {
      stats.calls.photo_review += 1;
      const answer = await deps.askCodex({
        kind: "photo_review",
        prompt: buildPhotoReviewPrompt({
          demo: ctx.demo,
          profile: current.profile,
          direction: current.direction,
          analyses,
          referenceCount: ctx.references.length,
          referenceKind: ctx.referenceKind,
          sectionCount: rendered.sections.length,
          round: revisions,
          maxRevisions: ctx.maxRevisions,
        }),
        images: [...ctx.references, rendered.shots.desktop, rendered.shots.mobile, ...rendered.sections],
        schema: ctx.schema(photoReviewJsonSchema()),
      });
      const parsed = PhotoReviewSchema.safeParse(answer);
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
    const total = photoReviewScore(review);
    candidates.push({ ...current, score: total });
    rounds.push({
      candidate: current.name,
      scores: { brand_fit: review.brand_fit, visual_quality: review.visual_quality, hierarchy: review.hierarchy, mobile_quality: review.mobile_quality, generic_template_feel: review.generic_template_feel, total },
      verdict: review.verdict,
      problems: [...review.problems.map((p) => ({ area: p.area, severity: p.severity })), ...review.photo_issues.map((p) => ({ area: `photo_${p.issue}`, severity: p.severity }))],
      revisionTarget: review.revision_target,
    });
    deps.log(`review ${current.name}: ${review.verdict}, total ${total}/65, target ${review.revision_target}`);
    if (review.needs_renderer_change) {
      notes.push("RENDERER_CHANGE_NEEDED");
      status = "blocked";
      break;
    }
    if (review.verdict === "accept" || revisions >= ctx.maxRevisions) break;

    // ---- one revision round: the state machine
    const plan = revisionPlan(review.revision_target);
    if (!plan.revise) {
      notes.push("NO_REVISION_TARGET");
      break;
    }
    let nextProfile = current.profile;
    if (plan.profile) {
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
      nextProfile = check.profile;
    }
    const next = await direct(nextProfile, plan.imageFeedback ? review.photo_issues : []);
    if (!next.ok) {
      notes.push(environmental(next.code) ? next.code : `REVISION_IMAGE_DIRECTION_INVALID_${revisions + 1}`);
      if (environmental(next.code)) status = "environment_failure";
      break;
    }
    revisions += 1;
    current = { name: `candidate-${revisions}`, profile: nextProfile, direction: next.value };
  }

  // ---- final: the best-reviewed candidate (later wins a tie)
  const best = candidates.reduce((a, b) => (b.score >= a.score ? b : a));
  if (best.score < 0) {
    notes.push("NO_REVIEWED_CANDIDATE");
    return { kind: "done", stats, status: status === "done" ? "fallback_template" : status, rounds, finalCandidate: null, revisions, after: null };
  }
  const final = await show("final", best.profile, best.direction);
  if (final.problems.length > 0) {
    notes.push("FINAL_RENDER_MISMATCH");
    await deps.writeRecord("render-check-final.json", { problems: final.problems });
    status = "blocked";
  }
  stats.finalLayout = best.direction.layout;
  return { kind: "done", stats, status, rounds, finalCandidate: best.name, revisions, after: final.rendered.shots };
}
