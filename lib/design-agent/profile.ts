import { z } from "zod";

// Design profile (DEV-028): how a demo looks, never what it says. Codex acts
// as the art director and may only combine the values defined here; every
// value maps to something the shared renderer
// (components/demo/profile/ProfileRenderer.tsx) already draws. Shop text
// always comes from the fact-only DemoView, never from a profile.
//
// The same zod schema validates Codex's answer and produces the JSON Schema
// given to `codex exec --output-schema`, so the two cannot drift.

export const DIRECTIONS = [
  "american_editorial",
  "editorial_luxury",
  "french_classic",
  "nordic_minimal",
  "japanese_modern",
  "kissaten_retro",
  "gallery_mono",
  "craft_paper",
  "boutique_minimal",
  "pop_bakeshop",
] as const;

export const DISPLAY_FACES = ["editorial_serif", "condensed_grotesk", "light_grotesk", "mincho"] as const;
export const BODY_FACES = ["sans", "serif"] as const;
export const DISPLAY_CASES = ["as_is", "uppercase"] as const;
export const DISPLAY_WEIGHTS = ["light", "regular", "bold", "black"] as const;
export const TRACKINGS = ["tight", "normal", "wide"] as const;

export const HERO_LAYOUTS = ["split_crop", "stacked_oversized", "centered_cover"] as const;
export const HERO_HEIGHTS = ["full", "tall", "medium"] as const;

export const GRIDS = ["editorial_12", "asymmetric_7_5", "single_column"] as const;
export const INFO_STYLES = ["ruled_list", "colophon", "ledger_columns"] as const;
export const DIVIDERS = ["hairline", "double_rule", "thick_rule", "none"] as const;
export const ALIGNMENTS = ["left", "center"] as const;

export const MOTIFS = [
  "monogram",
  "location_labels",
  "muffin_paper_svg",
  "ruled_frame",
  "dot_grid",
  "stamp_ring",
  "corner_marks",
] as const;

export const SPACING_SCALES = ["generous", "standard", "tight"] as const;
export const INTROS = ["none", "fade_rise", "rule_expand", "letter_reveal"] as const;

const hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

export const PaletteSchema = z.strictObject({
  background: hex,
  surface: hex,
  text: hex,
  primary: hex,
  secondary: hex,
  accent: hex,
});

// ---------------------------------------------------------------- layout (DEV-071, Stage 1)
//
// The Design Spec: which sections the page has and in what order, how each is
// set (variant) and on what ground, the type hierarchy and the first view.
// Sections are drawn only when the shop's facts give them content
// (lib/design-agent/layout.ts normalizes every layout before rendering), and
// every word on them is a fact or a fixed heading word.

export const SECTION_KINDS = ["about", "menu", "hours", "visit"] as const;
export const SECTION_VARIANTS = {
  about: ["lead", "statement", "side_heading"],
  menu: ["numbered", "chips", "columns", "feature_first"],
  hours: ["strip", "block"],
  visit: ["ledger", "cards", "split", "stacked"],
} as const;
export const GROUNDS = ["plain", "surface", "inverted"] as const;
export const FIRST_VIEWS = ["name_only", "name_lead", "name_hours", "name_menu", "vertical_name"] as const;
export const TYPE_SCALES = ["quiet", "standard", "dramatic"] as const;
export const HEADING_STYLES = ["en_ja", "ja_en", "ja_only", "vertical_ja"] as const;

const section = <K extends (typeof SECTION_KINDS)[number]>(kind: K) =>
  z.strictObject({ kind: z.literal(kind), variant: z.enum(SECTION_VARIANTS[kind]), ground: z.enum(GROUNDS) });

// A plain union (JSON Schema anyOf): Codex's structured output takes anyOf, not the
// oneOf a discriminated union emits. The kinds are literals, so one branch matches.
export const SectionSchema = z.union([section("about"), section("menu"), section("hours"), section("visit")]);

export const LayoutSchema = z.strictObject({
  firstView: z.enum(FIRST_VIEWS),
  sections: z
    .array(SectionSchema)
    .min(1)
    .max(SECTION_KINDS.length)
    .refine((list) => new Set(list.map((s) => s.kind)).size === list.length, { message: "section kinds repeat" }),
  type: z.strictObject({ scale: z.enum(TYPE_SCALES), headings: z.enum(HEADING_STYLES) }),
});

/**
 * DEV-071b: a layout inside a review's answer, before its revised profile is
 * checked: any number of sections, kinds may repeat. The pipeline collapses
 * repeats (collapseRepeatedSections, duplicate:<kind>) and then checks the
 * revised profile with DesignProfileSchema, so a repeat never rejects the review.
 */
export const LayoutAnswerSchema = LayoutSchema.extend({ sections: z.array(SectionSchema).min(1) });

export type SectionKind = (typeof SECTION_KINDS)[number];
export type LayoutSection = z.infer<typeof SectionSchema>;
export type Layout = z.infer<typeof LayoutSchema>;

