/**
 * Design research library v0.2 (2026-10-21): 40 studied references and nine
 * technique cards, imported verbatim under design-library/research/v02 (see its
 * MANIFEST.json for the hashes). OFFLINE only: nothing here fetches a URL, calls
 * a model, touches the worker or the pinned v1/v2 prompts.
 *
 * Review status is kept exactly as the original records it. The originals are
 * model-made observations of public images with no reviewer and no review date,
 * and the cards carry no review status at all, so every imported source and
 * card is a `candidate` for the DEV-099 bridge: the bridge cannot call a
 * selection built on them `review_ready` until a person records a review.
 *
 * `exploreV02Techniques` is the shop-specific step: it picks 2–4 cards from a
 * shop's verified facts and asset policy (never from the industry name alone),
 * says why for each, and labels the result exploratory and unreviewed.
 */
import { z } from "zod";
import type { DesignDnaPart } from "./design-dna";
import { parseDesignResearchSnapshot, type DesignResearchSnapshot } from "./research-bridge";

export const RESEARCH_V02_DIR = "design-library/research/v02";
export const RESEARCH_V02_LIBRARY_FILE = "secondroot_design_library_v02_20261021.json";
/** sha256 of the imported original (MANIFEST.json); a changed file is not the v0.2 library. */
export const RESEARCH_V02_LIBRARY_SHA256 = "ed4b79dcace883ca1796c11b9817ac4e0f2cbd7c2bd0d60b183bb0f8193bf0d0";

/** The original's own review labels, in increasing order of what was actually looked at. */
export const V02_REVIEW_STATUSES = [
  "discovered_needs_visual_review",
  "content_reviewed_visual_pending",
  "visual_reference_partially_inspected",
  "partial_visual_review_of_public_reference",
  "visual_reviewed_from_public_screenshot",
] as const;
export type V02ReviewStatus = (typeof V02_REVIEW_STATUSES)[number];
/** Statuses with an observation of the reference's visuals (a public image or screenshot); the rest saw none. */
const VISUALLY_OBSERVED: ReadonlySet<V02ReviewStatus> = new Set([
  "visual_reference_partially_inspected", "partial_visual_review_of_public_reference", "visual_reviewed_from_public_screenshot",
]);

const Text = z.string().max(400);
const Reference = z.object({
  id: z.string().regex(/^DR-\d{3}$/),
  name: z.string().min(1).max(120),
  industry: z.string().min(1).max(80),
  reference_url: z.string().url(),
  source_kind: z.string().min(1).max(80),
  review_status: z.enum(V02_REVIEW_STATUSES),
  design_archetype: z.string().regex(/^[a-z_]{3,60}$/),
  observed_visual_traits: Text,
  adaptation_idea: Text,
  photo_dependency: z.string().min(1).max(60),
  license_scope: z.string().startsWith("analysis_reference_only"),
  notes: Text,
  visual_evidence_url: z.string().url().optional(),
  evidence_scope: z.string().max(80).optional(),
});
const Card = z.object({
  id: z.string().regex(/^A\d{2}$/),
  key: z.string().regex(/^[a-z_]{3,60}$/),
  label: z.string().min(2).max(60),
  technique: Text,
  when_to_use: Text,
  avoid: Text,
  observed_reference_ids: z.array(z.string().regex(/^DR-\d{3}$/)).min(1).max(6),
});
const Library = z.object({
  version: z.literal("0.2-research-draft"),
  as_of: z.literal("2026-10-21"),
  counts: z.object({
    total_research_references: z.number().int(),
    current_partial_visual_references: z.number().int(),
    content_only_no_visual: z.number().int(),
    still_discovered_visual_pending: z.number().int(),
    full_browser_desktop_mobile_motion_verified: z.number().int(),
  }).passthrough(),
  policy: z.array(z.string()).min(1),
  design_principles: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() })),
  references: z.array(Reference).length(40),
  design_techniques_v02: z.array(Card).length(9),
  design_mix_rules: z.object({ selection: z.string() }).passthrough(),
});
export type ResearchLibraryV02 = z.infer<typeof Library>;
export type V02Card = z.infer<typeof Card>;

export class ResearchV02Error extends Error {
  readonly code = "RESEARCH_V02_INVALID";
  constructor(message: string) { super(message); this.name = "ResearchV02Error"; }
}

