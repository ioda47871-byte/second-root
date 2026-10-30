import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ASPECTS, multisetOverlap, similarityDetail, StructureDescriptor, structuralSimilarity, structureFindings } from "@/lib/design-agent/structure/descriptor";
import { describe as describeMeasure, measurePage, outsideRouterMarkup, sectionLayout, VIEWPORTS } from "@/lib/design-agent/structure/measure";

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
      describeMeasure({ viewport: { width: 1440, height: 900 }, sections: [], nav: null, media, chars: 10, verticalChars: 0, blocked: 0 });
    expect(page([{ box: { x: 0, y: 0, w: 800, h: 600 }, svg: true }]).imagery?.value).toBe("drawn");
    expect(page([{ box: { x: 0, y: 0, w: 100, h: 100 }, svg: false }]).imagery?.value).toBe("none");
    expect(page([{ box: { x: 0, y: 0, w: 800, h: 600 }, svg: false }, { box: { x: 0, y: 700, w: 800, h: 600 }, svg: false }]).imagery?.value).toBe("sequence");
  });

  it("section layout rules (geometry only)", () => {
    const blk = (x: number, y: number, w: number, h: number, o: Partial<{ mediaArea: number; svgArea: number; chars: number }> = {}) => ({ box: { x, y, w, h }, mediaArea: 0, svgArea: 0, chars: 10, centred: false, links: 0, ...o });
    const sec = (blocks: ReturnType<typeof blk>[], o: Partial<{ chars: number; verticalChars: number }> = {}) => ({ box: { x: 0, y: 0, w: 1440, h: 600 }, bg: "x", ownMedia: false, borders: { top: 0, bottom: 0 }, chars: 30, verticalChars: 0, blocks, ...o });
    expect(sectionLayout(sec([blk(0, 0, 1440, 600, { mediaArea: 1440 * 600, chars: 0 })]))).toBe("full_bleed_media");
    expect(sectionLayout(sec([blk(0, 0, 1440, 600, { svgArea: 1440 * 300, mediaArea: 1440 * 300 })]))).toBe("diagram");
    expect(sectionLayout(sec([blk(0, 0, 700, 500), blk(720, 0, 700, 500, { mediaArea: 700 * 500, chars: 0 })]))).toBe("split_copy_media");
    expect(sectionLayout(sec([blk(0, 0, 600, 400), blk(300, 200, 600, 400)]))).toBe("overlap_collage");
    expect(sectionLayout(sec([blk(0, 0, 400, 300), blk(450, 0, 400, 300), blk(900, 0, 400, 300)]))).toBe("grid_cards");
    expect(sectionLayout(sec([blk(0, 0, 900, 300)], { chars: 20, verticalChars: 15 }))).toBe("vertical_text");
    expect(sectionLayout(sec([blk(0, 0, 900, 300)]))).toBe("single_column_text");
  });
});