/** The profile's settings without `layout` (the part every profile has had since DEV-028). */
export const DesignProfileCoreSchema = z.strictObject({
  version: z.literal(1),
  direction: z.enum(DIRECTIONS),
  palette: PaletteSchema,
  typography: z.strictObject({
    display: z.enum(DISPLAY_FACES),
    body: z.enum(BODY_FACES),
    displayCase: z.enum(DISPLAY_CASES),
    displayWeight: z.enum(DISPLAY_WEIGHTS),
    tracking: z.enum(TRACKINGS),
  }),
  heroLayout: z.strictObject({
    layout: z.enum(HERO_LAYOUTS),
    height: z.enum(HERO_HEIGHTS),
    alignment: z.enum(ALIGNMENTS),
  }),
  composition: z.strictObject({
    grid: z.enum(GRIDS),
    infoStyle: z.enum(INFO_STYLES),
    divider: z.enum(DIVIDERS),
  }),
  motifs: z.array(z.enum(MOTIFS)).max(4),
  spacing: z.strictObject({ scale: z.enum(SPACING_SCALES) }),
  motion: z.strictObject({ intro: z.enum(INTROS), sectionFade: z.boolean() }),
  confidence: z.number().min(0).max(1),
  /** Short design rationale (no chain of thought). Kept locally; never rendered. */
  rationale: z.array(z.string().max(160)).max(4),
});

/**
 * A stored or rendered profile. `layout` is optional: profiles saved before
 * Stage 1 have none and render the fixed page (DEFAULT_LAYOUT). The version
 * stays 1 (the database keeps version = '1' and at most 8192 bytes).
 */
export const DesignProfileSchema = DesignProfileCoreSchema.extend({ layout: LayoutSchema.optional() });

/**
 * DEV-071b: what Codex must answer (the brief, a review's revised profile):
 * the profile with its layout required. Only the JSON Schema given to
 * `codex exec --output-schema` is made from it; answers are parsed with
 * DesignProfileSchema (a stored profile without a layout stays valid and draws
 * the page before Stage 1).
 */
export const DesignProfileCodexSchema = DesignProfileCoreSchema.extend({ layout: LayoutSchema });

/** DEV-071b: the revised profile as a review's answer is parsed (repeated kinds collapsed later). */
export const DesignProfileAnswerSchema = DesignProfileCoreSchema.extend({ layout: LayoutAnswerSchema.optional() });

export type DesignProfile = z.infer<typeof DesignProfileSchema>;
export type Palette = z.infer<typeof PaletteSchema>;

/** JSON Schema for `codex exec --output-schema`: the profile with its layout required (DEV-071b). */
export function designProfileJsonSchema(): object {
  return withoutMeta(z.toJSONSchema(DesignProfileCodexSchema));
}

export function withoutMeta(schema: object): object {
  const { $schema: _ignored, ...rest } = schema as Record<string, unknown>;
  void _ignored;
  return rest;
}

/**
 * Codex may be stricter about JSON Schema keywords than zod emits. This
 * copy drops length / range / pattern limits (zod still enforces them on the
 * answer), for `--schema-mode=loose` if the strict schema is refused.
 */
export function looseJsonSchema(schema: object): object {
  const drop = new Set(["maxItems", "minItems", "maxLength", "minLength", "minimum", "maximum", "pattern"]);
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).filter(([k]) => !drop.has(k)).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };
  return walk(schema) as object;
}

// ---------------------------------------------------------------- contrast

function luminance(color: string): number {
  const channel = (i: number) => {
    const c = parseInt(color.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Readable pairs the renderer relies on (WCAG AA; display colours as large text). */
export function paletteProblems(p: Palette): string[] {
  const problems: string[] = [];
  const need = (label: string, fg: string, bg: string, min: number) => {
    if (contrastRatio(fg, bg) < min) problems.push(`${label} contrast below ${min}:1`);
  };
  need("text on background", p.text, p.background, 4.5);
  need("text on surface", p.text, p.surface, 4.5);
  need("primary on background", p.primary, p.background, 3);
  need("background on primary", p.background, p.primary, 4.5);
  // Secondary sets small text, including the "not official" notice bar.
  need("secondary on background", p.secondary, p.background, 4.5);
  return problems;
}

export type ProfileCheck = { ok: true; profile: DesignProfile } | { ok: false; problems: string[] };

/** Parses and checks a candidate profile. Anything else means "use the existing template". */
export function checkProfile(value: unknown): ProfileCheck {
  const parsed = DesignProfileSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`) };
  }
  const profile = parsed.data;
  const problems = paletteProblems(profile.palette);
  if (new Set(profile.motifs).size !== profile.motifs.length) problems.push("motifs repeat");
  return problems.length > 0 ? { ok: false, problems } : { ok: true, profile };
}
