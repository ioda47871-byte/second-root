import { describe, expect, it } from "vitest";
import { BRIEF_STRUCTURE_RATIONALE, briefStructureOnDefault, CATEGORY_DEFAULT_PROFILES } from "@/lib/design-agent/defaults";
import { ALIGNMENTS, GRIDS, HERO_HEIGHTS, HERO_LAYOUTS, INFO_STYLES, SPACING_SCALES, type DesignProfile } from "@/lib/design-agent/profile";
import type { Category } from "@/lib/sales/types";
import { AMERICAN_EDITORIAL } from "./fixtures";

// DEV-044: a low-confidence brief keeps only its structural choices; everything else is the
// category default (.ai/reviews/DEV-044.md). The classification is pinned here leaf by leaf.

const CATEGORIES = Object.keys(CATEGORY_DEFAULT_PROFILES) as Category[];
/** The only leaves taken from the brief. */
const FROM_BRIEF = ["heroLayout.layout", "heroLayout.height", "heroLayout.alignment", "composition.grid", "composition.infoStyle", "spacing.scale"];

function leaves(value: unknown, prefix = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) for (const [p, x] of leaves(v, prefix ? `${prefix}.${k}` : k)) out.set(p, x);
  } else out.set(prefix, value);
  return out;
}

/** A low-confidence brief that differs from every default in every leaf it can. */
const BRIEF: DesignProfile = {
  ...AMERICAN_EDITORIAL,
  heroLayout: { layout: "stacked_oversized", height: "medium", alignment: "center" },
  composition: { grid: "asymmetric_7_5", infoStyle: "ledger_columns", divider: "thick_rule" },
  spacing: { scale: "tight" },
  motion: { intro: "letter_reveal", sectionFade: true },
  motifs: ["stamp_ring", "dot_grid"],
  confidence: 0.41,
  rationale: ["words from Codex that must not be kept"],
};

describe("briefStructureOnDefault (DEV-044)", () => {
  for (const category of CATEGORIES)
    it(`${category}: the six structural leaves come from the brief, every other leaf from the default`, () => {
      const base = CATEGORY_DEFAULT_PROFILES[category];
      const out = briefStructureOnDefault(BRIEF, category)!;
      expect(out).not.toBeNull();
      const got = leaves(out);
      const fromBrief = leaves(BRIEF);
      const fromBase = leaves(base);
      expect([...got.keys()].sort()).toEqual([...fromBase.keys()].sort());
      for (const [path, value] of got) {
        if (path === "rationale") continue;
        if (FROM_BRIEF.includes(path)) expect(value, path).toEqual(fromBrief.get(path));
        else expect(value, path).toEqual(fromBase.get(path));
      }
      expect(out.rationale).toEqual([BRIEF_STRUCTURE_RATIONALE]);
      expect(JSON.stringify(out)).not.toContain("words from Codex");
      // the brief's styling never leaks through
      expect(out.palette).toEqual(base.palette);
      expect(out.typography).toEqual(base.typography);
      expect(out.direction).toBe(base.direction);
      expect(out.motifs).toEqual(base.motifs);
      expect(out.composition.divider).toBe(base.composition.divider);
      expect(out.motion).toEqual(base.motion);
      expect(out.confidence).toBe(base.confidence);
    });

  it("every combination of the structural values on every category default passes the profile check", () => {
    let n = 0;
    for (const category of CATEGORIES)
      for (const layout of HERO_LAYOUTS)
        for (const height of HERO_HEIGHTS)
          for (const alignment of ALIGNMENTS)
            for (const grid of GRIDS)
              for (const infoStyle of INFO_STYLES)
                for (const scale of SPACING_SCALES) {
                  const brief = { ...BRIEF, heroLayout: { layout, height, alignment }, composition: { grid, infoStyle, divider: BRIEF.composition.divider }, spacing: { scale } };
                  const out = briefStructureOnDefault(brief, category);
                  expect(out, `${category} ${layout} ${height} ${alignment} ${grid} ${infoStyle} ${scale}`).not.toBeNull();
                  n++;
                }
    expect(n).toBe(CATEGORIES.length * 3 * 3 * 2 * 3 * 3 * 3);
  });

  it("does not change the category defaults themselves", () => {
    const before = JSON.stringify(CATEGORY_DEFAULT_PROFILES);
    for (const category of CATEGORIES) briefStructureOnDefault(BRIEF, category);
    expect(JSON.stringify(CATEGORY_DEFAULT_PROFILES)).toBe(before);
  });
});
