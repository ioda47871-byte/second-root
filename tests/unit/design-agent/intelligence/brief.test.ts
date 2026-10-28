import { describe, expect, it } from "vitest";
import { buildResearchBrief, DNA_PARTS, ShopResearchInput } from "@/lib/design-agent/intelligence/brief";
import { buildCorpus, TIERS } from "@/lib/design-agent/intelligence/corpus";
import { fictionalFiles } from "./fixtures";

// DEV-112: the brief only relays research principles with an explainable basis; it never fills gaps.

const corpus = () => buildCorpus(fictionalFiles());
const shop = (over: Record<string, unknown> = {}) =>
  ShopResearchInput.parse({
    schema: "shop_research_input_v1",
    shop_key: "fictional-bakery",
    display_name: "架空ベーカリー",
    category: null,
    facts_verified: true,
    traits: [
      { id: "T1", quote: "木の棚に毎朝のパンを並べる", source_id: "S1" },
      { id: "T2", quote: "季節の枝物を入口に飾る", source_id: "S2" },
    ],
    keywords: [],
    ...over,
  });

describe("research brief", () => {
  it("relates a case only with a stated basis, naming the field and the cited traits", () => {
    const b = buildResearchBrief(corpus(), shop({ keywords: [{ term: "shelf", trait_ids: ["T1"] }] }));
    expect(b.related_principles.map((r) => r.case_id)).toEqual(["CP-901"]);
    expect(b.related_principles[0]!.matches).toEqual([
      { basis: "keyword", term: "shelf", field: "shop_motifs", trait_ids: ["T1"] },
      { basis: "keyword", term: "shelf", field: "structural_translation", trait_ids: ["T1"] },
    ]);
    expect(b.related_principles[0]!.tier).toBe(TIERS.success);
  });

  it("uses the category label only as a stated basis", () => {
    const b = buildResearchBrief(corpus(), shop({ category: "florist" }));
    expect(b.related_principles.map((r) => [r.case_id, r.matches])).toEqual([["CP-902", [{ basis: "category_exact" }]]]);
  });

  it("matches whole words only (no partial hits)", () => {
    const b = buildResearchBrief(corpus(), shop({ keywords: [{ term: "art", trait_ids: ["T2"] }] }));
    // "partial" contains "art" but is not the word
    expect(b.related_principles).toEqual([]);
    expect(b.missing_inputs).toContain("no_research_case_related_with_evidence");
  });

  it("never fills gaps: no traits, no category and unverified facts are listed and the gate holds at G0", () => {
    const b = buildResearchBrief(corpus(), shop({ facts_verified: false, traits: [] }));
    expect(b.gate).toBe("G0_hold");
    expect(b.missing_inputs).toEqual([
      "facts_not_verified_by_a_person",
      "no_cited_traits",
      "no_research_category_label",
      "no_analyst_keywords_tied_to_traits",
      "no_research_case_related_with_evidence",
    ]);
    expect(b.related_principles).toEqual([]);
  });

  it("leaves every Design DNA part undecided and marks the brief as research only", () => {
    const b = buildResearchBrief(corpus(), shop({ category: "bakery" }));
    expect(Object.keys(b.design_dna)).toEqual([...DNA_PARTS]);
    for (const part of Object.values(b.design_dna)) expect(part.choice).toBeNull();
    expect(b.status).toBe("research_only_not_prompt_input_not_approved");
    expect(b.corpus.tiers_used_for_principles).toEqual([TIERS.success]);
    expect(b.corpus.tiers_counted_only).toEqual([TIERS.candidate, TIERS.queue]);
  });

  it("passes on what not to copy and the reuse bans, and keeps the failure library from every case", () => {
    const b = buildResearchBrief(corpus(), shop({ category: "bakery" }));
    expect(b.not_to_copy).toEqual(["exact ledge proportions"]);
    expect(b.reuse_policy_deny).toContain("copy_specific_composition");
    expect(b.reuse_policy_deny).toContain("feed_into_production_generators_without_separate_review");
    expect(b.failure_library.map((f) => f.failure_mode)).toEqual(["Falling back to a left-text right-image module", "Generic photo cards"]);
  });

  it("does not offer the case's composition, only its principle", () => {
    const b = buildResearchBrief(corpus(), shop({ category: "bakery" }));
    const r = b.related_principles[0]!;
    expect(Object.keys(r).sort()).toEqual(["case_id", "evidence_ref", "implementation", "known_failure_modes", "matches", "not_to_copy", "principle", "tier"]);
    expect(Object.keys(r.principle).sort()).toEqual(["structural_translation", "visual_mechanisms"]);
  });

  it.each<[string, Record<string, unknown>]>([
    ["a keyword citing an unknown trait", { keywords: [{ term: "shelf", trait_ids: ["T9"] }] }],
    ["duplicate trait ids", { traits: [{ id: "T1", quote: "a", source_id: "S1" }, { id: "T1", quote: "b", source_id: "S1" }] }],
    ["a trait without a source", { traits: [{ id: "T1", quote: "a" }] }],
    ["markup in a trait", { traits: [{ id: "T1", quote: "<img src=x>", source_id: "S1" }] }],
  ])("refuses shop input with %s", (_n, over) => {
    expect(ShopResearchInput.safeParse({
      schema: "shop_research_input_v1", shop_key: "fictional-bakery", display_name: "架空ベーカリー", category: null, facts_verified: true,
      traits: [{ id: "T1", quote: "木の棚", source_id: "S1" }], keywords: [], ...over,
    }).success).toBe(false);
  });
});
