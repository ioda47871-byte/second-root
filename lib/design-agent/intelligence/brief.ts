/**
 * DEV-112 Phase 1: builds a RESEARCH BRIEF for one shop from the read-only
 * corpus (corpus.ts). The brief is for a Claude session and the owner to read
 * before G1; it is not a prompt, not a template and not a design decision.
 *
 * - Shop input is verified facts only, each trait with its source. Nothing is
 *   inferred from the industry and nothing missing is filled in: gaps are
 *   listed under `missing_inputs` (G0).
 * - A research case is "related" only with an explainable basis: the same
 *   research category label, or an analyst keyword that is tied to a cited
 *   trait and appears in the case's own analysis text. Every match names the
 *   field and the trait ids it rests on.
 * - The research holds per-case analysis, not abstract principles: a case's
 *   structural translation and visual mechanisms often name its own layout,
 *   colours and labels. They are relayed together as
 *   `case_analysis_do_not_reproduce`, with the case's failure modes and
 *   `not_to_copy`, so a session can see how that shop's facts became a
 *   structure and then invent a different one from this shop's facts. Nothing
 *   is offered as a reusable composition or principle.
 * - Conditional selections stay marked as conditional.
 * - DEV-113: in partial mode the brief also carries the ledger report
 *   (`ledger`). It never changes which cases count as successes.
 * - Design DNA parts are left undecided (null): choosing them is the session's
 *   and the owner's work, from this shop's facts.
 */
import { z } from "zod";
import { TIERS, type ResearchCorpus } from "./corpus";

/** The 8 Design DNA parts (same names as the DEV-106 Design DNA format). */
export const DNA_PARTS = ["hero", "typography", "palette", "product_visual", "section_rhythm", "navigation", "mobile", "implementation"] as const;

const Line = (max: number) => z.string().trim().min(1).max(max).refine((s) => !/[\u0000-\u001f\u007f]|<<<|>>>|<\s*\/?\s*[a-z!]/i.test(s), "unsafe_text");

export const ShopResearchInput = z
  .object({
    schema: z.literal("shop_research_input_v1"),
    shop_key: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,40}$/),
    display_name: Line(120),
    /** A research category label as used by the corpus (e.g. bakery). Optional; never used to invent facts. */
    category: z.string().regex(/^[a-z0-9_]{2,80}$/).nullable(),
    /** True only when every trait's source has been checked by a person (G0). */
    facts_verified: z.boolean(),
    traits: z.array(z.object({ id: z.string().regex(/^T\d{1,3}$/), quote: Line(300), source_id: z.string().regex(/^S\d{1,3}$/) })).max(40),
    /** Analyst keywords (English, as in the corpus), each tied to cited traits. */
    keywords: z.array(z.object({ term: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9 -]{2,40}$/), trait_ids: z.array(z.string().regex(/^T\d{1,3}$/)).min(1) })).max(30),
  })
  .superRefine((v, ctx) => {
    const traitIds = new Set(v.traits.map((t) => t.id));
    if (traitIds.size !== v.traits.length) ctx.addIssue({ code: "custom", message: "duplicate_trait_id" });
    for (const k of v.keywords)
      for (const id of k.trait_ids) if (!traitIds.has(id)) ctx.addIssue({ code: "custom", message: `keyword_cites_unknown_trait:${id}` });
  });
export type ShopResearchInput = z.infer<typeof ShopResearchInput>;

type Match = { basis: "category_exact" } | { basis: "keyword"; term: string; field: "shop_motifs" | "visual_mechanisms" | "structural_translation"; trait_ids: string[] };

const wordHit = (text: string, term: string) => new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i").test(text);

export type ResearchBrief = ReturnType<typeof buildResearchBrief>;

