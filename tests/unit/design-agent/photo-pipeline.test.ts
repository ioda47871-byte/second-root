import { describe, expect, it } from "vitest";
import type { PhotoAnalysis } from "@/lib/design-agent/assets/analysis";
import type { ImageDirection } from "@/lib/design-agent/assets/direction";
import {
  analysesArtifact,
  assetSetDigest,
  assetsArtifact,
  digest,
  imagesArtifact,
  reusableAnalyses,
  verifyAnalyses,
  verifyAssets,
  verifyImages,
} from "@/lib/design-agent/assets/lineage";
import type { PhotoInput } from "@/lib/design-agent/assets/photo-codex";
import { checkRenderedPhotos, type PlacedPhoto } from "@/lib/design-agent/assets/render-check";
import type { PublicAssetId } from "@/lib/design-agent/assets/types";
import { CodexError } from "@/lib/design-agent/codex";
import { runDesignPipeline, type PipelineDeps } from "@/lib/design-agent/pipeline";
import { photoReviewJsonSchema, PhotoReviewSchema, revisionPlan, type PhotoReview } from "@/lib/design-agent/photo-review";
import type { DesignProfile } from "@/lib/design-agent/profile";
import { AMERICAN_EDITORIAL, MINIMAL_SHOP, review, SHOP } from "./fixtures";
import { fakeAnalysis, fakeManifest, fakePng, type FakeAsset } from "./photo-fixtures";

// DEV-029 stage 4: artifact lineage, PhotoAnalysis reuse, the revision state
// machine (one budget of 2 rounds for profile and images together), the
// photo-aware review and the mechanical render check. Fake Codex answers,
// in-memory rendering, photos drawn by the tests.

const A = "asset-aaaaaaaaaaaaaaaaaaaaaaaa";
const B = "asset-bbbbbbbbbbbbbbbbbbbbbbbb";
const C = "asset-cccccccccccccccccccccccc";
const ASSETS: FakeAsset[] = [
  { id: A, png: fakePng(360, 450, { seed: 1 }), sourceKind: "generated_concept" },
  { id: B, png: fakePng(480, 320, { seed: 2 }), sourceKind: "approved_real" },
  { id: C, png: fakePng(400, 400, { seed: 3 }), sourceKind: "generated_concept" },
];
const RUN = "job-photo-1";
const manifestOf = (n = 3, jobId = RUN) => fakeManifest(jobId, ASSETS.slice(0, n));
const inputsOf = (n = 3): PhotoInput[] => ASSETS.slice(0, n).map((a) => ({ assetId: a.id as PublicAssetId, png: a.png, width: a.png.readUInt32BE(16), height: a.png.readUInt32BE(20) }));
const ANALYSES: PhotoAnalysis[] = [fakeAnalysis(A, { orientation: "portrait" }), fakeAnalysis(B, { orientation: "landscape" }), fakeAnalysis(C, { orientation: "square" })];
const SECTIONS = { about: true, visit: true };

const place = (assetId: string, over: Record<string, unknown> = {}) =>
  ({ assetId, fit: "cover", focal: { x: 0.5, y: 0.4 }, mobileFocal: { x: 0.5, y: 0.45 }, aspect: { desktop: "4:5", mobile: "1:1" }, treatment: "natural", ...over }) as NonNullable<ImageDirection["hero"]>;
const direction = (n = 3, over: Partial<ImageDirection> = {}): ImageDirection => {
  const ids = ASSETS.slice(0, n).map((a) => a.id);
  return {
    version: 1,
    layout: "split_hero",
    hero: place(ids[0]),
    features: ids.length > 1 ? [{ ...place(ids[1]), slot: "visit", side: "right" }] : [],
    rejected: ids.slice(2).map((assetId) => ({ assetId, reason: "not_needed" as const })),
    paletteFit: 4,
    ...over,
  };
};

// ---------------------------------------------------------------- lineage

