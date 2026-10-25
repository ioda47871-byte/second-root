/**
 * DEV-107: shop-specific Design DNA proposals built from the techniques the owner adopted after DEV-106.
 * OFFLINE only: nothing here calls a model, fetches a page, generates an image, or reaches the worker or a database.
 *
 * Who does what:
 * - A Claude session reads one shop's facts and writes the proposal file: the shop's traits (each a verbatim quote of a
 *   fact), two directions, the techniques each direction uses and why, and the eight design parts.
 * - This module checks that work. Traits must quote the shop's own facts (never a placeholder or the fixture's
 *   "fictional" disclaimer). A technique may be used only if the owner adopted it and the cited traits meet its
 *   condition, and only in a variant the current CSS allows. Unused eligible techniques must say why. The two
 *   directions, the existing briefs and the other shop's directions must not share a design choice.
 * - Nothing reads the shop's industry or category: which techniques fit comes from the shop's facts alone, so there is
 *   no per-industry template (a test swaps the industry and expects the same result).
 *
 * The owner's decisions (2026-10-25): T3, T4, T8 adopted; T1, T2, T5, T6, T7 adopted with conditions. Not approved: a
 * fixed or sticky action bar (T1), wave / cut-corner / clip-path shapes (T7), and vertical text other than the shop
 * name. Adopting a technique does not make the reference sites human-reviewed; their records stay pending.
 */
import { z } from "zod";
import { DESIGN_DNA_PARTS, parseDesignDna, sharedDesignDnaParts, type DesignDnaBrief, type DesignDnaPart } from "./design-dna";
import { studyTextIsUnsafe } from "./research-bridge";

export const TECHNIQUE_DECISION_DATE = "2026-10-25";

/** What kind of shop fact a trait is, and which fact keys it may quote. */
export const TRAIT_KINDS = {
  identity: ["name", "description"],
  product: ["menu_items", "description"],
  // Kinds that claim something about the shop (what it leads with, how it makes things, how to order or book) must
  // come from the shop's own description, not from a bare list of item names. The kind is still the analysis's claim;
  // the owner reviews it.
  signature_item: ["description"],
  making_commitment: ["description"],
  practical_fact: ["hours", "closed_days", "access", "address", "phone"],
  product_attribute: ["description"],
  order_process: ["description"],
  // No fixture or design input has a booking field yet (DESIGN_FACT_KEYS); a description that states appointments or
  // reservations is the only source today, so T1 stays unavailable until such a fact exists.
  booking_route: ["booking", "description"],
} as const;
export type TraitKind = keyof typeof TRAIT_KINDS;
const TRAIT_KIND_NAMES = Object.keys(TRAIT_KINDS) as TraitKind[];

/** CSS the current renderer allows (page-css.ts), and what it refuses. Proposals name only these. */
export const ALLOWED_CSS = ["grid", "flex", "solid_colour_bands", "border_radius", "image_slot", "horizontal_text", "media_queries", "vertical_name"] as const;
export const REFUSED_CSS = ["fixed_position", "sticky_position", "clip_path", "pseudo_elements", "horizontal_scroll", "animation", "background_image", "vertical_non_name_text"] as const;
type AllowedCss = (typeof ALLOWED_CSS)[number];

type Need = { kind: TraitKind; min: number; keys?: readonly string[]; distinctKeys?: boolean };
type Variant = { css: readonly AllowedCss[]; needs: readonly Need[]; asset?: "concept_image" | "none" };
export type Technique = {
  owner: "adopted" | "conditional";
  name: string;
  principle: string;
  sources: readonly string[];
  parts: readonly DesignDnaPart[];
  maxTraits: number;
  variants: Record<string, Variant>;
  /** Variants that exist in the shortlist but are not allowed: the reason is the owner's decision or a missing input. */
  refused: Record<string, string>;
};

