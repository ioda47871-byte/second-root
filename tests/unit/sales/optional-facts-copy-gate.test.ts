import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { copyGateSendBlockers, nextCopyStep, reviewCopyQuality, shopContext, styleAndInformationFindings } from "@/lib/design-agent/quality-pipeline/copy-quality-review";

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

  it("rejects only missing hours at the real-shop copy send gate; verified hours are an exact passing control", () => {
    // Synthetic shop in the real_shop_proposal lane. The test MUST not pass only
    // because the fictional research lane is never sendable.
    const make = (withHours: boolean) => {
      const shopId = "proposal-gate-fixture";
      const facts = [
        fact("F1", "name", "架空の焼菓子店"),
        fact("F2", "category", "焼菓子"),
        fact("F3", "address", "架空市架空区架空町"),
        fact("F4", "description", "架空の焼菓子を扱います。"),
        ...(withHours ? [fact("F5", "hours", "10:00〜17:00")] : []),
      ];
      const factsPack = JSON.stringify({ schema: "shop_facts_pack_v1", shop_id: shopId, facts });
      const factsSha = createHash("sha256").update(factsPack).digest("hex");
      const items = [
        { id: "name-line", text: facts[0]!.value, claim_type: "fact", source_fact_ids: ["F1"], owner_review_needed: false },
        { id: "about-line", text: facts[3]!.value, claim_type: "fact", source_fact_ids: ["F4"], owner_review_needed: false },
        { id: "location-line", text: facts[2]!.value, claim_type: "fact", source_fact_ids: ["F3"], owner_review_needed: false },
        ...(withHours ? [{ id: "hours-line", text: "10:00〜17:00", claim_type: "fact", source_fact_ids: ["F5"], owner_review_needed: false }] : []),
      ];
      const copyRecord = JSON.stringify({ schema: "comp_copy_v1", shop_id: shopId, facts_sha256: factsSha, lane: "real_shop_proposal", items });
      const pageHtml = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head>
<body><main><section id="hero"><h1>架空の焼菓子店</h1></section>
<section id="about"><p>架空の焼菓子を扱います。</p></section>
<section id="location"><p>架空市架空区架空町</p></section>
${withHours ? '<section id="hours"><p>10:00〜17:00</p></section>' : ""}</main></body></html>`;
      const files = { factsPack, copyRecord, pageHtml, pageCss: "body { margin: 0; }" };
      const review = reviewCopyQuality(files);
      const approval = {
        shop_id: review.shop_id,
        facts_sha256: review.facts_sha256,
        copy_sha256: review.copy_sha256,
        page_html_sha256: review.page_html_sha256,
        page_css_sha256: review.page_css_sha256,
        decision: "approve" as const,
      };
      expect(review.lane).toBe("real_shop_proposal");
      expect(review.base_checks).toEqual({ ok: true, codes: [] });
      return { files, review, approval };
    };

    const missing = make(false);
    expect(missing.review.findings
      .filter((f) => (f.severity === "hold" || f.severity === "fail") && f.code !== "COPY_APPROVAL_MISSING")
      .map((f) => f.rule)).toEqual(["facts_missing_hours"]);
    expect(nextCopyStep(missing.review)).toBe("stop_hold");
    expect(copyGateSendBlockers(missing.review, missing.files, missing.approval)).toEqual(["REVIEW_NOT_PASSED"]);

    const verified = make(true);
    expect(verified.review.findings.map((f) => f.rule)).toEqual(["real_shop_needs_owner_approval"]);
    expect(nextCopyStep(verified.review)).toBe("owner_review");
    expect(copyGateSendBlockers(verified.review, verified.files, null)).toEqual(["OWNER_APPROVAL_MISSING"]);
    expect(copyGateSendBlockers(verified.review, verified.files, verified.approval)).toEqual([]);
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