describe("artifact lineage", () => {
  const manifest = manifestOf();
  const analyses = analysesArtifact(RUN, manifest, { photos: ANALYSES });
  const images = imagesArtifact(RUN, "candidate-0", manifest, analyses, AMERICAN_EDITORIAL, SECTIONS, direction());

  it("records run, job, asset set, input and output digests, and verifies them", () => {
    const assets = assetsArtifact(RUN, manifest);
    expect(assets).toMatchObject({ version: 1, runId: RUN, jobId: RUN, assetSetDigest: assetSetDigest(manifest) });
    expect(assets.assets).toEqual(manifest.assets.map((a) => ({ assetId: a.assetId, sha256: a.sha256 })));
    expect(verifyAssets(assets, RUN, manifest)).toBe(true);
    expect(analyses).toMatchObject({ runId: RUN, jobId: RUN, assetSetDigest: assetSetDigest(manifest), inputDigest: assetSetDigest(manifest), outputDigest: digest({ photos: ANALYSES }) });
    expect(verifyAnalyses(analyses, RUN, manifest)).toEqual({ photos: ANALYSES });
    expect(images).toMatchObject({ candidate: "candidate-0", analysesDigest: analyses.outputDigest, profileDigest: digest(AMERICAN_EDITORIAL), outputDigest: digest(direction()) });
    expect(verifyImages(images, RUN, "candidate-0", manifest, analyses, AMERICAN_EDITORIAL)).toEqual(direction());
  });

  it("refuses another run, another job, another asset set, another candidate, another profile or analysis, and edited values", () => {
    const otherJob = manifestOf(3, "job-photo-2");
    const otherSet = fakeManifest(RUN, [ASSETS[0], { ...ASSETS[1], png: fakePng(480, 320, { seed: 9 }) }, ASSETS[2]]);
    expect(verifyAssets(assetsArtifact(RUN, manifest), "job-photo-other", manifest)).toBe(false);
    expect(verifyAssets(assetsArtifact(RUN, manifest), RUN, otherJob)).toBe(false);
    expect(verifyAssets(assetsArtifact(RUN, manifest), RUN, otherSet)).toBe(false);
    expect(verifyAnalyses(analyses, "job-photo-other", manifest)).toBeNull();
    expect(verifyAnalyses(analyses, RUN, otherSet)).toBeNull();
    expect(verifyAnalyses({ ...analyses, value: { photos: [ANALYSES[1], ANALYSES[0], ANALYSES[2]] } }, RUN, manifest)).toBeNull();
    expect(verifyAnalyses({ ...analyses, extra: 1 }, RUN, manifest)).toBeNull();
    expect(verifyImages(images, RUN, "candidate-1", manifest, analyses, AMERICAN_EDITORIAL)).toBeNull();
    expect(verifyImages(images, RUN, "candidate-0", manifest, analyses, { ...AMERICAN_EDITORIAL, confidence: 0.5 })).toBeNull();
    const otherAnalyses = analysesArtifact(RUN, manifest, { photos: [ANALYSES[0], { ...ANALYSES[1], brandFit: 1 }, ANALYSES[2]] });
    expect(verifyImages(images, RUN, "candidate-0", manifest, otherAnalyses, AMERICAN_EDITORIAL)).toBeNull();
    expect(verifyImages({ ...images, value: direction(3, { paletteFit: 1 }) }, RUN, "candidate-0", manifest, analyses, AMERICAN_EDITORIAL)).toBeNull();
    expect(verifyImages(images, RUN, "candidate-0", otherJob, analyses, AMERICAN_EDITORIAL)).toBeNull();
  });

  it("reuses an analysis only for the same verified asset set", () => {
    expect(reusableAnalyses(analyses, RUN, manifest)).toEqual({ photos: ANALYSES });
    expect(reusableAnalyses(analyses, RUN, manifestOf(2))).toBeNull();
    expect(reusableAnalyses(analyses, RUN, fakeManifest(RUN, [ASSETS[0], { ...ASSETS[1], id: "asset-dddddddddddddddddddddddd" }, ASSETS[2]]))).toBeNull();
    expect(reusableAnalyses(analyses, RUN, fakeManifest(RUN, [ASSETS[0], { ...ASSETS[1], png: fakePng(480, 320, { seed: 9 }) }, ASSETS[2]]))).toBeNull();
    expect(reusableAnalyses(undefined, RUN, manifest)).toBeNull();
  });
});

