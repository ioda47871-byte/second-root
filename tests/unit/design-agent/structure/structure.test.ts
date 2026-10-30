import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ASPECTS, multisetOverlap, StructureDescriptor, structuralSimilarity, structureFindings } from "@/lib/design-agent/structure/descriptor";
import { describe as describeMeasure, measurePage, sectionLayout, VIEWPORTS } from "@/lib/design-agent/structure/measure";

// DEV-125 (Phase 2b, Issue #159): provisional 8-aspect structure descriptors, measured from real Chromium geometry on
// synthetic fixture pages. Offline: no Codex, no network (every request is aborted), JavaScript off.

const doc = (body: string) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body>${body}</body></html>`;

/** The generic landing page: top bar, split hero with a button, a card grid, alternating split bands. */
const generic = (accent: string) => ({
  html: doc(`<nav class="bar"><a href="#a">a</a><a href="#b">b</a><a href="#c">c</a></nav>
<section data-section="hero" class="split"><div class="copy"><h1>店名</h1><p>説明文の一行。</p><a href="#a">見る</a></div><img class="pic" alt=""></section>
<section data-section="menu" class="cards"><div class="card">一</div><div class="card">二</div><div class="card">三</div></section>
<section data-section="story" class="split"><img class="pic" alt=""><div class="copy"><p>こだわりの説明。</p></div></section>
<section data-section="info" class="split"><div class="copy"><p>営業時間</p></div><img class="pic" alt=""></section>`),
  css: `body{margin:0;font:16px sans-serif}.bar{display:flex;gap:24px;height:64px;align-items:center;padding:0 40px;background:${accent}}