const PRACTICAL = ["hours", "closed_days", "access", "phone"] as const;
export const TECHNIQUES: Record<string, Technique> = {
  T1: {
    owner: "conditional", name: "booking and phone route", principle: "The actions an appointment visitor needs are reachable without searching.",
    sources: ["DX-008", "DX-011"], parts: ["navigation", "mobile"], maxTraits: 2,
    variants: { header_link: { css: ["flex"], needs: [{ kind: "booking_route", min: 1 }] } },
    refused: { fixed_bar: "owner_not_approved_fixed_position" },
  },
  T2: {
    owner: "conditional", name: "practical fact row", principle: "The target visitor's practical worries are answered before any reading.",
    sources: ["DX-008"], parts: ["hero", "section_rhythm"], maxTraits: 4,
    variants: { text_badges: { css: ["flex", "border_radius"], needs: [{ kind: "practical_fact", min: 2, keys: PRACTICAL, distinctKeys: true }] } },
    refused: { line_icons_without_slots: "icons_need_image_slots" },
  },
  T3: {
    owner: "adopted", name: "readable shop information", principle: "Hours, days off and the address are text, not pictures.",
    sources: ["DX-005", "DX-036"], parts: ["section_rhythm", "implementation"], maxTraits: 4,
    variants: { text_ledger: { css: ["grid"], needs: [{ kind: "practical_fact", min: 1, keys: ["hours", "address"] }] } },
    refused: { open_day_calendar: "needs_closed_day_data_field" },
  },
  T4: {
    owner: "adopted", name: "numbered commitments", principle: "The shop's own reasons, numbered, read in a fixed order.",
    sources: ["DX-005", "DX-011"], parts: ["section_rhythm", "typography"], maxTraits: 4,
    variants: { numbered_text: { css: ["grid"], needs: [{ kind: "making_commitment", min: 2 }] } },
    refused: {},
  },
  T5: {
    owner: "conditional", name: "comparable product list", principle: "Products the buyer compares sit in rows with the same attributes.",
    sources: ["DX-036"], parts: ["product_visual", "section_rhythm"], maxTraits: 6,
    variants: { attribute_rows: { css: ["grid"], needs: [{ kind: "product_attribute", min: 3 }] } },
    refused: {},
  },
  T6: {
    owner: "conditional", name: "order steps", principle: "A made-to-order process is shown step by step before contact.",
    sources: ["DX-006"], parts: ["section_rhythm"], maxTraits: 3,
    variants: { numbered_steps: { css: ["grid"], needs: [{ kind: "order_process", min: 1 }] } },
    refused: { pictogram_steps: "pictograms_need_image_slots" },
  },
  T7: {
    owner: "conditional", name: "ground bands and one shop-derived shape", principle: "A few repeated means make the page feel designed as one.",
    sources: ["DX-002", "DX-023"], parts: ["palette", "section_rhythm"], maxTraits: 2,
    variants: {
      colour_bands: { css: ["solid_colour_bands"], needs: [] },
      radius_motif: { css: ["solid_colour_bands", "border_radius"], needs: [{ kind: "identity", min: 1 }] },
    },
    refused: { wave_or_cut_shape: "owner_not_approved_clip_path" },
  },
  T8: {
    owner: "adopted", name: "one signature item leads", principle: "The first screen decides what the shop is by one item.",
    sources: ["DX-027", "DX-033"], parts: ["hero", "product_visual"], maxTraits: 2,
    variants: {
      concept_image: { css: ["image_slot"], needs: [{ kind: "signature_item", min: 1 }], asset: "concept_image" },
      type_led: { css: ["horizontal_text"], needs: [{ kind: "signature_item", min: 1 }], asset: "none" },
    },
    refused: {},
  },
};
const TECHNIQUE_IDS = Object.keys(TECHNIQUES);

/** Text written by the analysis: clean, short, no instruction-like or markup-like content. */
const clean = (s: string) => !/[\u0000-\u001f\u007f]|<<<|>>>/.test(s) && !studyTextIsUnsafe(s);
const Note = z.string().trim().min(8).max(360).refine(clean);
const Short = z.string().trim().min(2).max(120).refine(clean);
const Id = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);
const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const Part = z.strictObject({ choice: Note, why: Note, trait_ids: z.array(Id).min(1).max(6) });
const AssetPolicy = z.enum(["none", "ai_concept_review_required", "approved_real_only"]);

