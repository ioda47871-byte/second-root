import { describe, expect, it } from "vitest";
import type { StructureDescriptor } from "@/lib/design-agent/structure/descriptor";
import { EMPHASISED_ITEMS, evaluateQualityDecision, QUALITY_CHECKLIST_ITEMS, RECENT_OTHER_SHOP_VERSIONS, templateWarnings } from "@/lib/sales/demo-version/quality";

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

const generic: StructureDescriptor = {
  schema: "structure_descriptor_v0",
  hero: { value: "split_copy_media", source: "measured" },
  flow: { value: "stacked_bands", source: "measured" },
  navigation: { value: "top_bar", source: "measured" },
  reading_path: { value: "z_pattern", source: "declared" },
  section_layouts: { value: ["grid_cards", "split_copy_media", "single_column_text"], source: "measured" },
  transitions: { value: ["hard_cut"], source: "measured" },
  text_direction: { value: "horizontal", source: "measured" },
  imagery: { value: "sequence", source: "measured" },
};

describe("template warnings (§7.5: warnings only)", () => {
  it("warns about the generic skeleton, another shop's skeleton and a reference — and never blocks", () => {
    const r = templateWarnings(generic, { references: { "CP-001": generic }, otherShops: { "version-x": generic } });
    expect(r.blocking).toBe(false);
    expect(r.warnings.map((w) => w.code).sort()).toEqual(["GENERIC_SKELETON", "SAME_SKELETON_AS_OTHER_SHOP", "TOO_CLOSE_TO_REFERENCE"]);
  });

  it("does not let warnings change a quality decision", () => {
    const w = templateWarnings(generic, { references: { "CP-001": generic } });
    expect(w.warnings.length).toBeGreaterThan(0);
    // evaluateQualityDecision has no warning input: the owner's checklist decides
    expect(evaluateQualityDecision({ decision: "approved", checklist: allOk, renders, viewedRenders: renders }).ok).toBe(true);
  });

  it("compares with at most 20 other shops' versions", () => {
    const others = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`v${i}`, generic]));
    const r = templateWarnings(generic, { otherShops: others });
    expect(r.warnings.filter((w) => w.code === "SAME_SKELETON_AS_OTHER_SHOP")).toHaveLength(RECENT_OTHER_SHOP_VERSIONS);
  });
});
