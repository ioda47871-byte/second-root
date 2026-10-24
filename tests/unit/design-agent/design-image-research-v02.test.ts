import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DESIGN_DNA_FIXTURE_DIR, parseDesignDna, sharedDesignDnaParts } from "@/lib/design-agent/design-image/design-dna";
import { selectDesignResearch } from "@/lib/design-agent/design-image/research-bridge";
import {
  RESEARCH_V02_DIR, RESEARCH_V02_LIBRARY_FILE, RESEARCH_V02_LIBRARY_SHA256, ResearchV02Error,
  exploreV02Techniques, parseResearchLibraryV02, toResearchSnapshot, type V02ShopProfile,
} from "@/lib/design-agent/design-image/research-v02";

const read = (path: string) => readFileSync(join(process.cwd(), path));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const rawLibrary = () => JSON.parse(read(join(RESEARCH_V02_DIR, RESEARCH_V02_LIBRARY_FILE)).toString("utf8")) as Record<string, unknown>;
const library = () => parseResearchLibraryV02(rawLibrary());
const wagashi: V02ShopProfile = {
  shop_key: "wagashi", name: "架空菓庵", fact_count: 5, imagery: "ai_concept_local", owner_tones: ["luxury"],
  fact_motif: { evidence_id: "making", motif: "a short row of small round dots read as the azuki grains of the tsubu-an cooked every morning" },
};
const experiment = () => JSON.parse(read(join(DESIGN_DNA_FIXTURE_DIR, "wagashi-v02-experiment.json")).toString("utf8")) as unknown;

describe("design research v0.2 import", () => {
  it("keeps the originals verbatim, as the manifest records them", () => {
    const manifest = JSON.parse(read(join(RESEARCH_V02_DIR, "MANIFEST.json")).toString("utf8")) as { files: { path: string; sha256: string; imported: boolean }[] };
    const imported = manifest.files.filter((f) => f.imported);
    expect(imported.map((f) => f.path).sort()).toEqual([RESEARCH_V02_LIBRARY_FILE, "secondroot_design_research_v02_20261021.md"]);
    for (const f of imported) expect(sha(read(join(RESEARCH_V02_DIR, f.path)))).toBe(f.sha256);
    expect(sha(read(join(RESEARCH_V02_DIR, RESEARCH_V02_LIBRARY_FILE)))).toBe(RESEARCH_V02_LIBRARY_SHA256);
  });

  it("parses 40 references and 9 cards whose counts match the original's own counts", () => {
    const lib = library();
    expect(lib.references).toHaveLength(40);
    expect(lib.design_techniques_v02.map((c) => c.id)).toEqual(["A01", "A02", "A03", "A04", "A05", "A06", "A07", "A08", "A09"]);
    const pending = lib.references.filter((r) => r.review_status === "discovered_needs_visual_review").map((r) => r.id);
    expect(pending).toEqual(["DR-015", "DR-019"]);
  });

  it("refuses a library whose counts or card links do not hold", () => {
    const counts = rawLibrary();
    (counts.counts as Record<string, number>).current_partial_visual_references = 40;
    expect(() => parseResearchLibraryV02(counts)).toThrow(ResearchV02Error);
    const card = rawLibrary();
    (card.design_techniques_v02 as { observed_reference_ids: string[] }[])[0]!.observed_reference_ids = ["DR-999"];
    expect(() => parseResearchLibraryV02(card)).toThrow(ResearchV02Error);
    const upgraded = rawLibrary();
    (upgraded.references as { review_status: string }[])[0]!.review_status = "human_reviewed";
    expect(() => parseResearchLibraryV02(upgraded)).toThrow(ResearchV02Error);
  });

  it("turns every record into a bridge candidate and keeps the original review label", () => {
    const lib = library();
    const snap = toResearchSnapshot(lib);
    expect(snap.sources).toHaveLength(38); // DR-015 and DR-019: nothing observed, kept in the file only
    expect(snap.sources.map((x) => x.id)).not.toContain("DR-015");
    expect(snap.technique_cards).toHaveLength(9);
    expect([...snap.sources, ...snap.technique_cards].every((x) => x.review.status === "candidate" && x.review.reviewer === null)).toBe(true);
    for (const src of snap.sources) expect(src.provenance!.original_review_status).toBe(lib.references.find((r) => r.id === src.id)!.review_status);
    expect(snap.technique_cards.every((c) => c.provenance!.part_assigned_by === "claude_session_unreviewed")).toBe(true);
  });

  it("cannot make the bridge call v0.2 research reviewed: the experimental brief stays insufficient", () => {
    const plan = selectDesignResearch(experiment(), toResearchSnapshot(library()));
    expect(plan.status).toBe("insufficient_reviewed_sources");
    expect(plan.selected).toEqual([]);
    expect(plan.image_generation_approved).toBe(false);
  });
});

