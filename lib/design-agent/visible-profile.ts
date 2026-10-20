import type { DesignProfile } from "./profile";

// DEV-066: which profile settings the review screenshots can show. The
// controlled run of 2026-10-20 ended with three candidates at 18/25 each;
// the renderer draws some settings nowhere a screenshot can see them:
// - direction is only a label (data-direction, no rule reads it)
// - heroLayout.alignment is written as data-align, no rule reads it
// - motion only runs under prefers-reduced-motion: no-preference, and the
//   shots are taken with reducedMotion "reduce"
// - confidence and rationale are never rendered
// A revision that changes only these renders the same page and spends a
// round on nothing. The quality bar (scores, verdict, gate) is unchanged.

/** Settings a revision can change without any change in the screenshots. */
export const NOT_IN_SCREENSHOTS = ["direction", "heroLayout.alignment", "motion.intro", "motion.sectionFade", "confidence", "rationale"] as const;

/** Every visible setting, as a dotted path (stable order). */
export const VISIBLE_SETTINGS = [
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

/** The visible settings that differ between two profiles (palette colours compare case-insensitively). */
export function visibleChanges(before: DesignProfile, after: DesignProfile): string[] {
  return VISIBLE_SETTINGS.filter((path) => !same(read(before, path), read(after, path)));
}