// ---------------------------------------------------------------- state machine and review schema

const photoReview = (over: Partial<PhotoReview> = {}): PhotoReview => ({
  ...review(),
  photo_scores: { image_selection: 4, crop: 4, focal_visibility: 4, text_image_collision: 5, image_repetition: 5, image_quality: 4, mobile_crop: 4, photo_brand_fit: 4 },
  photo_issues: [],
  revision_target: "none",
  ...over,
});
const revisedProfile = (accent: string): DesignProfile => ({ ...AMERICAN_EDITORIAL, palette: { ...AMERICAN_EDITORIAL.palette, accent } });

describe("revision state machine", () => {
  it("maps each target to what is regenerated (PhotoAnalysis never)", () => {
    expect(revisionPlan("none")).toEqual({ revise: false, profile: false, images: false, imageFeedback: false });
    expect(revisionPlan("images")).toEqual({ revise: true, profile: false, images: true, imageFeedback: true });
    expect(revisionPlan("profile")).toEqual({ revise: true, profile: true, images: true, imageFeedback: false });
    expect(revisionPlan("both")).toEqual({ revise: true, profile: true, images: true, imageFeedback: true });
  });

  it("has a structured target and no field for inventing placements or free photo notes", () => {
    expect(PhotoReviewSchema.safeParse(photoReview()).success).toBe(true);
    expect(PhotoReviewSchema.safeParse({ ...photoReview(), revision_target: "gallery" }).success).toBe(false);
    expect(PhotoReviewSchema.safeParse({ ...photoReview(), revised_image_direction: direction() }).success).toBe(false);
    expect(PhotoReviewSchema.safeParse({ ...photoReview(), photo_issues: [{ issue: "crop", severity: "high", note: "x" }] }).success).toBe(false);
    const schema = JSON.stringify(photoReviewJsonSchema());
    expect(schema).toContain("revision_target");
    expect(schema).not.toContain("revised_image_direction");
  });
});

// ---------------------------------------------------------------- render check

describe("render check: the page shows exactly what the direction says", () => {
  const manifest = manifestOf();
  const placedFor = (d: ImageDirection, over: (p: PlacedPhoto) => PlacedPhoto = (p) => p): PlacedPhoto[] =>
    (["desktop", "mobile"] as const).flatMap((device) => [
      ...(d.hero ? [{ assetId: d.hero.assetId, role: "hero" as const }] : []),
      ...d.features.map((f) => ({ assetId: f.assetId, role: f.slot })),
    ].map((p) => over({ ...p, device, visible: true, labelled: manifest.assets.find((a) => a.assetId === p.assetId)?.sourceKind === "generated_concept", overlapsText: false })));

  it("accepts the directed photos in their places on both devices", () => {
    expect(checkRenderedPhotos(direction(), manifest, placedFor(direction()))).toEqual([]);
  });

  it("refuses a missing, extra, misplaced, hidden, unlabelled or text-covering photo, or one device missing", () => {
    const d = direction();
    const all = placedFor(d);
    expect(checkRenderedPhotos(d, manifest, all.slice(1))).not.toEqual([]);
    expect(checkRenderedPhotos(d, manifest, [...all, { ...all[0], role: "about" }])).not.toEqual([]);
    expect(checkRenderedPhotos(d, manifest, placedFor(d, (p) => (p.role === "visit" ? { ...p, role: "about" } : p)))).not.toEqual([]);
    expect(checkRenderedPhotos(d, manifest, placedFor(d, (p) => (p.device === "mobile" && p.role === "hero" ? { ...p, visible: false } : p)))).not.toEqual([]);
    expect(checkRenderedPhotos(d, manifest, placedFor(d, (p) => ({ ...p, labelled: false })))).not.toEqual([]);
    expect(checkRenderedPhotos(d, manifest, placedFor(d, (p) => (p.role === "hero" ? { ...p, overlapsText: true } : p)))).not.toEqual([]);
    expect(checkRenderedPhotos(d, manifest, all.filter((p) => p.device === "desktop"))).not.toEqual([]);
    expect(checkRenderedPhotos(d, manifest, [...all, { ...all[0], assetId: "asset-dddddddddddddddddddddddd" }])).not.toEqual([]);
  });
});

