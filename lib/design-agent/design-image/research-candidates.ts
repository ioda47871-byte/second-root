/**
 * DEV-105: a separate, OFFLINE queue of candidate design-reference pages.
 *
 * The historical v0.2 dataset remains immutable at 40 references, 9 cards.
 * Nothing here fetches pages, uses third-party visuals, calls Codex,
 * writes the database, or marks a candidate as human-reviewed.
 */
import { z } from "zod";

const SafeNote = z.string().trim().min(20).max(440).refine(
  (s) => !/[\u0000-\u001f\u007f]|<<<|>>>|<\s*\/?\s*(script|iframe)/i.test(s),
);
const SourceURL = z.string().min(12).max(600).superRefine((value, ctx) => {
  try {
    const u = new URL(value);
    // DNS hosts can carry a trailing dot; normalize it for safety and dedupe.
    const h = u.hostname.toLowerCase().replace(/\.$/, "");
    const reserved = ["localhost", "local", "internal", "test", "invalid", "example", "onion"];
    if (
      u.protocol !== "https:" || u.username || u.password || !h || u.hash ||
      reserved.some((suffix) => h === suffix || h.endsWith("." + suffix)) ||
      h === "example.com" || h.endsWith(".example.com") || h === "0.0.0.0" ||
      /^\d{1,3}(?:\.\d{1,3}){3}$/.test(h) || h.includes(":") ||
      u.port || u.search
    ) throw new Error("unsafe reference URL");
  } catch {
    ctx.addIssue({ code: "custom", message: "source must be a specific public HTTPS page with no tracking parameters" });
  }
});

const CATEGORIES = ["bakery", "pastry", "cafe", "restaurant", "salon", "beauty", "wellness", "editorial"] as const;
const Source = z.strictObject({
  id: z.string().regex(/^DX-\d{3}$/),
  name: z.string().trim().min(2).max(100),
  industry: z.enum(CATEGORIES),
  source_kind: z.enum(["official_brand_site", "agency_case_study", "design_gallery", "portfolio_page"]),
  source_url: SourceURL,
  evidence_scope: z.literal("page_text_or_gallery_tags_only"),
  text_confirmed: SafeNote,
  technique_hypothesis_unreviewed: SafeNote,
  primary_learning_goal: z.enum(["hero", "product", "brand", "photography", "section", "trust", "information", "cta", "palette", "navigation", "typography", "mobile"]),
  review_status: z.literal("candidate_text_checked_visual_pending"),
  required_next_review: z.literal("verify_desktop_1440_and_mobile_390_visual_and_interaction_with_human"),
  rights: z.literal("analysis_reference_only_no_images_logos_copy_or_layout_reuse"),
});
const Batch = z.strictObject({
  schema_version: z.literal(1),
  version: z.literal("0.3-candidate-seed"),
  captured_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.literal("research_candidates_not_approved"),
  baseline_v02_library_sha256: z.literal("ed4b79dcace883ca1796c11b9817ac4e0f2cbd7c2bd0d60b183bb0f8193bf0d0"),
  record_count: z.number().int().min(1).max(100),
  collection_method: SafeNote,
  references: z.array(Source).min(1).max(100),
});
export type ResearchCandidateBatch = z.infer<typeof Batch>;
export class ResearchCandidateError extends Error {
  readonly code = "RESEARCH_CANDIDATE_INVALID";
  constructor(message: string) { super(message); this.name = "ResearchCandidateError"; }
}

/** Canonical comparison key for duplicates; never used to modify a recorded URL. */
export function referenceUrlKey(input: string): string {
  const u = new URL(input);
  return u.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "") + (u.pathname.replace(/\/+$/, "") || "/");
}

/**
 * Input previous URLs from the immutable 40-file v0.2 library and all prior
 * candidate batches. A duplicate or unreviewed record masquerading as
 * approved is rejected before the batch can enter the candidate pool.
 */
export function parseResearchCandidates(input: unknown, previousUrls: readonly string[]): ResearchCandidateBatch {
  const parsed = Batch.safeParse(input);
  if (!parsed.success) throw new ResearchCandidateError("schema_or_provenance");
  const batch = parsed.data;
  if (batch.references.length !== batch.record_count) throw new ResearchCandidateError("count_mismatch");
  const ids = batch.references.map((r) => r.id);
  if (new Set(ids).size !== ids.length) throw new ResearchCandidateError("duplicate_id");
  // v0.3 is append-only: DX-001 starts after the immutable 40-item v0.2 baseline.
  // Enforcing the next expected range prevents ID reuse across separately parsed batches,
  // even though previousUrls (which also includes v0.2) contains no DX IDs.
  if (previousUrls.length < 40) throw new ResearchCandidateError("missing_v02_baseline");
  const candidateOffset = previousUrls.length - 40;
  for (const [index, id] of ids.entries()) {
    const expected = `DX-${String(candidateOffset + index + 1).padStart(3, "0")}`;
    if (id !== expected) throw new ResearchCandidateError("nonsequential_candidate_id");
  }
  const prior = new Set(previousUrls.map(referenceUrlKey));
  const within = new Set<string>();
  for (const source of batch.references) {
    const url = referenceUrlKey(source.source_url);
    if (prior.has(url) || within.has(url)) throw new ResearchCandidateError("duplicate_url");
    within.add(url);
  }
  return batch;
}
/** No human approval, no Codex instructions, no image assets, no study techniques are returned. */
export function researchCandidateCounts(input: unknown, previousUrls: readonly string[]) {
  const batch = parseResearchCandidates(input, previousUrls);
  const counts: Record<(typeof CATEGORIES)[number], number> = {
    bakery: 0, pastry: 0, cafe: 0, restaurant: 0, salon: 0, beauty: 0, wellness: 0, editorial: 0,
  };
  for (const row of batch.references) counts[row.industry] += 1;
  return {
    existing_count: previousUrls.length,
    new_candidates: batch.references.length,
    counted_as_human_reviewed: 0,
    ready_for_design_prompt: false,
    new_source_counts: counts,
  };
}
