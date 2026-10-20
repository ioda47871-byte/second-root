import { describe, expect, it } from "vitest";
import { SECOND_LOOK_MIN_MS } from "@/lib/design-agent/photo-pipeline";
import { QUALITY_NOT_ACCEPTED, runDesignPipeline, type PipelineDeps } from "@/lib/design-agent/pipeline";
import { DesignProfileCoreSchema, type DesignProfile } from "@/lib/design-agent/profile";
import { notVisibleLine, VOCABULARY } from "@/lib/design-agent/prompts";
import { NOT_IN_SCREENSHOTS, VISIBLE_SETTINGS, visibleChanges } from "@/lib/design-agent/visible-profile";
import { CodexError } from "@/lib/design-agent/codex";
import { AMERICAN_EDITORIAL, review, SHOP } from "./fixtures";

// DEV-066: a revision that changes only settings the screenshots cannot show
// (direction, alignment, motion, confidence, rationale) renders the same page.
// The review is asked once more for a visible change; the scores, the verdict,
// the revision limit and the quality gate are unchanged.

function harness(answers: unknown[]) {
  const asked: Array<{ kind: string; prompt: string }> = [];
  const rendered: string[] = [];
  const logs: string[] = [];
  const deps: PipelineDeps = {
    askCodex: async ({ kind, prompt }) => {
      asked.push({ kind, prompt });
      return answers.shift();
    },
    writeProfile: async () => undefined,
    writeRecord: async () => undefined,
    render: async (candidate) => {
      rendered.push(candidate);
      return { desktop: `/shots/${candidate}-d.png`, mobile: `/shots/${candidate}-m.png` };
    },
    log: (line) => void logs.push(line),
  };
  return { deps, asked, rendered, logs };
}

const refs = ["/refs/ig-1.png"];
const NO_PHOTOS = { photos: false };
const invisible: DesignProfile = {
  ...AMERICAN_EDITORIAL,
  direction: AMERICAN_EDITORIAL.direction === "pop_bakeshop" ? "craft_paper" : "pop_bakeshop",
  heroLayout: { ...AMERICAN_EDITORIAL.heroLayout, alignment: AMERICAN_EDITORIAL.heroLayout.alignment === "left" ? "center" : "left" },
  motion: { intro: AMERICAN_EDITORIAL.motion.intro === "none" ? "fade_rise" : "none", sectionFade: !AMERICAN_EDITORIAL.motion.sectionFade },
  confidence: 0.9,
  rationale: ["other words"],
};
const visible = (accent: string): DesignProfile => ({ ...AMERICAN_EDITORIAL, palette: { ...AMERICAN_EDITORIAL.palette, accent } });
const revise = (profile: DesignProfile | null, extra: object = {}) =>
  review({ verdict: "revise", brand_fit: 3, generic_template_feel: 3, recommended_profile_changes: { summary: [], revised_profile: profile }, ...extra });

describe("visibleChanges", () => {
  it("ignores the settings the screenshots cannot show", () => {
    expect(visibleChanges(AMERICAN_EDITORIAL, invisible, NO_PHOTOS)).toEqual([]);
  });

  it("names each visible setting that changed; colours compare case-insensitively; motif order does not count", () => {
    const p = AMERICAN_EDITORIAL;
    expect(visibleChanges(p, visible("#123456"), NO_PHOTOS)).toEqual(["palette.accent"]);
    expect(visibleChanges(p, { ...p, palette: { ...p.palette, accent: p.palette.accent.toLowerCase() } }, NO_PHOTOS)).toEqual([]);
    expect(visibleChanges(p, { ...p, motifs: [...p.motifs].reverse() }, NO_PHOTOS)).toEqual([]);
    expect(visibleChanges(p, { ...p, spacing: { scale: p.spacing.scale === "tight" ? "generous" : "tight" } }, NO_PHOTOS)).toEqual(["spacing.scale"]);
  });

  it("surface counts only on pages with photos; accent only with a motif drawn in it", () => {
    const p = AMERICAN_EDITORIAL;
    const surface = { ...p, palette: { ...p.palette, surface: "#000000" } };
    expect(visibleChanges(p, surface, NO_PHOTOS)).toEqual([]);
    expect(visibleChanges(p, surface, { photos: true })).toEqual(["palette.surface"]);
    const plain = { ...p, motifs: ["monogram", "corner_marks"] } as DesignProfile;
    expect(visibleChanges(plain, { ...plain, palette: { ...plain.palette, accent: "#000000" } }, NO_PHOTOS)).toEqual([]);
    expect(visibleChanges(plain, { ...plain, motifs: ["monogram", "dot_grid"], palette: { ...plain.palette, accent: "#000000" } }, NO_PHOTOS)).toEqual(["palette.accent", "motifs"]);
  });

  it("every profile setting is either visible or listed as not in the screenshots", () => {
    const leaves = (shape: Record<string, unknown>, prefix = ""): string[] =>
      Object.entries(shape).flatMap(([k, v]) => {
        const inner = (v as { shape?: Record<string, unknown> }).shape;
        return inner ? leaves(inner, `${prefix}${k}.`) : [`${prefix}${k}`];
      });
    // The settings Codex chooses today. DEV-071b adds layout (Stage 1) to Codex's answer and to visibleChanges.
    const all = leaves(DesignProfileCoreSchema.shape as Record<string, unknown>).filter((k) => k !== "version");
    expect([...VISIBLE_SETTINGS, ...NOT_IN_SCREENSHOTS].sort()).toEqual(all.sort());
  });
});