const Direction = z.strictObject({
  id: Id,
  name: Short,
  identity: Note,
  asset_policy: AssetPolicy,
  techniques: z.array(z.strictObject({ id: z.string(), variant: z.string(), trait_ids: z.array(Id).max(6), why: Note })).min(1).max(4),
  not_used: z.array(z.strictObject({ id: z.string(), why: Note })).max(8),
  hero: Part,
  product_visual: Part,
  typography: Part,
  palette: Part.extend({ colors: z.array(z.strictObject({ name: Short, hex: Hex, role: z.enum(["ground", "text", "accent", "band"]) })).min(3).max(6) }),
  section_rhythm: Part.extend({ sections: z.array(z.strictObject({ id: Id, role: z.enum(["header", "hero", "products", "info", "footer", "other"]), purpose: Note })).min(3).max(8) }),
  navigation: Part,
  mobile: Part.extend({ desktop: Note }),
  implementation: Part.extend({
    status: z.enum(["existing_css", "needs_input_field", "needs_unapproved_capability"]),
    css: z.array(z.string()).min(1).max(8),
    needs: z.array(Note).max(4),
  }),
  comparison: z.strictObject({ baseline: z.string().regex(/^[a-z0-9-]+\.json$/), strengths: z.array(Note).min(1).max(4), weaknesses: z.array(Note).min(1).max(4) }),
});
export type ProposalDirection = z.infer<typeof Direction>;

const ProposalFile = z.strictObject({
  schema_version: z.literal(1),
  task: z.literal("DEV-107"),
  status: z.literal("ai_proposal_pending_owner_review"),
  shop_key: Id,
  fixture: z.string().regex(/^scripts\/sales-design-worker\/compare\/shops\/[a-z0-9-]+\.json$/),
  traits: z.array(z.strictObject({ id: Id, kind: z.enum(TRAIT_KIND_NAMES as [TraitKind, ...TraitKind[]]), fact_key: z.string(), quote: z.string().min(1).max(160) })).min(1).max(12),
  directions: z.array(Direction).length(2),
});
export type ShopProposalFile = z.infer<typeof ProposalFile>;

export class ShopProposalError extends Error {
  constructor(readonly reason: string) { super(reason); this.name = "ShopProposalError"; }
}
const fail = (reason: string): never => { throw new ShopProposalError(reason); };

/** The shop's facts, without industry or category: those never steer a design choice. */
export type ShopFacts = Record<string, string | readonly string[]>;
export function shopFactsFromFixture(fixture: { facts: Record<string, unknown> }): ShopFacts {
  const out: Record<string, string | readonly string[]> = {};
  for (const [k, v] of Object.entries(fixture.facts)) {
    if (k === "category") continue;
    if (typeof v === "string") out[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === "string")) out[k] = v as string[];
  }
  return out;
}

/**
 * Fixture placeholders and the fictional-shop disclaimer are not the shop's character. The name is exempt: it is the
 * shop's own name even when it contains one of these words.
 */
const PLACEHOLDER = /テスト|架空|実在|比較用/;

type Trait = ShopProposalFile["traits"][number];
/**
 * Where a quote sits in a fact value: it may not be part of a placeholder word (a token starting with テスト, such as a
 * fixture menu item "テストクロワッサン") or inside a sentence of the fictional-shop disclaimer.
 */
function quoteIsPlaceholder(value: string, quote: string): boolean {
  for (let at = value.indexOf(quote); at >= 0; at = value.indexOf(quote, at + 1)) {
    const tokenStart = Math.max(...[" ", "　", "、", "・", "「", "（", "(", "。"].map((c) => value.lastIndexOf(c, at - 1) + 1), 0);
    const token = value.slice(tokenStart, at + quote.length);
    // the disclaimer is a sentence of the description; a one-line fact (an address) is judged by its token alone
    const sentence = value.includes("。") ? value.slice(value.lastIndexOf("。", at - 1) + 1, value.indexOf("。", at + quote.length) + 1 || value.length) : "";
    if (!/テスト/.test(token) && !PLACEHOLDER.test(sentence) && !PLACEHOLDER.test(quote)) return false;
  }
  return true;
}

