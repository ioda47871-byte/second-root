import { describe, expect, it } from "vitest";
import { briefStructureOnDefault, CATEGORY_DEFAULT_PROFILES } from "@/lib/design-agent/defaults";
import { DEFAULT_LAYOUT } from "@/lib/design-agent/layout";
import { runDesignPipeline, type PipelineDeps } from "@/lib/design-agent/pipeline";
import { buildBriefPrompt, buildReviewPrompt, layoutOptionsLine } from "@/lib/design-agent/prompts";
import { checkProfile, type DesignProfile, type Layout } from "@/lib/design-agent/profile";
import type { DemoView } from "@/lib/sales/demo-content";
import { renderableProfile, uploadableProfile } from "@/lib/sales/design";
import { designBridgeRequest, workerJobIdFor } from "@/lib/sales/design-bridge-schema";
import { AMERICAN_EDITORIAL, MINIMAL_SHOP, review, SHOP } from "./fixtures";

// DEV-071b: Codex designs the layout; the pipeline normalizes it against the
// facts before rendering, reviewing, comparing and storing it, and records
// what changed with fixed codes. Fictional shops only.

function harness(answers: unknown[]) {
  const asked: Array<{ kind: string; prompt: string }> = [];
  const written: Record<string, DesignProfile> = {};
  const records: Record<string, unknown> = {};
  const deps: PipelineDeps = {
    askCodex: async ({ kind, prompt }) => {
      asked.push({ kind, prompt });
      return answers.shift();
    },
    writeProfile: async (name, profile) => void (written[name] = profile),
    writeRecord: async (name, value) => void (records[name] = value),
    render: async (candidate) => ({ desktop: `/shots/${candidate}-d.png`, mobile: `/shots/${candidate}-m.png` }),
    log: () => undefined,
  };
  return { deps, asked, written, records };
}

const refs = ["/refs/ig-1.png"];
const withLayout = (layout: Layout, over: Partial<DesignProfile> = {}): DesignProfile => ({ ...AMERICAN_EDITORIAL, ...over, layout });
const DESIGNED: Layout = {
  firstView: "name_lead",
  sections: [
    { kind: "menu", variant: "chips", ground: "inverted" },
    { kind: "about", variant: "statement", ground: "plain" },
    { kind: "hours", variant: "block", ground: "surface" },
    { kind: "visit", variant: "cards", ground: "plain" },
  ],
  type: { scale: "dramatic", headings: "ja_en" },
};
const revise = (profile: DesignProfile | null) => review({ verdict: "revise", brand_fit: 3, generic_template_feel: 3, recommended_profile_changes: { summary: [], revised_profile: profile } });

