import { describe, expect, it } from "vitest";
import { DESIGN_DNA_PARTS, DesignDnaError, parseDesignDna, sameDesignDna } from "@/lib/design-agent/design-image/design-dna";

const valid = () => ({
  schema_version: 1,
  shop_key: "fixture_01",
  status: "research_only",
  factual_copy: "verified_facts_only",
  asset_policy: "none",
  evidence: [
    { id: "fact01", origin: "verified_shop_fact", observation: "The shop offers handcrafted sweets.", source_label: "verified shop facts" },
  ],
  references: [
    { id: "DR-027", url: "https://bake-jp.com/info/abitecoffee_202609launch/", scope: "public_visual_only",
      observed_principle: "Strong typographic identity, limited colours, abstract shapes.",
      transferable_idea: "Explain a memorable graphic decision without copying its shapes.",
      rights: "analysis_only" },
  ],
  decisions: DESIGN_DNA_PARTS.map((part) => ({
    part, choice: `Unique ${part} decision built from the shop evidence.`,
    rationale: "Design reasoning connected to a verified store trait.",
    evidence_ids: ["fact01"], reference_ids: ["DR-027"],
  })),
});

describe("Design DNA: research-only, no template selection", () => {
  it("requires all eight independent decisions and explicit provenance", () => {
    const parsed = parseDesignDna(valid());
    expect(parsed.decisions.map((x) => x.part)).toEqual(DESIGN_DNA_PARTS);
    expect(parsed.status).toBe("research_only");
    expect(parsed.references[0]!.rights).toBe("analysis_only");
  });

  it("refuses ungrounded facts, duplicate sections, unapproved assets and additional payload fields", () => {
    const cases = [
      { ...valid(), decisions: valid().decisions.slice(0, -1) },
      { ...valid(), decisions: valid().decisions.map((x) => ({ ...x, evidence_ids: ["invented"] })) },
      { ...valid(), decisions: valid().decisions.map((x) => ({ ...x, part: "hero" })) },
      { ...valid(), asset_policy: "scraped_instagram_images" },
      { ...valid(), references: [{ ...valid().references[0], rights: "reuse_allowed" }] },
      { ...valid(), references: [{ ...valid().references[0], url: "file:///etc/passwd" }] },
      { ...valid(), evidence: [{ ...valid().evidence[0], image_url: "https://other.site/photo.jpg" }] },
      { ...valid(), status: "published" },
    ];
    for (const input of cases) expect(() => parseDesignDna(input)).toThrow(DesignDnaError);
  });

  it("flags copy/paste visual directions even if shop and references differ", () => {
    const a = parseDesignDna(valid());
    const b = parseDesignDna({ ...valid(), shop_key: "fixture_02", evidence: [{ ...valid().evidence[0], observation: "Different verified shop details." }] });
    expect(sameDesignDna(a, b)).toBe(true);
    b.decisions[0]!.choice = "Entirely different visual hierarchy and original hero focal point.";
    expect(sameDesignDna(a, b)).toBe(false);
  });
});
