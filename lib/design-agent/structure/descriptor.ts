/**
 * Phase 2b (DEV-125): a structure descriptor of a page in 8 aspects, and the overlap checks built on it.
 *
 * The vocabulary is PROVISIONAL (Issue #159: offline only; fixing it, and any use by a generator, is a separate
 * approval). It extends the research comparison (design-library/intelligence/v02/structure-audit.mjs: hero, navigation,
 * reading path, section layouts and their order) to 8 aspects.
 *
 * What the checks are for: telling when a new design is the same skeleton as an earlier one (a success case it must
 * not copy, or the other direction for the same shop), and when it is the generic landing-page skeleton. A result is
 * advisory structure data; it never says a design is good (only the owner decides that).
 *
 * Pure: zod only. Measuring a rendered page is measure.ts.
 */
import { z } from "zod";

export const VOCABULARY = {
  hero: ["object_led", "type_led", "diagram_led", "scene_led", "split_copy_media", "centered_headline"],
  flow: ["single_axis_scroll", "map_of_stations", "alternating_spreads", "one_continuous_surface", "stacked_bands"],
  navigation: ["top_bar", "side_index", "inline", "none"],
  reading_path: ["vertical_axis", "z_pattern", "f_pattern", "radial", "free"],
  section_layout: ["full_bleed_media", "split_copy_media", "single_column_text", "grid_cards", "overlap_collage", "diagram", "vertical_text"],
  transition: ["hard_cut", "overlap", "continuous"],
  text_direction: ["horizontal", "vertical", "mixed"],
  imagery: ["none", "single_lead", "sequence", "collage", "drawn"],
} as const;

/** The parts of the vocabulary that mark the generic landing page. */
export const GENERIC = {
  hero: new Set<string>(["split_copy_media", "centered_headline"]),
  flow: new Set<string>(["stacked_bands"]),
  section_layout: new Set<string>(["split_copy_media", "grid_cards"]),
};

const Source = z.enum(["declared", "measured"]);
const one = <T extends readonly [string, ...string[]]>(values: T) => z.strictObject({ value: z.enum(values), source: Source });
const many = <T extends readonly [string, ...string[]]>(values: T) => z.strictObject({ value: z.array(z.enum(values)).max(40), source: Source });

/** One aspect is null when it was neither declared nor measurable (it then counts as "different", never as a match). */
export const StructureDescriptor = z.strictObject({
  schema: z.literal("structure_descriptor_v0"),
  hero: one(VOCABULARY.hero).nullable(),
  flow: one(VOCABULARY.flow).nullable(),
  navigation: one(VOCABULARY.navigation).nullable(),
  reading_path: one(VOCABULARY.reading_path).nullable(),
  section_layouts: many(VOCABULARY.section_layout).nullable(),
  transitions: many(VOCABULARY.transition).nullable(),
  text_direction: one(VOCABULARY.text_direction).nullable(),
  imagery: one(VOCABULARY.imagery).nullable(),
});
export type StructureDescriptor = z.infer<typeof StructureDescriptor>;
type Aspect = Exclude<keyof StructureDescriptor, "schema">;
export const ASPECTS: readonly Aspect[] = ["hero", "flow", "navigation", "reading_path", "section_layouts", "transitions", "text_direction", "imagery"];

/** Weights of the similarity (sum 1). The skeleton-level aspects weigh most. */
const WEIGHTS = { hero: 0.2, flow: 0.15, navigation: 0.05, reading_path: 0.1, section_layouts: 0.2, layout_sequence: 0.1, transitions: 0.1, text_direction: 0.05, imagery: 0.05 } as const;

