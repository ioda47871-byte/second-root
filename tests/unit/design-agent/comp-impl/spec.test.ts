import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseShop } from "@/lib/design-agent/compare/shops";
import { checkCompSpec, specFactProblems, type CompSpec } from "@/lib/design-agent/comp-impl/spec";
import { FACTS_SOURCE, FIXTURE } from "./support";

// DEV-082: the implementation spec Claude writes from a comp (layout only).

const base = () => JSON.parse(readFileSync(join(FIXTURE, "layout-spec.json"), "utf8")) as CompSpec;
const demo = parseShop(JSON.parse(readFileSync(FACTS_SOURCE, "utf8")) as unknown)!.demo;
const problems = (mutate: (s: CompSpec) => void) => {
  const s = base();
  mutate(s);
  const r = checkCompSpec(s);
  return r.ok ? [] : r.problems;
};

describe("checkCompSpec", () => {
  it("accepts the synthetic fixture's spec, whose phrases are all verbatim facts", () => {
    const r = checkCompSpec(base());
    expect(r.ok).toBe(true);
    if (r.ok) expect(specFactProblems(r.spec, demo)).toEqual([]);
  });

  it.each<[string, (s: CompSpec) => void, string]>([
    ["an unknown field", (s) => Object.assign(s, { extra: 1 }), "SPEC_SHAPE"],
    ["an author other than a Claude session", (s) => Object.assign(s, { authored_by: "codex" }), "SPEC_SHAPE"],
    ["a section id twice", (s) => (s.sections[1]!.id = "header"), "SPEC_SECTION_ID_REPEAT"],
    ["a box past the artboard", (s) => (s.sections[1]!.box.w = 1.2), "SPEC_SHAPE"],
    ["a box whose sum passes the edge", (s) => (s.sections[1]!.box.x = 0.5), "SPEC_SECTION_BOX"],
    ["sections out of order", (s) => s.sections.reverse(), "SPEC_SECTION_ORDER"],
    ["overlapping sections", (s) => (s.sections[1]!.box.h = 0.5), "SPEC_SECTION_OVERLAP"],
    ["a repeated palette colour", (s) => (s.palette[1]!.hex = "#f4eee3"), "SPEC_PALETTE_REPEAT"],
    ["a flat type scale", (s) => (s.type_scale.heading_px = 56), "SPEC_TYPE_ORDER"],
    ["an invented nav label", (s) => (s.nav.items[0]!.label = "人気商品"), "SPEC_LABEL_NOT_ALLOWED"],
    ["a sales CTA", (s) => (s.cta = { label: "予約する", target: "info" }), "SPEC_LABEL_SALES"],
    ["a dead nav target", (s) => (s.nav.items[0]!.target = "menu"), "SPEC_TARGET_UNKNOWN"],
    ["a slot in an unknown section", (s) => (s.image_slots[0]!.section = "gallery"), "SPEC_SLOT_SECTION_UNKNOWN"],
    ["a disclosure in an unknown section", (s) => (s.disclosure.section = "nowhere"), "SPEC_DISCLOSURE_SECTION_UNKNOWN"],
    ["an altered disclosure", (s) => Object.assign(s.disclosure, { text: "デザイン提案" }), "SPEC_SHAPE"],
    ["the name not required", (s) => (s.required_facts = ["hours"]), "SPEC_NAME_NOT_REQUIRED"],
    ["a mobile order that drops a section", (s) => s.mobile.order.pop(), "SPEC_MOBILE_ORDER"],
  ])("refuses %s", (_name, mutate, code) => {
    expect(problems(mutate)).toContain(code);
  });

  it("refuses a phrase that is not inside a fact, and a required fact the shop does not have", () => {
    const s = base();
    s.fact_phrases = ["老舗の味"];
    expect(specFactProblems(s, demo)).toEqual(["SPEC_PHRASE_NOT_A_FACT"]);
    expect(specFactProblems(base(), { ...demo, phone: null })).toEqual(["SPEC_REQUIRED_FACT_ABSENT"]);
  });
});