section{display:flex;gap:40px;padding:60px 40px;margin:0;background:#fff;border-top:1px solid #ddd}.copy{width:600px}.pic{width:600px;height:400px;display:block}
.cards{display:flex;gap:24px}.card{width:400px;height:300px;background:${accent}}`,
});

/** A distinctive page: vertical type hero, an overlapping collage, sections running into each other, a drawn diagram. */
const distinctive = {
  html: doc(`<section data-section="hero" class="hero"><h1 class="v">朝に炊く粒あん</h1><svg class="mark" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg></section>
<section data-section="steps" class="collage"><div class="a">一つずつ</div><div class="b"></div><div class="c">お包み</div></section>
<section data-section="map" class="map"><svg class="diagram" viewBox="0 0 100 50"><path d="M0 0L100 50"/></svg><p>店頭</p></section>`),
  css: `body{margin:0;background:#f4efe4;font:16px serif}.hero{position:relative;height:900px;background:#f4efe4}.v{writing-mode:vertical-rl;font-size:96px;margin:80px}.mark{position:absolute;right:80px;top:120px;width:500px;height:500px}
.collage{position:relative;height:800px;margin-top:-120px;background:#f4efe4}.collage>div{position:absolute;width:500px;height:400px}.a{left:100px;top:0;writing-mode:vertical-rl;font-size:48px}.b{left:350px;top:150px;background:url(assets/A1.png)}.c{left:700px;top:250px;writing-mode:vertical-rl;font-size:48px}
.map{background:#f4efe4;height:700px}.diagram{width:1200px;height:600px}`,
};

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
});
afterAll(async () => {
  await browser.close();
});
const measure = (p: { html: string; css: string }) => measurePage(browser, p, VIEWPORTS.desktop);

describe("measured from the render (desktop 1440)", () => {
  it("reads the generic landing page as its generic skeleton", async () => {
    const d = describeMeasure(await measure(generic("#c33")));
    expect(StructureDescriptor.parse(d)).toEqual(d);
    expect(d.navigation).toEqual({ value: "top_bar", source: "measured" });
    expect(d.hero).toEqual({ value: "split_copy_media", source: "measured" });
    expect(d.section_layouts?.value).toEqual(["split_copy_media", "grid_cards", "split_copy_media", "split_copy_media"]);
    expect(d.transitions?.value).toEqual(["hard_cut", "hard_cut", "hard_cut"]);
    expect(d.flow).toEqual({ value: "stacked_bands", source: "measured" });
    expect(d.text_direction?.value).toBe("horizontal");
    expect(d.imagery?.value).toBe("sequence");
    expect(structureFindings(d).map((f) => f.code)).toEqual(["GENERIC_SKELETON", "ASPECTS_UNKNOWN"]);
  }, 60_000);

  it("reads the distinctive page: mostly vertical type, an overlapping collage, running sections, a drawing and one picture; declared aspects fill the rest", async () => {
    const d = describeMeasure(await measure(distinctive), { hero: "type_led", flow: "single_axis_scroll", reading_path: "vertical_axis" });
    expect(d.section_layouts?.value).toEqual(["vertical_text", "overlap_collage", "diagram"]);
    expect(d.transitions?.value).toEqual(["overlap", "continuous"]);
    expect(d.navigation?.value).toBe("none");
    expect(d.text_direction?.value).toBe("vertical");
    expect(d.imagery?.value).toBe("single_lead");
    expect([d.hero, d.flow, d.reading_path]).toEqual([
      { value: "type_led", source: "declared" },
      { value: "single_axis_scroll", source: "declared" },
      { value: "vertical_axis", source: "declared" },
    ]);
    expect(structureFindings(d)).toEqual([]);
  }, 60_000);

  it("a declaration never hides what geometry shows (a split hero stays split)", async () => {
    const d = describeMeasure(await measure(generic("#333")), { hero: "object_led", flow: "map_of_stations" });
    expect([d.hero?.value, d.hero?.source, d.flow?.value, d.flow?.source]).toEqual(["split_copy_media", "measured", "stacked_bands", "measured"]);
  }, 60_000);

  it("the phone width is measured on its own", async () => {
    const m = await measurePage(browser, generic("#c33"), VIEWPORTS.mobile);
    expect(m.viewport).toEqual({ width: 390, height: 844 });
    expect(m.sections).toHaveLength(4);
  }, 60_000);
});

describe("similarity and overlap checks", () => {
  it("a recolour of the same skeleton is the same structure; a different skeleton is far", async () => {
    const red = describeMeasure(await measure(generic("#c33")), { reading_path: "z_pattern" });
    const blue = describeMeasure(await measure(generic("#33c")), { reading_path: "z_pattern" });
    const other = describeMeasure(await measure(distinctive), { hero: "type_led", flow: "single_axis_scroll", reading_path: "vertical_axis" });
    expect(structuralSimilarity(red, blue)).toBe(1);
    expect(structuralSimilarity(red, other)).toBeLessThan(0.2);
    expect(structureFindings(red, { siblings: { blue } }).map((f) => f.code)).toContain("SIBLINGS_SAME_SKELETON");
    expect(structureFindings(other, { references: { "CP-003": red }, siblings: { red } })).toEqual([]);
    expect(structureFindings(blue, { references: { "CP-003": red } })[0]).toEqual({ code: "TOO_CLOSE_TO_REFERENCE", reference: "CP-003", similarity: 1 });
  }, 60_000);

  it("unknown aspects never count as a match, and are reported", () => {
    const empty = { schema: "structure_descriptor_v0", hero: null, flow: null, navigation: null, reading_path: null, section_layouts: null, transitions: null, text_direction: null, imagery: null } as const;
    expect(structuralSimilarity(empty, empty)).toBe(0);
    expect(structureFindings(empty)).toEqual([{ code: "ASPECTS_UNKNOWN", aspects: [...ASPECTS] }]);
    expect(multisetOverlap(["a", "a", "b"], ["a", "b", "b"])).toBeCloseTo(0.5);
    expect(StructureDescriptor.safeParse({ ...empty, hero: { value: "hero_with_button", source: "measured" } }).success).toBe(false);
  });

  it("a generic hero alone is not the generic skeleton", () => {
    const d = StructureDescriptor.parse({ schema: "structure_descriptor_v0", hero: { value: "split_copy_media", source: "measured" }, flow: { value: "map_of_stations", source: "declared" }, navigation: null, reading_path: null, section_layouts: { value: ["split_copy_media", "diagram", "vertical_text"], source: "measured" }, transitions: null, text_direction: null, imagery: null });
    expect(structureFindings(d).map((f) => f.code)).toEqual(["ASPECTS_UNKNOWN"]);
  });

  it("imagery: drawings only are drawn; nothing large is none", () => {
    const page = (media: { box: { x: number; y: number; w: number; h: number }; svg: boolean }[]) =>
      describeMeasure({ viewport: { width: 1440, height: 900 }, sections: [], nav: null, media, chars: 10, verticalChars: 0 });
    expect(page([{ box: { x: 0, y: 0, w: 800, h: 600 }, svg: true }]).imagery?.value).toBe("drawn");
    expect(page([{ box: { x: 0, y: 0, w: 100, h: 100 }, svg: false }]).imagery?.value).toBe("none");
    expect(page([{ box: { x: 0, y: 0, w: 800, h: 600 }, svg: false }, { box: { x: 0, y: 700, w: 800, h: 600 }, svg: false }]).imagery?.value).toBe("sequence");
  });

  it("section layout rules (geometry only)", () => {
    const blk = (x: number, y: number, w: number, h: number, o: Partial<{ mediaArea: number; svgArea: number; chars: number }> = {}) => ({ box: { x, y, w, h }, mediaArea: 0, svgArea: 0, chars: 10, centred: false, links: 0, ...o });
    const sec = (blocks: ReturnType<typeof blk>[], o: Partial<{ chars: number; verticalChars: number }> = {}) => ({ box: { x: 0, y: 0, w: 1440, h: 600 }, bg: "x", borders: { top: 0, bottom: 0 }, chars: 30, verticalChars: 0, blocks, ...o });
    expect(sectionLayout(sec([blk(0, 0, 1440, 600, { mediaArea: 1440 * 600, chars: 0 })]))).toBe("full_bleed_media");
    expect(sectionLayout(sec([blk(0, 0, 1440, 600, { svgArea: 1440 * 300, mediaArea: 1440 * 300 })]))).toBe("diagram");
    expect(sectionLayout(sec([blk(0, 0, 700, 500), blk(720, 0, 700, 500, { mediaArea: 700 * 500, chars: 0 })]))).toBe("split_copy_media");
    expect(sectionLayout(sec([blk(0, 0, 600, 400), blk(300, 200, 600, 400)]))).toBe("overlap_collage");
    expect(sectionLayout(sec([blk(0, 0, 400, 300), blk(450, 0, 400, 300), blk(900, 0, 400, 300)]))).toBe("grid_cards");
    expect(sectionLayout(sec([blk(0, 0, 900, 300)], { chars: 20, verticalChars: 15 }))).toBe("vertical_text");
    expect(sectionLayout(sec([blk(0, 0, 900, 300)]))).toBe("single_column_text");
  });
});

describe("isolation (provisional vocabulary: never used by a generator without a separate approval)", () => {
  it("is imported by nothing outside its own module and tests, and reaches no network, process or model", async () => {
    const { spawnSync } = await import("node:child_process");
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const repo = resolve(__dirname, "../../../..");
    const users = spawnSync("git", ["grep", "--untracked", "-lE", "design-agent/structure([\"'`/]|$)", "--", "lib", "app", "components", "scripts"], { cwd: repo, encoding: "utf8" }).stdout.trim();
    expect(users).toBe("");
    for (const f of ["lib/design-agent/structure/descriptor.ts", "lib/design-agent/structure/measure.ts"]) {
      const src = readFileSync(resolve(repo, f), "utf8");
      expect(src, f).not.toMatch(/\bfetch\(|node:https?|child_process|codex|anthropic|openai|writeFile/);
    }
  });
});
