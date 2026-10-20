import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SECOND_LOOK_MIN_MS } from "@/lib/design-agent/photo-pipeline";
import { QUALITY_NOT_ACCEPTED, runDesignPipeline, type PipelineDeps } from "@/lib/design-agent/pipeline";
import { DEFAULT_LAYOUT } from "@/lib/design-agent/layout";
import { DesignProfileCodexSchema, type DesignProfile, type Layout } from "@/lib/design-agent/profile";
import { notVisibleLine, VOCABULARY } from "@/lib/design-agent/prompts";
import { ACCENT_DIRECTIONS, NOT_IN_SCREENSHOTS, SURFACE_DIRECTIONS, VISIBLE_SETTINGS, visibleChanges } from "@/lib/design-agent/visible-profile";
import { CodexError } from "@/lib/design-agent/codex";
import { AMERICAN_EDITORIAL, review, SHOP } from "./fixtures";

// DEV-066: a revision that changes only settings the screenshots cannot show
// (motion, confidence, rationale; until DEV-067 also direction and alignment) renders the same page.
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
const NO_PHOTOS = { photos: false, demo: SHOP };
const invisible: DesignProfile = {
  ...AMERICAN_EDITORIAL,
  motion: { intro: AMERICAN_EDITORIAL.motion.intro === "none" ? "fade_rise" : "none", sectionFade: !AMERICAN_EDITORIAL.motion.sectionFade },
  confidence: 0.9,
  rationale: ["other words"],
};
const visible = (accent: string): DesignProfile => ({ ...AMERICAN_EDITORIAL, palette: { ...AMERICAN_EDITORIAL.palette, accent } });
const revise = (profile: DesignProfile | null, extra: object = {}) =>
  review({ verdict: "revise", brand_fit: 3, generic_template_feel: 3, recommended_profile_changes: { summary: [], revised_profile: profile }, ...extra });

