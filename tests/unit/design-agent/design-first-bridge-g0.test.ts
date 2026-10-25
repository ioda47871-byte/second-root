import { describe, expect, it } from "vitest";
import { traceBridgeJobFacts, type G0EvidenceRow } from "@/lib/design-agent/design-first/bridge-g0";

const SOURCE = "https://www.instagram.com/brot_yanagi/";
const NOW = "2026-10-26T02:00:00+09:00";
const JOB = {
  version: 1 as const,
  job_id: "b-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  facts: {
    name: "架空麦工房",
    category: "bakery",
    description: "毎朝焼くバゲット",
    menu_items: ["バゲット", "クロワッサン"],
  },
  source: { instagram_url: SOURCE },
};
function evidence(): G0EvidenceRow[] {
  return [
    { fact_key: "name", source_url: SOURCE, quote: "架空麦工房", checked_at: NOW },
    { fact_key: "description", source_url: SOURCE, quote: "毎朝焼くバゲット", checked_at: NOW },
    { fact_key: "menu_items.0", source_url: SOURCE, quote: "バゲット", checked_at: NOW },
    { fact_key: "menu_items.1", source_url: SOURCE, quote: "クロワッサン", checked_at: NOW },
  ];
}

describe("DEV-112 existing worker job → G0 traceability (offline, no approvals)", () => {
  it("keeps worker facts verbatim and produces research-only input, with no G1/G2/publish permission", () => {
    const result = traceBridgeJobFacts(JOB, evidence());
    expect(result.status).toBe("traceable_not_verified");
    if (result.status !== "traceable_not_verified") throw new Error("expected trace");
    expect(result.data.shop_facts).toEqual({
      name: "架空麦工房",
      description: "毎朝焼くバゲット",
      menu_items: ["バゲット", "クロワッサン"],
    });
    expect(result.data.traced_keys).toEqual(["name", "description", "menu_items.0", "menu_items.1"]);
    expect(result.data.source_count).toBe(1);
    expect(result.data).toMatchObject({
      independent_source_verification_required: true, owner_review_required: true,
      image_model_input_authorized: false, image_edit_authorized: false,
      image_generation_authorized: false, comp_to_site_authorized: false,
      publish_authorized: false, outreach_authorized: false,
    });
  });

  it("reports exactly which factual claims still need a source", () => {
    const result = traceBridgeJobFacts(JOB, evidence().slice(0, 2));
    expect(result).toEqual({ status: "missing_evidence", missing: ["menu_items.0", "menu_items.1"], data: null });
  });

  it("refuses outside URLs, false quotes and repeated claims instead of claiming verification", () => {
    for (const changed of [
      [{ ...evidence()[0]!, source_url: "https://example.com/unrelated" }, ...evidence().slice(1)],
      [{ ...evidence()[0]!, quote: "別の店" }, ...evidence().slice(1)],
      [...evidence(), evidence()[0]!],
      [...evidence(), { ...evidence()[0]!, fact_key: "new_claim" }],
    ]) {
      expect(traceBridgeJobFacts(JOB, changed)).toEqual({ status: "inconsistent_evidence", missing: [], data: null });
    }
  });

  it("uses an exact allowlist for evidence; no raw screenshot or agent assertion passes", () => {
    expect(traceBridgeJobFacts(JOB, [{ ...evidence()[0]!, screenshot_png: "base64..." }])).toEqual({ status: "invalid_evidence", data: null });
    expect(traceBridgeJobFacts(JOB, [{ ...evidence()[0]!, verified_by_ai: true }])).toEqual({ status: "invalid_evidence", data: null });
    expect(traceBridgeJobFacts(JOB, [{ ...evidence()[0]!, checked_at: "yesterday" }])).toEqual({ status: "invalid_evidence", data: null });
    expect(traceBridgeJobFacts({ ...JOB, image: "secret" }, evidence())).toEqual({ status: "invalid_job", data: null });
  });

  it("rejects unknown fact fields and wrong-type values rather than silently filtering claims", () => {
    expect(traceBridgeJobFacts({ ...JOB, facts: { ...JOB.facts, website: "invented" } }, evidence()))
      .toEqual({ status: "invalid_facts", data: null });
    expect(traceBridgeJobFacts({ ...JOB, facts: { ...JOB.facts, menu_items: ["valid", 7] } }, evidence()))
      .toEqual({ status: "invalid_facts", data: null });
  });

  it("does not equate a syntactically valid job with verified source access", () => {
    expect(traceBridgeJobFacts({ ...JOB, source: { instagram_url: "https://example.com/misnamed" } }, evidence()))
      .toEqual({ status: "invalid_source", data: null });
    expect(traceBridgeJobFacts({ ...JOB, source: { instagram_url: "https://www.instagram.com/accounts/login/" } }, evidence()))
      .toEqual({ status: "invalid_source", data: null });
  });

  it("never treats a category switch as new source evidence or different content facts", () => {
    const first = traceBridgeJobFacts(JOB, evidence());
    const second = traceBridgeJobFacts({ ...JOB, facts: { ...JOB.facts, category: "cafe" } }, evidence());
    expect(first.status).toBe("traceable_not_verified");
    expect(second.status).toBe("traceable_not_verified");
    if (first.status === "traceable_not_verified" && second.status === "traceable_not_verified") {
      expect(second.data.shop_facts).toEqual(first.data.shop_facts);
    }
  });

  it("empty claims do not auto-approve a design; only record the supplied name", () => {
    const small = { ...JOB, facts: { name: "架空麦工房", category: "bakery" } };
    const result = traceBridgeJobFacts(small, [evidence()[0]!]);
    expect(result.status).toBe("traceable_not_verified");
    if (result.status === "traceable_not_verified") expect(result.data.owner_review_required).toBe(true);
  });
});