describe("review fixes (DEV-125 Fresh Review)", () => {
  /** A realistic generic page: images sized only by their own proportions, headings over card grids and columns. */
  const realistic = (o: { ratio?: boolean; accent?: string } = {}) => ({
    html: doc(`<header><nav><a href="#a">a</a><a href="#b">b</a><a href="#c">c</a></nav></header>
<section data-section="hero"><div class="row"><div class="copy"><h1>店名</h1><p>説明</p><a href="#a">見る</a></div><div class="pic"><img src="assets/A1.png" alt=""></div></div></section>
<section data-section="menu"><h2>メニュー</h2><div class="grid"><div class="card">一</div><div class="card">二</div><div class="card">三</div></div></section>
<section data-section="story"><h2>こだわり</h2><div class="row"><div class="pic"><img src="assets/A1.png" alt=""></div><div class="copy"><p>説明</p></div></div></section>
<section data-section="info" class="bgimg"><p>営業時間</p></section>`),
    css: `body{margin:0}header{position:sticky;top:0;background:${o.accent ?? "#fff"}}nav{display:flex;gap:20px;padding:20px 40px}section{padding:60px 40px}
.row{display:flex;gap:40px}.copy,.pic{flex:1}img{width:100%;height:auto;display:block${o.ratio ? ";aspect-ratio:4/3" : ""}}.grid{display:flex;gap:24px}.card{flex:1;height:280px;background:#eee}
.bgimg{height:600px;background:url(assets/A1.png) center/cover}`,
  });

  it("H1: images without set sizes keep their proportions, so the generic skeleton is still seen and a copy still matches", async () => {
    const d = describeMeasure(await measure(realistic()));
    expect(d.section_layouts?.value).toEqual(["split_copy_media", "grid_cards", "split_copy_media", "full_bleed_media"]);
    expect(d.imagery?.value).not.toBe("none");
    expect(structureFindings(d).map((f) => f.code)).toContain("GENERIC_SKELETON");
    const other = describeMeasure(await measure(realistic({ ratio: true, accent: "#c33" })));
    expect(structuralSimilarity(d, other)).toBeGreaterThanOrEqual(0.75);
  }, 60_000);

  it("H2: a declaration cannot hide a copied skeleton (measured aspects alone decide when they cover enough)", async () => {
    const a = describeMeasure(await measure(distinctive));
    const b = describeMeasure(await measure(distinctive), { hero: "object_led", flow: "map_of_stations", reading_path: "radial" });
    const c = describeMeasure(await measure(distinctive), { hero: "type_led", flow: "single_axis_scroll", reading_path: "vertical_axis" });
    expect(similarityDetail(b, c).similarity).toBeLessThan(0.75);
    expect(similarityDetail(b, c, { measuredOnly: true })).toMatchObject({ similarity: 1 });
    expect(structuralSimilarity(a, b)).toBe(1);
    expect(structureFindings(b, { references: { "CP-003": c } }).map((f) => f.code)).toContain("TOO_CLOSE_TO_REFERENCE");
  }, 60_000);

  it("M3 / L1 / L2 / L4: a section's own background picture, no style injection, DOM clobbering, refused requests counted", async () => {
    const m = await measurePage(
      browser,
      {
        html: `<form name="querySelectorAll"></form><img name="body" alt=""><section data-section="a" class="bg"><p>店名</p></section><section data-section="b"><img src="https://example.com/x.png" alt=""><p>説明</p></section>`,
        css: `.bg{height:700px;background:url(assets/A1.png)}</style><nav><a>a</a><a>b</a><a>c</a></nav><style>`,
      },
      VIEWPORTS.desktop,
    );
    expect(m.sections.map(sectionLayout)[0]).toBe("full_bleed_media");
    expect(m.nav).toBeNull();
    expect(m.chars).toBeGreaterThan(0);
    expect(m.blocked).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("L3: a one-section page has no order to compare; empty lists are not a descriptor", () => {
    const one = StructureDescriptor.parse({ schema: "structure_descriptor_v0", hero: null, flow: null, navigation: { value: "none", source: "measured" }, reading_path: null, section_layouts: { value: ["diagram"], source: "measured" }, transitions: null, text_direction: { value: "horizontal", source: "measured" }, imagery: { value: "drawn", source: "measured" } });
    expect(similarityDetail(one, one).coverage).toBeCloseTo(0.35);
    expect(structuralSimilarity(one, one)).toBe(0);
    expect(StructureDescriptor.safeParse({ ...one, transitions: { value: [], source: "measured" } }).success).toBe(false);
  });
});

describe("re-review fixes (DEV-125 round 2)", () => {
  /** A text-led page: a top bar and sections of plain text (layouts all fall back to single_column_text). */
  const textPage = (cls: string) => ({
    html: doc(`<nav><a href="#a">a</a><a href="#b">b</a><a href="#c">c</a></nav><section data-section="a" class="${cls}"><p>一</p></section><section data-section="b" class="${cls}"><p>二</p></section><section data-section="c" class="${cls}"><p>三</p></section>`),
    css: `nav{display:flex;gap:20px;height:60px}section{height:400px;padding:40px}.cut{border-top:2px solid #000}.run{margin-top:-60px}`,
  });

  it("H-A: two text-led pages that differ in every declared aspect are not a copy of each other", async () => {
    const a = describeMeasure(await measure(textPage("cut")), { hero: "type_led", flow: "single_axis_scroll", reading_path: "vertical_axis" });
    const b = describeMeasure(await measure(textPage("run")), { hero: "diagram_led", flow: "map_of_stations", reading_path: "radial" });
    expect(structuralSimilarity(a, b)).toBeLessThan(0.6);
    expect(structureFindings(a, { references: { ref: b }, siblings: { sib: b } }).map((f) => f.code)).not.toContain("TOO_CLOSE_TO_REFERENCE");
  }, 60_000);

  it("H-B: the textbook generic page inside max-width containers is still the generic skeleton", async () => {
    const page = {
      html: doc(`<header><nav><a href="#a">a</a><a href="#b">b</a><a href="#c">c</a></nav></header>
<section data-section="hero"><div class="inner"><div class="row"><div class="copy"><h1>店名</h1><a href="#a">見る</a></div><div class="pic"><img src="assets/A1.png" alt=""></div></div></div></section>
<section data-section="menu"><div class="inner"><h2>メニュー</h2><div class="grid"><div class="card">一</div><div class="card">二</div><div class="card">三</div></div></div></section>
<section data-section="story"><div class="inner"><h2>こだわり</h2><div class="row"><div class="pic"><img src="assets/A1.png" alt=""></div><div class="copy"><p>説明</p></div></div></div></section>
<section data-section="info"><div class="inner"><h2>店舗情報</h2><div class="row"><div class="copy"><p>営業時間</p></div><div class="pic"><img src="assets/A1.png" alt=""></div></div></div></section>`),
      css: `body{margin:0}header{position:sticky;top:0}nav{display:flex;gap:20px;padding:20px}section{border-top:1px solid #ddd}.inner{max-width:1120px;margin:0 auto;padding:80px}
.row{display:flex;gap:40px}.copy,.pic{flex:1}img{width:100%;height:auto;display:block}.grid{display:flex;gap:24px}.card{flex:1;height:260px;background:#eee}`,
    };
    const d = describeMeasure(await measure(page));
    expect(d.section_layouts?.value).toEqual(["split_copy_media", "grid_cards", "split_copy_media", "split_copy_media"]);
    expect(structureFindings(d).map((f) => f.code)).toContain("GENERIC_SKELETON");
  }, 60_000);

  it("M-A: markup that can reach out before the request router is refused before anything is drawn", async () => {
    for (const bad of ['<link rel="prerender" href="http://127.0.0.1/">', '<iframe src="http://127.0.0.1/"></iframe>', '<object data="x"></object>', '<embed src="x">', '<meta http-equiv="refresh" content="0;url=http://127.0.0.1/">', "<link rel=preconnect href=//x>"])
      await expect(measurePage(browser, { html: doc(bad), css: "" }, VIEWPORTS.desktop)).rejects.toMatchObject({ code: "MEASURE_PAGE_REFUSED" });
    expect(outsideRouterMarkup(doc("<p>x</p>"))).toBeNull();
  }, 60_000);

  it("L-A: names that shadow DOM methods on a form do not break measuring", async () => {
    const m = await measurePage(browser, { html: `<form><input name="getBoundingClientRect"><input name="childNodes"><input name="localName"></form><section data-section="a"><p>店名</p></section>`, css: "" }, VIEWPORTS.desktop);
    expect(m.sections.length).toBeGreaterThanOrEqual(1);
  }, 60_000);
});

describe("final review fix (DEV-125 round 3, M-1)", () => {
  it("a section whose only content is one full picture or drawing (wrapped or not) is a picture, not plain text", async () => {
    const m = await measurePage(
      browser,
      {
        html: doc(`<section data-section="a"><img class="full" src="assets/A1.png" alt=""></section><section data-section="b"><div class="inner"><svg class="full" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg></div></section><section data-section="c"><picture><img class="full" src="assets/A1.png" alt=""></picture></section>`),
        css: `body{margin:0}.full{display:block;width:100%;height:700px}section{height:700px}`,
      },
      VIEWPORTS.desktop,
    );
    expect(m.sections.map(sectionLayout)).toEqual(["full_bleed_media", "diagram", "full_bleed_media"]);
  }, 60_000);
});

describe("isolation (provisional vocabulary: never used by a generator without a separate approval)", () => {
  it("is imported by nothing outside its own module and tests, and reaches no network, process or model", async () => {
    const { spawnSync } = await import("node:child_process");
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const repo = resolve(__dirname, "../../../..");
    // any importer, absolute or relative (M2); git grep exits 1 when nothing matches (an error is 128, never a pass)
    const g = spawnSync("git", ["grep", "--untracked", "-lE", "structure/(descriptor|measure)|from [\"'`]\\./(descriptor|measure)[\"'`]", "--", ".", ":!lib/design-agent/structure/**", ":!tests/unit/design-agent/structure/**", ":!.ai/**", ":!docs/**"], { cwd: repo, encoding: "utf8" });
    expect([g.status, g.stdout.trim()]).toEqual([1, ""]);
    for (const f of ["lib/design-agent/structure/descriptor.ts", "lib/design-agent/structure/measure.ts"]) {
      const src = readFileSync(resolve(repo, f), "utf8");
      expect(src, f).not.toMatch(/\bfetch\(|node:https?|child_process|codex|anthropic|openai|writeFile/);
    }
  });
});
