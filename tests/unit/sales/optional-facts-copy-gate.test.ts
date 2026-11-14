import { describe, expect, it } from "vitest";
import { shopContext, styleAndInformationFindings } from "@/lib/design-agent/quality-pipeline/copy-quality-review";

// DEV-263k (Issue #275): optional hours may be absent from a trusted facts pack,
// but the independent copy quality HOLD must NOT be silently relaxed by onboarding.
// All shops and values here are fictional.
describe("optional facts are NOT permission to send unverified opening hours", () => {
  const fact = (id: string, key: string, value: string) => ({ id, key, value, source_id: "S1" });
  const base = [
    fact("F1", "name", "架空の焼菓子店"),
    fact("F2", "category", "baked_goods"),
    fact("F3", "address", "架空市架空区架空町1-2"),
    fact("F4", "description", "架空のお菓子を扱う架空のお店です。"),
    fact("F5", "service_1", "架空の焼菓子"),
  ];

  it("HOLDs facts_missing_hours for a sparse real-shop pack", () => {
    const review = styleAndInformationFindings([], shopContext(base), "real_shop_proposal");
    expect(review.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "COPY_INFORMATION_MISSING", severity: "hold", rule: "facts_missing_hours" }),
      ]),
    );
  });

  it("does not claim missing hours when a trusted hour fact actually exists", () => {
    const withHours = [...base, fact("F6", "hours", "10:00〜17:00")];
    const review = styleAndInformationFindings([], shopContext(withHours), "real_shop_proposal");
    expect(review.findings.some((f) => f.rule === "facts_missing_hours")).toBe(false);
    // With hours in the pack but none displayed, the normal copy_omits_hours REVISE still applies.
    expect(review.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "COPY_INFORMATION_MISSING", severity: "revise", rule: "copy_omits_hours" }),
      ]),
    );
  });
});
