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
    // the principles it cites rest on text (ChatGPT's viewing summary), and the result says so
    expect(r.reference_mode).toBe("TEXT_ONLY_PROVISIONAL");
    // with no reference pictures or text at all, the set holds
    const held = checkDirectionSet(example(), { ...opts, referenceMode: "MISSING_OR_HOLD" });
    expect(held.status).toBe("HOLD");
    expect(held.findings).toContainEqual({ check: "refs", code: "REFERENCE_MODE_HOLD" });
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
    expect(r.findings).toContainEqual({ check: "C2", code: "SECTIONS_SHARED", direction: "d1-seam-across|d2-lacquer-layers", detail: "copied:5/5,pairs:5,layouts:1.00" });
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

  it("C2: a near-copy holds too — one layout changed and every facet reworded (review round 2 M1)", () => {
    for (const reword of [(s: string) => `${s}の層`, (s: string) => s.replaceAll("線", "糸")]) {
      const s = example();
      const [a, b] = [s.directions[0], s.directions[1]];
      b.sections = structuredClone(a.sections);
      b.sections[0].layout = "vertical_text";
      for (const x of b.sections) x.motif_facet = reword(x.motif_facet);
      b.descriptor.section_layouts.value = b.sections.map((x: { layout: string }) => x.layout);
      expect(codes(s)).toContain("SECTIONS_SHARED");
      // facets rewritten from scratch: still held, because id, ground and layout are copied in 4 of 5 body sections
      const t = example();
      t.directions[1].sections = structuredClone(t.directions[0].sections).map((x: { motif_facet: string }, i: number) => ({ ...x, motif_facet: ["あ", "い", "う", "え", "お", "か"][i] + "を見せる別の話" }));
      t.directions[1].sections[0].layout = "vertical_text";
      t.directions[1].descriptor.section_layouts.value = t.directions[1].sections.map((x: { layout: string }) => x.layout);
      expect(codes(t)).toContain("SECTIONS_SHARED");
    }
  });

  it("C2: short pages that only share the shop's facts, or the same few layouts in another order, are not held (round 2 L2)", () => {
    const s = example();
    const short = (d: { sections: Array<{ layout: string }>; descriptor: { section_layouts: { value: string[] }; transitions: { value: string[] } } }, keep: number[]) => {
      d.sections = keep.map((i) => d.sections[i]!);
      d.descriptor.section_layouts.value = d.sections.map((x) => x.layout);
      d.descriptor.transitions.value = d.descriptor.transitions.value.slice(0, d.sections.length - 1);
    };
    short(s.directions[0], [0, 4, 5]); // diagram, overlap_collage, single_column_text
    short(s.directions[2], [1, 4, 5]); // diagram, overlap_collage, single_column_text
    expect(codes(s)).not.toContain("SECTIONS_SHARED");
    // two pages sharing only the class and the visit
    const t = example();
    t.directions[2].sections[4].motif_facet = t.directions[0].sections[4].motif_facet;
    t.directions[2].sections[5].motif_facet = t.directions[0].sections[5].motif_facet;
    expect(codes(t)).not.toContain("SECTIONS_SHARED");
  });

  it("text is compared after NFKC and without digits (ASCII, full-width or kanji) (round 2 L1)", () => {
    for (const nums of [["０", "１", "２", "３", "４", "５"], ["一", "二", "三", "四", "五", "六"]]) {
      const s = example();
      s.directions[0].sections.forEach((x: { motif_facet: string }, i: number) => (x.motif_facet = `金の線${nums[i]}`));
      expect(codes(s)).toContain("MOTIF_FACETS_REPEATED");
    }
  });

  it("copied evidence holds but is not reported as the machine contradicting the answer (round 2 L3)", () => {
    const s = example();
    s.directions[2].checklist.C1.evidence = s.directions[0].checklist.C1.evidence;
    const f = checkDirectionSet(s, opts).findings;
    expect(f.map((x) => x.code)).toEqual(["EVIDENCE_COPIED"]);
  });

  it("C2: padding every facet, renaming the ids, or copying a short page whole does not hide a copy (round 3 M2)", () => {
    // (a) all of d1's body, ids renamed, one layout changed, a fixed phrase in front of every facet
    const s = example();
    const [a, b] = [s.directions[0], s.directions[1]];
    b.sections = structuredClone(a.sections).map((x: { id: string; motif_facet: string }) => ({ ...x, id: `${x.id}-b`, motif_facet: `漆の層として見せる: ${x.motif_facet}` }));
    b.sections[0].layout = "vertical_text";
    b.descriptor.section_layouts.value = b.sections.map((x: { layout: string }) => x.layout);
    expect(codes(s)).toContain("SECTIONS_SHARED");
    // (b) a 4-section page copied whole with one layout changed
    const t = example();
    const keep = (d: { sections: Array<{ layout: string }>; descriptor: { section_layouts: { value: string[] } } }, from: Array<{ layout: string }>) => {
      d.sections = structuredClone(from);
      d.descriptor.section_layouts.value = d.sections.map((x) => x.layout);
    };
    keep(t.directions[0], t.directions[0].sections.slice(2));
    keep(t.directions[1], t.directions[0].sections);
    t.directions[1].sections[0].layout = "vertical_text";
    t.directions[1].descriptor.section_layouts.value = t.directions[1].sections.map((x: { layout: string }) => x.layout);
    expect(codes(t)).toContain("SECTIONS_SHARED");
  });

  it("C2: sharing ids and the shop's ground colour, with other layouts and facets, is not a copy (round 3 M1)", () => {
    const s = example();
    const [d1, d3] = [s.directions[0], s.directions[2]];
    // two sections in each with the same ids on the same ground (生成り), different layouts and facets
    d1.sections[3].id = "about";
    d3.sections[1].id = "about";
    d3.sections[1].ground = d1.sections[3].ground;
    d1.sections[4].id = "class";
    d1.sections[4].ground = "生成り";
    d3.sections[4].id = "class";
    d3.sections[4].ground = "生成り";
    expect(d1.sections[3].layout).not.toBe(d3.sections[1].layout);
    expect(codes(s)).not.toContain("SECTIONS_SHARED");
  });

  it("C3: a facet that is only digits or symbols holds; empty text is similar to nothing (round 3 L1)", () => {
    const s = example();
    s.directions[0].sections[1].motif_facet = "(2)";
    s.directions[0].sections[2].motif_facet = "十";
    expect(codes(s)).toContain("MOTIF_FACET_EMPTY");
  });

  it("evidence copied with a small addition still counts as copied (round 3 L4)", () => {
    const s = example();
    s.directions[2].checklist.C4.evidence = `${s.directions[1].checklist.C4.evidence} (d3)`;
    expect(codes(s)).toContain("EVIDENCE_COPIED");
  });

  it("C2: the same ground and layout in the same places (3+, 60%+) holds on its own; the same stages seen through different lenses do not (round 4)", () => {
    const s = example();
    const [a, b] = [s.directions[0], s.directions[2]];
    // b keeps its own ids and facets but takes a's ground and layout in body places 0, 2, 3
    for (const i of [0, 2, 3]) {
      b.sections[i].ground = a.sections[i].ground;
      b.sections[i].layout = a.sections[i].layout;
    }
    b.descriptor.section_layouts.value = b.sections.map((x: { layout: string }) => x.layout);
    const f = checkDirectionSet(s, opts).findings.find((x) => x.code === "SECTIONS_SHARED");
    expect(f?.detail).toMatch(/pairs:3/);
    expect(f?.detail).toMatch(/copied:[01]\//);
    // lenses: "線で見る…" and "器で見る…" over the same stages are not a copy
    const t = example();
    const stages = ["割れ", "漆で固める", "乾くのを待つ", "金を蒔く", "教室", "来店"];
    t.directions[0].sections.forEach((x: { motif_facet: string }, i: number) => (x.motif_facet = `線で見る${stages[i]}`));
    t.directions[2].sections.forEach((x: { motif_facet: string }, i: number) => (x.motif_facet = `器のまわりで見る${stages[i]}`));
    expect(codes(t)).not.toContain("SECTIONS_SHARED");
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
    // a malformed principles file is an input error (2), not a hold (1)
    const badPrinciples = join(p, "..", "principles.json");
    writeFileSync(badPrinciples, JSON.stringify({ visual_mode: "TEXT_ONLY_PROVISIONAL", cases: [], principles: [] }));
    const cli2 = (args: string[]) => {
      try {
        execFileSync("npx", ["tsx", cli, ...args], { encoding: "utf8", stdio: "pipe" });
        return 0;
      } catch (e) {
        return (e as { status: number }).status;
      }
    };
    expect(cli2(["--set", resolve(REPO, POC, "direction-set.json"), "--facts", FACTS, "--principles", badPrinciples])).toBe(2);
    // a principles file without (or with an unknown) visual_mode is malformed too
    const real = JSON.parse(readFileSync(resolve(REPO, "design-library/research/quality-pipeline/principles-v1.json"), "utf8"));
    for (const mode of [undefined, "SEEN_BY_SOMEONE"]) {
      writeFileSync(badPrinciples, JSON.stringify({ ...real, visual_mode: mode }));
      expect(cli2(["--set", resolve(REPO, POC, "direction-set.json"), "--facts", FACTS, "--principles", badPrinciples])).toBe(2);
    }
  }, 90_000);
});
