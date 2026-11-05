import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CompPage } from "@/lib/design-agent/comp-impl/page";
import { GEOMETRY_SCRIPT, GeometrySchema } from "@/lib/design-agent/comp-impl/page-scripts";
import { APPROVED_CAPABILITIES } from "@/lib/design-agent/comp-impl/spec";
import { SEAM, WHEEL } from "../../../../lib/design-agent/research/decoration-fixtures";
import { checkN1Asset, pendingN1Review, renderN1Preview, type N1Asset } from "../../../../lib/design-agent/research/decoration-review";
import { checkDecorationPage, checkDecorationSvg, type DecorationAssetRef } from "../../../../lib/design-agent/research/decoration-svg";
import { layeredCssProblems, overlapCodes, overlapScan, overlapSweep, pixelPass, sweepRanges, type Opener, type OverlapPlan } from "../comp-impl/overlap-harness";
import { launch } from "../comp-impl/support";

// DEV-174 (Issue #193 comment 6628165899): N1 joined to phase C's text protection. TEST-ONLY PROTOTYPE, NOT ENABLED.
// An N1 decoration is a recorded SVG shown only through `<img>` (decoration-svg.ts). Placed on a page, it is one more
// painter for the phase C render check (overlap-harness.ts, docs/design/phase-c-design.md §3): V2 — it never paints
// above any glyph box; V4 — under protected text (and, with the proposed default `plate`, under ordinary text) only when
// an opaque flat plate hides it. The join below is the conjunction a future N1 + layered_decoration run would need:
//   page allowlist (checkDecorationPage) ∧ strict SVG check (checkDecorationSvg) ∧ proposed grammar (layeredCssProblems,
//   flag on) ∧ today's run geometry, unchanged (GEOMETRY_SCRIPT: no img may touch protected text, whatever the order —
//   n1-decoration-svg.md §7 C-2 says phase C must not loosen it) ∧ phase C render check (overlapScan; the 1px sweep where
//   widths matter) ∧ the owner record (checkN1Asset).
// The img is judged by its BOX: the browser does not tell where an image's pixels are transparent, so a transparent
// region over text counts as paint (fail closed). Nothing here is wired into comp-impl; APPROVED_CAPABILITIES stays [].

vi.setConfig({ testTimeout: 600_000, hookTimeout: 120_000 });

const ORIGIN = "http://n1-join.invalid";
const PAGE_URL = `${ORIGIN}/page/index.html`;
const FACT = "000-0000-0712";
const PLAN: OverlapPlan = { protect: [FACT], ordinary: "plate", grammar: true };
const CHECKED = [1440, 1280, 1024, 768, 601, 600, 480, 390, 375, 360, 340, 320] as const;
const SVGS = new Map([
  ["assets/seam.svg", SEAM],
  ["assets/wheel.svg", WHEEL],
]);
const BASE = 'body { margin: 0; font-family: "IPAGothic", sans-serif; font-size: 20px; line-height: 1.6; color: #1F1D1B; background: #ffffff; } p { margin: 0; } .wrap { position: relative; padding: 40px; }';