describe("visibleChanges", () => {
  it("DEV-071b: the layout as the page draws it", () => {
    const withLayout = (layout: Layout): DesignProfile => ({ ...AMERICAN_EDITORIAL, layout });
    const p = withLayout(DEFAULT_LAYOUT);
    const s = DEFAULT_LAYOUT.sections;
    // no layout draws DEFAULT_LAYOUT
    expect(visibleChanges(AMERICAN_EDITORIAL, p, NO_PHOTOS)).toEqual([]);
    expect(visibleChanges(p, withLayout({ ...DEFAULT_LAYOUT, sections: [s[1], s[0], s[2]] }), NO_PHOTOS)).toEqual(["layout.sections"]);
    expect(visibleChanges(p, withLayout({ ...DEFAULT_LAYOUT, sections: [{ kind: "menu", variant: "chips", ground: "plain" }, s[0], s[2]] }), NO_PHOTOS)).toEqual(["layout.sections"]);
    expect(visibleChanges(p, withLayout({ ...DEFAULT_LAYOUT, firstView: "name_lead" }), NO_PHOTOS)).toEqual(["layout.firstView", "layout.sections"]);
    expect(visibleChanges(p, withLayout({ ...DEFAULT_LAYOUT, type: { scale: "dramatic", headings: "en_ja" } }), NO_PHOTOS)).toEqual(["layout.type.scale"]);
    expect(visibleChanges(p, withLayout({ ...DEFAULT_LAYOUT, type: { scale: "standard", headings: "ja_en" } }), NO_PHOTOS)).toEqual(["layout.type.headings"]);
    // not drawn for these facts: a first view without facts, a section without facts, vertical headings beside a short section
    expect(visibleChanges(p, withLayout({ ...DEFAULT_LAYOUT, firstView: "vertical_name" }), NO_PHOTOS)).toEqual([]);
    expect(visibleChanges(p, withLayout({ ...DEFAULT_LAYOUT, firstView: "name_menu" }), NO_PHOTOS)).toEqual([]);
    expect(visibleChanges(withLayout({ ...DEFAULT_LAYOUT, type: { scale: "standard", headings: "ja_only" } }), withLayout({ ...DEFAULT_LAYOUT, type: { scale: "standard", headings: "vertical_ja" } }), NO_PHOTOS)).toEqual([]);
    const minimal = { photos: false, demo: { ...SHOP, description: null, menuItems: [], address: null, hours: null, closedDays: null, access: null, phone: null } };
    expect(visibleChanges(p, withLayout({ ...DEFAULT_LAYOUT, sections: [{ kind: "about", variant: "statement", ground: "inverted" }] }), minimal)).toEqual([]);
    expect(visibleChanges(p, withLayout({ ...DEFAULT_LAYOUT, type: { scale: "dramatic", headings: "ja_only" } }), minimal)).toEqual([]);
    // boutique_minimal draws every section as a surface panel; a surface band there is a panel with
    // more space and no rule (renderer-sections-browser measures it), so it counts
    const boutique = (ground: "plain" | "surface" | "inverted"): DesignProfile => ({ ...p, direction: "boutique_minimal", layout: { ...DEFAULT_LAYOUT, sections: [{ ...s[0], ground }, s[1], s[2]] } });
    expect(visibleChanges(boutique("plain"), boutique("surface"), NO_PHOTOS)).toEqual(["layout.sections"]);
    expect(visibleChanges(boutique("plain"), boutique("inverted"), NO_PHOTOS)).toEqual(["layout.sections"]);
    // composition draws only on the sections that use it
    const grid = (q: DesignProfile, g: DesignProfile["composition"]["grid"]) => ({ ...q, composition: { ...q.composition, grid: g } });
    const info = (q: DesignProfile) => ({ ...q, composition: { ...q.composition, infoStyle: q.composition.infoStyle === "colophon" ? ("ruled_list" as const) : ("colophon" as const) } });
    // statement / stacked set their own columns, but the grid's gap still differs: visible (re-review Low)
    const allFixed = withLayout({ ...DEFAULT_LAYOUT, sections: [{ kind: "about", variant: "statement", ground: "plain" }, { kind: "visit", variant: "stacked", ground: "plain" }] });
    const shop = { photos: false, demo: { ...SHOP, menuItems: [] } };
    expect(visibleChanges(grid(allFixed, "editorial_12"), grid(allFixed, "asymmetric_7_5"), shop)).toEqual(["composition.grid"]);
    // vertical headings set their own columns and gap: the two grids draw the same page
    const long = { photos: false, demo: { ...SHOP, description: "あ".repeat(80), menuItems: ["a", "b", "c"] } };
    const vertical = withLayout({ ...DEFAULT_LAYOUT, type: { scale: "standard", headings: "vertical_ja" } });
    expect(visibleChanges(grid(vertical, "editorial_12"), grid(vertical, "asymmetric_7_5"), long)).toEqual([]);
    expect(visibleChanges(grid(vertical, "editorial_12"), grid(vertical, "single_column"), long)).toEqual(["composition.grid"]);
    // infoStyle: any visit section (colophon centres a one-row visit whatever its variant, re-review Medium)
    expect(visibleChanges(info(allFixed), allFixed, shop)).toEqual(["composition.infoStyle"]);
    expect(visibleChanges(info(p), p, NO_PHOTOS)).toEqual(["composition.infoStyle"]);
    const noVisit = withLayout({ ...DEFAULT_LAYOUT, sections: [DEFAULT_LAYOUT.sections[0], DEFAULT_LAYOUT.sections[1]] });
    const factsWithoutVisit = { photos: false, demo: { ...SHOP, address: null, access: null, phone: null, hours: null, closedDays: null } };
    expect(visibleChanges(info(noVisit), noVisit, factsWithoutVisit)).toEqual([]);
    // a page without sections: grid, info style and divider draw nothing
    expect(visibleChanges(grid(info(p), "single_column"), p, minimal)).toEqual([]);
    // a surface band shows the surface colour
    const surfaceBand = withLayout({ ...DEFAULT_LAYOUT, sections: [{ ...s[0], ground: "surface" }, s[1], s[2]] });
    expect(visibleChanges(surfaceBand, { ...surfaceBand, palette: { ...surfaceBand.palette, surface: "#000000" } }, NO_PHOTOS)).toEqual(["palette.surface"]);
    expect(visibleChanges(p, { ...p, palette: { ...p.palette, surface: "#000000" } }, NO_PHOTOS)).toEqual([]);
  });

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

  it("DEV-067: direction and alignment are visible changes", () => {
    const p = AMERICAN_EDITORIAL;
    expect(visibleChanges(p, { ...p, direction: p.direction === "gallery_mono" ? "craft_paper" : "gallery_mono" }, NO_PHOTOS)).toEqual(["direction"]);
    expect(visibleChanges(p, { ...p, heroLayout: { ...p.heroLayout, alignment: p.heroLayout.alignment === "left" ? "center" : "left" } }, NO_PHOTOS)).toEqual(["heroLayout.alignment"]);
  });

  it("DEV-067: the surface counts for the directions that draw panels in it, the accent for those that draw in it", () => {
    const p = { ...AMERICAN_EDITORIAL, motifs: ["monogram"] } as DesignProfile;
    const surface = (q: DesignProfile) => ({ ...q, palette: { ...q.palette, surface: "#000000" } });
    const accent = (q: DesignProfile) => ({ ...q, palette: { ...q.palette, accent: "#000000" } });
    for (const d of SURFACE_DIRECTIONS) expect(visibleChanges({ ...p, direction: d }, surface({ ...p, direction: d }), NO_PHOTOS)).toEqual(["palette.surface"]);
    for (const d of ACCENT_DIRECTIONS) expect(visibleChanges({ ...p, direction: d }, accent({ ...p, direction: d }), NO_PHOTOS)).toEqual(["palette.accent"]);
    const plain = { ...p, direction: "nordic_minimal" } as DesignProfile;
    expect(visibleChanges(plain, surface(plain), NO_PHOTOS)).toEqual([]);
    expect(visibleChanges(plain, accent(plain), NO_PHOTOS)).toEqual([]);
  });

  it("DEV-067 review: gallery_mono repaints the accent motifs, so its accent is not a visible change", () => {
    const g = { ...AMERICAN_EDITORIAL, direction: "gallery_mono", motifs: ["location_labels", "dot_grid"] } as DesignProfile;
    expect(visibleChanges(g, { ...g, palette: { ...g.palette, accent: "#000000" } }, NO_PHOTOS)).toEqual([]);
    // the same motifs under another direction draw the accent
    const n = { ...g, direction: "nordic_minimal" } as DesignProfile;
    expect(visibleChanges(n, { ...n, palette: { ...n.palette, accent: "#000000" } }, NO_PHOTOS)).toEqual(["palette.accent"]);
  });

  it("the lists match the stylesheet: the directions whose rules read the surface / accent colour", () => {
    const css = readFileSync(join(process.cwd(), "components/demo/profile/profile.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const reading = (token: string) =>
      new Set([...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[2]!.includes(`var(${token})`)).flatMap((m) => [...m[1]!.matchAll(/data-direction="([a-z_]+)"/g)].map((d) => d[1]!)));
    expect([...reading("--p-surface")].sort()).toEqual([...SURFACE_DIRECTIONS].sort());
    expect([...reading("--p-accent")].sort()).toEqual([...ACCENT_DIRECTIONS].sort());
  });

  it("surface counts only on pages with photos; accent only with a motif drawn in it", () => {
    const p = AMERICAN_EDITORIAL;
    const surface = { ...p, palette: { ...p.palette, surface: "#000000" } };
    expect(visibleChanges(p, surface, NO_PHOTOS)).toEqual([]);
    expect(visibleChanges(p, surface, { photos: true, demo: SHOP })).toEqual(["palette.surface"]);
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
    // Everything Codex chooses, the layout included (DEV-071b).
    const all = leaves(DesignProfileCodexSchema.shape as Record<string, unknown>).filter((k) => k !== "version");
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
    expect(VOCABULARY).toContain("Motion never shows in the review screenshots");
    expect(VOCABULARY).not.toContain("It is a name only");
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