// ---------------------------------------------------------------- the pipeline with photos

type Answer = unknown | CodexError;

function harness(answers: { codex?: Answer[]; photo?: Answer[] }, opts: { placed?: (candidate: string, d: ImageDirection | null) => PlacedPhoto[]; stored?: Record<string, unknown> } = {}) {
  const codex = [...(answers.codex ?? [])];
  const photo = [...(answers.photo ?? [])];
  const calls: string[] = [];
  const reviewImages: string[][] = [];
  const reviewPrompts: string[] = [];
  const records = new Map<string, unknown>(Object.entries(opts.stored ?? {}));
  const profiles = new Map<string, DesignProfile>();
  const rendered: string[] = [];
  const manifest = manifestOf();
  const take = (list: Answer[]) => {
    const next = list.shift();
    if (next instanceof CodexError) throw next;
    return next;
  };
  const deps: PipelineDeps = {
    askCodex: async ({ kind, images, prompt }) => {
      calls.push(kind);
      if (kind === "photo_review" || kind === "review") {
        reviewImages.push(images);
        reviewPrompts.push(prompt);
      }
      return take(codex);
    },
    askPhotoCodex: async ({ kind }) => {
      calls.push(kind);
      return take(photo);
    },
    writeProfile: async (name, p) => void profiles.set(name, p),
    writeRecord: async (name, value) => void records.set(name, value),
    readRecord: async (name) => records.get(name),
    render: async (candidate) => {
      rendered.push(candidate);
      return { desktop: `/shots/${candidate}-d.png`, mobile: `/shots/${candidate}-m.png` };
    },
    renderPhotos: async (candidate) => {
      rendered.push(candidate);
      const art = records.get(`${candidate}.images.json`) as { value: ImageDirection } | undefined;
      const d = art?.value ?? null;
      const placed = opts.placed
        ? opts.placed(candidate, d)
        : (["desktop", "mobile"] as const).flatMap((device) =>
            d
              ? [...(d.hero ? [{ assetId: d.hero.assetId, role: "hero" as const }] : []), ...d.features.map((f) => ({ assetId: f.assetId, role: f.slot }))].map((p) => ({
                  ...p,
                  device,
                  visible: true,
                  labelled: manifest.assets.find((a) => a.assetId === p.assetId)?.sourceKind === "generated_concept",
                  overlapsText: false,
                }))
              : [],
          );
      return { shots: { desktop: `/shots/${candidate}-d.png`, mobile: `/shots/${candidate}-m.png` }, sections: [`/shots/${candidate}-m-section-1.png`], placed };
    },
    log: () => undefined,
  };
  return { deps, calls, reviewImages, reviewPrompts, records, profiles, rendered, manifest };
}

const refs = ["/refs/1.png"];
const photosInput = (n = 3) => ({ runId: RUN, manifest: manifestOf(n), inputs: inputsOf(n) });
const analysesAnswer = (n = 3) => ({ photos: ANALYSES.slice(0, n) });