type Case = { body: string; css: string; assets?: DecorationAssetRef[] };
const IMG = (cls: string, file = "assets/seam.svg") => `<img class="${cls}" src="${file}" alt="" aria-hidden="true" referrerpolicy="no-referrer">`;
const html = (body: string) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>n1 join</title></head><body><main class="wrap">${body}</main></body></html>`;
const seamOnly: DecorationAssetRef[] = [{ id: "seam", file: "assets/seam.svg" }];

let browser: Browser;
let ctx: BrowserContext;
let tab: Page;
const unexpected: string[] = [];
let current = "";

/** Serves `page` and the recorded SVGs; anything else is aborted and logged. JavaScript off; the CSS is added after load. */
async function serve(context: BrowserContext, log: string[], page: () => string) {
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (url === PAGE_URL) return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: page() });
    const svg = url.startsWith(`${ORIGIN}/page/`) ? SVGS.get(url.slice(`${ORIGIN}/page/`.length)) : undefined;
    if (svg !== undefined) return route.fulfill({ status: 200, contentType: "image/svg+xml", body: svg });
    if (url !== `${ORIGIN}/favicon.ico`) log.push(url);
    return route.abort("blockedbyclient");
  });
}
async function open(page: Page, c: Case) {
  current = html(c.body);
  await page.goto(PAGE_URL, { waitUntil: "load" });
  await page.evaluate((css) => document.head.append(Object.assign(document.createElement("style"), { textContent: css })), `${BASE}\n${c.css}`);
  await page.evaluate("document.fonts ? document.fonts.ready.then(() => true) : true");
}

type Join = { page: string[]; svg: string[]; grammar: string[]; geometry: string[]; overlap: string[] };
const blocking = (j: Join) => [...j.page, ...j.svg, ...j.grammar, ...j.geometry, ...j.overlap];
/** The static half of the join (no browser). */
function staticJoin(c: Case): Omit<Join, "overlap" | "geometry"> {
  const assets = c.assets ?? seamOnly;
  return {
    page: checkDecorationPage(html(c.body), c.css, assets).problems,
    svg: [...new Set(assets.flatMap((a) => checkDecorationSvg(Buffer.from(SVGS.get(a.file) ?? "")).findings.map((f) => f.code)))],
    grammar: layeredCssProblems(c.css, { layeredDecoration: true }),
  };
}
async function joinAt(c: Case, width = 800): Promise<Join> {
  await tab.setViewportSize({ width, height: 600 });
  await open(tab, c);
  const g = GeometrySchema.parse(await tab.evaluate(`(${GEOMETRY_SCRIPT})(${JSON.stringify({ facts: [FACT], from: width, to: width, step: false })})`));
  return { ...staticJoin(c), geometry: [...new Set(g.failing.flatMap((f) => f.codes))].sort(), overlap: overlapCodes(await overlapScan(tab, PLAN)) };
}

beforeAll(async () => {
  browser = await launch();
  ctx = await browser.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1, javaScriptEnabled: false, serviceWorkers: "block" });
  await serve(ctx, unexpected, () => current);
  tab = await ctx.newPage();
});
afterAll(async () => {
  await ctx?.close();
  await browser?.close();
});

// ---------------------------------------------------------------- the cases

const FACT_P = `<p class="fact">電話 ${FACT}</p>`;
const ORDINARY_P = `<p class="body">湯上がりの、帰り道。</p>`;

/**
 * Must fail: each is clean in every static part of the join; the phase C render check refuses it with the code named,
 * and today's run geometry gives exactly the codes listed (it does not look at ordinary text, so those two give none).
 */
const FACT_OVER = ["FACT_COVERED", "FACT_IMAGE_OVERLAP"];
const FACT_UNDER = ["FACT_IMAGE_OVERLAP"];
const MUST_FAIL: Array<[string, Case, string, string[]]> = [
  ["img over a fact (absolute, z-index 1)", { body: `${FACT_P}${IMG("deco")}`, css: ".deco { position: absolute; left: 40px; top: 36px; width: 300px; height: 40px; z-index: 1; }" }, "OVERLAP_PAINT_ABOVE_PROTECTED", FACT_OVER],
  ["img over a fact, in flow, pulled up by a negative margin", { body: `${FACT_P}${IMG("deco")}`, css: ".deco { display: block; width: 300px; height: 40px; margin-top: -30px; }" }, "OVERLAP_PAINT_ABOVE_PROTECTED", FACT_OVER],
  ["img under a fact, no plate (the text lifted above it)", { body: `${FACT_P}${IMG("deco")}`, css: ".fact { position: relative; z-index: 2; } .deco { position: absolute; left: 40px; top: 36px; width: 300px; height: 40px; z-index: 1; }" }, "OVERLAP_PROTECTED_ON_DECORATION", FACT_UNDER],
  ["img under a fact, no plate (z-index -1 in an isolated group)", { body: `${FACT_P}${IMG("deco")}`, css: ".wrap { isolation: isolate; } .deco { position: absolute; left: 40px; top: 36px; width: 300px; height: 40px; z-index: -1; }" }, "OVERLAP_PROTECTED_ON_DECORATION", FACT_UNDER],
  [
    "img under a fact on a 90% white plate (not opaque)",
    { body: `<p class="fact"><span class="plate">電話 ${FACT}</span></p>${IMG("deco")}`, css: ".plate { display: inline-block; position: relative; z-index: 2; padding: 4px 6px; background: rgba(255, 255, 255, 0.9); } .deco { position: absolute; left: 40px; top: 36px; width: 300px; height: 40px; z-index: 1; }" },
    "OVERLAP_PROTECTED_ON_DECORATION",
    FACT_UNDER,
  ],
  ["img over ordinary text", { body: `${ORDINARY_P}${IMG("deco")}`, css: ".deco { position: absolute; left: 40px; top: 36px; width: 300px; height: 40px; z-index: 1; }" }, "OVERLAP_PAINT_ABOVE_TEXT", []],
  ["img under ordinary text, no plate (plate is the proposed default)", { body: `${ORDINARY_P}${IMG("deco")}`, css: ".body { position: relative; z-index: 2; } .deco { position: absolute; left: 40px; top: 36px; width: 300px; height: 40px; z-index: 1; }" }, "OVERLAP_TEXT_ON_DECORATION", []],
  ["img pushes a fact off screen (negative margin on the text's block)", { body: `${IMG("deco")}${FACT_P}`, css: ".deco { display: block; width: 100px; height: 40px; } .fact { margin-left: -120px; }" }, "OVERLAP_PROTECTED_OFFSCREEN", ["FACT_OFFSCREEN"]],
];

/**
 * The transparent case: the seam's box is 98% transparent. Its one stroke runs at 70% of the box's width; the box is
 * placed so that the fact's glyphs lie in the transparent part, left of the stroke. Not one pixel of the decoration
 * touches the glyphs, yet the box does.
 */
const TRANSPARENT: Case = { body: `${FACT_P}${IMG("deco")}`, css: ".deco { position: absolute; left: 30px; top: 30px; width: 400px; height: 50px; z-index: 1; }" };

/**
 * The plate under a fact: phase C's V4 admits it (the fact sits on its own opaque lifted plate), but today's run geometry
 * (FACT_IMAGE_OVERLAP: no img may touch protected text) refuses it, and n1-decoration-svg.md §7 C-2 says not to loosen
 * that. HOLD for the owner: the join keeps C-2.
 */
const PLATE_FACT: Case = {
  body: `<p class="fact"><span class="plate">電話 ${FACT}</span></p>${IMG("deco")}`,
  css: ".plate { display: inline-block; position: relative; z-index: 2; padding: 4px 6px; background: #ffffff; } .deco { position: absolute; left: 30px; top: 30px; width: 400px; height: 50px; z-index: 1; }",
};

/** Must pass: every part of the join is clean. */
const MUST_PASS: Array<[string, Case]> = [
  ["img in flow, clear of text", { body: `${FACT_P}${IMG("deco")}${ORDINARY_P}`, css: ".deco { display: block; width: 300px; height: 40px; }" }],
  ["img absolute in the gutter, above, touching no glyph", { body: `${FACT_P}${ORDINARY_P}${IMG("deco")}`, css: ".deco { position: absolute; right: 20px; top: 20px; width: 60px; height: 200px; z-index: 1; }" }],
  [
    "img under ordinary text on an opaque lifted plate",
    { body: `<p class="body"><span class="plate">湯上がりの、帰り道。</span></p>${IMG("deco")}`, css: ".plate { display: inline-block; position: relative; z-index: 2; padding: 4px 6px; background: #f3efe6; } .deco { position: absolute; left: 30px; top: 30px; width: 400px; height: 50px; z-index: 1; }" },
  ],
  ["two recorded assets, both clear", { body: `${FACT_P}${IMG("deco")}${IMG("hub", "assets/wheel.svg")}`, css: ".deco { display: block; width: 300px; height: 40px; } .hub { display: block; width: 144px; height: 140px; }", assets: [...seamOnly, { id: "wheel", file: "assets/wheel.svg" }] }],
];

/**
 * The scaled case. The img's width is a share of the page (40%). Below 800px the fact sits under it; from 800px beside it
 * after a fixed gutter; from 900px the gutter becomes a share of the page too. Between (one band ending at 899px; on this
 * container's fonts 849–899px), 40% of the width passes the fixed gutter and the img's box reaches the fact. No checked
 * width (1024, 768 …) is in that band: only the 1px sweep sees it. The safe variant widens the fixed gutter.
 * Font-independent: the upper edge (899, the last width before the 900px media query) and 852, the first width where
 * today's run geometry sees the img's box reach the fact's line box (0.4 × 852 > the line's left edge at 340px: layout,
 * not glyphs). The lower edge of phase C's band depends on the glyphs' ink (side bearings), so it is not pinned: it is
 * read from the sweep, checked against fresh opens at every width around it (an oracle), and must contain 852.
 */
const SCALED = (gutter: string): Case => ({
  body: `${IMG("deco")}${FACT_P}`,
  css: `.deco { position: absolute; left: 0; top: 0; width: 40%; height: 120px; z-index: 1; } .fact { margin-top: 140px; } @media (min-width: 800px) { .fact { margin-top: 0; margin-left: ${gutter}; } } @media (min-width: 900px) { .fact { margin-left: 62%; } }`,
});

describe("DEV-174 the join stays OFF", () => {
  it("approves no N1 / phase C capability (DEV-180: gradient_ground alone)", () => expect(APPROVED_CAPABILITIES).toEqual(["gradient_ground"]));
});

describe("DEV-174 must fail: an N1 img that reaches text (static parts clean, the phase C check refuses)", () => {
  it.each(MUST_FAIL)("%s", async (name, c, code, geometry) => {
    const j = await joinAt(c);
    console.log(`DEV-174 must-fail ${name}: geometry=${JSON.stringify(j.geometry)} overlap=${JSON.stringify(j.overlap)}`);
    expect([j.page, j.svg, j.grammar]).toEqual([[], [], []]);
    expect(j.overlap).toContain(code);
    expect(j.geometry).toEqual(geometry);
    expect(unexpected).toEqual([]);
  });

  it("img with transparent regions over a fact: the box counts (V2 fails closed); the pixels alone would let it through", async () => {
    const j = await joinAt(TRANSPARENT);
    expect([j.page, j.svg, j.grammar]).toEqual([[], [], []]);
    expect(j.overlap).toEqual(["OVERLAP_PAINT_ABOVE_PROTECTED"]);
    // today's run geometry also judges the box: the img's box over the fact's line
    expect(j.geometry).toEqual(FACT_OVER);
    const px = await pixelPass(tab, PLAN);
    // the stroke misses every glyph and the rest is transparent: the ink reaches the screen untouched
    expect(Object.keys(px.codes)).not.toContain("PIXEL_COVER_PROTECTED");
    expect(px.worstTransmittance).toBeGreaterThanOrEqual(0.97);
    // and the same box on the plate passes (MUST_PASS 3): the plate, not the transparency, is what makes it safe
  });

  it("img scaled with the width: reaches the fact only between checked widths — the 1px sweep finds it, the 12 checked widths miss it", async () => {
    const c = SCALED("300px");
    expect(Object.values(staticJoin(c)).flat()).toEqual([]);
    const s = await overlapSweep(browser, { html: html(c.body), css: c.css } as CompPage, PLAN, 320, 1920, sweepOpener(c));
    expect(s.measured).toBe(1601);
    console.log(`DEV-174 scaled sweep: ${JSON.stringify(sweepRanges(s))} ${s.ms}ms`);
    const ranges = sweepRanges(s);
    expect(Object.keys(ranges)).toEqual(["OVERLAP_PAINT_ABOVE_PROTECTED"]);
    // one contiguous band (no comma), ending at the 900px media query, starting after the 800px one
    const band = /^(\d+)–(\d+)$/.exec(ranges.OVERLAP_PAINT_ABOVE_PROTECTED!);
    expect(band, ranges.OVERLAP_PAINT_ABOVE_PROTECTED).not.toBeNull();
    const [lo, hi] = [Number(band![1]), Number(band![2])];
    expect(hi).toBe(899);
    expect(lo).toBeGreaterThanOrEqual(800);
    expect(lo).toBeLessThanOrEqual(852); // it contains the line box's first contact (below)
    // the same widths opened afresh (real resizes) agree with the sweep, edge included, around the lower edge and across
    // the upper; today's run geometry (line boxes, no growth) sees a band inside it: phase C grows protected glyph boxes by
    // 1 px (V4), so it also catches the widths where the box grazes
    const geo: number[] = [];
    const from = Math.min(845, lo - 4);
    for (let w = from; w <= 905; w++) {
      const j = await joinAt(c, w);
      expect(j.overlap.includes("OVERLAP_PAINT_ABOVE_PROTECTED"), `overlap ${w}`).toBe(w >= lo && w <= hi);
      if (j.geometry.includes("FACT_IMAGE_OVERLAP")) geo.push(w);
    }
    console.log(`DEV-174 scaled geometry (today's run) widths: ${geo[0]}–${geo[geo.length - 1]} (${geo.length})`);
    expect(geo.length).toBeGreaterThan(0);
    expect(geo.every((w, i) => i === 0 || w === geo[i - 1]! + 1)).toBe(true);
    expect(geo[0]).toBe(852);
    expect(geo[geo.length - 1]).toBe(899);
    expect(geo[0]).toBeGreaterThanOrEqual(lo);
    for (const w of CHECKED) expect((await joinAt(c, w)).overlap, `${w}`).toEqual([]);
  });

  it("the static half refuses what the render check would let through: inline SVG, an unrecorded or non-decorative img, an SVG with text, the decoration from CSS", async () => {
    const clear = MUST_PASS[0]![1];
    expect(staticJoin({ ...clear, body: clear.body.replace(IMG("deco"), SEAM) }).page).toContain("INLINE_SVG");
    expect(staticJoin({ ...clear, body: clear.body.replace('alt=""', 'alt="継ぎ目"') }).page).toContain("SVG_IMG_NOT_DECORATIVE");
    expect(staticJoin({ ...clear, body: clear.body.replace("assets/seam.svg", "assets/other.svg") }).page).toContain("SVG_NOT_RECORDED");
    expect(staticJoin({ ...clear, body: clear.body.replace(IMG("deco"), '<div class="deco"></div>'), css: `${clear.css} .deco { background-image: url(assets/seam.svg); }` }).page).toEqual(expect.arrayContaining(["CSS_URL", "SVG_FROM_CSS"]));
    expect(checkDecorationSvg(Buffer.from(SEAM.replace("</svg>", "<text>半額</text></svg>"))).ok).toBe(false);
    // and the render check still passes the clear page: the halves are independent, the join needs both
    expect((await joinAt(clear)).overlap).toEqual([]);
  });
});

