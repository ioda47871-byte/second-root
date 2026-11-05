import type { Browser, BrowserContext, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cssProblems, htmlSourceProblems } from "@/lib/design-agent/comp-impl/page";
import type { PageCssOptions } from "@/lib/design-agent/comp-impl/page-css";
import { GEOMETRY_SCRIPT, GeometrySchema } from "@/lib/design-agent/comp-impl/page-scripts";
import { layerScan, openCompPage, textMeasure } from "@/lib/design-agent/comp-impl/render";
import { APPROVED_CAPABILITIES, CAPABILITY_NAMES } from "@/lib/design-agent/comp-impl/spec";
import { layerCodes } from "@/lib/design-agent/comp-impl/verify";
import { launch } from "./support";
import type { CompPage } from "@/lib/design-agent/comp-impl/page";
import { textCheck, widthRanges } from "@/lib/design-agent/comp-impl/checks";
import { withWideMetrics } from "./gradient-harness";
import { SHOPS, type ShopKey } from "./nowrap-harness";
import {
  inventory,
  INVENTORY_CATEGORIES,
  LAYER_CSS,
  layeredCssProblems,
  layeredDecl,
  overlapCodes,
  overlapPage,
  overlapScan,
  overlapSweep,
  pixelPass,
  shopPlan,
  sweepRanges,
  instanceCodes,
  withPinnedFonts,
  type OverlapPlan,
  type OverlapSweep,
  type Opener,
} from "./overlap-harness";

// DEV-173 (Issue #193 comment 6628165899): phase C — safe overlap, paint order and layers (docs/design/phase-c-design.md).
// DESIGN AND OFFLINE VERIFICATION ONLY. Nothing in lib/ changes and nothing is enabled: APPROVED_CAPABILITIES stays empty,
// no capability or PageCssOptions key is added, and the run never sees the prototype. These tests hold:
// 1. today, with every flag off and with every phase B flag on, the production grammar refuses every overlap construct,
//    and the run's layer scan stops the C′ pages (STACKING_CONTEXT, PSEUDO_GEOMETRY_UNKNOWN);
// 2. the proposed grammar (test-only wrapper around pageCssProblems) admits exactly its list behind its flag and
//    changes nothing without it;
// 3. the proposed render check (test-only prototype, overlap-harness.ts) catches decoration or other text over or under
//    protected text and covers over ordinary text — z-index, negative margins, transforms, absolute siblings,
//    pseudo-elements, outlines, shadows, filters, text on text, blend modes, pointer-events: none, isolation tricks,
//    atomic painting, grid stacking — passes layered decoration that touches no glyph, fails closed where it cannot
//    prove the order, and agrees with Chromium's own pixels where both can see;
// 4. the three shops: the strict B pages, the B pages with layers in the proposed grammar, and the C′ pages, at the
//    checked widths, in the pixel pass and over the 1px sweep 320–1920.

vi.setConfig({ testTimeout: 900_000, hookTimeout: 300_000 });

const SHOP_KEYS = Object.keys(SHOPS) as ShopKey[];
const ALL_B: PageCssOptions = { verticalName: true, displayScale: true, displayNowrap: true, colourSyntax: true, gradientGround: true, translucentDecoration: true };
const FACT = "000-0000-0712";
const PLAN: OverlapPlan = { protect: [FACT], ordinary: "plate" };
const CHECKED = [1440, 1280, 1024, 768, 601, 600, 480, 390, 375, 360, 340, 320] as const;

let browser: Browser;
let raw: BrowserContext;
let tab: Page;
beforeAll(async () => {
  browser = await launch();
  raw = await browser.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1, javaScriptEnabled: false });
  await raw.route("**/*", (route) => route.abort());
  tab = await raw.newPage();
});
afterAll(async () => {
  await raw?.close();
  await browser?.close();
});

const BASE = '* { margin: 0; padding: 0; } body { font-family: "IPAGothic", sans-serif; font-size: 20px; line-height: 1.6; color: #1F1D1B; background: #fff; } .wrap { position: relative; padding: 40px; }';
async function load(body: string, css: string, width = 800) {
  await tab.setViewportSize({ width, height: 600 });
  await tab.setContent(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>${BASE}\n${css}</style></head><body>${body}</body></html>`);
}
async function geo(body: string, css: string, plan: OverlapPlan = PLAN, width = 800) {
  await load(body, css, width);
  return overlapCodes(await overlapScan(tab, plan));
}
const open: Opener = async (b, p, w) => {
  const o = await openCompPage(b, p, { width: w, height: 900, scale: 1, mobile: false });
  return { page: o.page, close: () => o.context.close() };
};

// ---------------------------------------------------------------- 1. today: everything is refused

/** Declarations of every overlap / layering construct (the inventory's categories), each refused today. */
const CONSTRUCTS = [
  "position: absolute",
  "position: relative",
  "position: fixed",
  "position: sticky",
  "top: 0",
  "left: 10px",
  "inset: 0",
  "z-index: 1",
  "z-index: -1",
  "margin-top: -20px",
  "margin: 0 -10px",
  "transform: rotate(3deg)",
  "transform: translate(10px, 0)",
  "translate: 10px",
  "rotate: 3deg",
  "isolation: isolate",
  "pointer-events: none",
  "overflow: hidden",
  "overflow-x: clip",
  "mix-blend-mode: multiply",
  "clip-path: inset(0)",
  "mask-image: none",
  "filter: drop-shadow(0 4px 4px #000)",
  "backdrop-filter: blur(2px)",
  "outline: 1px solid #000",
  "box-shadow: 0 4px 8px #000",
  "text-shadow: 0 0 2px #000",
  "-webkit-text-stroke: 1px #000",
  "will-change: transform",
  "contain: paint",
  "grid-column: 1 / 3",
  "grid-area: 1 / 1",
];

describe("DEV-173 phase C stays OFF (the production checker today)", () => {
  it("approves nothing and names no phase C capability", () => {
    expect(APPROVED_CAPABILITIES).toEqual([]);
    expect(CAPABILITY_NAMES as readonly string[]).not.toContain("layered_decoration");
    expect(CAPABILITY_NAMES.some((c) => /layer|overlap|magazine|hero_overlay/.test(c))).toBe(false);
  });

  it("refuses every overlap construct with every flag off, with vertical_name, and with every phase B flag on", () => {
    for (const d of CONSTRUCTS)
      for (const opts of [{}, { verticalName: true }, ALL_B] as PageCssOptions[]) {
        const p = cssProblems(`.x { ${d}; }`, opts);
        expect(p.length, `${d} ${JSON.stringify(opts)}`).toBeGreaterThan(0);
      }
    // pseudo-elements: the selector itself is refused
    for (const sel of [".x::before", ".x::after", ".x:before"]) expect(cssProblems(`${sel} { color: #000; }`, ALL_B)).toContain("CSS_PSEUDO_ELEMENT");
    // opacity < 1 is the one layering property a phase B flag admits (translucent_decoration), and only that
    expect(cssProblems(".x { opacity: .5; }")).toContain("CSS_VALUE");
    expect(cssProblems(".x { opacity: .5; }", { translucentDecoration: true })).toEqual([]);
  });

  it("refuses the three C′ pages (stylesheet with every flag, inline SVG in the HTML) and the three layer pages without the proposed flag", () => {
    for (const shop of SHOP_KEYS) {
      const c = overlapPage(shop, "cprime");
      for (const opts of [{}, ALL_B] as PageCssOptions[]) {
        // as written it stops at the lexical stage (tsugute: Japanese in comments and font names, CSS_SYNTAX_NON_ASCII;
        // bicycle: a ">" in a comment, CSS_SYNTAX_ANGLE_BRACKET; sento: url(#…) SVG paint, CSS_SYNTAX_URL); with comments,
        // non-ASCII and url() taken out, the property check is reached and refuses it too
        expect(cssProblems(c.css, opts)).toEqual([{ tsugute: "CSS_SYNTAX_NON_ASCII", bicycle: "CSS_SYNTAX_ANGLE_BRACKET", sento: "CSS_SYNTAX_URL" }[shop]]);
        const p = cssProblems(c.css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/[^\x00-\x7f]/g, "x").replace(/url\([^)]*\)/g, "none"), opts);
        expect(p, `${shop} ${JSON.stringify(opts)}`).toContain("CSS_PROPERTY");
        expect(p).toContain("CSS_PSEUDO_ELEMENT");
        expect(p).toContain("CSS_VIEWPORT_UNIT");
      }
      expect(htmlSourceProblems(c.html)).toContain("HTML_ELEMENT");
      const l = overlapPage(shop, "layer");
      expect(htmlSourceProblems(l.html)).toEqual([]);
      for (const opts of [{}, ALL_B] as PageCssOptions[]) expect(cssProblems(l.css, opts).length, shop).toBeGreaterThan(0);
    }
  });

  it("the run's layer scan stops every C′ page and every layer page today (STACKING_CONTEXT; PSEUDO_GEOMETRY_UNKNOWN where C′ draws pseudo-elements)", async () => {
    for (const shop of SHOP_KEYS)
      for (const v of ["layer", "cprime"] as const) {
        const o = await openCompPage(browser, overlapPage(shop, v), { width: 1440, height: 900, scale: 1, mobile: false });
        try {
          const codes = layerCodes(await layerScan(o.page, []));
          expect(codes, `${shop} ${v}`).toContain("STACKING_CONTEXT");
          if (v === "cprime" && shop !== "bicycle") expect(codes).toContain("PSEUDO_GEOMETRY_UNKNOWN");
        } finally {
          await o.context.close();
        }
      }
  });
});