function checkTraits(traits: Trait[], facts: ShopFacts): Map<string, Trait> {
  const byId = new Map<string, Trait>();
  for (const t of traits) {
    if (byId.has(t.id)) fail("duplicate_trait");
    if (!(TRAIT_KINDS[t.kind] as readonly string[]).includes(t.fact_key)) fail("trait_wrong_fact_key");
    if (t.quote.trim().length < 2) fail("trait_placeholder");
    const value = facts[t.fact_key];
    const values = (value === undefined ? [] : typeof value === "string" ? [value] : value).filter((v) => v.includes(t.quote));
    if (!values.length) fail("trait_not_in_facts");
    if (t.fact_key !== "name" && values.every((v) => quoteIsPlaceholder(v, t.quote))) fail("trait_placeholder");
    byId.set(t.id, t);
  }
  return byId;
}

/**
 * The written choices are read too, clause by clause: wording that proposes something the owner has not approved, an
 * image under a no-image policy, or a price or booking the facts do not give is refused, in English or Japanese. A
 * mention negated right next to it ("no fixed bar", "固定しない") is fine. This is a keyword screen, not understanding:
 * the owner still reads every choice.
 */
const NEGATION_BEFORE = /\b(no|not|never|without|nothing|none|instead of)\b/i;
/** Japanese negates after the verb: 固定しない, 写真は無し. */
const NEGATION_AFTER = /^.{0,4}?(しない|ない|無し|なし|不要)/;
const PROSE_RULES: Array<{ re: RegExp; reason: string; unless?: (d: ProposalDirection) => boolean }> = [
  { re: /position:\s*(fixed|sticky)|\bfixed (bar|header|footer|button)|\bsticky\b|stays on screen|while scrolling|固定|追従/i, reason: "prose_refused_feature" },
  { re: /clip-?path|wave[- ]shaped|\bwav(e|y) (edge|border)|cut[- ]corner|\bblob\b|波形|切り欠き/i, reason: "prose_refused_feature" },
  { re: /carousel|slideshow|\banimat|fade[- ]in|parallax|カルーセル|スライド|アニメーション|フェード/i, reason: "prose_refused_feature" },
  { re: /\bvertical(ly)?\b|縦書き|縦組|縦に|vertical-rl/i, reason: "prose_refused_feature", unless: (d) => d.implementation.css.includes("vertical_name") },
  { re: /\b(photo|photograph|picture|image|illustration)s? of\b|AI[- ]generated|concept image|写真|画像|イラスト/i, reason: "prose_asset_conflict", unless: (d) => d.asset_policy !== "none" },
  { re: /\bbook(ing)?\b|\breservations?\b|\breserve\b|予約/i, reason: "prose_invented_fact", unless: (d) => d.techniques.some((t) => t.id === "T1") },
  { re: /\bprices?\b|\bonline (shop|store|order)|\bcart\b|価格|値段|購入|通販|注文/i, reason: "prose_invented_fact" },
];
const PRICE = /\d\s*円|¥\s*\d|\d\s*yen/i;
function proseOf(d: ProposalDirection): string[] {
  const texts = [d.identity, ...d.techniques.map((t) => t.why), ...d.not_used.map((n) => n.why), ...d.section_rhythm.sections.map((x) => x.purpose), d.mobile.desktop,
    ...PART_KEYS.flatMap((k) => [d[k].choice, d[k].why])];
  return texts.flatMap((t) => t.split(/(?<=[.;。、,])\s*|:\s/));
}
/** A match counts as negated only when a negation sits right next to it: up to three words before, or 〜ない after. */
function negated(clause: string, at: number, length: number): boolean {
  const before = clause.slice(0, at).trim().split(/\s+/).slice(-3).join(" ");
  return NEGATION_BEFORE.test(before) || NEGATION_AFTER.test(clause.slice(at + length));
}
function checkProse(d: ProposalDirection): void {
  for (const clause of proseOf(d)) {
    if (PRICE.test(clause)) fail("prose_invented_fact");
    for (const r of PROSE_RULES) {
      if (r.unless?.(d)) continue;
      for (const m of clause.matchAll(new RegExp(r.re.source, "gi"))) if (!negated(clause, m.index, m[0].length)) fail(r.reason);
    }
  }
}