describe("DEV-174 must pass: N1 img placements the join admits (geometry, order, plates, pixels)", () => {
  it.each(MUST_PASS)("%s", async (_, c) => {
    const j = await joinAt(c);
    expect(blocking(j)).toEqual([]);
    const px = await pixelPass(tab, PLAN);
    expect(px.codes).toEqual({});
    expect(unexpected).toEqual([]);
  });

  it("img under a fact on an opaque lifted plate: phase C passes it (geometry and pixels); today's geometry gate still refuses it (C-2 kept)", async () => {
    const j = await joinAt(PLATE_FACT);
    expect([j.page, j.svg, j.grammar, j.overlap]).toEqual([[], [], [], []]);
    expect(j.geometry).toContain("FACT_IMAGE_OVERLAP");
    expect((await pixelPass(tab, PLAN)).codes).toEqual({});
  });

  it("the scaled img with a gutter that holds at every width: no code anywhere in 320–1920", async () => {
    const c = SCALED("360px");
    const s = await overlapSweep(browser, { html: html(c.body), css: c.css } as CompPage, PLAN, 320, 1920, sweepOpener(c));
    expect(s.measured).toBe(1601);
    expect(s.failing).toEqual([]);
  });
});

describe("DEV-174 a clean placement is still not ON: the owner record is pending", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "dev174-join-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets/seam.svg"), SEAM);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("every part of the join passes the clear page, and the asset is refused for want of an owner decision", async () => {
    const j = await joinAt(MUST_PASS[0]![1]);
    expect(blocking(j)).toEqual([]);
    const r = await renderN1Preview(browser, Buffer.from(SEAM), 100, 100);
    expect(r.problems).toEqual([]);
    const asset: N1Asset = { id: "seam", file: "assets/seam.svg", sha256: createHash("sha256").update(SEAM).digest("hex"), bytes: Buffer.byteLength(SEAM), width: 100, height: 100, kind: "decoration_svg", role: "decoration" };
    // checkN1Asset reads the bytes and renders the preview itself; the pending record carries that same picture
    expect(await checkN1Asset(browser, dir, asset, undefined)).toEqual(["N1_REVIEW_MISSING"]);
    expect(await checkN1Asset(browser, dir, asset, pendingN1Review(asset, asset.sha256, r.preview!))).toEqual(["N1_REVIEW_PENDING"]);
  });
});

function sweepOpener(c: Case): Opener {
  return async (b, _p, w) => {
    const log: string[] = [];
    const context = await b.newContext({ viewport: { width: w, height: 900 }, deviceScaleFactor: 1, javaScriptEnabled: false, serviceWorkers: "block" });
    await serve(context, log, () => html(c.body));
    const page = await context.newPage();
    await page.goto(PAGE_URL, { waitUntil: "load" });
    await page.evaluate((css) => document.head.append(Object.assign(document.createElement("style"), { textContent: css })), `${BASE}\n${c.css}`);
    await page.evaluate("document.fonts ? document.fonts.ready.then(() => true) : true");
    return {
      page,
      close: async () => {
        await context.close();
        expect(log).toEqual([]);
      },
    };
  };
}
