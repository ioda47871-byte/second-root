import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FidelitySpec, motifPreservation, scoreFidelity, type MeasuredPage } from "@/lib/design-agent/quality-pipeline/fidelity-measure";
import { measureSpec } from "../../../../scripts/design-artifact/fidelity-measure";

// DEV-160 (Issue #193 comment 6596798696, items 4–6): the motif and text measures of the comp (A), the strict-lane
// implementation (B) and the research-only fidelity implementation (C). Report-only: nothing here decides quality.
const REPO = resolve(__dirname, "../../../..");
const page = (o: Partial<MeasuredPage>): MeasuredPage => ({
  width: 1440,
  pageHeight: 3000,
  scrollWidth: 1440,
  sections: [
    { id: "a", top: 0, bottom: 1000 },
    { id: "b", top: 1000, bottom: 2000 },
    { id: "c", top: 2000, bottom: 3000 },
  ],
  motif: [],
  captionLines: [],
  words: [],
  ...o,
});
const box = (top: number, bottom: number, left = 700, right = 704) => ({ top, bottom, left, right });

describe("fidelity scores (pure)", () => {
  it("one line through the whole page: full coverage, both boundaries crossed and carried", () => {
    const s = scoreFidelity(page({ motif: [box(0, 3000)] }));
    expect(s).toMatchObject({ motif_coverage: 1, motif_largest_gap_px: 0, boundaries_crossed: 2, boundaries_carried: 2, boundaries_total: 2, sections_touched: 3 });
  });
  it("a line drawn in one piece per section is carried across a boundary only where the pieces meet and line up", () => {
    const s = scoreFidelity(page({ motif: [box(0, 1000), box(1000, 2000), box(2010, 3000)] }));
    expect(s).toMatchObject({ boundaries_crossed: 0, boundaries_carried: 1 });
    const apart = scoreFidelity(page({ motif: [box(0, 1000, 100, 104), box(1000, 2000, 900, 904)] }));
    expect(apart.boundaries_carried).toBe(0);
    // one box that only grazes a boundary (by 1px) is not a line carried across it
    expect(scoreFidelity(page({ motif: [box(0, 1001)] })).boundaries_carried).toBe(0);
  });
  it("gaps, captions drawn over, broken words and a page wider than its viewport are counted", () => {
    const s = scoreFidelity(
      page({
        motif: [box(0, 500), box(2500, 3000)],
        scrollWidth: 1500,
        captionLines: [
          { covered: true, crossedByMotif: true },
          { covered: true, crossedByMotif: false },
          { covered: false, crossedByMotif: false },
        ],
        words: [
          { text: "まわる", lines: 2 },
          { text: "熱い", lines: 1 },
        ],
      }),
    );
    expect(s).toMatchObject({ motif_coverage: 0.333, motif_largest_gap_px: 2000, caption_lines_covered: 2, caption_lines_crossed: 1, caption_lines_total: 3, words_broken: ["まわる"], horizontal_overflow: true });
  });
  it("preservation is a share of the comp's, capped at 1, and null where the comp has none", () => {
    const comp = scoreFidelity(page({ motif: [box(0, 3000)] }));
    const half = scoreFidelity(page({ motif: [box(0, 1500)] }));
    expect(motifPreservation(comp, half)).toEqual({ coverage: 0.5, boundaries_crossed: 0.5, boundaries_carried: 0.5, sections_touched: 0.667 });
    expect(motifPreservation(scoreFidelity(page({})), half).coverage).toBeNull();
  });
  it("the measure reaches nothing but zod, node and playwright (no model, worker, phase2f or comp-impl module)", () => {
    const spec = (src: string) => [...src.matchAll(/(?:\bfrom\s*|(?<!@)\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/g)].map((m) => m[1]).sort();
    expect(spec(readFileSync(resolve(REPO, "lib/design-agent/quality-pipeline/fidelity-measure.ts"), "utf8"))).toEqual(["zod"]);
    const cli = readFileSync(resolve(REPO, "scripts/design-artifact/fidelity-measure.ts"), "utf8");
    expect(spec(cli)).toEqual(["../../lib/design-agent/quality-pipeline/fidelity-measure", "node:fs", "node:path", "playwright"]);
    expect(cli.replace(/require\.main === module/g, "")).not.toMatch(/\brequire\s*[([]|import\s*\(|node:(https?|net|tls|child_process|worker_threads|vm)|\/worker\/|anthropic|openai|\bspawn\(|execFile|process\.binding|\bfetch\(|codex/i);
  });
  it("refuses duplicate page keys", () => {
    const one = { key: "comp", dir: "design-library/research/quality-pipeline/poc/x", section_attribute: "data-section", motif: [".m"], captions: [], words: [] };
    expect(FidelitySpec.safeParse({ schema: "fidelity_spec_v0", shop: "tsugute", pages: [one, one] }).success).toBe(false);
  });
  it("the spec names pages inside the research tree only, with the two known section attributes", () => {
    const ok = { schema: "fidelity_spec_v0", shop: "tsugute", pages: [0, 1].map((i) => ({ key: i ? "strict_b" : "comp", dir: "design-library/research/quality-pipeline/poc/x", section_attribute: "data-section", motif: [".m"], captions: [], words: [] })) };
    expect(FidelitySpec.safeParse(ok).success).toBe(true);
    for (const dir of ["design-library/research/quality-pipeline/poc/../../../app", "/etc", "app/x"]) expect(FidelitySpec.safeParse({ ...ok, pages: ok.pages.map((p) => ({ ...p, dir })) }).success, dir).toBe(false);
    expect(FidelitySpec.safeParse({ ...ok, pages: ok.pages.map((p) => ({ ...p, section_attribute: "id" })) }).success).toBe(false);
  });
});

describe("the three shops, measured (report-only)", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  });
  afterAll(async () => {
    await browser?.close();
  });
  const spec = (shop: string) => FidelitySpec.parse(JSON.parse(readFileSync(resolve(REPO, `design-library/research/quality-pipeline/poc/${shop}/fidelity-spec.json`), "utf8")));

  it("つぐ手: C keeps the comp's seam at 1440 and 390 and breaks no word at any width; B breaks the name and spills at tablet widths", async () => {
    const r = await measureSpec(spec("tsugute"), browser);
    expect(r.passing).toBe(false);
    for (const v of ["desktop_1440", "mobile_390"]) {
      expect(r.motif_preservation.fidelity_c![v]!.coverage).toBeGreaterThan(0.9);
      expect(r.motif_preservation.fidelity_c![v]!.boundaries_carried).toBe(1);
    }
    for (const v of ["desktop_1440", "mobile_390", "tablet_1024", "tablet_768"]) {
      expect(r.pages.fidelity_c![v]!.score.words_broken, v).toEqual([]);
      expect(r.pages.fidelity_c![v]!.score.horizontal_overflow, v).toBe(false);
      expect(r.pages.fidelity_c![v]!.score.caption_lines_crossed, v).toBe(0);
    }
    expect(r.pages.strict_b!.desktop_1440!.score.words_broken).toContain("つぐ手");
    expect(r.pages.strict_b!.tablet_768!.score.horizontal_overflow).toBe(true);
  }, 240_000);

  it("輪: B keeps about half of the comp's wheel and crosses no boundary; C keeps it", async () => {
    const r = await measureSpec(spec("bicycle"), browser);
    expect(r.motif_preservation.strict_b!.desktop_1440!.coverage).toBeLessThan(0.7);
    expect(r.motif_preservation.strict_b!.desktop_1440!.boundaries_crossed).toBe(0);
    expect(r.motif_preservation.fidelity_c!.desktop_1440!.coverage).toBeGreaterThan(0.9);
    expect(r.motif_preservation.fidelity_c!.desktop_1440!.boundaries_crossed).toBe(1);
    expect(r.pages.strict_b!.mobile_390!.score.words_broken).toContain("まわる");
    expect(r.pages.fidelity_c!.mobile_390!.score.words_broken).toEqual([]);
  }, 240_000);

  it("ゆげ湯: the thermometer runs the whole page in A, B and C; only A and C cross boundaries with one strip", async () => {
    const r = await measureSpec(spec("sento"), browser);
    for (const k of ["comp", "strict_b", "fidelity_c"]) expect(r.pages[k]!.desktop_1440!.score.motif_coverage, k).toBeGreaterThan(0.95);
    expect(r.pages.strict_b!.desktop_1440!.score.boundaries_crossed).toBe(0);
    expect(r.pages.fidelity_c!.desktop_1440!.score.boundaries_crossed).toBe(r.pages.comp!.desktop_1440!.score.boundaries_crossed);
    expect(r.pages.strict_b!.tablet_1024!.score.words_broken.length).toBeGreaterThan(0);
    expect(r.pages.fidelity_c!.tablet_1024!.score.words_broken).toEqual([]);
  }, 240_000);
});
