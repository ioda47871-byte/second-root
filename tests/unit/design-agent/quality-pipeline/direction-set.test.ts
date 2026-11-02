import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkDirectionSet } from "../../../../lib/design-agent/quality-pipeline/direction-set";
import { loadInputs } from "../../../../scripts/design-artifact/direction-set";

// DEV-157 (Issue #193, T1): the art-direction set and its offline checks. A PASS is "ready to draw comps", never quality.

const REPO = resolve(__dirname, "../../../..");
const POC = "design-library/research/quality-pipeline/poc/tsugute";
const FACTS = resolve(REPO, POC, "facts-pack.json");
const principles = JSON.parse(readFileSync(resolve(REPO, "design-library/research/quality-pipeline/principles-v1.json"), "utf8")) as {
  cases: Array<{ id: string; principles: string[] }>;
  not_viewed: string[];
};
const example = () => JSON.parse(readFileSync(resolve(REPO, POC, "direction-set.json"), "utf8"));
const opts = loadInputs(FACTS);
const codes = (s: unknown) => checkDirectionSet(s, opts).findings.map((f) => f.code);

describe("art direction set (DEV-157, Issue #193)", () => {
  it("the つぐ手 example is ready for comps, and the note says that is not a quality verdict", () => {
    const r = checkDirectionSet(example(), opts);
    expect(r.findings).toEqual([]);
    expect(r.status).toBe("READY_FOR_COMPS");
    expect(r.note).toMatch(/not a quality verdict/);
  });

  it("the example cites only viewed cases and its facts SHA is the pack's", () => {
    const s = example();
    expect(s.facts_sha256).toBe(createHash("sha256").update(readFileSync(FACTS)).digest("hex"));
    expect(s.shop_id).toBe(opts.shopId);
    for (const d of s.directions) for (const r of [...d.references, ...d.not_used]) expect(principles.not_viewed).not.toContain(r.case_id);
  });

  it("a bad shape holds with SET_SCHEMA (two directions, an unknown hero)", () => {
    const s = example();
    s.directions.pop();
    expect(codes(s)).toEqual(["SET_SCHEMA"]);
    const t = example();
    t.directions[0].composition.hero = "split_hero";
    expect(codes(t)).toEqual(["SET_SCHEMA"]);
  });

  it("C1: facts SHA, chosen motif, motif ids and fact refs", () => {
    const s = example();
    s.facts_sha256 = "0".repeat(64);
    expect(codes(s)).toContain("FACTS_SHA_MISMATCH");
    const t = example();
    t.motif.chosen = "M9";
    expect(codes(t)).toContain("MOTIF_CHOSEN_UNKNOWN");
    const u = example();
    u.motif.candidates[1].id = "M1";
    expect(codes(u)).toContain("MOTIF_IDS_DUPLICATED");
    const v = example();
    v.motif.candidates[0].fact_refs = ["F99"];
    expect(codes(v)).toContain("MOTIF_FACT_UNKNOWN");
    // every direction answered C1 "yes", so each one is contradicted
    expect(checkDirectionSet(v, opts).findings.filter((f) => f.code === "ANSWER_CONTRADICTED_BY_CHECK" && f.check === "C1")).toHaveLength(3);
  });

  it("C2: two directions sharing a hero (or a flow) hold, and the descriptor must agree with the composition", () => {
    const s = example();
    s.directions[1].composition.hero = "diagram_led";
    s.directions[1].descriptor.hero.value = "diagram_led";
    const r = checkDirectionSet(s, opts);
    expect(r.status).toBe("HOLD");
    expect(r.findings).toContainEqual({ check: "C2", code: "HERO_OR_FLOW_SHARED", direction: "d1-seam-across|d2-lacquer-layers" });
    const t = example();
    t.directions[1].composition.hero = "diagram_led"; // descriptor left as type_led
    expect(codes(t)).toContain("DESCRIPTOR_COMPOSITION_MISMATCH");
    const u = example();
    u.directions[2].sections.reverse();
    expect(codes(u)).toContain("DESCRIPTOR_SECTIONS_MISMATCH");
    const v = example();
    v.directions[0].id = v.directions[1].id;
    expect(codes(v)).toContain("DIRECTION_IDS_DUPLICATED");
  });

  it("C2: a sibling with the same skeleton holds even when the hero and flow labels differ", () => {
    const s = example();
    const [a, b] = [s.directions[0], s.directions[1]];
    b.sections = structuredClone(a.sections);
    for (const k of ["navigation", "reading_path", "section_layouts", "transitions", "text_direction", "imagery"]) b.descriptor[k] = structuredClone(a.descriptor[k]);
    expect(codes(s)).toContain("SIBLINGS_SAME_SKELETON");
  });

  it("C5: the schema refuses a generic hero or flow; half or more generic sections hold", () => {
    const s = example();
    s.directions[2].composition = { hero: "split_copy_media", flow: "stacked_bands" };
    expect(codes(s)).toEqual(["SET_SCHEMA"]);
    const t = example();
    const d = t.directions[2];
    for (const x of d.sections.slice(0, 3)) x.layout = "grid_cards";
    d.descriptor.section_layouts.value = d.sections.map((x: { layout: string }) => x.layout);
    const r = checkDirectionSet(t, opts);
    expect(r.findings).toContainEqual({ check: "C5", code: "LOWER_SECTIONS_GENERIC", direction: "d3-vessel-stations", detail: "3/6" });
    expect(r.findings).toContainEqual({ check: "C5", code: "ANSWER_CONTRADICTED_BY_CHECK", direction: "d3-vessel-stations" });
    d.sections[0].layout = "diagram";
    d.descriptor.section_layouts.value = d.sections.map((x: { layout: string }) => x.layout);
    expect(checkDirectionSet(t, opts).findings.map((f) => f.code)).not.toContain("LOWER_SECTIONS_GENERIC"); // 2/6
  });

  it("C2: a descriptor with an unknown aspect holds (it would escape the sibling comparison)", () => {
    const s = example();
    s.directions[0].descriptor.transitions = null;
    expect(codes(s)).toContain("DESCRIPTOR_ASPECTS_UNKNOWN");
  });

  it("C3: repeated facets and duplicated section ids hold", () => {
    const s = example();
    for (const x of s.directions[0].sections) x.motif_facet = "金の線";
    expect(codes(s)).toContain("MOTIF_FACETS_REPEATED");
    const t = example();
    t.directions[0].sections[1].id = t.directions[0].sections[0].id;
    expect(codes(t)).toContain("SECTION_IDS_DUPLICATED");
  });

  it("C4: a phone plan that copies the desktop plan, or repeats itself, holds", () => {
    const s = example();
    s.directions[0].sp_plan.first_screen = s.directions[0].pc_plan;
    expect(codes(s)).toContain("SP_PLAN_NOT_SEPARATE");
    const t = example();
    t.directions[1].sp_plan.overlaps = t.directions[1].sp_plan.reorder;
    expect(codes(t)).toContain("SP_PLAN_NOT_SEPARATE");
  });

  it("refs: a not-viewed case or an unknown principle holds", () => {
    for (const id of principles.not_viewed) {
      const s = example();
      s.directions[0].references[0].case_id = id;
      expect(codes(s)).toContain("REFERENCE_NOT_VIEWED");
    }
    const t = example();
    t.directions[0].references[0].principle = "P9";
    expect(codes(t)).toContain("PRINCIPLE_UNKNOWN");
  });

  it("a designer's 'no' holds; 'unknown' with a reason does not", () => {
    const s = example();
    s.directions[1].checklist.C6 = { answer: "no", evidence: "写真と文字がまだ関係していない" };
    expect(checkDirectionSet(s, opts).findings).toEqual([{ check: "C6", code: "DESIGNER_ANSWERED_NO", direction: "d2-lacquer-layers" }]);
    const t = example();
    t.directions[1].checklist.C6 = { answer: "unknown", evidence: "カンプで確かめる" };
    expect(checkDirectionSet(t, opts).status).toBe("READY_FOR_COMPS");
  });

  it("C2: two directions with the same body hold even when only cheap labels differ (review H1)", () => {
    const s = example();
    const [a, b] = [s.directions[0], s.directions[1]];
    b.sections = structuredClone(a.sections);
    for (const k of ["section_layouts", "transitions", "reading_path", "imagery"]) b.descriptor[k] = structuredClone(a.descriptor[k]);
    b.descriptor.navigation.value = "none";
    b.descriptor.text_direction.value = "mixed";
    const r = checkDirectionSet(s, opts);
    expect(r.status).toBe("HOLD");
    expect(r.findings).toContainEqual({ check: "C2", code: "SECTIONS_SHARED", direction: "d1-seam-across|d2-lacquer-layers", detail: "facets:6" });
    // the same layouts in another order are the same body
    const t = example();
    t.directions[2].sections = structuredClone(t.directions[0].sections).reverse();
    t.directions[2].descriptor.section_layouts.value = t.directions[2].sections.map((x: { layout: string }) => x.layout);
    expect(codes(t)).toContain("SECTIONS_SHARED");
  });

  it("C2: a flow shared by two directions holds; a measured aspect in a declared record holds", () => {
    const s = example();
    s.directions[2].composition.flow = "single_axis_scroll";
    s.directions[2].descriptor.flow.value = "single_axis_scroll";
    expect(checkDirectionSet(s, opts).findings).toContainEqual({ check: "C2", code: "HERO_OR_FLOW_SHARED", direction: "d2-lacquer-layers|d3-vessel-stations" });
    const t = example();
    t.directions[0].descriptor.imagery.source = "measured";
    expect(checkDirectionSet(t, opts).findings).toContainEqual({ check: "C2", code: "DESCRIPTOR_NOT_DECLARED", direction: "d1-seam-across", detail: "imagery" });
  });

  it("C1: the facts pack's shop, each direction's motif focus, and the chosen motif in use", () => {
    expect(codes(example()).length).toBe(0);
    const s = example();
    s.shop_id = "another-shop";
    expect(codes(s)).toContain("SHOP_ID_MISMATCH");
    const t = example();
    t.directions[1].motif_focus = "M8";
    expect(codes(t)).toContain("MOTIF_FOCUS_UNKNOWN");
    const u = example();
    u.directions[0].motif_focus = "M4";
    expect(codes(u)).toContain("MOTIF_CHOSEN_UNUSED");
  });

  it("refs: a cited case must carry the cited principle; set-aside cases must be viewed and not also used", () => {
    const s = example();
    s.directions[1].references[1].principle = "P4"; // CP-012 is P1/P3/P5
    expect(checkDirectionSet(s, opts).findings).toContainEqual({ check: "refs", code: "REFERENCE_PRINCIPLE_NOT_IN_CASE", direction: "d2-lacquer-layers", detail: "P4:CP-012" });
    for (const d of example().directions) for (const r of d.references) expect(principles.cases.find((c) => c.id === r.case_id)?.principles).toContain(r.principle);
    const t = example();
    t.directions[0].not_used[0].case_id = "CP-003";
    expect(codes(t)).toContain("REFERENCE_NOT_VIEWED");
    const u = example();
    u.directions[0].not_used[0].case_id = u.directions[0].references[0].case_id;
    expect(codes(u)).toContain("REFERENCE_BOTH_USED_AND_NOT");
  });

  it("evidence is written per direction: the same text (up to spaces, digits and punctuation) in two directions holds", () => {
    const s = example();
    s.directions[2].checklist.C6.evidence = `${s.directions[1].checklist.C6.evidence} 。`;
    expect(checkDirectionSet(s, opts).findings).toContainEqual({ check: "C6", code: "EVIDENCE_COPIED", direction: "d2-lacquer-layers|d3-vessel-stations" });
  });

  it("C3/C4 compare text loosely: numbered copies of one facet, or a phone line that is the desktop plan with spaces, hold", () => {
    const s = example();
    s.directions[0].sections.forEach((x: { motif_facet: string }, i: number) => (x.motif_facet = `金の線${i}`));
    expect(codes(s)).toContain("MOTIF_FACETS_REPEATED");
    // boundary: n-1 distinct facets is allowed, n-2 is not
    const t = example();
    t.directions[0].sections[1].motif_facet = t.directions[0].sections[0].motif_facet;
    expect(codes(t)).not.toContain("MOTIF_FACETS_REPEATED");
    t.directions[0].sections[2].motif_facet = t.directions[0].sections[0].motif_facet;
    expect(codes(t)).toContain("MOTIF_FACETS_REPEATED");
    const u = example();
    u.directions[0].sp_plan.reorder = ` ${u.directions[0].pc_plan}。`;
    expect(codes(u)).toContain("SP_PLAN_NOT_SEPARATE");
  });

  it("a 'yes' answer is contradicted by a machine finding on the same check (C2, C3, C4)", () => {
    const s = example();
    s.directions[0].sections[1].id = s.directions[0].sections[0].id;
    s.directions[1].sp_plan.overlaps = s.directions[1].sp_plan.reorder;
    s.directions[2].composition.flow = "single_axis_scroll";
    s.directions[2].descriptor.flow.value = "single_axis_scroll";
    const f = checkDirectionSet(s, opts).findings.filter((x) => x.code === "ANSWER_CONTRADICTED_BY_CHECK");
    expect(f).toContainEqual({ check: "C3", code: "ANSWER_CONTRADICTED_BY_CHECK", direction: "d1-seam-across" });
    expect(f).toContainEqual({ check: "C4", code: "ANSWER_CONTRADICTED_BY_CHECK", direction: "d2-lacquer-layers" });
    expect(f).toContainEqual({ check: "C2", code: "ANSWER_CONTRADICTED_BY_CHECK", direction: "d3-vessel-stations" });
  });

  it("the example shop is fictional and makes no real-world claim", () => {
    const pack = readFileSync(FACTS, "utf8");
    expect(pack).toContain("架空");
    expect(pack).toContain("実在の工房ではありません");
    expect(pack).not.toMatch(/名古屋|千種|052-/);
  });

  it("the CLI exits 0 for the example and 1 for a held set, printing the findings", () => {
    const cli = resolve(REPO, "scripts/design-artifact/direction-set.ts");
    const run = (set: string, facts = FACTS) => {
      try {
        return { code: 0, out: execFileSync("npx", ["tsx", cli, "--set", set, "--facts", facts], { encoding: "utf8" }) };
      } catch (e) {
        const x = e as { status: number; stdout: string };
        return { code: x.status, out: x.stdout };
      }
    };
    expect(run(resolve(REPO, POC, "direction-set.json")).code).toBe(0);
    const s = example();
    s.directions[0].references[0].case_id = "CP-003";
    const p = join(mkdtempSync(join(tmpdir(), "dset-")), "set.json");
    writeFileSync(p, JSON.stringify(s));
    const r = run(p);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).findings.map((f: { code: string }) => f.code)).toContain("REFERENCE_NOT_VIEWED");
    // unreadable inputs are a usage error (2), not a hold
    expect(run(join(p, "..", "missing.json")).code).toBe(2);
    const bad = join(p, "..", "bad-pack.json");
    writeFileSync(bad, JSON.stringify({ schema: "shop_facts_pack_v1", shop_id: "x", facts: [] }));
    expect(run(resolve(REPO, POC, "direction-set.json"), bad).code).toBe(2);
  }, 90_000);
});