// ---------------------------------------------------------------- 2. the proposed grammar

describe("DEV-173 the proposed grammar (test-only prototype of layered_decoration)", () => {
  const ADMITTED = [
    "position: absolute",
    "position: relative",
    "top: -40px",
    "left: 46%",
    "right: 2rem",
    "inset: 0",
    "inset: 0 auto auto 10px",
    "z-index: -1",
    "z-index: 9",
    "isolation: isolate",
    "transform: rotate(-38deg)",
    "transform: translate(10px, -4%)",
    "transform: translateY(-20px) rotate(4deg)",
    "transform-origin: top center",
    "margin-top: -150px",
    "margin: 0 -10px",
    "overflow-x: clip",
    "overflow: hidden",
  ];
  const REFUSED = [
    "position: fixed",
    "position: sticky",
    "top: 10vw",
    "top: calc(10% - 4px)",
    "left: 3000px",
    "z-index: 10",
    "z-index: -2",
    "transform: rotate(60deg)",
    "transform: scale(2)",
    "transform: skewX(4deg)",
    "transform: matrix(1, 0, 0, 1, 0, 0)",
    "transform: rotate(4deg) rotate(4deg) rotate(4deg) rotate(4deg)",
    "transform: perspective(100px)",
    "translate: 10px",
    "margin-top: -500px",
    "overflow: scroll",
    "pointer-events: none",
    "mix-blend-mode: multiply",
    "clip-path: inset(0)",
    "filter: blur(2px)",
    "outline: 1px solid #000",
    "box-shadow: 0 4px 8px #000",
    "text-shadow: 0 0 2px #000",
    "-webkit-text-stroke: 1px #000",
    "will-change: transform",
    "contain: paint",
    "grid-area: 1 / 1",
  ];

  it("without the flag it is exactly the production grammar", () => {
    for (const d of [...ADMITTED, ...REFUSED, ...CONSTRUCTS]) expect(layeredCssProblems(`.x { ${d}; }`), d).toEqual(cssProblems(`.x { ${d}; }`));
    for (const shop of SHOP_KEYS) for (const v of ["strict", "layer", "cprime"] as const) expect(layeredCssProblems(overlapPage(shop, v).css)).toEqual(cssProblems(overlapPage(shop, v).css));
  });

  it("with the flag it admits its list and nothing else (pseudo-elements, viewport units, blend, clip, filters, outlines, outer shadows, pointer-events stay refused)", () => {
    for (const d of ADMITTED) {
      expect(layeredDecl(d.split(":")[0]!, d.slice(d.indexOf(":") + 1)), d).toBe(true);
      expect(layeredCssProblems(`.x { ${d}; }`, { layeredDecoration: true }), d).toEqual([]);
    }
    for (const d of REFUSED) expect(layeredCssProblems(`.x { ${d}; }`, { layeredDecoration: true }).length, d).toBeGreaterThan(0);
    expect(layeredCssProblems(".x::before { position: absolute; }", { layeredDecoration: true })).toContain("CSS_PSEUDO_ELEMENT");
  });

  it("the three layer pages pass with the flag (HTML through the allowlist unchanged); their extra CSS uses nothing outside the list", () => {
    for (const shop of SHOP_KEYS) {
      expect(layeredCssProblems(overlapPage(shop, "layer").css, { layeredDecoration: true }), shop).toEqual([]);
      expect(cssProblems(LAYER_CSS[shop]).length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------- 3. the render check on synthetic probes

const F = `<p class="f">${FACT}</p>`;
const O = `<p class="o">線の引き方を相談します</p>`;
const D = `<div class="d" aria-hidden="true"></div>`;
/** pixel: the code the pixel pass must show, null for its blind spot, "font" where it depends on the face installed. */
type Probe = { name: string; body: string; css: string; expect: string; pixel: string | null | "font" };
/** Each must fail with `expect` (the prototype); `pixel` is what the pixel pass sees (null: nothing — its blind spot). */
const PROBES: Probe[] = [
  { name: "z-index: a 5% cover", body: `<div class="wrap">${F}${D}</div>`, css: ".d { position: absolute; z-index: 2; left: 60px; top: 44px; width: 40px; height: 20px; background: rgba(200, 0, 0, .05); }", expect: "OVERLAP_PAINT_ABOVE_PROTECTED", pixel: "PIXEL_COVER_PROTECTED" },
  { name: "z-index: a 2% cover (under the pixel bound)", body: `<div class="wrap">${F}${D}</div>`, css: ".d { position: absolute; z-index: 2; left: 60px; top: 44px; width: 40px; height: 20px; background: rgba(0, 0, 0, .02); }", expect: "OVERLAP_PAINT_ABOVE_PROTECTED", pixel: null },
  { name: "negative margin: a positioned card pulled up over the fact", body: `<div class="wrap">${F}<div class="card"><p>次の区画</p></div></div>`, css: ".card { position: relative; margin-top: -24px; padding-top: 40px; background: #f4efe6; }", expect: "OVERLAP_PAINT_ABOVE_PROTECTED", pixel: "PIXEL_COVER_PROTECTED" },
  { name: "transform: a translated empty block (a stacking context over in-flow text)", body: `<div class="wrap">${F}${D}</div>`, css: ".d { height: 12px; width: 120px; background: #ddd; transform: translate(10px, -24px); }", expect: "OVERLAP_PAINT_ABOVE_PROTECTED", pixel: "PIXEL_COVER_PROTECTED" },
  { name: "absolute sibling, z-index auto", body: `<div class="wrap">${F}${D}</div>`, css: ".d { position: absolute; left: 50px; top: 46px; width: 60px; height: 14px; background: #c79a45; }", expect: "OVERLAP_PAINT_ABOVE_PROTECTED", pixel: "PIXEL_COVER_PROTECTED" },
  { name: "pseudo-element: a 3% veil (::after, inset 0)", body: `<div class="wrap">${F}</div>`, css: ".wrap::after { content: ''; position: absolute; inset: 0; background: rgba(0, 0, 0, .03); }", expect: "OVERLAP_PAINT_ABOVE_PROTECTED", pixel: "PIXEL_COVER_PROTECTED" },
  { name: "pseudo-element: a solid bar (::before)", body: `<div class="wrap">${F}</div>`, css: ".wrap::before { content: ''; position: absolute; left: 40px; top: 50px; width: 200px; height: 4px; background: #c79a45; }", expect: "OVERLAP_PAINT_ABOVE_PROTECTED", pixel: "PIXEL_COVER_PROTECTED" },
  { name: "outline spreading from a far box", body: `<div class="wrap">${F}${D}</div>`, css: ".d { position: absolute; left: 400px; top: 40px; width: 10px; height: 10px; outline: 300px solid rgba(0, 0, 0, .04); }", expect: "OVERLAP_PROTECTED_ORDER_UNPROVEN", pixel: "PIXEL_COVER_PROTECTED" },
  { name: "box-shadow spreading from a far box", body: `<div class="wrap">${F}${D}</div>`, css: ".d { position: absolute; z-index: 2; left: 400px; top: 40px; width: 10px; height: 10px; box-shadow: 0 0 0 300px rgba(0, 0, 0, .04); }", expect: "OVERLAP_PROTECTED_ORDER_UNPROVEN", pixel: "PIXEL_COVER_PROTECTED" },
  { name: "drop-shadow filter reaching the fact", body: `<div class="wrap">${F}<div class="board"></div></div>`, css: ".board { height: 40px; width: 200px; background: #ccc; filter: drop-shadow(0 -30px 6px rgba(0, 0, 0, .3)); }", expect: "OVERLAP_PROTECTED_ORDER_UNPROVEN", pixel: "PIXEL_COVER_PROTECTED" },
  { name: "text over text: ordinary text lifted over the fact", body: `<div class="wrap">${F}<p class="o2">上に重ねた文字</p></div>`, css: ".o2 { position: absolute; z-index: 1; left: 50px; top: 40px; }", expect: "OVERLAP_PROTECTED_TEXT_ON_TEXT", pixel: null },
  { name: "text under text: an aria-hidden ghost word below the fact", body: `<div class="wrap">${F}<p class="g" aria-hidden="true">継ぐ</p></div>`, css: ".wrap { isolation: isolate; } .g { position: absolute; z-index: -1; left: 40px; top: 10px; font-size: 90px; color: #eee; }", expect: "OVERLAP_PROTECTED_TEXT_ON_TEXT", pixel: "PIXEL_PROTECTED_GROUND_NOT_FLAT" },
  { name: "a 1px line across the digits, above", body: `<div class="wrap">${F}${D}</div>`, css: ".d { position: absolute; z-index: 1; left: 40px; top: 55px; width: 300px; height: 1px; background: #c79a45; }", expect: "OVERLAP_PAINT_ABOVE_PROTECTED", pixel: "PIXEL_COVER_PROTECTED" },
  { name: "a 1px line across the digits, below (z-index -1, isolated)", body: `<div class="wrap">${F}${D}</div>`, css: ".wrap { isolation: isolate; } .d { position: absolute; z-index: -1; left: 40px; top: 55px; width: 300px; height: 1px; background: #c79a45; }", expect: "OVERLAP_PROTECTED_ON_DECORATION", pixel: "PIXEL_PROTECTED_GROUND_NOT_FLAT" },
  { name: "an SVG stroke across the fact", body: `<div class="wrap">${F}<svg class="s" viewBox="0 0 300 40" aria-hidden="true"><path d="M0 20 C100 0 200 40 300 20" fill="none" stroke="#c79a45" stroke-width="2"/></svg></div>`, css: ".s { position: absolute; z-index: 1; left: 40px; top: 36px; width: 300px; height: 40px; }", expect: "OVERLAP_PAINT_ABOVE_PROTECTED", pixel: "PIXEL_COVER_PROTECTED" },
  { name: "clipped: an overflow box cuts the fact", body: `<div class="wrap"><div class="c">${F}</div></div>`, css: ".c { overflow: hidden; width: 80px; } .f { white-space: nowrap; }", expect: "OVERLAP_PROTECTED_CLIPPED", pixel: null },
  { name: "clipped: clip-path on an ancestor", body: `<div class="wrap"><div class="c">${F}</div></div>`, css: ".c { clip-path: inset(0 50% 0 0); }", expect: "OVERLAP_PROTECTED_CLIPPED", pixel: null },
  { name: "off screen: pulled left by a negative margin", body: `<div class="wrap">${F}</div>`, css: ".f { margin-left: -200px; }", expect: "OVERLAP_PROTECTED_OFFSCREEN", pixel: null },
  { name: "mix-blend-mode: difference over the fact", body: `<div class="wrap">${F}${D}</div>`, css: ".d { position: absolute; z-index: 1; left: 40px; top: 40px; width: 80px; height: 32px; background: #fff; mix-blend-mode: difference; }", expect: "OVERLAP_PAINT_ABOVE_PROTECTED", pixel: "PIXEL_COVER_PROTECTED" },
  { name: "pointer-events: none on the cover (hit-testing would skip it)", body: `<div class="wrap">${F}${D}</div>`, css: ".d { position: absolute; z-index: 2; left: 40px; top: 40px; width: 80px; height: 32px; background: #000; pointer-events: none; }", expect: "OVERLAP_PAINT_ABOVE_PROTECTED", pixel: "PIXEL_COVER_PROTECTED" },
  { name: "isolation trap: z-index -1 inside an isolated group that is itself above", body: `<div class="wrap">${F}<div class="grp">${D}</div></div>`, css: ".grp { position: absolute; inset: 0; z-index: 1; isolation: isolate; } .d { position: absolute; z-index: -1; left: 40px; top: 40px; width: 80px; height: 32px; background: #c79a45; }", expect: "OVERLAP_PAINT_ABOVE_PROTECTED", pixel: "PIXEL_COVER_PROTECTED" },
  { name: "opacity: an earlier translucent sibling pulled under the text paints above it", body: `<div class="wrap">${D}${F}</div>`, css: ".d { opacity: .9; height: 20px; margin-bottom: -20px; background: #ddd; }", expect: "OVERLAP_PAINT_ABOVE_PROTECTED", pixel: "PIXEL_COVER_PROTECTED" },
  // the fact overflows its own box sideways; hit-testing does not list it outside that box, so the order is unproven (closed)
  { name: "atomic painting: a later flex item over an earlier item's overflowing text", body: `<div class="wrap"><div class="row"><div class="a">${F}</div><div class="b"></div></div></div>`, css: ".row { display: flex; } .a { flex: none; width: 60px; white-space: nowrap; } .b { flex: none; width: 100px; height: 32px; margin-left: 10px; background: #ddd; }", expect: "OVERLAP_PROTECTED_ORDER_UNPROVEN", pixel: "PIXEL_COVER_PROTECTED" },
  { name: "atomic painting: a later flex item pulled back over an earlier item's text", body: `<div class="wrap"><div class="row"><div class="a">${F}</div><div class="b"></div></div></div>`, css: ".row { display: flex; } .a { flex: none; white-space: nowrap; } .b { flex: none; width: 100px; height: 12px; align-self: center; margin-left: -120px; background: #ddd; }", expect: "OVERLAP_PAINT_ABOVE_PROTECTED", pixel: "PIXEL_COVER_PROTECTED" },
  { name: "grid stacking: a later item on the same cell", body: `<div class="wrap"><div class="g">${F}<div class="b"></div></div></div>`, css: ".g { display: grid; } .g > * { grid-area: 1 / 1; } .b { background: #ddd; height: 10px; align-self: center; }", expect: "OVERLAP_PAINT_ABOVE_PROTECTED", pixel: "PIXEL_COVER_PROTECTED" },
  // DEV-173 Fresh Review M1: a later run of the same paragraph, pulled back by an inline-block with a negative margin
  { name: "text over text inside one element: a later run pulled back over the fact", body: `<div class="wrap"><p class="f">${FACT}<span class="k" aria-hidden="true"></span>1111</p></div>`, css: ".k { display: inline-block; margin-left: -120px; }", expect: "OVERLAP_PROTECTED_TEXT_ON_TEXT", pixel: null },
  // DEV-173 Fresh Review M2: the fact pulled over its container's border (the border runs under the digits)
  { name: "an ancestor's top border under the fact (negative margin)", body: `<div class="wrap"><div class="box">${F}</div></div>`, css: ".box { border-top: 3px solid #c79a45; } .f { margin-top: -14px; }", expect: "OVERLAP_PROTECTED_ON_DECORATION", pixel: null },
  { name: "an ancestor's left border under the fact (negative margin)", body: `<div class="wrap"><div class="box">${F}</div></div>`, css: ".box { border-left: 3px solid #c79a45; } .f { margin-left: -14px; }", expect: "OVERLAP_PROTECTED_ON_DECORATION", pixel: null },
  { name: "an ancestor's gradient ground under the fact", body: `<div class="wrap"><div class="box">${F}</div></div>`, css: ".box { background: linear-gradient(90deg, #fff, #c79a45); }", expect: "OVERLAP_PROTECTED_ON_DECORATION", pixel: null },
  // DEV-173 Fresh Review L3: ordinary text clipped by an overflow box
  { name: "ordinary text clipped by an overflow box", body: `<div class="wrap"><div class="c">${O}</div></div>`, css: ".c { overflow: hidden; width: 80px; } .o { white-space: nowrap; }", expect: "OVERLAP_TEXT_CLIPPED", pixel: null },
  // DEV-173 CI / re-review: an ancestor's drop-shadow (one child's shadow falls under another child's text)
  { name: "an ancestor's drop-shadow under the fact (a photo's shadow on its own caption)", body: `<div class="wrap"><div class="board"><div class="photo"></div>${F}</div></div>`, css: ".board { filter: drop-shadow(0 26px 6px rgba(0, 0, 0, .4)); } .photo { height: 30px; background: #ccc; }", expect: "OVERLAP_PROTECTED_ORDER_UNPROVEN", pixel: null },
  // DEV-173 re-review M1 / L2: glyphs canvas measureText does not draw as the page does — fail closed
  { name: "tabular figures (font-variant-numeric) drawn wider than measured", body: `<div class="wrap">${F}${D}</div>`, css: ".f { font-family: Inter, sans-serif; font-size: 40px; font-variant-numeric: tabular-nums; } .d { position: absolute; z-index: 2; left: 60px; top: 60px; width: 3px; height: 3px; background: #c79a45; }", expect: "OVERLAP_PROTECTED_GLYPHS_UNMEASURED", pixel: "font" },
  { name: "a combining mark (NFD) above its base", body: `<div class="wrap"><p class="f">Cafe\u0301 ${FACT}</p>${D}</div>`, css: '.f { font-family: "DejaVu Sans", sans-serif; } .d { position: absolute; z-index: 2; left: 80px; top: 40px; width: 3px; height: 3px; background: #c79a45; }', expect: "OVERLAP_PROTECTED_GLYPHS_UNMEASURED", pixel: null },
  { name: "an underline (text-decoration) drawn outside the glyphs", body: `<div class="wrap">${F}${D}</div>`, css: ".f { text-decoration: underline; } .d { position: absolute; z-index: 2; left: 60px; top: 66px; width: 40px; height: 3px; background: #c79a45; }", expect: "OVERLAP_PROTECTED_GLYPHS_UNMEASURED", pixel: null },
  { name: "a list marker (text the walker does not see)", body: `<div class="wrap"><ul class="l"><li>${FACT}</li></ul></div>`, css: ".l { padding-left: 40px; }", expect: "OVERLAP_MARKER_UNMEASURED", pixel: null },
  // re-review 3 M1: the filter is on the text's own element (one child's shadow under the element's own text)
  { name: "the text's own element's drop-shadow (a child's shadow under the element's own text)", body: `<div class="wrap"><div class="board"><div class="photo"></div>${FACT}</div></div>`, css: ".board { filter: drop-shadow(0 26px 6px rgba(0, 0, 0, .6)); } .photo { height: 30px; background: #ccc; }", expect: "OVERLAP_PROTECTED_ORDER_UNPROVEN", pixel: null },
  // re-review 3 L1: a filter that changes the text's own pixels on an ancestor (the pixel reference keeps filters)
  { name: "an ancestor's filter: opacity(0.15) fades the fact", body: `<div class="wrap"><div class="box">${F}</div></div>`, css: ".box { filter: opacity(0.15); }", expect: "OVERLAP_PROTECTED_TEXT_FILTERED", pixel: null },
  { name: "an ancestor's filter: brightness(0) blackens the fact", body: `<div class="wrap"><div class="box">${F}</div></div>`, css: ".box { filter: brightness(0); }", expect: "OVERLAP_PROTECTED_TEXT_FILTERED", pixel: null },
  // re-review 4 L1-b: a filter on body or html fades or blackens every text (they were skipped)
  { name: "body's filter: opacity(0.1) fades the fact", body: `<div class="wrap">${F}</div>`, css: "body { filter: opacity(0.1); }", expect: "OVERLAP_PROTECTED_TEXT_FILTERED", pixel: null },
  { name: "html's filter: brightness(0) blackens the fact", body: `<div class="wrap">${F}</div>`, css: "html { filter: brightness(0); }", expect: "OVERLAP_PROTECTED_TEXT_FILTERED", pixel: null },
  // re-review 3 L6
  { name: "small caps (font-variant-caps) drawn otherwise than measured", body: `<div class="wrap"><p class="f">Tel ${FACT}</p></div>`, css: ".f { font-variant-caps: all-small-caps; }", expect: "OVERLAP_PROTECTED_GLYPHS_UNMEASURED", pixel: null },
  // DEV-175 re-review 4 H1: a fact split over elements — its last digits in a span of their own — is protected text
  { name: "a fact split over elements: its last digits (a span) covered", body: `<div class="wrap"><p class="f">000-0000-<span class="s">0712</span></p>${D}</div>`, css: ".d { position: absolute; z-index: 2; left: 136px; top: 44px; width: 30px; height: 20px; background: #c79a45; }", expect: "OVERLAP_PAINT_ABOVE_PROTECTED", pixel: "PIXEL_COVER_PROTECTED" },
  { name: "ordinary text covered", body: `<div class="wrap">${O}${D}</div>`, css: ".d { position: absolute; z-index: 2; left: 60px; top: 46px; width: 40px; height: 16px; background: #c79a45; }", expect: "OVERLAP_PAINT_ABOVE_TEXT", pixel: "PIXEL_COVER_TEXT" },
  { name: "ordinary text over a decoration with no plate", body: `<div class="wrap">${O}${D}</div>`, css: ".wrap { isolation: isolate; } .d { position: absolute; z-index: -1; left: 40px; top: 55px; width: 300px; height: 3px; background: #c79a45; }", expect: "OVERLAP_TEXT_ON_DECORATION", pixel: null },
];

/** Each must pass: layered decoration that touches no glyph, or sits under a plate. */
const LEGIT: Array<{ name: string; body: string; css: string; plan?: OverlapPlan }> = [
  { name: "an under-layer seam in the gutter between two columns", body: `<div class="wrap cols"><div>${F}</div><div>${O}</div>${D}</div>`, css: ".cols { display: grid; grid-template-columns: 1fr 1fr; column-gap: 60px; isolation: isolate; } .d { position: absolute; z-index: -1; top: 0; bottom: 0; left: calc(50% - 2px); width: 4px; background: #c79a45; }" },
  { name: "a decoration above, clear of every glyph", body: `<div class="wrap">${F}${D}</div>`, css: ".d { position: absolute; z-index: 2; left: 400px; top: 40px; width: 60px; height: 60px; background: #c79a45; }" },
  { name: "a line under the fact, hidden by the fact's own opaque plate", body: `<div class="wrap">${F}${D}</div>`, css: ".f { display: inline-block; position: relative; z-index: 2; background: #fff; padding: 0 2px; } .d { position: absolute; z-index: 1; left: 0; right: 0; top: 55px; height: 3px; background: #c79a45; }" },
  { name: "a line under ordinary text, hidden by a plate on its block", body: `<div class="wrap">${O}${D}</div>`, css: ".o { display: inline-block; position: relative; z-index: 2; background: #fff; padding: 0 2px; } .d { position: absolute; z-index: 1; left: 0; right: 0; top: 55px; height: 3px; background: #c79a45; }" },
  { name: "decoration drawn over an image only", body: `<div class="wrap">${F}<div class="board"><img alt="" width="200" height="100" src="data:,"><div class="crack" aria-hidden="true"></div></div></div>`, css: ".board { position: relative; width: 200px; height: 100px; background: #ccc; } .crack { position: absolute; left: 90px; top: 10px; width: 4px; height: 80px; background: #c79a45; transform: rotate(16deg); }" },
  { name: "a turned bar whose box meets the fact but whose paint does not", body: `<div class="wrap">${F}${D}</div>`, css: ".d { position: absolute; z-index: 2; left: 220px; top: 20px; width: 4px; height: 90px; background: #c79a45; transform: rotate(40deg); transform-origin: top center; }" },
  { name: "an SVG curve whose box covers the fact but whose stroke passes clear", body: `<div class="wrap">${F}<svg class="s" viewBox="0 0 300 120" aria-hidden="true"><path d="M0 4 L300 4 L300 116" fill="none" stroke="#c79a45" stroke-width="2"/></svg></div>`, css: ".s { position: absolute; z-index: 1; left: 30px; top: 0; width: 300px; height: 120px; }" },
  { name: "a content card with a negative margin over empty space only", body: `<div class="wrap">${F}<div class="pad"></div><div class="card"><p>次の区画</p></div></div>`, css: ".pad { height: 80px; } .card { position: relative; z-index: 1; margin-top: -60px; background: #f4efe6; }" },
  { name: "ordinary text over a decoration, with ordinary: allow", body: `<div class="wrap">${O}${D}</div>`, css: ".wrap { isolation: isolate; } .d { position: absolute; z-index: -1; left: 40px; top: 55px; width: 300px; height: 3px; background: #c79a45; }", plan: { protect: [FACT], ordinary: "allow" } },
];

describe("DEV-173 the render check (prototype) on synthetic probes", () => {
  const matrix: string[] = [];
  afterAll(() => console.log(`DEV-173 probe matrix (probe | prototype | pixel | lib V2 covers / non-content | lib hit-test)\n${matrix.join("\n")}`));

  it("exactly one probe leaves its pixel outcome to the face installed (the tabular-figures probe)", () => {
    expect(PROBES.filter((p) => p.pixel === "font").map((p) => p.name)).toEqual(["tabular figures (font-variant-numeric) drawn wider than measured"]);
  });

  it.each(PROBES)("fails: $name", async (p) => {
    await load(p.body, p.css);
    const g = overlapCodes(await overlapScan(tab, PLAN));
    expect(g, p.name).toContain(p.expect);
    await load(p.body, p.css);
    const pr = await pixelPass(tab, PLAN);
    expect(pr.disagreements, `${p.name} pixels vs geometry, text by text`).toEqual([]);
    const px = Object.keys(pr.codes).sort();
    // "font": whether the dot lands on ink depends on the face (Inter and its tabular figures are not on CI); the geometric
    // fail-closed code above is the guarantee. Where the face really widens the figures (measured: tabular "1111" wider than
    // proportional — document.fonts.check("40px Inter") is no test, it is true for any system face, installed or not),
    // the pixel cover is asserted as well
    if (p.pixel === "font") {
      await load(`<span id="a" style="font: 40px Inter, sans-serif">1111</span><span id="b" style="font: 40px Inter, sans-serif; font-variant-numeric: tabular-nums">1111</span>`, "");
      const [wa, wb] = (await tab.evaluate(`["a", "b"].map((i) => document.getElementById(i).getBoundingClientRect().width)`)) as number[];
      if (wb! > wa! + 1) expect(px, `${p.name} pixel (the face widens the figures)`).toContain("PIXEL_COVER_PROTECTED");
    } else if (p.pixel) expect(px, `${p.name} pixel`).toContain(p.pixel);
    else expect(px.filter((c) => c.startsWith("PIXEL_COVER")), `${p.name} pixel blind spot`).toEqual([]);
    // what today's run-side scripts would say on the same raw HTML (informative: the allowlist refuses all of it first)
    await load(p.body, p.css);
    const scan = await layerScan(tab, [FACT]);
    const hit = GeometrySchema.parse(await tab.evaluate(`(${GEOMETRY_SCRIPT})(${JSON.stringify({ facts: [FACT], from: 800, to: 800, step: false })})`));
    matrix.push(`${p.name} | ${g.join(",")} | ${px.join(",") || "-"} | ${scan.covers.count}/${scan.nonContentOverlap.fact} | ${[...new Set(hit.failing.flatMap((f) => f.codes))].join(",") || "-"}`);
  });

  it.each(LEGIT)("passes: $name", async (l) => {
    await load(l.body, l.css);
    expect(overlapCodes(await overlapScan(tab, l.plan ?? PLAN)), l.name).toEqual([]);
    await load(l.body, l.css);
    const px = await pixelPass(tab, l.plan ?? PLAN);
    expect(Object.keys(px.codes), `${l.name} pixel`).toEqual([]);
  });

  it("the plate is exact: translucent, too small, below the decoration, or a ground with an image is not a plate", async () => {
    const base = ".d { position: absolute; z-index: 1; left: 0; right: 0; top: 55px; height: 3px; background: #c79a45; }";
    expect(await geo(`<div class="wrap">${F}${D}</div>`, `.f { display: inline-block; position: relative; z-index: 2; background: #fff; padding: 0 2px; } ${base}`)).toEqual([]);
    // the plate must hold the protected glyph boxes grown by 1 px (V4): a plate flush with the first and last glyph is short
    expect(await geo(`<div class="wrap">${F}${D}</div>`, `.f { display: inline-block; position: relative; z-index: 2; background: #fff; } ${base}`)).toContain("OVERLAP_PROTECTED_ON_DECORATION");
    expect(await geo(`<div class="wrap">${F}${D}</div>`, `.f { display: inline-block; position: relative; z-index: 2; background: rgba(255, 255, 255, .9); padding: 0 2px; } ${base}`)).toContain("OVERLAP_PROTECTED_ON_DECORATION");
    expect(await geo(`<div class="wrap">${F}${D}</div>`, `.f { display: inline-block; position: relative; z-index: 0; background: #fff; padding: 0 2px; } ${base}`)).toContain("OVERLAP_PAINT_ABOVE_PROTECTED");
    expect(await geo(`<div class="wrap">${F}${D}</div>`, `.f { display: inline-block; position: relative; z-index: 2; background: linear-gradient(#fff, #fff); padding: 0 2px; } ${base}`)).toContain("OVERLAP_PROTECTED_ON_DECORATION");
    // a plate on an ancestor that holds the glyphs, lifted as a unit
    expect(await geo(`<div class="wrap"><div class="card">${F}</div>${D}</div>`, `.card { position: relative; z-index: 2; background: #fff; padding: 4px; } ${base}`)).toEqual([]);
    // an opaque ground on a box that is not atomic is no plate: a later in-flow block pulled up paints its ground after
    // the fact's ground and before the fact's text, so the line shows under the digits
    expect(await geo(`<div class="wrap"><p class="f">${FACT}</p><div class="d2" aria-hidden="true"></div></div>`, ".f { background: #fff; padding: 0 2px; } .d2 { height: 3px; margin-top: -18px; background: #c79a45; }")).toContain("OVERLAP_PROTECTED_ON_DECORATION");
    // an ancestor's border under the fact passes only on a plate inside that ancestor (painted after it in tree order)
    expect(await geo(`<div class="wrap"><div class="box">${F}</div></div>`, ".box { border-top: 3px solid #c79a45; } .f { margin-top: -14px; background: #fff; padding: 2px; }")).toEqual([]);
    // the fact's own ground with no lift: the line (positioned, z-index 1) paints above the fact itself
    expect(await geo(`<div class="wrap">${F}${D}</div>`, `.f { background: #fff; } ${base}`)).toContain("OVERLAP_PAINT_ABOVE_PROTECTED");
  });

  it("glyph boxes are the ink (+1 px antialias), and protected ones 1 px more: a line 1.3 px under a fact's ink fails, the same line under ordinary text passes; lines set solid under tall font metrics do not meet", async () => {
    for (const [body, code] of [[F, "OVERLAP_PAINT_ABOVE_PROTECTED"], [`<p class="f">線の引き方を相談します</p>`, null]] as const) {
      await load(`<div class="wrap">${body}</div>`, "");
      const g = (await overlapScan(tab, PLAN, { glyphs: true })).glyphs!.find((t) => t.rects.length > 0)!;
      // the raw ink's bottom is the box's bottom less the 1 px antialias growth
      const raw = Math.max(...g.rects.map((r) => r.bottom)) - 1;
      const got = await geo(`<div class="wrap">${body}${D}</div>`, `.d { position: absolute; z-index: 2; left: 0; right: 0; top: ${raw + 1.3}px; height: 1px; background: #c79a45; }`);
      if (code) expect(got, "protected").toContain(code);
      else expect(got, "ordinary").toEqual([]);
    }
    // two paragraphs set solid (line-height 1) in a face whose content area is 1.45 em: the Range rects overlap, the ink does not
    const tall = '@font-face { font-family: "TallGothic"; src: local("IPAGothic"); ascent-override: 116%; descent-override: 29%; } .t { font-family: "TallGothic", sans-serif; font-size: 40px; line-height: 1; }';
    expect(await geo(`<div class="wrap"><p class="t">線の引き方</p><p class="t">相談します</p></div>`, tall)).toEqual([]);
  });

  it("drop-shadow alone does not change the text's own pixels: the two drop-shadow probes fail on order only, not TEXT_FILTERED (re-review 4 L1-a: the rgba() inside the computed value is not a filter function)", async () => {
    for (const name of ["an ancestor's drop-shadow under the fact (a photo's shadow on its own caption)", "the text's own element's drop-shadow (a child's shadow under the element's own text)"]) {
      const p = PROBES.find((x) => x.name === name)!;
      const got = await geo(p.body, p.css);
      expect(got, name).toContain("OVERLAP_PROTECTED_ORDER_UNPROVEN");
      expect(got.filter((c) => c.endsWith("TEXT_FILTERED")), name).toEqual([]);
    }
    // and with another function next to it, the filter changes the text: TEXT_FILTERED
    expect(await geo(`<div class="wrap"><div class="box">${F}</div></div>`, ".box { filter: drop-shadow(0 2px 2px rgba(0, 0, 0, .5)) blur(1px); }")).toContain("OVERLAP_PROTECTED_TEXT_FILTERED");
  });

  it("fails closed: a pseudo-element whose content is not a string, and paint the order cannot be proven for", async () => {
    await load(`<div class="wrap">${F}</div>`, ".wrap::after { content: counter(x); position: absolute; left: 40px; top: 40px; }");
    expect(overlapCodes(await overlapScan(tab, PLAN))).toContain("OVERLAP_PSEUDO_UNPROVEN");
    // a filter whose spread the check cannot bound covers everything after it
    expect(await geo(`<div class="wrap">${F}<div class="b"></div></div>`, ".b { height: 10px; width: 10px; background: #ccc; filter: url(#x); }")).toContain("OVERLAP_PROTECTED_ORDER_UNPROVEN");
  });

  it("a pre-existing gap of the production checker, pinned as it is today (DEV-173 Fresh Review L2): height: 0 lets the next paragraph print over ordinary text; the layer scan and the 15-point hit-test say nothing, only the text check's overprint does", async () => {
    const body = `<div class="wrap"><div class="box">${O}</div><p>次の段落の文字です</p></div>`;
    const css = ".box { height: 0; }";
    expect(cssProblems(css)).toEqual([]);
    await load(body, css);
    expect(layerCodes(await layerScan(tab, [FACT]))).toEqual([]);
    const hit = GeometrySchema.parse(await tab.evaluate(`(${GEOMETRY_SCRIPT})(${JSON.stringify({ facts: [FACT], from: 800, to: 800, step: false })})`));
    expect(hit.failing).toEqual([]);
    expect(textCheck(await textMeasure(tab, [FACT])).codes).toEqual(["TEXT_OVERLAP"]);
    // the prototype names it too
    expect(await geo(body, css)).toEqual(["OVERLAP_TEXT_ON_TEXT"]);
  });

  it("materialized pseudo-elements are where Chromium draws them (absolute and in-flow)", async () => {
    for (const css of [".wrap::after { content: ''; position: absolute; left: 33px; top: 17px; width: 71px; height: 9px; background: #000; }", ".wrap::before { content: ''; display: block; width: 50px; height: 7px; margin: 3px 0 5px 12px; background: #000; }"]) {
      await load(`<div class="wrap">${F}</div>`, css);
      const drawn = await tab.screenshot();
      await tab.evaluate(`document.head.appendChild(Object.assign(document.createElement("style"), { textContent: "*::before, *::after { visibility: hidden !important; }" }))`);
      const without = await tab.screenshot();
      const sharp = (await import("sharp")).default;
      const a = await sharp(drawn).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const b = await sharp(without).removeAlpha().raw().toBuffer();
      let box = { left: 1e9, top: 1e9, right: -1, bottom: -1 };
      for (let y = 0; y < a.info.height; y++)
        for (let x = 0; x < a.info.width; x++) {
          const i = (y * a.info.width + x) * 3;
          if (a.data[i] !== b[i] || a.data[i + 1] !== b[i + 1] || a.data[i + 2] !== b[i + 2]) box = { left: Math.min(box.left, x), top: Math.min(box.top, y), right: Math.max(box.right, x + 1), bottom: Math.max(box.bottom, y + 1) };
        }
      await load(`<div class="wrap">${F}</div>`, css);
      await overlapScan(tab, PLAN);
      const r = (await tab.evaluate(`(() => { const r = document.querySelector("[data-ov-pseudo]").getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })()`)) as typeof box;
      for (const k of ["left", "top", "right", "bottom"] as const) expect(Math.abs(r[k] - box[k]), `${css} ${k}`).toBeLessThanOrEqual(1);
    }
  });

  it("a cover that exists only at 1100–1108px is found by the 1px sweep and missed by the checked widths", async () => {
    const page = { dir: "", html: `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="style.css"></head><body><div class="wrap">${F}${D}</div></body></html>`, css: `${BASE}\n.d { position: absolute; z-index: 2; left: 600px; top: 40px; width: 40px; height: 32px; background: #c79a45; }\n@media (min-width: 1100px) and (max-width: 1108px) { .d { left: 60px; } }`, assets: [], files: new Map(), htmlSha256: "", cssSha256: "" };
    for (const mode of ["real", "stepped"] as const) {
      const s = await overlapSweep(browser, page, PLAN, 1090, 1120, open, mode);
      expect(s.measured).toBe(31);
      expect(sweepRanges(s), mode).toEqual({ OVERLAP_PAINT_ABOVE_PROTECTED: "1100–1108" });
    }
    for (const w of [1024, 1280, 1440]) {
      const o = await openCompPage(browser, page, { width: w, height: 900, scale: 1, mobile: false });
      try {
        expect(overlapCodes(await overlapScan(o.page, PLAN))).toEqual([]);
      } finally {
        await o.context.close();
      }
    }
  });
});

// ---------------------------------------------------------------- 4. the three shops

describe("DEV-173 the three shops", () => {
  const cprime: Record<string, Record<number, string[]>> = {};
  afterAll(() => console.log(`DEV-173 C′ codes at the checked widths\n${JSON.stringify(cprime, null, 1)}`));

  it("inventory of the C′ pages: what they use for overlap and layering (pinned)", () => {
    const got = Object.fromEntries(SHOP_KEYS.map((s) => [s, inventory(s)]));
    console.log(`DEV-173 inventory\n${INVENTORY_CATEGORIES.map((c) => `${c}\t${SHOP_KEYS.map((s) => got[s]![c]).join("\t")}`).join("\n")}`);
    for (const s of SHOP_KEYS) {
      expect(got[s]!.position_absolute, s).toBeGreaterThan(5);
      expect(got[s]!.inline_svg, s).toBeGreaterThan(0);
      expect(got[s]!.aria_hidden_text, s).toBeGreaterThan(0);
    }
  });

  // The shop pages' text geometry depends on the fonts installed (CI: Playwright's fonts on ubuntu, no IPA; this container:
  // IPA). Nothing below pins a width range measured here: strict is computed in the test and the layer pages must equal it
  // width by width. The same comparison also runs under withWideMetrics (gradient-harness.ts), which approximates taller
  // CJK metrics in this container (it has no effect where the IPA fonts are absent).
  /** The strict pages' only findings with pinned fonts: protected texts off screen in the known tablet / narrow overflow. */
  const PINNED_STRICT: Record<ShopKey, Record<string, number[]>> = {
    tsugute: {
      "架空線架空駅1番出口から徒歩6分": [768, 601],
      "漆が乾くまで、修理には一か月ほどかかります": [768, 601],
      "器を持ち込むと、継ぎ目の線を一緒に決めます": [601],
      "水曜・木曜": [601],
    },
    bicycle: {
      "修理の前に、どこを直すかを一緒に確かめます": [1024, 768, 601],
      "輪": [1024, 768, 601],
      "振れ取りでは、スポークを一本ずつ締めて車輪をまっ": [768, 601, 360, 340, 320],
      "架空線架空駅南口から徒歩3分": [768, 601],
      "パンク修理から車輪の振れ取りまで、店先の作業台で": [340, 320],
    },
    sento: {
      "のれんは、季節ごとに色を変えます": [768, 601],
      "壁には、タイルで描いた山の絵があります": [768, 601],
      "手ぬぐいと石けんを貸し出しています": [768, 601],
    },
  };
  const fontVariants = [
    ["installed", (p: CompPage) => p],
    ["wide", withWideMetrics],
    ["pinned", withPinnedFonts],
  ] as const;

  it("strict and layer at the checked widths (PC, tablet, SP; SP with phone emulation), installed fonts and wide metrics: the layer pages add no code; C′ is recorded", async () => {
    for (const [fonts, f] of fontVariants)
      for (const shop of SHOP_KEYS) {
        if (fonts === "installed") cprime[shop] = {};
        const strictCodes: string[] = [];
        for (const w of CHECKED) {
          const codes: Record<string, string[]> = {};
          for (const v of fonts === "installed" ? (["strict", "layer", "cprime"] as const) : (["strict", "layer"] as const)) {
            const o = await openCompPage(browser, f(overlapPage(shop, v)), { width: w, height: 900, scale: 1, mobile: w <= 390 });
            try {
              const sc = await overlapScan(o.page, shopPlan(shop, { grammar: v === "layer" }));
              codes[v] = v === "cprime" ? overlapCodes(sc) : instanceCodes(sc);
            } finally {
              await o.context.close();
            }
          }
          // text by text (DEV-173 re-review L1): a layer may not add an instance even of a code strict already has
          expect(codes.layer, `${fonts} ${shop} ${w}`).toEqual(codes.strict);
          // with the faces pinned to IPAGothic (the same on CI), strict holds exactly the known overflow: these texts, these
          // widths (re-review 3 L3; measured here and with CI's font set through FONTCONFIG_FILE — identical)
          if (fonts === "pinned") expect(codes.strict, `pinned ${shop} ${w} strict`).toEqual(Object.entries(PINNED_STRICT[shop]).filter(([, ws]) => ws.includes(w)).map(([text]) => `${text} :: OVERLAP_PROTECTED_OFFSCREEN`).sort());
          strictCodes.push(`${w}:${codes.strict!.join(",") || "-"}`);
          if (fonts === "installed") cprime[shop]![w] = codes.cprime!;
        }
        console.log(`DEV-173 strict ${fonts} ${shop}: ${strictCodes.join(" ")}`);
        // C′ fails at every checked width (its own layering reaches text somewhere at each)
        if (fonts === "installed") expect(Object.values(cprime[shop]!).every((c) => c.length > 0), shop).toBe(true);
      }
  }, 2_400_000);

  const strictSweeps: Partial<Record<ShopKey, OverlapSweep>> = {};

  it("the 1px sweep 320–1920: the layer pages give exactly the strict pages' codes at every width, both computed here (stepped root; real resizes agree at the breakpoints and ends)", async () => {
    for (const shop of SHOP_KEYS) {
      const strict = await overlapSweep(browser, overlapPage(shop, "strict"), shopPlan(shop), 320, 1920, open, "stepped");
      const layer = await overlapSweep(browser, overlapPage(shop, "layer"), shopPlan(shop, { grammar: true }), 320, 1920, open, "stepped");
      strictSweeps[shop] = strict;
      console.log(`DEV-173 sweep ${shop}: strict ${JSON.stringify(sweepRanges(strict))} ${strict.ms}ms, layer ${JSON.stringify(sweepRanges(layer))} ${layer.ms}ms`);
      expect(strict.measured).toBe(1601);
      expect(layer.measured).toBe(1601);
      expect(layer.failing, shop).toEqual(strict.failing);
      for (const [a, b] of [[320, 330], [595, 606], [1195, 1205], [1355, 1365], [1910, 1920]] as const) {
        const real = await overlapSweep(browser, overlapPage(shop, "layer"), shopPlan(shop, { grammar: true }), a, b, open, "real");
        expect(real.failing, `${shop} ${a}–${b}`).toEqual(layer.failing.filter((f) => f.w >= a && f.w <= b));
      }
    }
  }, 2_400_000);

  it("the strict sweep's ranges hold at their edges with real resizes (the stepped root and the real viewport agree where the codes change)", async () => {
    for (const shop of SHOP_KEYS) {
      const strict = strictSweeps[shop];
      expect(strict, "the sweep test ran first").toBeDefined();
      const failing = new Map(strict!.failing.map((f) => [f.w, f.codes.join(",")]));
      // every width whose codes differ from the width before (the range edges), checked with its neighbour
      const edges: number[] = [];
      for (let w = 321; w <= 1920; w++) if ((failing.get(w) ?? "") !== (failing.get(w - 1) ?? "")) edges.push(w);
      for (const e of edges.slice(0, 16)) {
        const lo = e - 1;
        const hi = e;
        const real = await overlapSweep(browser, overlapPage(shop, "strict"), shopPlan(shop), lo, hi, open, "real");
        expect(real.failing, `${shop} ${e}`).toEqual(strict!.failing.filter((f) => f.w >= lo && f.w <= hi));
      }
    }
  });

  it("C′ between the checked widths: on sento's C′ page the 1px sweep finds the surface board over the bath fact in a narrow band that no checked width hits", async () => {
    const sento = overlapPage("sento", "cprime");
    // a window around the band measured here (1260–1262) and on CI (1271–1275, with the first glyph boxes); the band is
    // computed, not pinned: it moves with the fonts installed. (The first version also reported the ghost 沸く on the
    // fire fact at 861–885: that came from glyph boxes larger than the ink, and is gone with ink boxes; the picture shows
    // the outline clear of the fact.)
    for (const [from, to, code] of [[1230, 1310, "OVERLAP_PAINT_ABOVE_PROTECTED"]] as const) {
      const s = await overlapSweep(browser, sento, shopPlan("sento"), from, to, open, "real");
      const band = s.failing.filter((f) => f.codes.some((c) => c.endsWith(` :: ${code}`))).map((f) => f.w);
      console.log(`DEV-173 sento C′ ${code} in ${from}–${to}: ${widthRanges(band) || "none"}`);
      expect(band.length, `${code} ${from}–${to}`).toBeGreaterThan(0);
      expect(band.length, "narrow").toBeLessThanOrEqual(40);
      expect(band.some((w) => (CHECKED as readonly number[]).includes(w)), "no checked width in the band").toBe(false);
    }
    for (const w of CHECKED) {
      const o = await openCompPage(browser, sento, { width: w, height: 900, scale: 1, mobile: w <= 390 });
      try {
        const c = overlapCodes(await overlapScan(o.page, shopPlan("sento")));
        expect(c.includes("OVERLAP_PAINT_ABOVE_PROTECTED"), String(w)).toBe(false);
      } finally {
        await o.context.close();
      }
    }
  });

  it("glyph boxes that miss the ink fail closed: tsugute C′'s vertical words drawn from a Latin face with a CJK fallback (as on CI, where IPAMincho is absent) — the geometry names them unmeasured, the pixels find ink outside every box", async () => {
    const p = overlapPage("tsugute", "cprime");
    const remapped = { ...p, css: `${["IPAMincho", "IPA明朝", "IPAPMincho"].map((f) => `@font-face { font-family: "${f}"; src: local("Liberation Serif"); }`).join("\n")}\n${p.css}` };
    for (const w of [1440, 390]) {
      let o = await openCompPage(browser, remapped, { width: w, height: 900, scale: 1, mobile: w <= 390 });
      try {
        const s = await overlapScan(o.page, shopPlan("tsugute"), { glyphs: true });
        const unmeasured = (s.glyphs ?? []).filter((g) => g.codes.some((c) => c.endsWith("GLYPHS_UNMEASURED"))).map((g) => g.text);
        expect(unmeasured, String(w)).toContain("つぐ手");
      } finally {
        await o.context.close();
      }
      o = await openCompPage(browser, remapped, { width: w, height: 900, scale: 1, mobile: w <= 390 });
      try {
        const px = await pixelPass(o.page, shopPlan("tsugute"));
        expect(Object.keys(px.codes), String(w)).toContain("PIXEL_INK_OUTSIDE_GLYPHS");
        expect(px.disagreements).toEqual([]);
      } finally {
        await o.context.close();
      }
    }
  });

  it("the pixel pass at 1440 / 768 / 390: strict and layer show no cover; text by text, every text the pixels see covered on C′ is named by a geometric code that means a cover", async () => {
    for (const shop of SHOP_KEYS)
      for (const w of [1440, 768, 390]) {
        const res: Record<string, string[]> = {};
        for (const v of ["strict", "layer", "cprime"] as const) {
          const o = await openCompPage(browser, overlapPage(shop, v), { width: w, height: 900, scale: 1, mobile: w <= 390 });
          try {
            const px = await pixelPass(o.page, shopPlan(shop));
            res[v] = Object.keys(px.codes).sort();
            res[`${v}Covered`] = px.coveredTexts;
            expect(px.disagreements, `${shop} ${v} ${w}`).toEqual([]);
          } finally {
            await o.context.close();
          }
        }
        console.log(`DEV-173 pixel ${shop} ${w}: ${JSON.stringify(res)}`);
        expect(res.strict!.filter((c) => c.startsWith("PIXEL_COVER")), `${shop} ${w}`).toEqual([]);
        expect(res.layer!.filter((c) => c.startsWith("PIXEL_COVER")), `${shop} ${w}`).toEqual([]);
        // the glyph boxes hold every pixel of text ink the page draws (strict and layer have horizontal text only)
        expect(res.strict!.concat(res.layer!).filter((c) => c === "PIXEL_INK_OUTSIDE_GLYPHS"), `${shop} ${w} ink outside`).toEqual([]);
      }
  }, 2_400_000);
});