export function buildResearchBrief(corpus: ResearchCorpus, shop: ShopResearchInput, opts: { maxRelated?: number } = {}) {
  const maxRelated = opts.maxRelated ?? 5;
  const matched = corpus.successes
    .map((c) => {
      const matches: Match[] = [];
      if (shop.category && shop.category === c.category) matches.push({ basis: "category_exact" });
      for (const k of shop.keywords) {
        const fields = [
          ["shop_motifs", c.shop_motifs.join(" | ")],
          ["visual_mechanisms", c.visual_mechanisms.join(" | ")],
          ["structural_translation", c.structural_translation],
        ] as const;
        for (const [field, text] of fields) if (wordHit(text, k.term)) matches.push({ basis: "keyword", term: k.term, field, trait_ids: [...k.trait_ids].sort() });
      }
      return { c, matches };
    })
    .filter((x) => x.matches.length > 0)
    .sort((a, b) => b.matches.length - a.matches.length || a.c.id.localeCompare(b.c.id));
  const related = matched
    .slice(0, maxRelated)
    .map(({ c, matches }) => ({
      case_id: c.id,
      tier: c.tier,
      manifest_status: c.manifest_status,
      owner_selection: c.owner_selection,
      conditional: c.conditional,
      implementation: c.implementation,
      evidence_ref: c.evidence_ref,
      matches,
      case_analysis_do_not_reproduce: { structural_translation: c.structural_translation, visual_mechanisms: [...c.visual_mechanisms] },
      known_failure_modes: [...c.known_failure_modes],
      not_to_copy: [...c.not_to_copy],
    }));

  // the whole failure library: what the owner rejected or the analysis flagged, from every success case
  const failures = new Map<string, string[]>();
  for (const c of corpus.successes) for (const f of c.known_failure_modes) failures.set(f, [...(failures.get(f) ?? []), c.id]);

  const missing: string[] = [];
  if (!shop.facts_verified) missing.push("facts_not_verified_by_a_person");
  if (shop.traits.length === 0) missing.push("no_cited_traits");
  if (!shop.category) missing.push("no_research_category_label");
  if (shop.keywords.length === 0) missing.push("no_analyst_keywords_tied_to_traits");
  if (related.length === 0) missing.push("no_research_case_related_with_evidence");

  return {
    schema: "design_intelligence_research_brief_v1" as const,
    status: "research_only_not_prompt_input_not_approved" as const,
    // Only part of G0 is checked here (verified, cited traits). The rest of the canonical G0 stays for the session and the owner.
    gate: shop.facts_verified && shop.traits.length > 0 ? ("G0_partially_checked" as const) : ("G0_hold" as const),
    g0_not_checked_here: ["usable_product_names", "shop_strengths", "cta_is_true", "approved_asset_list"],
    corpus: {
      as_of: corpus.as_of,
      source_sha256: corpus.source_sha256,
      counts: corpus.counts,
      tiers_used_for_case_analysis: [TIERS.success],
      tiers_counted_only: [TIERS.candidate, TIERS.queue],
    },
    shop: {
      shop_key: shop.shop_key,
      display_name: shop.display_name,
      category: shop.category,
      facts_verified: shop.facts_verified,
      traits: shop.traits.map((t) => ({ ...t })),
    },
    how_to_use: {
      research_allow: corpus.reuse_policy.allow,
      research_basis: corpus.provenance_basis,
      research_limitations: corpus.limitations,
      rule: "Each related case shows how that shop's own facts became that shop's own structure. Learn the reasoning, not the result: invent a different structure from this shop's facts.",
    },
    related_total: matched.length,
    related_cases: related,
    failure_library: [...failures].map(([failure_mode, case_ids]) => ({ failure_mode, case_ids })).sort((a, b) => a.failure_mode.localeCompare(b.failure_mode)),
    not_to_copy: [...new Set(related.flatMap((r) => r.not_to_copy))].sort(),
    reuse_policy_deny: corpus.reuse_policy.deny,
    quality_gates: corpus.reuse_policy.quality_gates,
    design_dna: Object.fromEntries(DNA_PARTS.map((p) => [p, { choice: null, decided_by: "session_from_shop_facts_then_owner" }])),
    missing_inputs: missing,
    // DEV-113: only in partial mode. Absent in phase1_compat, so the Phase 1 brief is byte-for-byte unchanged.
    ...(corpus.ledger ? { ledger: corpus.ledger } : {}),
  };
}