describe("runDesignPipeline with photos", () => {
  it("1, 2 and 3 photos, no revision: brief, analysis, direction, photo review — 4 Codex calls", async () => {
    for (const n of [1, 2, 3]) {
      const h = harness({ codex: [AMERICAN_EDITORIAL, photoReview({ verdict: "accept" })], photo: [analysesAnswer(n), direction(n)] });
      const report = await runDesignPipeline({ demo: SHOP, references: refs, photos: photosInput(n) }, h.deps);
      expect(report).toMatchObject({ status: "done", finalCandidate: "candidate-0", revisions: 0 });
      expect(h.calls).toEqual(["brief", "photo_analysis", "image_direction", "photo_review"]);
      expect(h.rendered).toEqual(["none", "candidate-0", "final"]);
      expect(h.records.has("assets.json")).toBe(true);
      expect(h.records.has("photo-analyses.json")).toBe(true);
      expect((h.records.get("candidate-0.images.json") as { value: ImageDirection }).value).toEqual(direction(n));
      expect((h.records.get("final.images.json") as { candidate: string; value: ImageDirection })).toMatchObject({ candidate: "final", value: direction(n) });
      // the review sees the references, both screenshots and the section crops
      expect(h.reviewImages[0]).toEqual([...refs, "/shots/candidate-0-d.png", "/shots/candidate-0-m.png", "/shots/candidate-0-m-section-1.png"]);
      expect(h.reviewPrompts[0]).toContain(`"layout": "split_hero"`);
      expect(report.photos).toMatchObject({ analysis: "done", finalLayout: "split_hero" });
    }
  });

  it("images target: keeps the profile, regenerates only the direction; analysis runs once", async () => {
    const h = harness({
      codex: [AMERICAN_EDITORIAL, photoReview({ verdict: "revise", revision_target: "images", photo_issues: [{ issue: "crop", severity: "high" }] }), photoReview({ verdict: "accept" })],
      photo: [analysesAnswer(), direction(), direction(3, { layout: "framed_hero" })],
    });
    const report = await runDesignPipeline({ demo: SHOP, references: refs, photos: photosInput() }, h.deps);
    expect(h.calls).toEqual(["brief", "photo_analysis", "image_direction", "photo_review", "image_direction", "photo_review"]);
    expect(report.revisions).toBe(1);
    expect(h.profiles.get("candidate-1")).toEqual(AMERICAN_EDITORIAL);
    expect((h.records.get("candidate-1.images.json") as { value: ImageDirection }).value.layout).toBe("framed_hero");
  });

  it("profile and both targets: profile first, then a new direction; two rounds at most in all", async () => {
    const h = harness({
      codex: [
        AMERICAN_EDITORIAL,
        photoReview({ verdict: "revise", revision_target: "profile", recommended_profile_changes: { summary: [], revised_profile: revisedProfile("#8A6A3A") } }),
        photoReview({ verdict: "revise", revision_target: "both", recommended_profile_changes: { summary: [], revised_profile: revisedProfile("#9A7A4A") }, photo_issues: [{ issue: "placement", severity: "medium" }] }),
        photoReview({ verdict: "revise", revision_target: "both", recommended_profile_changes: { summary: [], revised_profile: revisedProfile("#AA8A5A") } }),
        photoReview(),
      ],
      photo: [analysesAnswer(), direction(), direction(3, { layout: "framed_hero" }), direction(3, { layout: "type_hero_feature_band", hero: null, features: [{ ...place(B), slot: "about", side: "left" }], rejected: [A, C].map((assetId) => ({ assetId, reason: "not_needed" as const })) })],
    });
    const report = await runDesignPipeline({ demo: SHOP, references: refs, photos: photosInput(), maxRevisions: 5 }, h.deps);
    expect(h.calls).toEqual(["brief", "photo_analysis", "image_direction", "photo_review", "image_direction", "photo_review", "image_direction", "photo_review"]);
    expect(report.revisions).toBe(2);
    expect(h.profiles.get("candidate-1")?.palette.accent).toBe("#8A6A3A");
    expect(h.profiles.get("candidate-2")?.palette.accent).toBe("#9A7A4A");
    expect(h.calls.filter((c) => c === "photo_analysis")).toHaveLength(1);
  });

  it("none target or a missing revised profile stops; an invalid revised direction stops with the best so far", async () => {
    const none = harness({ codex: [AMERICAN_EDITORIAL, photoReview({ verdict: "revise", revision_target: "none" })], photo: [analysesAnswer(), direction()] });
    expect((await runDesignPipeline({ demo: SHOP, references: refs, photos: photosInput() }, none.deps)).notes).toContain("NO_REVISION_TARGET");
    const noProfile = harness({ codex: [AMERICAN_EDITORIAL, photoReview({ verdict: "revise", revision_target: "profile" })], photo: [analysesAnswer(), direction()] });
    expect((await runDesignPipeline({ demo: SHOP, references: refs, photos: photosInput() }, noProfile.deps)).notes).toContain("NO_REVISED_PROFILE");
    const badDirection = harness({ codex: [AMERICAN_EDITORIAL, photoReview({ verdict: "revise", revision_target: "images" })], photo: [analysesAnswer(), direction(), { ...direction(), layout: "gallery_grid" }] });
    const r = await runDesignPipeline({ demo: SHOP, references: refs, photos: photosInput() }, badDirection.deps);
    expect(r).toMatchObject({ status: "done", finalCandidate: "candidate-0", revisions: 0 });
    expect(r.notes).toContain("REVISION_IMAGE_DIRECTION_INVALID_1");
  });

  it("falls back to the page without photos (the DEV-028 loop) when the analysis or the first direction is unusable", async () => {
    for (const photo of [[{ photos: [] }], [analysesAnswer(), { ...direction(), caption: "x" }]]) {
      const h = harness({ codex: [AMERICAN_EDITORIAL, review()], photo });
      const report = await runDesignPipeline({ demo: SHOP, references: refs, photos: photosInput() }, h.deps);
      expect(report.status).toBe("done");
      expect(h.calls.at(-1)).toBe("review");
      expect(h.records.has("final.images.json")).toBe(false);
      expect(report.photos?.finalLayout ?? null).toBeNull();
    }
  });

  it("stops the job on an environment failure in a photo call, like the brief", async () => {
    const h = harness({ codex: [AMERICAN_EDITORIAL], photo: [new CodexError("CODEX_QUOTA", "x")] });
    expect((await runDesignPipeline({ demo: SHOP, references: refs, photos: photosInput() }, h.deps)).status).toBe("environment_failure");
  });

  it("blocks when the rendered page does not show what the direction says", async () => {
    const h = harness({ codex: [AMERICAN_EDITORIAL], photo: [analysesAnswer(), direction()] }, { placed: () => [] });
    const report = await runDesignPipeline({ demo: SHOP, references: refs, photos: photosInput() }, h.deps);
    expect(report.status).toBe("blocked");
    expect(report.notes).toContain("PHOTO_RENDER_MISMATCH");
    expect(h.calls).not.toContain("photo_review");
  });

  it("reuses a stored analysis of the same asset set (no call), and redoes one for another set", async () => {
    const manifest = manifestOf();
    const stored = { "photo-analyses.json": analysesArtifact(RUN, manifest, { photos: ANALYSES }) };
    const same = harness({ codex: [AMERICAN_EDITORIAL, photoReview()], photo: [direction()] }, { stored });
    const r = await runDesignPipeline({ demo: SHOP, references: refs, photos: photosInput() }, same.deps);
    expect(same.calls).toEqual(["brief", "image_direction", "photo_review"]);
    expect(r.photos?.analysis).toBe("reused");
    const staleStored = { "photo-analyses.json": analysesArtifact(RUN, manifestOf(2), { photos: ANALYSES.slice(0, 2) }) };
    const other = harness({ codex: [AMERICAN_EDITORIAL, photoReview()], photo: [analysesAnswer(), direction()] }, { stored: staleStored });
    await runDesignPipeline({ demo: SHOP, references: refs, photos: photosInput() }, other.deps);
    expect(other.calls).toEqual(["brief", "photo_analysis", "image_direction", "photo_review"]);
  });

  it("a page whose sections cannot hold a feature gets no feature (direction refused, page without photos)", async () => {
    const h = harness({ codex: [AMERICAN_EDITORIAL, review()], photo: [analysesAnswer(), direction()] });
    await runDesignPipeline({ demo: MINIMAL_SHOP, references: refs, photos: photosInput() }, h.deps);
    expect(h.calls.at(-1)).toBe("review");
  });

  it("without photos the DEV-028 loop runs exactly as before", async () => {
    const h = harness({ codex: [AMERICAN_EDITORIAL, review()] });
    const report = await runDesignPipeline({ demo: SHOP, references: refs }, h.deps);
    expect(h.calls).toEqual(["brief", "review"]);
    expect(report.photos).toBeUndefined();
    const empty = harness({ codex: [AMERICAN_EDITORIAL, review()] });
    await runDesignPipeline({ demo: SHOP, references: refs, photos: { runId: RUN, manifest: manifestOf(0), inputs: [] } }, empty.deps);
    expect(empty.calls).toEqual(["brief", "review"]);
  });
});
