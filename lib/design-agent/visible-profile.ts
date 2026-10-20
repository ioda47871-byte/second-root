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
] as const;

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
 * compare case-insensitively). Without photos (the DEV-028 loop) the settings
 * drawn only on photo pages do not count unless either profile's direction
 * draws them; the accent counts only when either profile has a motif or a
 * direction drawn in it.
 */
export function visibleChanges(before: DesignProfile, after: DesignProfile, options: { photos: boolean }): string[] {
  const has = (list: readonly string[], value: string) => list.includes(value);
  const accentShown = [before, after].some((p) => p.motifs.some((m) => has(ACCENT_MOTIFS, m)) || has(ACCENT_DIRECTIONS, p.direction));
  const surfaceShown = options.photos || [before, after].some((p) => has(SURFACE_DIRECTIONS, p.direction));
  const hidden: readonly string[] = [...(surfaceShown ? [] : ONLY_WITH_PHOTOS), ...(accentShown ? [] : ["palette.accent"])];
  return VISIBLE_SETTINGS.filter((path) => !hidden.includes(path) && !same(read(before, path), read(after, path)));
}
