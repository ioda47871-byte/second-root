import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { StructureDescriptor } from "@/lib/design-agent/structure/descriptor";
import { MIN_COVERAGE } from "@/lib/design-agent/structure/descriptor";
import { compareWithReferences, coverageCeiling, ReferenceDescriptors } from "@/lib/design-agent/structure/references";

// DEV-136: the declared structure descriptors of the success cases and the rejected versions, and the offline comparison.

const REPO = resolve(__dirname, "../../../..");
const read = (p: string) => JSON.parse(readFileSync(resolve(REPO, p), "utf8"));
const set = ReferenceDescriptors.parse(read("design-library/intelligence/v02/structure-descriptors-v0.json"));
const manifest = read("design-library/success-cases/manifest.json") as { records: { id: string; preview?: string; binary_original_verification?: string }[] };

const d = (o: Partial<Record<Exclude<keyof StructureDescriptor, "schema">, string | string[]>>): StructureDescriptor => {
  const out: Record<string, unknown> = { schema: "structure_descriptor_v0" };
  for (const k of ["hero", "flow", "navigation", "reading_path", "section_layouts", "transitions", "text_direction", "imagery"]) {
    const v = (o as Record<string, unknown>)[k];
    out[k] = v === undefined ? null : { value: v, source: "measured" };
  }
  return out as StructureDescriptor;
};

describe("the reference set (declared, provisional)", () => {
  it("covers exactly the registered success cases, with the manifest's evidence", () => {
    expect(set.success.map((e) => e.id).sort()).toEqual(manifest.records.map((r) => r.id).sort());
    for (const e of set.success) {
      const r = manifest.records.find((x) => x.id === e.id)!;
      // an image only where the repository holds one; original_unavailable exactly where the manifest says so
      expect(e.evidence === "image", e.id).toBe(Boolean(r.preview));
      expect(e.evidence === "original_unavailable", e.id).toBe(r.binary_original_verification === "original_unavailable");
    }
  });

  it("points every entry at research files that exist", () => {
    for (const e of [...set.success, ...set.rejected]) {
      for (const b of e.basis) {
        // "path#pointer" or "path (note)": the path is everything before the first # or space
        const path = b.split(/[# ]/)[0]!;
        expect(existsSync(resolve(REPO, path)), `${e.id}: ${path}`).toBe(true);
      }
    }
  });

  it("names rejected versions of registered or studied cases only", () => {
    for (const e of set.rejected) expect(e.case).toMatch(/^CP-\d{3}$/);
    expect(set.rejected.length).toBeGreaterThan(0);
  });

  it("refuses a measured aspect, a duplicate id or another scope", () => {
    const raw = read("design-library/intelligence/v02/structure-descriptors-v0.json");
    const measured = structuredClone(raw);
    measured.success[0].descriptor.hero = { value: "type_led", source: "measured" };
    expect(ReferenceDescriptors.safeParse(measured).success).toBe(false);
    const dup = structuredClone(raw);
    dup.success[1].id = dup.success[0].id;
    expect(ReferenceDescriptors.safeParse(dup).success).toBe(false);
    expect(ReferenceDescriptors.safeParse({ ...raw, scope: "generation_input" }).success).toBe(false);
  });
});

describe("offline comparison with the references (advisory)", () => {
  it("a generic landing page is close to the rejected skeletons, not to a success case", () => {
    const generic = d({ hero: "split_copy_media", flow: "stacked_bands", navigation: "top_bar", section_layouts: ["split_copy_media", "split_copy_media", "grid_cards", "split_copy_media"], transitions: ["hard_cut", "hard_cut", "hard_cut"] });
    const r = compareWithReferences(generic, set);
    expect(r.close_to_rejected.length).toBeGreaterThan(0);
    expect(r.close_to_rejected.map((m) => m.id)).toEqual(expect.arrayContaining(["CP-025-v1"]));
    expect(r.too_close_to_success).toEqual([]);
    expect(r.advisory).toBe(true);
  });

  it("a page with a success case's own skeleton is named as too close to it (a copy)", () => {
    const cp003 = set.success.find((e) => e.id === "CP-003")!.descriptor;
    expect(compareWithReferences(cp003, set).too_close_to_success.map((m) => m.id)).toContain("CP-003");
  });

  it("no success case is itself close to a rejected skeleton (the set does not contradict itself)", () => {
    let decided = 0;
    for (const e of set.success) {
      const r = compareWithReferences(e.descriptor, set);
      expect(r.close_to_rejected, e.id).toEqual([]);
      decided += set.rejected.length - r.undecided.filter((id) => set.rejected.some((x) => x.id === id)).length;
    }
    // the check means something only if some success / rejected pairs are actually decided
    expect(decided).toBeGreaterThan(0);
  });

  it("a reference too sparse to decide is listed as undecided, never as 'not close'", () => {
    const r = compareWithReferences(d({ hero: "type_led" }), set);
    expect(r.undecided.length).toBeGreaterThan(0);
  });
});

// DEV-144 (Issue #177 C): which references are too thin to ever be decided. Pinned, so a record that gains or loses
// aspects shows here (and in docs/design/reference-structure-descriptors.md).
const THIN = [
  "CP-005", "CP-006", "CP-007", "CP-008", "CP-010", "CP-013", "CP-015", "CP-018", "CP-019", "CP-020", "CP-021", "CP-022", "CP-023", "CP-024",
  "CP-026", "CP-027", "CP-028", "CP-029", "CP-030", "CP-031", "CP-032", "PT-02-draft-1", "CP-025-v2", "CP-027-v1",
];

describe("DEV-144: the coverage ceiling of each reference (report only)", () => {
  const all = [...set.success, ...set.rejected];

  it("names exactly the 24 references whose own record can never reach MIN_COVERAGE", () => {
    expect(all.filter((e) => coverageCeiling(e.descriptor) < MIN_COVERAGE).map((e) => e.id).sort()).toEqual([...THIN].sort());
    // every original-unavailable case is among them; the image cases are not
    for (const e of set.success.filter((x) => x.evidence === "original_unavailable")) expect(THIN, e.id).toContain(e.id);
    for (const e of set.success.filter((x) => x.evidence === "image")) expect(coverageCeiling(e.descriptor), e.id).toBeGreaterThanOrEqual(0.9);
  });

  it("a candidate known on every aspect leaves exactly the thin references undecided", () => {
    const full = set.success.find((e) => e.id === "CP-001")!.descriptor;
    const r = compareWithReferences(full, set);
    expect(r.too_thin).toEqual([...THIN].sort());
    expect(r.undecided).toEqual(r.too_thin);
  });

  it("too_thin is always a part of undecided, never a finding of its own", () => {
    for (const cand of [d({ hero: "type_led" }), d({ hero: "split_copy_media", flow: "stacked_bands" }), set.success[0]!.descriptor]) {
      const r = compareWithReferences(cand, set);
      for (const id of r.too_thin) expect(r.undecided).toContain(id);
      for (const m of [...r.too_close_to_success, ...r.close_to_rejected]) expect(r.too_thin).not.toContain(m.id);
    }
  });
});

