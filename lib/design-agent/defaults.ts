import type { Category } from "@/lib/sales/types";
import { checkProfile, type DesignProfile } from "./profile";

// Calm per-category profiles, used when Codex answers with low confidence
// (the material said too little about the shop's style). Hand-made; checked
// by the same validator as Codex's answers (tests/unit/design-agent).

export const LOW_CONFIDENCE = 0.5;

const base = {
  version: 1,
  heroLayout: { layout: "centered_cover", height: "tall", alignment: "left" },
  composition: { grid: "editorial_12", infoStyle: "ruled_list", divider: "hairline" },
  spacing: { scale: "generous" },
  motion: { intro: "fade_rise", sectionFade: false },
  confidence: 1,
  rationale: ["Category default (not enough material about the shop's own style)."],
} satisfies Omit<DesignProfile, "direction" | "palette" | "typography" | "motifs">;

export const CATEGORY_DEFAULT_PROFILES: Record<Category, DesignProfile> = {
  bakery: {
    ...base,
    direction: "craft_paper",
    palette: { background: "#F3EADB", surface: "#FBF6EC", text: "#2E2117", primary: "#5A3A22", secondary: "#56603F", accent: "#8A5A33" },
    typography: { display: "mincho", body: "sans", displayCase: "as_is", displayWeight: "bold", tracking: "normal" },
    motifs: ["location_labels", "corner_marks"],
  },
  baked_goods: {
    ...base,
    direction: "editorial_luxury",
    palette: { background: "#F5EFE4", surface: "#FBF7EF", text: "#1F1614", primary: "#6D1F30", secondary: "#6F4B45", accent: "#B9777D" },
    typography: { display: "editorial_serif", body: "sans", displayCase: "as_is", displayWeight: "regular", tracking: "tight" },
    motifs: ["monogram", "location_labels"],
    composition: { grid: "editorial_12", infoStyle: "colophon", divider: "double_rule" },
  },
  cafe: {
    ...base,
    direction: "gallery_mono",
    palette: { background: "#F2EFEA", surface: "#FAF8F4", text: "#1E1F1D", primary: "#1E1F1D", secondary: "#5B5E58", accent: "#24473B" },
    typography: { display: "light_grotesk", body: "sans", displayCase: "as_is", displayWeight: "light", tracking: "tight" },
    heroLayout: { layout: "stacked_oversized", height: "tall", alignment: "left" },
    motifs: ["location_labels"],
  },
};

/** Fixed note on a combined profile (never rendered; removed before upload). */
export const BRIEF_STRUCTURE_RATIONALE =
  "Category default styling; hero layout, height and alignment, grid, information style and spacing from a low-confidence brief.";

/**
 * DEV-044: a low-confidence brief (schema-valid, checked, confidence < LOW_CONFIDENCE).
 * Only its structural choices are kept: the hero's layout / height / alignment, the grid,
 * the information style and the spacing scale. Everything brand-sensitive or without
 * evidence (direction, palette, typography, motifs, divider, motion, confidence) comes from
 * the category default. Field-by-field reasons: .ai/reviews/DEV-044.md.
 * Returns null if the combination fails the profile check (the caller then uses the default).
 */
export function briefStructureOnDefault(brief: DesignProfile, category: Category): DesignProfile | null {
  const base = CATEGORY_DEFAULT_PROFILES[category];
  const combined: DesignProfile = {
    ...base,
    heroLayout: { layout: brief.heroLayout.layout, height: brief.heroLayout.height, alignment: brief.heroLayout.alignment },
    composition: { grid: brief.composition.grid, infoStyle: brief.composition.infoStyle, divider: base.composition.divider },
    spacing: { scale: brief.spacing.scale },
    rationale: [BRIEF_STRUCTURE_RATIONALE],
  };
  const check = checkProfile(combined);
  return check.ok ? check.profile : null;
}
