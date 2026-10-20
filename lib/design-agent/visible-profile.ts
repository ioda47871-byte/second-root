import type { DemoView } from "@/lib/sales/demo-content";
import { DEFAULT_LAYOUT, normalizeLayout } from "./layout";
import type { DesignProfile } from "./profile";

// DEV-066: which profile settings the review screenshots can show. The
// controlled run of 2026-10-20 ended with three candidates at 18/25 each;
// the renderer draws some settings nowhere a screenshot can see them:
// - (until DEV-067) direction was only a label and heroLayout.alignment was
//   read by no rule; DEV-067 gives both a visual effect
// - motion only runs under prefers-reduced-motion: no-preference, and the
//   shots are taken with reducedMotion "reduce"
// - confidence and rationale are never rendered
// A revision that changes only these renders the same page and spends a
// round on nothing. The quality bar (scores, verdict, gate) is unchanged.

/** Settings a revision can change without any change in the screenshots. */
export const NOT_IN_SCREENSHOTS = ["motion.intro", "motion.sectionFade", "confidence", "rationale"] as const;

/**
 * DEV-066: settings the renderer draws only on a page with photos: the surface
 * colour is the ground of a photo frame (.photo). DEV-067: the directions in
 * SURFACE_DIRECTIONS draw panels in it too, with or without photos.
 */
export const ONLY_WITH_PHOTOS = ["palette.surface"] as const;
export const SURFACE_DIRECTIONS = ["kissaten_retro", "boutique_minimal", "pop_bakeshop"] as const;

/**
 * The motifs drawn in the accent colour (location label marks, the dot field,
 * the stamp ring, the pleated liner). With none of them the accent shows nowhere.
 */
export const ACCENT_MOTIFS = ["location_labels", "dot_grid", "stamp_ring", "muffin_paper_svg"] as const;
/** DEV-067: directions that draw in the accent colour whatever the motifs (french_classic's diamonds, pop_bakeshop's dots and shadows). */
export const ACCENT_DIRECTIONS = ["french_classic", "pop_bakeshop"] as const;
/** DEV-067: directions that repaint every accent motif in another colour (gallery_mono's hero draws them in the background colour). */
export const NO_ACCENT_DIRECTIONS = ["gallery_mono"] as const;

/** DEV-071b: section variants that set their own columns on desktop, whatever composition.grid says. */
export const FIXED_COLUMN_VARIANTS = ["statement", "stacked", "side_heading"] as const;

/** Every visible setting, as a dotted path (stable order). */
export const VISIBLE_SETTINGS = [
  "direction",
  "palette.background",
  "palette.surface",
  "palette.text",
  "palette.primary",
  "palette.secondary",
  "palette.accent",
  "typography.display",
  "typography.body",
  "typography.displayCase",
  "typography.displayWeight",
  "typography.tracking",
  "heroLayout.layout",
  "heroLayout.height",
  "heroLayout.alignment",
  "composition.grid",
  "composition.infoStyle",
  "composition.divider",
  "motifs",
  "spacing.scale",
  // DEV-071b: the layout, as the page draws it (normalized against the facts)
  "layout.firstView",
  "layout.sections",
  "layout.type.scale",
  "layout.type.headings",
] as const;

/**
 * The layout as the page draws it: normalized against the facts (sections without
 * facts left out, a first view without facts shown as the name alone, vertical
 * headings beside short sections set horizontally), and no type hierarchy on a page
 * without sections. Every ground counts: in boutique_minimal (sections drawn as
 * surface panels) a surface band is still a panel with more space and no rule.
 */
function drawnLayout(profile: DesignProfile, demo: DemoView) {
  const { layout } = normalizeLayout(profile.layout ?? DEFAULT_LAYOUT, demo);
  return {
    firstView: layout.firstView,
    sections: layout.sections.map((s) => ({ kind: s.kind, variant: s.variant, ground: s.ground })),
    type: layout.sections.length > 0 ? layout.type : null,
  };
}

function read(profile: DesignProfile, path: string): unknown {
  let value: unknown = profile;
  for (const key of path.split(".")) value = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  return value;
}

function same(a: unknown, b: unknown): boolean {
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  // motifs: the same set in another order draws the same page
  if (Array.isArray(a) && Array.isArray(b)) return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The visible settings that differ between two profiles (palette colours
 * compare case-insensitively; the layout as drawn for these facts, DEV-071b). Without photos (the DEV-028 loop) the settings
 * drawn only on photo pages do not count unless either profile's direction
 * draws them; the accent counts only when either profile has a motif or a
 * direction drawn in it (gallery_mono repaints the accent motifs).
 */
export function visibleChanges(before: DesignProfile, after: DesignProfile, options: { photos: boolean; demo: DemoView }): string[] {
  const has = (list: readonly string[], value: string) => list.includes(value);
  const drawn = [before, after].map((p) => ({ ...p, layout: drawnLayout(p, options.demo) }));
  const accentShown = [before, after].some(
    (p) => (!has(NO_ACCENT_DIRECTIONS, p.direction) && p.motifs.some((m) => has(ACCENT_MOTIFS, m))) || has(ACCENT_DIRECTIONS, p.direction),
  );
  // the surface colour also shows on a page with a surface band (DEV-071b)
  const surfaceShown = options.photos || drawn.some((p) => has(SURFACE_DIRECTIONS, p.direction) || p.layout.sections.some((s) => s.ground === "surface"));
  // DEV-071b: the composition settings draw only on the sections that use them (on both pages).
  // grid: none without sections; editorial_12 and asymmetric_7_5 differ only in the columns, which a
  // statement, stacked or side_heading section or vertical headings set themselves (both set the same
  // heading size). infoStyle: only the ledger (and split) visit. divider: only between two sections.
  const forced = (p: (typeof drawn)[number]) => p.layout.type?.headings === "vertical_ja" || p.layout.sections.every((x) => has(FIXED_COLUMN_VARIANTS, x.variant));
  const grids = new Set([before.composition.grid, after.composition.grid]);
  const gridHidden = drawn.every((p) => p.layout.sections.length === 0) || (grids.has("editorial_12") && grids.has("asymmetric_7_5") && drawn.every(forced));
  // (the split visit's location labels follow colophon's centring too)
  const ledgerShown = drawn.some((p) => p.layout.sections.some((x) => x.kind === "visit" && (x.variant === "ledger" || x.variant === "split")));
  const dividerShown = drawn.some((p) => p.layout.sections.length > 1);
  const hidden: readonly string[] = [
    ...(surfaceShown ? [] : ONLY_WITH_PHOTOS),
    ...(accentShown ? [] : ["palette.accent"]),
    ...(gridHidden ? ["composition.grid"] : []),
    ...(ledgerShown ? [] : ["composition.infoStyle"]),
    ...(dividerShown ? [] : ["composition.divider"]),
  ];
  return VISIBLE_SETTINGS.filter((path) => !hidden.includes(path) && !same(read(drawn[0] as DesignProfile, path), read(drawn[1] as DesignProfile, path)));
}