/** Parses the original library and checks it says what it counts (fails closed on any mismatch). */
export function parseResearchLibraryV02(raw: unknown): ResearchLibraryV02 {
  const parsed = Library.safeParse(raw);
  if (!parsed.success) throw new ResearchV02Error("library:schema");
  const lib = parsed.data;
  const ids = new Set(lib.references.map((r) => r.id));
  if (ids.size !== lib.references.length) throw new ResearchV02Error("library:duplicate_reference");
  if (new Set(lib.design_techniques_v02.map((c) => c.id)).size !== lib.design_techniques_v02.length)
    throw new ResearchV02Error("library:duplicate_card");
  for (const c of lib.design_techniques_v02)
    if (c.observed_reference_ids.some((r) => !ids.has(r))) throw new ResearchV02Error("library:card_unknown_reference");
  const count = (s: V02ReviewStatus) => lib.references.filter((r) => r.review_status === s).length;
  const visual = lib.references.filter((r) => VISUALLY_OBSERVED.has(r.review_status)).length;
  const c = lib.counts;
  if (c.total_research_references !== lib.references.length || c.current_partial_visual_references !== visual ||
      c.content_only_no_visual !== count("content_reviewed_visual_pending") ||
      c.still_discovered_visual_pending !== count("discovered_needs_visual_review") ||
      c.full_browser_desktop_mobile_motion_verified !== 0)
    throw new ResearchV02Error("library:counts");
  return lib;
}

/**
 * The Design DNA part each card mainly shapes. Assigned by a Claude session
 * when importing (the original has no such field); unreviewed, and recorded as
 * such on every card the bridge sees.
 */
export const V02_CARD_PART: Readonly<Record<string, DesignDnaPart>> = {
  A01: "hero", A02: "typography", A03: "product_visual", A04: "palette", A05: "palette",
  A06: "hero", A07: "section_rhythm", A08: "product_visual", A09: "typography",
};

/** The original library as a DEV-099 bridge snapshot: every source and card a `candidate`, original labels kept. */
export function toResearchSnapshot(lib: ResearchLibraryV02): DesignResearchSnapshot {
  const candidate = { status: "candidate" as const, reviewer: null, reviewed_at: null };
  return parseDesignResearchSnapshot({
    schema_version: 1,
    status: "research_only",
    // a reference nobody has looked at (no observation at all) is kept in the library file but not offered as a source
    sources: lib.references.filter((r) => r.review_status !== "discovered_needs_visual_review").map((r) => ({
      id: r.id,
      url: r.reference_url,
      scope: r.review_status === "content_reviewed_visual_pending" ? "site_structure_only" : "public_visual_only",
      rights: "analysis_only",
      // what was observed, or the original's own note that nothing was
      observed_principle: [...(r.observed_visual_traits || r.notes)].slice(0, 300).join(""),
      review: candidate,
      provenance: { library: "design_research_v02", original_id: r.id, original_review_status: r.review_status },
    })),
    technique_cards: lib.design_techniques_v02.map((c) => {
      const part = V02_CARD_PART[c.id];
      if (!part) throw new ResearchV02Error("library:card_without_part");
      return {
        id: c.id,
        part,
        source_ids: c.observed_reference_ids,
        transferable_principle: c.technique,
        use: `${c.label}：${c.when_to_use}`,
        avoid: c.avoid,
        review: candidate,
        provenance: { library: "design_research_v02", original_id: c.id, part_assigned_by: "claude_session_unreviewed" },
      };
    }),
  });
}

/** What a shop's verified inputs say, for choosing cards. Tones come only from the owner, never from the industry. */
export type V02ShopProfile = {
  shop_key: string;
  /** The verified shop name (facts source of truth). */
  name: string;
  /** Verified fact fields shown on the page (hours, address, …); only their number is used. */
  fact_count: number;
  /** none: no product imagery at all; ai_concept_local / approved_real: reviewed images exist. */
  imagery: "none" | "ai_concept_local" | "approved_real";
  /** Brand tones the OWNER stated (Design DNA evidence of origin owner_direction); empty when none. */
  owner_tones: readonly ("quiet" | "luxury" | "energetic" | "playful")[];
  /** A motif grounded in one verified fact, e.g. { evidence_id: "making", motif: "…" }; null when there is none. */
  fact_motif: { evidence_id: string; motif: string } | null;
};