describe("pipeline with layouts (DEV-071b)", () => {
  it("renders, reviews and stores the layout as drawn, and records the adjustments with fixed codes", async () => {
    const h = harness([withLayout(DESIGNED), review()]);
    const report = await runDesignPipeline({ demo: SHOP, references: refs }, h.deps);
    expect(report.status).toBe("done");
    // name_lead puts the description in the hero: no about section
    expect(report.layoutAdjustments).toEqual([{ candidate: "brief", codes: ["about_in_first_view"] }]);
    const drawn = { ...DESIGNED, sections: DESIGNED.sections.filter((s) => s.kind !== "about") };
    expect(h.written["candidate-0"]?.layout).toEqual(drawn);
    expect(h.written.final?.layout).toEqual(drawn);
    expect(checkProfile(h.written.final).ok).toBe(true);
    // the review sees the profile that produced the screenshots
    expect(h.asked[1]?.prompt).toContain('"firstView": "name_lead"');
    expect(h.asked[1]?.prompt).not.toContain('"variant": "statement"');
    expect(JSON.stringify(report.layoutAdjustments)).toMatch(/^[\w:":,{}[\]\-]+$/);
  });

  it("keeps Codex's layout when the page has no section (a valid stored layout needs one); the renderer normalizes it", async () => {
    const h = harness([withLayout(DESIGNED), review()]);
    const report = await runDesignPipeline({ demo: MINIMAL_SHOP, references: refs }, h.deps);
    expect(report.layoutAdjustments[0]?.codes).toEqual(["first_view:name_lead", "dropped:menu", "dropped:about", "dropped:hours", "dropped:visit"]);
    expect(h.written["candidate-0"]?.layout).toEqual(DESIGNED);
  });

  it("an answer without a layout draws the page before Stage 1 and is recorded as layout:missing", async () => {
    const h = harness([AMERICAN_EDITORIAL, review()]);
    const report = await runDesignPipeline({ demo: SHOP, references: refs }, h.deps);
    expect(report.status).toBe("done");
    expect(report.layoutAdjustments).toEqual([{ candidate: "brief", codes: ["layout:missing"] }]);
    expect(h.written.final?.layout).toBeUndefined();
  });

  it("a revision whose layout change the facts cannot show is not visible: the review is asked once more", async () => {
    const base = withLayout(DEFAULT_LAYOUT);
    // SHOP's name is Latin: vertical_name is drawn as the name alone
    const invisible = withLayout({ ...DEFAULT_LAYOUT, firstView: "vertical_name" });
    const visible = withLayout({ ...DEFAULT_LAYOUT, sections: [DEFAULT_LAYOUT.sections[1], DEFAULT_LAYOUT.sections[0], DEFAULT_LAYOUT.sections[2]] });
    const h = harness([base, revise(invisible), revise(visible), review()]);
    const report = await runDesignPipeline({ demo: SHOP, references: refs }, h.deps);
    expect(report.notes).toEqual(["REVISION_NOT_VISIBLE_1"]);
    expect(report.rounds.map((r) => [r.candidate, r.again ?? false, r.changed ?? null])).toEqual([
      ["candidate-0", false, null],
      ["candidate-0", true, null],
      ["candidate-1", false, ["layout.sections"]],
    ]);
    expect(report.layoutAdjustments).toEqual([]);
    expect(h.asked[2]?.prompt).toContain("or the layout's sections, first view or type");
  });

  it("records the adjustments of a revised candidate", async () => {
    const h = harness([withLayout(DEFAULT_LAYOUT), revise(withLayout({ ...DEFAULT_LAYOUT, firstView: "name_hours", type: { scale: "standard", headings: "vertical_ja" } })), review()]);
    const report = await runDesignPipeline({ demo: SHOP, references: refs }, h.deps);
    // SHOP's description is short: vertical headings fall back to ja_only
    expect(report.layoutAdjustments).toEqual([{ candidate: "candidate-1", codes: ["headings:vertical_ja"] }]);
    expect(report.rounds.at(-1)?.changed).toEqual(["layout.firstView", "layout.type.headings"]);
    expect(h.written["candidate-1"]?.layout?.type.headings).toBe("ja_only");
  });

  it("a low-confidence brief keeps its page structure; grounds and type come from the category default", async () => {
    const brief = withLayout(DESIGNED, { confidence: 0.3 });
    const combined = briefStructureOnDefault(brief, "baked_goods")!;
    expect(combined.layout).toEqual({ firstView: "name_lead", sections: DESIGNED.sections.map((s) => ({ ...s, ground: "plain" })), type: CATEGORY_DEFAULT_PROFILES.baked_goods.layout!.type });
    // without a layout in the brief: the default's
    expect(briefStructureOnDefault({ ...brief, layout: undefined }, "bakery")!.layout).toEqual(DEFAULT_LAYOUT);
    const h = harness([brief, review()]);
    const report = await runDesignPipeline({ demo: SHOP, references: refs }, h.deps);
    expect(report.profileSource).toBe("category_default_brief_structure");
    expect(h.written["candidate-0"]?.layout?.sections.map((s) => [s.kind, s.ground])).toEqual([["menu", "plain"], ["hours", "plain"], ["visit", "plain"]]);
    for (const p of Object.values(CATEGORY_DEFAULT_PROFILES)) expect(p.layout).toEqual(DEFAULT_LAYOUT);
  });
});

describe("the stored form (DEV-071b)", () => {
  it("a worst-case profile with the largest layout passes the bridge and the server checks and stays far below 8192 bytes", () => {
    const biggest: Layout = {
      firstView: "vertical_name",
      sections: [
        { kind: "visit", variant: "stacked", ground: "inverted" },
        { kind: "about", variant: "side_heading", ground: "inverted" },
        { kind: "menu", variant: "feature_first", ground: "inverted" },
        { kind: "hours", variant: "strip", ground: "inverted" },
      ],
      type: { scale: "dramatic", headings: "vertical_ja" },
    };
    const worst: DesignProfile = { ...AMERICAN_EDITORIAL, motifs: ["monogram", "location_labels", "muffin_paper_svg", "corner_marks"], layout: biggest };
    const stored = uploadableProfile(worst);
    const request = { action: "submit", jobId: "00000000-0000-4000-8000-000000000000", outcome: "ready", profile: stored, errorCode: null, workerCommit: null, lineage: { workerJobId: workerJobIdFor("00000000-0000-4000-8000-000000000000") } };
    expect(designBridgeRequest.safeParse(request).success).toBe(true);
    expect(renderableProfile({ enabled: true, status: "ready", profile: stored })).toEqual(stored);
    // jsonb (pg_column_size) stays close to the text size; the column allows 8192
    expect(Buffer.byteLength(JSON.stringify(stored))).toBeLessThan(2048);
    // the worst rationale never leaves the PC; even with it the profile is far below the limit
    expect(Buffer.byteLength(JSON.stringify({ ...worst, rationale: Array(4).fill("あ".repeat(160)) }))).toBeLessThan(4096);
  });
});

describe("layout options in the prompts (DEV-071b)", () => {
  const shops: Record<string, DemoView> = { full: SHOP, minimal: MINIMAL_SHOP, long_menu: { ...SHOP, name: "架空菓子店", menuItems: ["a", "b", "c", "d"] } };

  it("lists the sections and first views the facts support, in fixed words only", () => {
    expect(layoutOptionsLine(SHOP)).toBe(
      "This shop's facts support these sections: about, menu, hours, visit (the opening hours go in the hours section if you choose one, otherwise in visit). First views: name_only, name_lead, name_hours.",
    );
    expect(layoutOptionsLine(shops.long_menu!)).toContain("name_menu (only if the menu section is not the first section), vertical_name");
    expect(layoutOptionsLine(MINIMAL_SHOP)).toBe("This shop's facts support these sections: none (the page is the hero only; layout.sections is still required, and none of them is drawn). First views: name_only.");
    for (const demo of Object.values(shops)) {
      const line = layoutOptionsLine(demo);
      for (const fact of [demo.name, demo.description, demo.address, demo.hours, ...demo.menuItems].filter((v): v is string => Boolean(v) && v!.length > 1)) expect(line).not.toContain(fact);
    }
  });

  it("puts the options line and the layout vocabulary in the brief and the review", () => {
    const brief = buildBriefPrompt({ demo: SHOP, referenceCount: 1, currentDemoCount: 2 });
    const reviewPrompt = buildReviewPrompt({ demo: SHOP, profile: AMERICAN_EDITORIAL, referenceCount: 1, round: 0, maxRevisions: 2 });
    for (const prompt of [brief, reviewPrompt]) {
      expect(prompt).toContain(layoutOptionsLine(SHOP));
      expect(prompt).toContain("layout.sections: the sections in the order you choose");
      expect(prompt).not.toContain("The page always has, in this order");
    }
  });
});
