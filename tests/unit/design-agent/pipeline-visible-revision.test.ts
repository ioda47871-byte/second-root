import { describe, expect, it } from "vitest";
import { SECOND_LOOK_MIN_MS } from "@/lib/design-agent/photo-pipeline";
import { QUALITY_NOT_ACCEPTED, runDesignPipeline, type PipelineDeps } from "@/lib/design-agent/pipeline";
import { DesignProfileSchema, type DesignProfile } from "@/lib/design-agent/profile";
import { notVisibleLine, VOCABULARY } from "@/lib/design-agent/prompts";
import { NOT_IN_SCREENSHOTS, VISIBLE_SETTINGS, visibleChanges } from "@/lib/design-agent/visible-profile";
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
    expect(visibleChanges(AMERICAN_EDITORIAL, invisible)).toEqual([]);
  });

  it("names each visible setting that changed; colours compare case-insensitively; motif order does not count", () => {
    const p = AMERICAN_EDITORIAL;
    expect(visibleChanges(p, visible("#123456"))).toEqual(["palette.accent"]);
    expect(visibleChanges(p, { ...p, palette: { ...p.palette, accent: p.palette.accent.toLowerCase() } })).toEqual([]);
    expect(visibleChanges(p, { ...p, motifs: [...p.motifs].reverse() })).toEqual([]);
    expect(visibleChanges(p, { ...p, spacing: { scale: p.spacing.scale === "tight" ? "generous" : "tight" } })).toEqual(["spacing.scale"]);
  });

  it("every profile setting is either visible or listed as not in the screenshots", () => {
    const leaves = (shape: Record<string, unknown>, prefix = ""): string[] =>
      Object.entries(shape).flatMap(([k, v]) => {
        const inner = (v as { shape?: Record<string, unknown> }).shape;
        return inner ? leaves(inner, `${prefix}${k}.`) : [`${prefix}${k}`];
      });
    const all = leaves(DesignProfileSchema.shape as Record<string, unknown>).filter((k) => k !== "version");
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
});