export type V02Pick = {
  card_id: string;
  key: string;
  label: string;
  part: DesignDnaPart;
  /** Why this shop: each reason names the input it rests on. */
  reasons: string[];
  /** Only references whose visuals were observed; each keeps the original review label. */
  references: { id: string; url: string; original_review_status: V02ReviewStatus }[];
};
export type V02Exploration = {
  kind: "v02_technique_exploration";
  shop_key: string;
  /** Always: the library has no human review; this is a hypothesis for a person to judge. */
  status: "exploratory_unreviewed";
  picks: V02Pick[];
  not_picked: { card_id: string; reason: string }[];
  image_generation_approved: false;
};

const MAX_PICKS = 4;
/**
 * Cards that rest on a specific shop input come first; then the structure cards, A07 (section rhythm) before
 * A09 and A06, so a concept always keeps a rhythm across its sections before it adds a layout refinement.
 */
const ORDER = ["A02", "A03", "A01", "A04", "A05", "A08", "A07", "A09", "A06"] as const;

/**
 * Picks 2–4 cards for one shop (design_mix_rules: "Choose 2 to 4 compatible
 * techniques … based on verified facts"). Deterministic; never reads the
 * industry name; A04 (quiet black-white) and A05 (loud colour stripe) are never
 * mixed. Fewer than two eligible cards is an error, not a padded answer.
 */
export function exploreV02Techniques(lib: ResearchLibraryV02, profile: V02ShopProfile): V02Exploration {
  const name = profile.name.trim();
  const chars = [...name].length;
  const tones = new Set(profile.owner_tones);
  const eligible: Record<string, string | null> = {
    A01: profile.imagery === "none" && chars >= 2 && chars <= 8
      ? `photo-free shop (imagery: none) with a short name (${chars} characters)`
      : null,
    A02: /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]{2,8}$/u.test(name)
      ? `the verified name is ${chars} Japanese characters, short enough to set as one vertical accent`
      : null,
    A03: profile.fact_motif ? `one mark from a verified fact (evidence ${profile.fact_motif.evidence_id}): ${profile.fact_motif.motif}` : null,
    A04: tones.has("quiet") || tones.has("luxury") ? "the owner asked for a quiet / luxury tone" : null,
    A05: tones.has("energetic") ? "the owner asked for an energetic tone" : null,
    A08: tones.has("playful") ? "the owner asked for a playful tone" : null,
    A07: "every page: hero, then the products, then the information ledger, each with a different lead",
    A09: profile.imagery !== "none"
      ? "reviewed product imagery exists, so the name needs a strong size contrast to stay the brand, not a caption"
      : "photo-free page: hierarchy has to come from type size alone",
    A06: profile.fact_count <= 6 ? `a short fact group (${profile.fact_count} fields) fits two alignment axes` : null,
  };
  const cardById = new Map(lib.design_techniques_v02.map((c) => [c.id, c]));
  const refById = new Map(lib.references.map((r) => [r.id, r]));
  const picks: V02Pick[] = [];
  const notPicked: { card_id: string; reason: string }[] = [];
  for (const id of ORDER) {
    const card = cardById.get(id)!;
    const reason = eligible[id];
    if (!reason) { notPicked.push({ card_id: id, reason: "no verified input supports it" }); continue; }
    if (picks.length >= MAX_PICKS) { notPicked.push({ card_id: id, reason: `limit of ${MAX_PICKS} cards per concept` }); continue; }
    if ((id === "A05" && picks.some((p) => p.card_id === "A04")) || (id === "A04" && picks.some((p) => p.card_id === "A05"))) {
      notPicked.push({ card_id: id, reason: "A04 and A05 are opposite directions; never mixed" });
      continue;
    }
    const references = card.observed_reference_ids
      .map((r) => refById.get(r)!)
      .filter((r) => VISUALLY_OBSERVED.has(r.review_status))
      .map((r) => ({ id: r.id, url: new URL(r.reference_url).href, original_review_status: r.review_status }));
    if (!references.length) { notPicked.push({ card_id: id, reason: "no visually observed reference" }); continue; }
    picks.push({ card_id: id, key: card.key, label: card.label, part: V02_CARD_PART[id]!, reasons: [reason], references });
  }
  if (picks.length < 2) throw new ResearchV02Error("exploration:too_few_cards");
  return { kind: "v02_technique_exploration", shop_key: profile.shop_key, status: "exploratory_unreviewed", picks, not_picked: notPicked, image_generation_approved: false };
}