export function multisetOverlap(a: readonly string[], b: readonly string[]): number {
  const count = (xs: readonly string[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>());
  const ac = count(a);
  const bc = count(b);
  let inter = 0;
  let union = 0;
  for (const k of new Set([...ac.keys(), ...bc.keys()])) {
    inter += Math.min(ac.get(k) ?? 0, bc.get(k) ?? 0);
    union += Math.max(ac.get(k) ?? 0, bc.get(k) ?? 0);
  }
  return union ? inter / union : 1;
}

const edges = (xs: readonly string[]) => xs.slice(1).map((x, i) => `${xs[i]}>${x}`);

/** 0 (nothing shared) .. 1 (same skeleton). An aspect unknown on either side contributes 0. */
export function structuralSimilarity(a: StructureDescriptor, b: StructureDescriptor): number {
  const eq = (k: Exclude<Aspect, "section_layouts" | "transitions">) => (a[k] && b[k] && a[k]!.value === b[k]!.value ? 1 : 0);
  const la = a.section_layouts?.value;
  const lb = b.section_layouts?.value;
  const ta = a.transitions?.value;
  const tb = b.transitions?.value;
  const s =
    WEIGHTS.hero * eq("hero") +
    WEIGHTS.flow * eq("flow") +
    WEIGHTS.navigation * eq("navigation") +
    WEIGHTS.reading_path * eq("reading_path") +
    WEIGHTS.section_layouts * (la && lb ? multisetOverlap(la, lb) : 0) +
    WEIGHTS.layout_sequence * (la && lb ? multisetOverlap(edges(la), edges(lb)) : 0) +
    WEIGHTS.transitions * (ta && tb ? multisetOverlap(ta, tb) : 0) +
    WEIGHTS.text_direction * eq("text_direction") +
    WEIGHTS.imagery * eq("imagery");
  return Math.round(s * 1000) / 1000;
}

/** Provisional thresholds (Issue #159: to be fixed with the vocabulary). */
export const THRESHOLDS = { too_close_to_reference: 0.75, siblings_same_skeleton: 0.6 } as const;

export type StructureFinding =
  | { code: "TOO_CLOSE_TO_REFERENCE"; reference: string; similarity: number }
  | { code: "SIBLINGS_SAME_SKELETON"; sibling: string; similarity: number }
  | { code: "GENERIC_SKELETON"; reasons: string[] }
  | { code: "ASPECTS_UNKNOWN"; aspects: Aspect[] };

/**
 * Advisory checks of one design against the references it must not copy and the other direction(s) of the same shop.
 * An empty list means only that none of these structural patterns was found.
 */
export function structureFindings(candidate: StructureDescriptor, o: { references?: Record<string, StructureDescriptor>; siblings?: Record<string, StructureDescriptor> } = {}): StructureFinding[] {
  const out: StructureFinding[] = [];
  for (const [id, ref] of Object.entries(o.references ?? {})) {
    const s = structuralSimilarity(candidate, ref);
    if (s >= THRESHOLDS.too_close_to_reference) out.push({ code: "TOO_CLOSE_TO_REFERENCE", reference: id, similarity: s });
  }
  for (const [id, sib] of Object.entries(o.siblings ?? {})) {
    const s = structuralSimilarity(candidate, sib);
    if (s >= THRESHOLDS.siblings_same_skeleton) out.push({ code: "SIBLINGS_SAME_SKELETON", sibling: id, similarity: s });
  }
  const reasons: string[] = [];
  if (candidate.hero && GENERIC.hero.has(candidate.hero.value)) reasons.push(`hero:${candidate.hero.value}`);
  if (candidate.flow && GENERIC.flow.has(candidate.flow.value)) reasons.push(`flow:${candidate.flow.value}`);
  const layouts = candidate.section_layouts?.value ?? [];
  const generic = layouts.filter((l) => GENERIC.section_layout.has(l)).length;
  if (layouts.length && generic / layouts.length >= 0.5) reasons.push(`section_layouts:${generic}/${layouts.length}`);
  // a generic hero alone is not the generic skeleton; with a generic flow or mostly generic sections it is
  if (reasons.length >= 2) out.push({ code: "GENERIC_SKELETON", reasons });
  const unknown = ASPECTS.filter((k) => candidate[k] === null);
  if (unknown.length) out.push({ code: "ASPECTS_UNKNOWN", aspects: unknown });
  return out;
}