function needMet(need: Need, cited: Trait[]): boolean {
  const ok = cited.filter((t) => t.kind === need.kind && (!need.keys || need.keys.includes(t.fact_key)));
  const count = need.distinctKeys ? new Set(ok.map((t) => t.fact_key)).size : ok.length;
  return count >= need.min;
}

/** For each technique: may this shop use it at all, in which variants, and if not, why. Reads traits only. */
export function techniqueEligibility(traits: readonly Trait[], assetPolicy: z.infer<typeof AssetPolicy>) {
  return Object.fromEntries(TECHNIQUE_IDS.map((id) => {
    const t = TECHNIQUES[id]!;
    const variants = Object.entries(t.variants).filter(([, v]) =>
      v.needs.every((n) => needMet(n, [...traits])) && !(v.asset === "concept_image" && assetPolicy !== "ai_concept_review_required")).map(([name]) => name);
    return [id, { eligible: variants.length > 0, variants }];
  })) as Record<string, { eligible: boolean; variants: string[] }>;
}

/** WCAG relative-luminance contrast of two #rrggbb colours. */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

const PART_KEYS = ["hero", "product_visual", "typography", "palette", "section_rhythm", "navigation", "mobile", "implementation"] as const satisfies readonly DesignDnaPart[];

function checkDirection(d: ProposalDirection, traits: Map<string, Trait>): void {
  const all = [...traits.values()];
  const eligibility = techniqueEligibility(all, d.asset_policy);
  const used = new Set<string>();
  const css = new Set<string>();
  for (const u of d.techniques) {
    const t = TECHNIQUES[u.id];
    if (!t) fail("technique_unknown");
    if (used.has(u.id)) fail("technique_repeated");
    used.add(u.id);
    if (u.variant in t!.refused) fail("variant_refused");
    const v = t!.variants[u.variant];
    if (!v) fail("variant_unknown");
    if (u.trait_ids.length > t!.maxTraits) fail("technique_too_many_traits");
    const cited = u.trait_ids.map((id) => traits.get(id) ?? fail("trait_unknown"));
    if (!v!.needs.every((n) => needMet(n, cited))) fail("technique_condition_unmet");
    if (v!.asset === "concept_image" && d.asset_policy !== "ai_concept_review_required") fail("asset_policy_conflict");
    for (const c of v!.css) css.add(c);
  }
  // every technique this shop could use but this direction does not is explained
  const notUsed = new Set(d.not_used.map((n) => n.id));
  if (d.not_used.some((n) => !TECHNIQUES[n.id] || used.has(n.id))) fail("not_used_invalid");
  for (const [id, e] of Object.entries(eligibility)) if (e.eligible && !used.has(id) && !notUsed.has(id)) fail("unused_eligible_unexplained");
  checkProse(d);
  // parts cite real traits
  for (const k of PART_KEYS) for (const id of d[k].trait_ids) if (!traits.has(id)) fail("trait_unknown");
  // palette: a ground, a text colour, readable contrast
  const of = (role: string) => d.palette.colors.filter((c) => c.role === role);
  const grounds = of("ground"), texts = of("text"), bands = of("band"), accents = of("accent");
  if (grounds.length !== 1 || !texts.length) fail("palette_roles");
  const surfaces = [...grounds, ...bands];
  for (const t of texts) for (const s of surfaces) if (contrastRatio(t.hex, s.hex) < 4.5) fail("palette_contrast");
  for (const a of accents) for (const s of surfaces) if (contrastRatio(a.hex, s.hex) < 3) fail("palette_contrast");
  // a band must read as a different ground, or "sections separated by ground colour" separates nothing
  for (const b of bands) if (contrastRatio(b.hex, grounds[0]!.hex) < 1.2) fail("palette_band_invisible");
  // implementation: only allowed CSS; the status follows from what is used
  for (const c of d.implementation.css) {
    if ((REFUSED_CSS as readonly string[]).includes(c)) fail("css_refused");
    if (!(ALLOWED_CSS as readonly string[]).includes(c)) fail("css_unknown");
  }
  for (const c of css) if (!d.implementation.css.includes(c)) fail("css_missing_for_technique");
  if (d.implementation.css.includes("image_slot") && d.asset_policy === "none") fail("asset_policy_conflict");
  const expected = d.implementation.css.includes("vertical_name") ? "needs_unapproved_capability" : d.implementation.needs.length > 0 ? "needs_input_field" : "existing_css";
  if (d.implementation.status !== expected) fail("implementation_status_mismatch");
}

