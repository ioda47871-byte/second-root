import { describe, expect, it } from "vitest";
import { EMPHASISED_ITEMS, evaluateQualityDecision, QUALITY_CHECKLIST_ITEMS, RECENT_OTHER_SHOP_VERSIONS, templateWarnings, type StructureFindingInput } from "@/lib/sales/demo-version/quality";

const allOk = Object.fromEntries(QUALITY_CHECKLIST_ITEMS.map((k) => [k, "ok"]));
const renders = { desktop_1440: "1".repeat(64), mobile_390: "2".repeat(64) };

describe("7-item checklist (§7.2)", () => {
  it("has the seven items with 3・4・5 emphasised", () => {
    expect(QUALITY_CHECKLIST_ITEMS).toHaveLength(7);
    expect(EMPHASISED_ITEMS).toEqual(["shop_specific_structure", "no_generic_lp_regression", "full_page_information"]);
  });

  it("allows approval only with all seven ok and both required renders viewed", () => {
    expect(evaluateQualityDecision({ decision: "approved", checklist: allOk, renders, viewedRenders: renders }).ok).toBe(true);
  });

  it.each(QUALITY_CHECKLIST_ITEMS)("one ng (%s) blocks approval but allows changes_requested / rejected", (item) => {
    const checklist = { ...allOk, [item]: "ng" };
    expect(evaluateQualityDecision({ decision: "approved", checklist, renders, viewedRenders: renders })).toEqual({ ok: false, codes: ["CHECKLIST_HAS_NG"] });
    expect(evaluateQualityDecision({ decision: "changes_requested", checklist, renders, viewedRenders: renders }).ok).toBe(true);
    expect(evaluateQualityDecision({ decision: "rejected", checklist, renders, viewedRenders: renders }).ok).toBe(true);
  });

  it("needs the PC 1440 and SP 390 renders, as they were shown", () => {
    expect(evaluateQualityDecision({ decision: "approved", checklist: allOk, renders: { desktop_1440: renders.desktop_1440 }, viewedRenders: renders })).toEqual({ ok: false, codes: ["RENDER_MISSING"] });
    expect(evaluateQualityDecision({ decision: "approved", checklist: allOk, renders, viewedRenders: { ...renders, mobile_390: "3".repeat(64) } })).toEqual({ ok: false, codes: ["RENDER_NOT_VIEWED"] });
    expect(evaluateQualityDecision({ decision: "approved", checklist: allOk, renders: { ...renders, tablet_768: "4".repeat(64) }, viewedRenders: renders })).toEqual({ ok: false, codes: ["RENDER_NOT_VIEWED"] });
  });

  it("refuses a malformed checklist or decision", () => {
    expect(evaluateQualityDecision({ decision: "approved", checklist: { ...allOk, extra: "ok" }, renders, viewedRenders: renders })).toEqual({ ok: false, codes: ["CHECKLIST_INVALID"] });
    expect(evaluateQualityDecision({ decision: "approved", checklist: { ...allOk, not_a_copy: "maybe" }, renders, viewedRenders: renders })).toEqual({ ok: false, codes: ["CHECKLIST_INVALID"] });
    expect(evaluateQualityDecision({ decision: "approved", checklist: { identity_lock: "ok" }, renders, viewedRenders: renders })).toEqual({ ok: false, codes: ["CHECKLIST_INVALID"] });
    expect(evaluateQualityDecision({ decision: "ship" as "approved", checklist: allOk, renders, viewedRenders: renders })).toEqual({ ok: false, codes: ["DECISION_INVALID"] });
  });
});

const FINDINGS: StructureFindingInput[] = [
  { code: "GENERIC_SKELETON", reasons: ["hero:split_copy_media", "flow:stacked_bands"] },
  { code: "TOO_CLOSE_TO_REFERENCE", reference: "CP-001", similarity: 0.9 },
  { code: "SIBLINGS_SAME_SKELETON", sibling: "version-x", similarity: 0.7 },
  { code: "ASPECTS_UNKNOWN", aspects: ["transitions"] },
];

describe("template warnings (§7.5: warnings only)", () => {
  it("maps the structure findings to warnings and never blocks", () => {
    const r = templateWarnings(FINDINGS);
    expect(r.blocking).toBe(false);
    expect(r.warnings).toEqual([
      { code: "GENERIC_SKELETON", reasons: ["hero:split_copy_media", "flow:stacked_bands"] },
      { code: "TOO_CLOSE_TO_REFERENCE", reference: "CP-001", similarity: 0.9 },
      { code: "SAME_SKELETON_AS_OTHER_SHOP", versionId: "version-x", similarity: 0.7 },
      { code: "ASPECTS_UNKNOWN", aspects: ["transitions"] },
    ]);
  });

  it("has no way to change a quality decision (the owner's checklist decides)", () => {
    expect(templateWarnings(FINDINGS).warnings.length).toBe(4);
    expect(evaluateQualityDecision.length).toBe(1);
    expect(evaluateQualityDecision({ decision: "approved", checklist: allOk, renders, viewedRenders: renders }).ok).toBe(true);
  });

  it("keeps at most 20 other shops' versions and drops unknown codes", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ code: "SIBLINGS_SAME_SKELETON" as const, sibling: `v${i}`, similarity: 0.8 }));
    expect(templateWarnings(many).warnings).toHaveLength(RECENT_OTHER_SHOP_VERSIONS);
    expect(templateWarnings([{ code: "SOMETHING_NEW" } as unknown as StructureFindingInput]).warnings).toEqual([]);
  });
});