describe("shop-specific exploration of v0.2 cards", () => {
  it("picks 2–4 cards for the wagashi shop from its own inputs, with visually observed references only", () => {
    const x = exploreV02Techniques(library(), wagashi);
    expect(x.status).toBe("exploratory_unreviewed");
    expect(x.image_generation_approved).toBe(false);
    expect(x.picks.map((p) => p.card_id)).toEqual(["A02", "A03", "A04", "A07"]);
    const refs = x.picks.flatMap((p) => p.references);
    expect(refs.every((r) => !["discovered_needs_visual_review", "content_reviewed_visual_pending"].includes(r.original_review_status))).toBe(true);
    expect(x.picks.every((p) => p.reasons.length > 0)).toBe(true);
    expect(x.not_picked.find((n) => n.card_id === "A01")!.reason).toMatch(/no verified input/);
  });

  it("chooses differently for a different shop, never from the industry name, and never mixes A04 with A05", () => {
    const cafe = exploreV02Techniques(library(), {
      shop_key: "cafe", name: "Bonte", fact_count: 4, imagery: "none", owner_tones: ["energetic", "luxury"], fact_motif: null,
    });
    const ids = cafe.picks.map((p) => p.card_id);
    expect(ids).not.toContain("A02");
    expect(ids).toContain("A01");
    expect(ids.includes("A04") && ids.includes("A05")).toBe(false);
    expect(ids).not.toEqual(exploreV02Techniques(library(), wagashi).picks.map((p) => p.card_id));
    const plain = exploreV02Techniques(library(), { ...wagashi, owner_tones: [], fact_motif: null });
    expect(plain.picks.map((p) => p.card_id)).not.toContain("A04");
    expect(plain.picks.map((p) => p.card_id)).not.toContain("A03");
  });
});

describe("the experimental wagashi direction (v0.2 research)", () => {
  it("is a valid Design DNA brief citing only visually observed v0.2 references that match the picks", () => {
    const brief = parseDesignDna(experiment());
    const lib = library();
    const picked = new Set(exploreV02Techniques(lib, wagashi).picks.flatMap((p) => p.references.map((r) => r.id)));
    for (const r of brief.references) {
      const original = lib.references.find((o) => new URL(o.reference_url).href === r.url && o.id === r.id);
      expect(original, r.id).toBeDefined();
      expect(picked.has(r.id), r.id).toBe(true);
    }
  });

  it("cites each reference under the part its picked card is assigned to (the bridge links all four once a person reviews them)", () => {
    const brief = parseDesignDna(experiment());
    const picks = exploreV02Techniques(library(), wagashi).picks;
    for (const d of brief.decisions)
      for (const ref of d.reference_ids) {
        const card = picks.find((p) => p.part === d.part);
        expect(card, `${d.part} cites ${ref}`).toBeDefined();
        expect(card!.references.map((r) => r.id), `${d.part} cites ${ref}`).toContain(ref);
      }
    // only to prove the links: a hypothetical review of exactly the picked cards and their sources
    const snap = toResearchSnapshot(library());
    const reviewed = { status: "human_reviewed" as const, reviewer: "hypothetical_test_reviewer", reviewed_at: "2026-10-24T00:00:00Z" };
    const pickedCards = new Set(picks.map((p) => p.card_id));
    const pickedRefs = new Set(picks.flatMap((p) => p.references.map((r) => r.id)));
    for (const c of snap.technique_cards) if (pickedCards.has(c.id)) c.review = reviewed;
    for (const src of snap.sources) if (pickedRefs.has(src.id)) src.review = reviewed;
    const plan = selectDesignResearch(experiment(), snap);
    expect(plan.selected.map((x) => [x.part, x.technique_id])).toEqual([
      ["typography", "A02"], ["palette", "A04"], ["product_visual", "A03"], ["section_rhythm", "A07"],
    ]);
    expect(plan.status).toBe("review_ready");
  });

  it("shares no decision with the existing wagashi brief, and keeps the fixture's wording (店頭, not a counter)", () => {
    expect(JSON.stringify(experiment())).not.toMatch(/counter/i);
    const current = parseDesignDna(JSON.parse(read(join(DESIGN_DNA_FIXTURE_DIR, "wagashi.json")).toString("utf8")));
    expect(sharedDesignDnaParts(parseDesignDna(experiment()), current)).toEqual([]);
  });
});