/** One shop's proposal file, checked against that shop's facts. */
export function parseShopProposals(raw: unknown, facts: ShopFacts): ShopProposalFile {
  const parsed = ProposalFile.safeParse(raw);
  if (!parsed.success) return fail("schema");
  const f = parsed.data;
  const traits = checkTraits(f.traits, facts);
  for (const d of f.directions) checkDirection(d, traits);
  if (f.directions[0]!.id === f.directions[1]!.id) fail("duplicate_direction");
  const key = (d: ProposalDirection) => d.techniques.map((t) => `${t.id}:${t.variant}`).sort().join("|");
  if (key(f.directions[0]!) === key(f.directions[1]!)) fail("directions_same_techniques");
  return f;
}

/** A direction as a Design DNA brief (design-dna.ts), so the existing provenance and copy checks apply too. */
export function toDesignDnaBrief(f: ShopProposalFile, d: ProposalDirection, referenceUrls: ReadonlyMap<string, string>): DesignDnaBrief {
  const traits = new Map(f.traits.map((t) => [t.id, t]));
  const usedIds = new Set(DESIGN_DNA_PARTS.flatMap((p) => d[p].trait_ids));
  const sourcesFor = (part: DesignDnaPart) => [...new Set(d.techniques.filter((u) => TECHNIQUES[u.id]!.parts.includes(part)).flatMap((u) => TECHNIQUES[u.id]!.sources))];
  const refIds = [...new Set(DESIGN_DNA_PARTS.flatMap(sourcesFor))];
  return parseDesignDna({
    schema_version: 1, shop_key: f.shop_key, status: "research_only", factual_copy: "verified_facts_only", asset_policy: d.asset_policy,
    evidence: [...usedIds].map((id) => ({ id, origin: "verified_shop_fact", observation: traits.get(id)!.quote, source_label: `fixture facts.${traits.get(id)!.fact_key}` })),
    references: refIds.map((id) => {
      const t = d.techniques.map((u) => TECHNIQUES[u.id]!).find((x) => x.sources.includes(id))!;
      return { id, url: referenceUrls.get(id) ?? fail("reference_url_missing"), scope: "public_visual_only", observed_principle: t.principle, transferable_idea: `${t.name}, built from this shop's own facts`, rights: "analysis_only" };
    }),
    decisions: DESIGN_DNA_PARTS.map((part) => ({ part, choice: d[part].choice, rationale: d[part].why, evidence_ids: d[part].trait_ids, reference_ids: sourcesFor(part) })),
  });
}

/**
 * Across all proposals: no design choice repeated between two directions, or between a direction and an existing
 * brief. A copy signal only (sharedDesignDnaParts compares wording), not an originality score.
 */
export function overlappingChoices(briefs: ReadonlyArray<{ label: string; brief: DesignDnaBrief }>): Array<{ a: string; b: string; parts: DesignDnaPart[] }> {
  const out: Array<{ a: string; b: string; parts: DesignDnaPart[] }> = [];
  for (let i = 0; i < briefs.length; i++)
    for (let j = i + 1; j < briefs.length; j++) {
      const parts = sharedDesignDnaParts(briefs[i]!.brief, briefs[j]!.brief);
      if (parts.length) out.push({ a: briefs[i]!.label, b: briefs[j]!.label, parts });
    }
  return out;
}