describe("runDesignPipeline: revisions that change nothing visible (DEV-066)", () => {
  it("asks the same review once more; a visible revision then becomes candidate-1 with its changes recorded", async () => {
    const h = harness([AMERICAN_EDITORIAL, revise(invisible), revise(visible("#123456")), review()]);
    const report = await runDesignPipeline({ demo: SHOP, references: refs }, h.deps);
    expect(report.notes).toEqual(["REVISION_NOT_VISIBLE_1"]);
    expect(report.status).toBe("done");
    expect(report.revisions).toBe(1);
    expect(report.rounds.map((r) => [r.candidate, r.again ?? false, r.changed ?? null])).toEqual([
      ["candidate-0", false, null],
      ["candidate-0", true, null],
      ["candidate-1", false, ["palette.accent"]],
    ]);
    // the extra look renders nothing new: candidate-0 is rendered once
    expect(h.rendered).toEqual(["none", "candidate-0", "candidate-1", "final"]);
    const reviews = h.asked.filter((a) => a.kind === "review");
    expect(reviews[1]!.prompt).toContain(notVisibleLine("candidate-0"));
    expect(reviews[0]!.prompt).not.toContain(notVisibleLine("candidate-0"));
    expect(h.logs).toContain("candidate-1: changes palette.accent");
  });

  it("still nothing visible: stops with NO_VISIBLE_REVISION, and the gate blocks the unaccepted final", async () => {
    const h = harness([AMERICAN_EDITORIAL, revise(invisible), revise(invisible)]);
    const report = await runDesignPipeline({ demo: SHOP, references: refs }, h.deps);
    expect(report.notes).toEqual(["REVISION_NOT_VISIBLE_1", "NO_VISIBLE_REVISION", QUALITY_NOT_ACCEPTED]);
    expect(report.status).toBe("blocked");
    expect(report.revisions).toBe(0);
    expect(report.finalCandidate).toBe("candidate-0");
    expect(h.rendered).toEqual(["none", "candidate-0", "final"]);
  });

  it("the extra look may accept: the candidate is then accepted (the gate reads its latest verdict)", async () => {
    const h = harness([AMERICAN_EDITORIAL, revise(invisible), review()]);
    const report = await runDesignPipeline({ demo: SHOP, references: refs }, h.deps);
    expect(report.status).toBe("done");
    expect(report.notes).toEqual(["REVISION_NOT_VISIBLE_1"]);
    expect(report.finalCandidate).toBe("candidate-0");
  });

  it("no time for the extra look: REVISION_NOT_VISIBLE_NO_TIME, no further review", async () => {
    const h = harness([AMERICAN_EDITORIAL, revise(invisible)]);
    h.deps.timeLeftMs = () => SECOND_LOOK_MIN_MS - 1;
    const report = await runDesignPipeline({ demo: SHOP, references: refs }, h.deps);
    expect(report.notes).toEqual(["REVISION_NOT_VISIBLE_1", "REVISION_NOT_VISIBLE_NO_TIME", QUALITY_NOT_ACCEPTED]);
    expect(h.asked.filter((a) => a.kind === "review")).toHaveLength(1);
  });

  it("the revision limit is unchanged: at most 2 rendered revisions", async () => {
    const h = harness([AMERICAN_EDITORIAL, revise(visible("#111111")), revise(visible("#222222")), revise(visible("#333333"))]);
    const report = await runDesignPipeline({ demo: SHOP, references: refs }, h.deps);
    expect(report.revisions).toBe(2);
    expect(report.rounds.filter((r) => !r.again).map((r) => r.changed ?? null)).toEqual([null, ["palette.accent"], ["palette.accent"]]);
    expect(report.status).toBe("blocked");
  });

  it("the review prompt says which settings do not show", () => {
    expect(VOCABULARY).toContain("It is a name only: the page looks the same for every direction.");
    expect(VOCABULARY).toContain("recorded only; it does not change the page yet");
    expect(VOCABULARY).toContain("Motion never shows in the review screenshots");
  });

  it("the extra look does not move the leader (DEV-034: the leader is chosen like the final)", async () => {
    const h = harness([AMERICAN_EDITORIAL, revise(invisible), revise(visible("#111111"), { brand_fit: 4 }), revise(visible("#222222")), review()]);
    const report = await runDesignPipeline({ demo: SHOP, references: refs }, h.deps);
    expect(report.notes).toEqual(["REVISION_NOT_VISIBLE_1"]);
    expect(report.rounds.map((r) => [r.candidate, r.notVisible ?? false, r.scores.total])).toEqual([
      ["candidate-0", false, 18],
      ["candidate-0", true, 19],
      ["candidate-1", false, 18],
      ["candidate-2", false, 20],
    ]);
    expect(report.finalCandidate).toBe("candidate-2");
    expect(report.status).toBe("done");
  });

  it("after a revise-from-best second look, a revision with no visible change is checked against the best candidate", async () => {
    const lower = review({ verdict: "revise", brand_fit: 2, generic_template_feel: 3, recommended_profile_changes: { summary: [], revised_profile: visible("#333333") } });
    const h = harness([AMERICAN_EDITORIAL, revise(visible("#111111")), lower, revise(AMERICAN_EDITORIAL), revise(visible("#444444")), review()]);
    const report = await runDesignPipeline({ demo: SHOP, references: refs }, h.deps);
    expect(report.notes).toEqual(["REVISION_FROM_BEST_2", "REVISION_NOT_VISIBLE_2"]);
    expect(report.rounds.map((r) => [r.candidate, r.again ?? false, r.notVisible ?? false])).toEqual([
      ["candidate-0", false, false],
      ["candidate-1", false, false],
      ["candidate-0", true, false],
      ["candidate-0", true, true],
      ["candidate-2", false, false],
    ]);
    expect(report.rounds[4]!.changed).toEqual(["palette.accent"]);
    expect(report.status).toBe("done");
  });

  it("the extra look ends like any review: renderer change, no profile, an invalid answer, an error", async () => {
    const cases: Array<[unknown, string[]]> = [
      [revise(null, { needs_renderer_change: true, renderer_change_note: "x" }), ["REVISION_NOT_VISIBLE_1", "RENDERER_CHANGE_NEEDED"]],
      [revise(null), ["REVISION_NOT_VISIBLE_1", "NO_REVISED_PROFILE", QUALITY_NOT_ACCEPTED]],
      [{ verdict: "maybe" }, ["REVISION_NOT_VISIBLE_1", "REVIEW_INVALID_candidate-0_NOT_VISIBLE", QUALITY_NOT_ACCEPTED]],
      [new CodexError("CODEX_TIMEOUT", "x"), ["REVISION_NOT_VISIBLE_1", "REVIEW_CODEX_TIMEOUT", QUALITY_NOT_ACCEPTED]],
    ];
    for (const [answer, notes] of cases) {
      const answers: unknown[] = [AMERICAN_EDITORIAL, revise(invisible), answer];
      const h = harness([]);
      h.deps.askCodex = async () => {
        const next = answers.shift();
        if (next instanceof Error) throw next;
        return next;
      };
      const report = await runDesignPipeline({ demo: SHOP, references: refs }, h.deps);
      expect(report.notes).toEqual(notes);
      expect(report.status).toBe("blocked");
      expect(report.revisions).toBe(0);
    }
  });
});
