import type { Browser, BrowserContext, Page } from "playwright";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cssProblems, htmlSourceProblems } from "@/lib/design-agent/comp-impl/page";
import type { PageCssOptions } from "@/lib/design-agent/comp-impl/page-css";
import { paletteCheck, widthRanges } from "@/lib/design-agent/comp-impl/checks";
import { phaseBCodes, gradientProblems, type PhaseBScan } from "@/lib/design-agent/comp-impl/phase-b";
import { compMeasure, displaySweepPass, openCompPage, pageWidths, phaseBScan } from "@/lib/design-agent/comp-impl/render";
import { APPROVED_CAPABILITIES, pageCssOptionsOf, type CompSpec } from "@/lib/design-agent/comp-impl/spec";
import { contrastRatio, luminance } from "@/lib/design-agent/comp-impl/verify";
import { POC_DISCLOSURE } from "@/lib/design-agent/design-image/prompt";
import { launch } from "./support";
import { allCodes, NOWRAP_WIDTHS, rawDoc, SHOPS, shopFacts, widthCodes, type ShopKey } from "./nowrap-harness";
import { cPrimeCss, gradientDeclarations, gradPage, SENTO_BAR, SENTO_LIQUID, TSUGUTE_GOLD } from "./gradient-harness";

// DEV-172 (Issue #193 comment 6628165899): the safety verification of gradient_ground
// (docs/design/gradient-ground-decision.md). The capability stays OFF: APPROVED_CAPABILITIES is empty and these tests turn
// the flag on only in their own calls (cssProblems, phaseBScan, displaySweepPass), as phase-b.test.ts, display-nowrap.test.ts
// and display-scale.test.ts do. They hold, against the production checker (page-css.ts, phase-b.ts through render.ts):
// 1. flag off: every gradient form, on every property and through every indirection, is refused by the grammar;
// 2. flag on: only one linear / radial gradient of 2–8 opaque stops in background / background-image passes; every
//    non-opaque stop, other form, sizing / positioning property and url() is still refused;
// 3. text is never on a gradient: a ground that holds text or meets a text line fails (GROUND_HAS_TEXT / _UNDER_TEXT) at
//    every width, whatever its contrast, for facts, small text and display words alike; contrast is NOT what decides;
// 4. the stop rule (GRADIENT_HARD_STOP / _TOO_STEEP) is exact at its edges, judges every gradient, and fails closed
//    (GRADIENT_UNMEASURED) on any form it cannot read; the 1px sweep finds width-dependent failures between checked widths;
// 5. the three shops: what ON gives (sento's thermometer and heat bar, tsugute's bowls), what it refuses (every C′ gradient
//    with text on it), and what the stop rule says about C′'s own colours.

vi.setConfig({ testTimeout: 600_000, hookTimeout: 300_000 });

const ON: PageCssOptions = { gradientGround: true };
const ONC: PageCssOptions = { gradientGround: true, colourSyntax: true };
const OFF: PageCssOptions = {};
const SHOP_KEYS = Object.keys(SHOPS) as ShopKey[];

let browser: Browser;
let raw: BrowserContext;
let tab: Page;
beforeAll(async () => {
  browser = await launch();
  raw = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await raw.route("**/*", (route) => route.abort());
  tab = await raw.newPage();
});
afterAll(async () => {
  await raw?.close();
  await browser?.close();
});

const BASE = 'body { margin: 0; font-family: "IPAGothic", sans-serif; font-size: 16px; line-height: 1.5; color: #1F1D1B; }';
/** Phase B scan of a raw body at a width (the allowlist is NOT applied: raw HTML can do what the allowlist refuses). */
async function scan(body: string, css: string, o: { width?: number; css?: PageCssOptions; words?: readonly string[] } = {}): Promise<PhaseBScan> {
  await tab.setViewportSize({ width: o.width ?? 1440, height: 900 });
  await tab.setContent(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>${BASE}\n${css}</style></head><body>${body}</body></html>`);
  return phaseBScan(tab, { css: o.css ?? ON, displayWords: o.words ?? [] });
}
const codes = async (body: string, css: string, o: { width?: number; css?: PageCssOptions; words?: readonly string[] } = {}) => phaseBCodes(await scan(body, css, o));
const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
const contrast = (a: string, b: string) => contrastRatio(luminance(hex(a)), luminance(hex(b)));
/** The 1px sweep of a page with a capability on; never PHASE_B_UNMEASURED. Codes by width. */
async function sweep(page: ReturnType<typeof rawDoc>, css: PageCssOptions = ON, words: readonly string[] = []) {
  const s = (await displaySweepPass(browser, page, { css, displayWords: words }))!;
  expect(s.failing.some((f) => f.codes.includes("PHASE_B_UNMEASURED"))).toBe(false);
  const by = (code: string) => s.failing.filter((f) => f.codes.includes(code)).map((f) => f.w);
  return { s, by };
}
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

// ---------------------------------------------------------------- the grammar

/** Gradient forms the grammar refuses with every flag (off, gradient_ground, gradient_ground + colour_syntax), with the code. */
const NEVER: Array<[string, string]> = [
  // other gradient functions and forms
  ["background: repeating-linear-gradient(#000, #fff)", "CSS_VALUE"],
  ["background: repeating-radial-gradient(#000, #fff)", "CSS_VALUE"],
  ["background: conic-gradient(#000, #fff)", "CSS_VALUE"],
  ["background: repeating-conic-gradient(#000 0 10%, #fff 0 20%)", "CSS_VALUE"],
  ["background: -webkit-linear-gradient(#000, #fff)", "CSS_VALUE"],
  ["background: -webkit-gradient(linear, left top, left bottom, from(#000), to(#fff))", "CSS_VALUE"],
  ["background: radial-gradient(circle at 50% 50%, #000, #fff)", "CSS_VALUE"],
  ["background: radial-gradient(closest-side, #000, #fff)", "CSS_VALUE"],
  ["background: radial-gradient(40px, #000, #fff)", "CSS_VALUE"],
  ["background: radial-gradient(60% 45% at 35% 30%, #000, #fff)", "CSS_VALUE"],
  ["background: linear-gradient(in oklab, #000, #fff)", "CSS_VALUE"],
  ["background: linear-gradient(to right in oklab, #000, #fff)", "CSS_VALUE"],
  ["background: linear-gradient(in hsl longer hue, #f00, #00f)", "CSS_VALUE"],
  ["background: linear-gradient(1rad, #000, #fff)", "CSS_VALUE"],
  ["background: linear-gradient(100grad, #000, #fff)", "CSS_VALUE"],
  ["background: linear-gradient(calc(45deg), #000, #fff)", "CSS_VALUE"],
  ["background: linear-gradient(to left left, #000, #fff)", "CSS_VALUE"],
  // stop positions: px, two positions, hints, calc, outside 0–100 %
  ["background: linear-gradient(#000 10px, #fff)", "CSS_VALUE"],
  ["background: linear-gradient(#000 10% 20%, #fff)", "CSS_VALUE"],
  ["background: linear-gradient(#000, 30%, #fff)", "CSS_VALUE"],
  ["background: linear-gradient(#000 calc(10%), #fff)", "CSS_VALUE"],
  ["background: linear-gradient(#000 -10%, #fff)", "CSS_VALUE"],
  ["background: linear-gradient(#000, #fff 120%)", "CSS_VALUE"],
  // stop count and layers
  ["background: linear-gradient(#000)", "CSS_VALUE"],
  ["background: linear-gradient(#000, #111, #222, #333, #444, #555, #666, #777, #888)", "CSS_VALUE"],
  ["background: linear-gradient(#000, #fff), linear-gradient(#fff, #000)", "CSS_VALUE"],
  ["background: linear-gradient(#000, #fff) #fff", "CSS_VALUE"],
  ["background: linear-gradient(#000, #fff) 0 0 / 10px 10px", "CSS_VALUE"],
  // non-opaque or indirect stop colours
  ["background: linear-gradient(transparent, #fff)", "CSS_VALUE"],
  ["background: linear-gradient(currentcolor, #fff)", "CSS_VALUE"],
  ["background: linear-gradient(currentColor, #fff)", "CSS_VALUE"],
  ["background: linear-gradient(#0000, #fff)", "CSS_VALUE"],
  ["background: linear-gradient(#000e, #fff)", "CSS_VALUE"],
  ["background: linear-gradient(#00000080, #fff)", "CSS_VALUE"],
  ["background: linear-gradient(#000000fe, #fff)", "CSS_VALUE"],
  ["background: linear-gradient(rgba(0, 0, 0, .99), #fff)", "CSS_VALUE"],
  ["background: linear-gradient(rgb(0 0 0 / 0.5), #fff)", "CSS_VALUE"],
  ["background: linear-gradient(rgb(0 0 0 / 99%), #fff)", "CSS_VALUE"],
  ["background: linear-gradient(hsl(0 0% 0% / .5), #fff)", "CSS_VALUE"],
  ["background: linear-gradient(hsla(0, 0%, 0%, .5), #fff)", "CSS_VALUE"],
  ["background: linear-gradient(oklch(0.5 0.1 30 / .5), #fff)", "CSS_VALUE"],
  ["background: linear-gradient(rgb(from #f00 r g b), #fff)", "CSS_VALUE"],
  ["background: linear-gradient(rgb(from #f00 r g b / .5), #fff)", "CSS_VALUE"],
  ["background: linear-gradient(color-mix(in srgb, #f00, #00f), #fff)", "CSS_VALUE"],
  ["background: linear-gradient(color(srgb 0 0 0), #fff)", "CSS_VALUE"],
  ["background: linear-gradient(light-dark(#000, #fff), #fff)", "CSS_VALUE"],
  ["background: linear-gradient(Canvas, #fff)", "CSS_VALUE"],
  ["background: linear-gradient(CanvasText, #fff)", "CSS_VALUE"],
  ["background: linear-gradient(var(--c), #fff)", "CSS_VALUE"],
  ["background: linear-gradient(rgb(var(--r), 0, 0), #fff)", "CSS_VALUE"],
  ["background: linear-gradient(calc(1) 0 0, #fff)", "CSS_VALUE"],
  // indirections and image functions
  ["background: var(--g)", "CSS_VALUE"],
  ["background-image: var(--g)", "CSS_PROPERTY|CSS_VALUE"], // off: the property itself is not in the table
  ["background: image-set(linear-gradient(#000, #fff) 1x)", "CSS_VALUE"],
  ["background: -webkit-image-set(linear-gradient(#000, #fff) 1x)", "CSS_VALUE"],
  ['background: image-set("a.png" 1x)', "CSS_VALUE"],
  ["background: cross-fade(linear-gradient(#000, #fff), linear-gradient(#fff, #000), 50%)", "CSS_VALUE"],
  ["background: -webkit-cross-fade(linear-gradient(#000, #fff), linear-gradient(#fff, #000), 50%)", "CSS_VALUE"],
  ["background: element(#a)", "CSS_VALUE"],
  ["background: -moz-element(#a)", "CSS_VALUE"],
  ["background: paint(x)", "CSS_VALUE"],
  ['background: src("a.png")', "CSS_VALUE"],
  ["background: attr(data-g)", "CSS_VALUE"],
  // other properties that take an image
  ["border-image: linear-gradient(#000, #fff) 1", "CSS_PROPERTY"],
  ["border-image-source: linear-gradient(#000, #fff)", "CSS_PROPERTY"],
  ["mask: linear-gradient(#000, #fff)", "CSS_PROPERTY"],
  ["mask-image: linear-gradient(#000, #fff)", "CSS_PROPERTY"],
  ["-webkit-mask-image: linear-gradient(#000, #fff)", "CSS_PROPERTY"],
  ["-webkit-mask-box-image: linear-gradient(#000, #fff)", "CSS_PROPERTY"],
  ["list-style-image: linear-gradient(#000, #fff)", "CSS_PROPERTY"],
  ["list-style: linear-gradient(#000, #fff)", "CSS_VALUE"],
  ["content: linear-gradient(#000, #fff)", "CSS_PROPERTY"],
  ["shape-outside: linear-gradient(#000, #fff)", "CSS_PROPERTY"],
  ["-webkit-box-reflect: below 0 linear-gradient(#000, #fff)", "CSS_PROPERTY"],
  ["cursor: linear-gradient(#000, #fff), auto", "CSS_PROPERTY"],
  ["--g: linear-gradient(#000, #fff)", "CSS_PROPERTY"],
  // what would change the gradient's geometry or let it paint text
  ["background-size: 10px 10px", "CSS_PROPERTY"],
  ["background-repeat: repeat", "CSS_PROPERTY"],
  ["background-position: 0 0", "CSS_PROPERTY"],
  ["background-attachment: fixed", "CSS_PROPERTY"],
  ["background-origin: content-box", "CSS_PROPERTY"],
  ["background-clip: text", "CSS_PROPERTY"],
  ["-webkit-background-clip: text", "CSS_PROPERTY"],
  ["background-blend-mode: multiply", "CSS_PROPERTY"],
  ["-webkit-text-fill-color: transparent", "CSS_PROPERTY"],
  ["mix-blend-mode: multiply", "CSS_PROPERTY"],
  // network: url() never gets past the tokenizer
  ["background: url(a.png)", "CSS_SYNTAX_URL"],
  ["background-image: url(https://example.invalid/a.png)", "CSS_SYNTAX_URL"],
  ['background: linear-gradient(#000, #fff), url("a.png")', "CSS_SYNTAX_URL"],
];

/** Passes with gradient_ground alone (and with colour_syntax too). */
const ALLOWED_ON = [
  "background: linear-gradient(#000, #fff)",
  "background-image: linear-gradient(#000, #fff)",
  "background: linear-gradient(to right, #000, #fff 40%)",
  "background: linear-gradient(to top left, #000, #fff)",
  "background: linear-gradient(45deg, #000, #fff)",
  "background: linear-gradient(-360deg, #000, #fff)",
  "background: linear-gradient(0.25turn, #000, #fff)",
  "background: radial-gradient(circle, #000, #fff)",
  "background: radial-gradient(ellipse, #000 0%, #fff 100%)",
  "background: linear-gradient(#000, #111, #222, #333, #444, #555, #666, #777)",
  "background: linear-gradient(#000f, #000000ff, white, black)",
  "background: linear-gradient(rgb(0, 0, 0), rgba(0, 0, 0, 1), rgba(0, 0, 0, 100%), rgb(0 0 0 / 1))",
  `background: ${SENTO_BAR}`,
  ...Object.values(SENTO_LIQUID).map((g) => `background: ${g}`),
];
/** Pass only with colour_syntax as well (named, hsl, oklch, oklab without alpha below 1). */
const ALLOWED_ONC = ["background: linear-gradient(red, #fff)", "background: linear-gradient(hsl(0 0% 0%), hsla(0, 0%, 0%, 1))", "background: linear-gradient(oklch(0.5 0.1 30), oklab(0.5 0.1 0.1))", "background: linear-gradient(rebeccapurple, oklch(0.5 0.1 30 / 1))"];

describe("DEV-172 gradient_ground stays OFF", () => {
  it("approves nothing and turns the flag on for no spec", () => {
    expect(APPROVED_CAPABILITIES).toEqual([]);
    expect(pageCssOptionsOf({ capabilities: ["gradient_ground"] })).toEqual({});
    expect(pageCssOptionsOf({ capabilities: ["gradient_ground", "colour_syntax", "translucent_decoration"] })).toEqual({});
  });

  it("with the flag off, the 1px sweep does not run and every gradient the flag would allow is refused (CSS_VALUE / CSS_PROPERTY)", async () => {
    expect(await displaySweepPass(browser, rawDoc('<div class="g"></div>', "body { margin: 0; } .g { height: 40px; }"), { css: OFF, displayWords: [] })).toBeNull();
    for (const d of [...ALLOWED_ON, ...ALLOWED_ONC]) {
      const p = cssProblems(`.x { ${d}; }`);
      expect(p.length, d).toBeGreaterThan(0);
      expect(p.every((c) => c === "CSS_VALUE" || c === "CSS_PROPERTY"), d).toBe(true);
    }
  });

  it.each([
    ["OFF", OFF],
    ["gradient_ground", ON],
    ["gradient_ground + colour_syntax", ONC],
  ] as const)("every other gradient form, image function, image property, sizing property and url() is refused (%s)", (_, opts) => {
    for (const [d, code] of NEVER) {
      const p = cssProblems(`.x { ${d}; }`, opts);
      expect(code.split("|").some((c) => p.includes(c)), `${d}: ${p.join(" ")}`).toBe(true);
    }
    expect(NEVER.length).toBeGreaterThanOrEqual(85);
  });

  it("the HTML around the stylesheet: no style attribute, no style element, no svg gradient, no data: or external URL", () => {
    const g = "background: linear-gradient(#000, #fff)";
    expect(htmlSourceProblems(`<div style="${g}"></div>`)).toContain("HTML_INLINE_STYLE");
    expect(htmlSourceProblems(`<style>.x { ${g} }</style>`)).toContain("HTML_INLINE_STYLE");
    expect(htmlSourceProblems('<svg><linearGradient id="a"><stop offset="0"/></linearGradient></svg>')).toContain("HTML_ELEMENT");
    expect(htmlSourceProblems('<img src="data:image/svg+xml,x" alt="">')).toContain("HTML_URL_SCHEME");
    expect(htmlSourceProblems('<link rel="stylesheet" href="https://example.invalid/a.css">')).toContain("HTML_EXTERNAL_URL");
    for (const o of [OFF, ON, ONC]) {
      expect(cssProblems('@import "a.css";', o)).toContain("CSS_AT_RULE");
      expect(cssProblems(".x { background: u\\72l(a.png); }", o).some((c) => c.startsWith("CSS_SYNTAX"))).toBe(true);
    }
  });
});

describe("DEV-172 gradient_ground ON: the grammar", () => {
  it("passes one linear / radial gradient of 2–8 opaque stops in background or background-image; colour_syntax adds named, hsl, oklch, oklab", () => {
    for (const d of ALLOWED_ON) {
      expect(cssProblems(`.x { ${d}; }`, ON), d).toEqual([]);
      expect(cssProblems(`.x { ${d}; }`, ONC), d).toEqual([]);
    }
    for (const d of ALLOWED_ONC) {
      expect(cssProblems(`.x { ${d}; }`, ON), d).toEqual(["CSS_VALUE"]);
      expect(cssProblems(`.x { ${d}; }`, ONC), d).toEqual([]);
    }
    expect(cssProblems(".x { background: #fff; background-image: none; }", ON)).toEqual([]);
  });

  it("the grammar does not know roles: with the flag a fact's selector, body, html and * take a gradient too (only the render keeps it off text)", () => {
    for (const sel of [".address-fact", "dd", "p", "h1", "body", "html", "*", "main section:first-child"]) expect(cssProblems(`${sel} { background: linear-gradient(#000, #fff); }`, ON), sel).toEqual([]);
    expect(cssProblems("p::before { background: linear-gradient(#000, #fff); }", ON)).toContain("CSS_PSEUDO_ELEMENT");
  });

  it("network: a page with a url() ground (raw HTML, past the allowlist) fetches nothing and its ground is unmeasured", async () => {
    const page = rawDoc('<div class="g"></div><p>文字</p>', "body { margin: 0; } .g { height: 200px; background-image: url(https://example.invalid/a.png), linear-gradient(#000, #fff); }");
    const o = await openCompPage(browser, page, { width: 1440, height: 900, scale: 1, mobile: false });
    try {
      expect(o.blocked()).toBeGreaterThan(0);
      expect(phaseBCodes(await phaseBScan(o.page, { css: ON, displayWords: [] }))).toEqual(["GRADIENT_UNMEASURED"]);
    } finally {
      await o.context.close();
    }
  });
});

// ---------------------------------------------------------------- text and grounds

describe("DEV-172 gradient_ground ON: text is never on a gradient", () => {
  const { name, facts, words } = shopFacts("sento");
  const G = "linear-gradient(#ffffff, #f6f1e7)"; // two light stops: dark text on it would have ample contrast everywhere

  it.each([
    ["a fact paragraph", `<p class="g">${facts.address}</p>`],
    ["a dd", `<dl><dt>住所</dt><dd class="g">${facts.address}</dd></dl>`],
    ["the disclosure", `<p class="g" data-comp-disclosure>${POC_DISCLOSURE}</p>`],
    ["12px text", `<small class="g" style="font-size: 12px">${facts.hours}</small>`],
    ["a display word (the full shop name) at 200px", `<h1 class="g" style="font-size: 200px">${name}</h1>`],
    ["a section holding text", `<section class="g"><div><p>${facts.phone}</p></div></section>`],
    ["body", `<p>${facts.phone}</p>`],
    ["an empty box with an aria-label", '<div class="g" aria-label="熱い"></div>'],
    ["an image with an alt", '<img class="g" alt="湯船" width="40" height="40">'],
    ["a box around an image with an alt", '<div class="g"><img alt="湯船" width="40" height="40"></div>'],
  ])("GROUND_HAS_TEXT: a gradient on %s", async (label, body) => {
    const css = label === "body" ? `body { background: ${G}; }` : `.g { display: block; background: ${G}; }`;
    for (const o of [ON, { ...ON, displayScale: true, displayNowrap: true }, ONC]) expect(await codes(body, css, { css: o, words }), label).toContain("GROUND_HAS_TEXT");
  });

  it("text-free boxes are grounds: an empty div, hr, an aria-hidden div, an image with an empty alt", async () => {
    for (const body of ['<div class="g"></div>', '<hr class="g">', '<div class="g" aria-hidden="true"><div></div></div>', '<img class="g" alt="" width="40" height="40">']) {
      expect(await codes(`<p>${facts.phone}</p>${body}<p style="margin-top: 40px">${facts.address}</p>`, `.g { display: block; height: 30px; border: 0; margin: 20px 0; background: ${G}; }`), body).toEqual([]);
    }
  });

  it("GROUND_UNDER_TEXT at the edge: a text-free ground 1px into a text line fails; touching it, or less than 0.5px into it, passes", async () => {
    await scan(`<p class="t">${facts.address}</p>`, ".t { margin: 0; }");
    const bottom = (await tab.evaluate(`(() => { const r = document.createRange(); r.selectNodeContents(document.querySelector(".t").firstChild); return Math.max(...Array.from(r.getClientRects()).map((x) => x.bottom)); })()`)) as number;
    const at = (top: number) => codes(`<p class="t">${facts.address}</p><div class="g"></div>`, `.t { margin: 0; } .g { position: absolute; left: 0; width: 600px; height: 50px; top: ${top}px; background: ${G}; }`);
    expect(await at(bottom - 1)).toEqual(["GROUND_UNDER_TEXT"]);
    expect(await at(bottom - 0.6)).toEqual(["GROUND_UNDER_TEXT"]);
    expect(await at(bottom - 0.4)).toEqual([]);
    expect(await at(bottom)).toEqual([]);
    console.log(`DEV-172 ground edge: text bottom ${bottom}px; 1px and 0.6px into it fail, 0.4px and touching pass`);
  });

  it("GROUND_UNDER_TEXT counts the whole border box: an empty inline span whose vertical padding reaches the next line fails", async () => {
    expect(await codes(`<p class="a">${facts.hours}</p><p>あ<span class="g"></span>い</p><p class="a">${facts.phone}</p>`, `p { margin: 0; } .g { padding: 30px 8px; background: ${G}; }`)).toEqual(["GROUND_UNDER_TEXT"]);
    expect(await codes(`<p>あ<span class="g"></span>い</p>`, "p { margin: 40px 0; } .g { padding: 0 30px; background: linear-gradient(to right, #ffffff, #f6f1e7); }")).toEqual([]);
  });

  it("contrast is not what decides: C′'s gold band under 金を蒔いて (its dark end fails 4.5:1) and the same text on two light stops both fail at every width of 320–1920", async () => {
    const ink = "#1d1915";
    expect(contrast(ink, "#8c6524")).toBeLessThan(4.5); // C′'s dark end: the comment in C′ says 3.7:1
    expect(contrast(ink, "#f1d68f")).toBeGreaterThan(4.5);
    expect(contrast(ink, "#f6f1e7")).toBeGreaterThan(4.5);
    for (const g of [TSUGUTE_GOLD, G]) {
      const page = rawDoc('<div class="cut-kin"><p>金を蒔いて</p></div>', `body { margin: 0; color: ${ink}; } .cut-kin { margin: 0 16px; padding: 12px 0; background: ${g}; }`);
      expect(cssProblems(page.css, ON)).toEqual([]);
      const { s, by } = await sweep(page);
      expect(by("GROUND_HAS_TEXT")).toEqual(range(320, 1920));
      console.log(`DEV-172 text on ${g.slice(0, 40)}…: sweep fails ${widthRanges(s.failing.map((f) => f.w))}`);
    }
  });

  it("text that reaches a gradient only at some widths fails exactly there (an independent overlap oracle), whether its glyphs land on the failing or the passing end", async () => {
    // a fixed-height copy box: its text overflows below it when it wraps to a third line, onto a text-free band whose
    // left end (#8c6524) fails 4.5:1 with the ink and whose right end (#f1d68f) passes. Left-aligned text overflows onto
    // the left end, right-aligned onto the right end. Allowlisted CSS: text-align, height and the gradient.
    const ink = "#1d1915";
    for (const align of ["left", "right"]) {
      const css = `body { margin: 0; color: ${ink}; } .copy { margin: 0 16px; height: 60px; font-size: 20px; line-height: 1.5; text-align: ${align}; } .band { margin: 0 16px; height: 80px; background: linear-gradient(to right, #8c6524, #f1d68f); }`;
      expect(cssProblems(css, ON)).toEqual([]);
      const page = rawDoc(`<p class="copy">${facts.address}、${facts.access}。${facts.hours}</p><div class="band"></div>`, css);
      // the oracle: step the root's width like the sweep and intersect every text line with the band (own code, not the checker's)
      const o = await openCompPage(browser, page, { width: 1920, height: 900, scale: 1, mobile: false });
      let oracle: Array<{ w: number; xs: number[] }>;
      try {
        oracle = (await o.page.evaluate(`(() => {
          const html = document.documentElement;
          html.style.setProperty("margin", "0", "important");
          const band = document.querySelector(".band");
          const out = [];
          for (let w = 320; w <= 1920; w++) {
            html.style.setProperty("width", w + "px", "important");
            const b = band.getBoundingClientRect();
            const r = document.createRange();
            r.selectNodeContents(document.querySelector(".copy").firstChild);
            const hit = Array.from(r.getClientRects()).filter((x) => x.width > 0.5 && x.height > 0.5 && Math.min(x.bottom, b.bottom) - Math.max(x.top, b.top) > 0.5);
            if (hit.length) out.push({ w, xs: hit.map((x) => ((x.left + x.right) / 2 - b.left) / b.width) });
          }
          return out;
        })()`)) as Array<{ w: number; xs: number[] }>;
      } finally {
        await o.context.close();
      }
      const { by } = await sweep(page);
      const failing = by("GROUND_UNDER_TEXT");
      expect(failing.length).toBeGreaterThan(50);
      expect(failing).toEqual(oracle.map((x) => x.w));
      const side = align === "left" ? oracle.every((x) => x.xs.every((f) => f < 0.5)) : oracle.every((x) => x.xs.every((f) => f > 0.5));
      expect(side, `${align}: the overflowing line sits on the ${align} half of the band`).toBe(true);
      console.log(`DEV-172 overflow onto the band (${align}): GROUND_UNDER_TEXT ${widthRanges(failing)} = the oracle (${oracle.length} widths)`);
    }
  });

  it("the run's contrast data does not read gradients: the ground image is counted, its colours are not (palette check)", async () => {
    // documented gap for design fidelity (not text safety: no text may sit on it): gradient stops are outside the palette check
    await scan('<div class="g"></div><p>文字</p>', ".g { height: 100px; background: linear-gradient(#00ff00, #ff00ff); }");
    const m = await compMeasure(tab);
    const r = paletteCheck(m, { palette: [{ name: "ink", hex: "#1F1D1B", role: "text" }, { name: "paper", hex: "#FFFFFF", role: "ground" }] } as unknown as CompSpec);
    expect(r.codes).toEqual([]);
    expect(r).toMatchObject({ background_images: 1 });
  });
});

// ---------------------------------------------------------------- the stop rule

describe("DEV-172 gradient_ground ON: the stop rule", () => {
  const band = (g: string, w: number, h: number) => codes('<div class="g"></div><p>文字</p>', `.g { width: ${w}px; height: ${h}px; background: ${g}; }`);

  it("GRADIENT_TOO_STEEP at the edge (2 levels per px): black to white needs 128px; 127px fails, in every direction form", async () => {
    expect(await band("linear-gradient(#000, #fff)", 300, 128)).toEqual([]);
    expect(await band("linear-gradient(#000, #fff)", 300, 127)).toEqual(["GRADIENT_TOO_STEEP"]);
    expect(await band("linear-gradient(to right, #000, #fff)", 128, 40)).toEqual([]);
    expect(await band("linear-gradient(to right, #000, #fff)", 127, 40)).toEqual(["GRADIENT_TOO_STEEP"]);
    expect(await band("linear-gradient(90deg, #000, #fff)", 127, 40)).toEqual(["GRADIENT_TOO_STEEP"]);
    expect(await band("linear-gradient(0.25turn, #000, #fff)", 128, 40)).toEqual([]);
    // 45deg on a square: the line is w·sin + h·cos = 1.414·side: 91px → 128.7 passes, 90px → 127.3 fails
    expect(await band("linear-gradient(45deg, #000, #fff)", 91, 91)).toEqual([]);
    expect(await band("linear-gradient(45deg, #000, #fff)", 90, 90)).toEqual(["GRADIENT_TOO_STEEP"]);
  });

  it("the line is measured short where it is not exact (stricter than the drawing): a corner takes min(w, h), a radial min(w, h) / 2", async () => {
    // to bottom right on 600×130: the drawn line is about 254px (black to white would pass); the rule takes 130
    expect(await band("linear-gradient(to bottom right, #000, #fff)", 600, 130)).toEqual([]);
    expect(await band("linear-gradient(to bottom right, #000, #fff)", 600, 120)).toEqual(["GRADIENT_TOO_STEEP"]);
    expect(await band("radial-gradient(circle, #000, #fff)", 600, 256)).toEqual([]);
    expect(await band("radial-gradient(circle, #000, #fff)", 600, 254)).toEqual(["GRADIENT_TOO_STEEP"]);
  });

  it("GRADIENT_HARD_STOP at the edge: adjacent stops need 24px and 10% of the line; a step with no colour change is free", async () => {
    // 300px: 10% = 30px
    expect(await band("linear-gradient(#000, #101010 10%, #202020)", 40, 300)).toEqual([]);
    expect(await band("linear-gradient(#000, #101010 9.9%, #202020)", 40, 300)).toEqual(["GRADIENT_HARD_STOP"]);
    // 200px: 24px = 12%
    expect(await band("linear-gradient(#000, #101010 12%, #202020)", 40, 200)).toEqual([]);
    expect(await band("linear-gradient(#000, #101010 11.9%, #202020)", 40, 200)).toEqual(["GRADIENT_HARD_STOP"]);
    // a hard edge: both codes
    expect(await band("linear-gradient(#000 50%, #fff 50%)", 40, 300)).toEqual(["GRADIENT_HARD_STOP", "GRADIENT_TOO_STEEP"]);
    expect(await band("linear-gradient(#000 50%, #000 50%, #fff)", 40, 300)).toEqual([]);
  });

  it("every gradient is judged: 60 allowlisted bands, the 60th with a hard stop, fails; the stop count is a grammar limit only (the render judges 10 stops; the 10% share caps even stops at 11)", async () => {
    const css = `body { margin: 0; } .b { height: 200px; background: linear-gradient(#000, #101010); } .b:last-child { background: linear-gradient(#000 50%, #fff 50%); }`;
    expect(cssProblems(css, ON)).toEqual([]);
    const s = await scan(`<div>${'<div class="b"></div>'.repeat(60)}</div><p>文字</p>`, css);
    expect(s.gradients.count).toBe(60);
    expect(phaseBCodes(s)).toEqual(["GRADIENT_HARD_STOP", "GRADIENT_TOO_STEEP"]);
    const stops = (n: number) => `linear-gradient(${Array.from({ length: n }, (_, i) => `rgb(${i * 10}, 0, 0)`).join(", ")})`;
    expect(cssProblems(`.x { background: ${stops(10)}; }`, ON)).toEqual(["CSS_VALUE"]);
    expect(await band(stops(10), 40, 1200)).toEqual([]);
    expect(await band(stops(11), 40, 1200)).toEqual([]); // gaps of exactly 10%
    expect(await band(stops(12), 40, 1200)).toEqual(["GRADIENT_HARD_STOP"]); // gaps of 9.1%
  });

  it.each([
    ["conic", "conic-gradient(#000, #fff)"],
    ["repeating linear", "repeating-linear-gradient(#000, #fff 50%)"],
    ["radial with a position", "radial-gradient(circle at 20% 20%, #000, #fff)"],
    ["radial with a size", "radial-gradient(40px, #000, #fff)"],
    ["an interpolation space", "linear-gradient(in oklab, #000, #fff)"],
    ["px stops", "linear-gradient(#000 10px, #fff 200px)"],
    ["a colour hint", "linear-gradient(#000, 30%, #fff)"],
    ["a transparent stop", "linear-gradient(transparent, #fff)"],
    ["an alpha-only change", "linear-gradient(#000, rgb(0 0 0 / 0.02))"],
    ["currentcolor of a translucent text colour", "linear-gradient(currentcolor, #fff)"],
    ["a var() stop holding a translucent colour", "linear-gradient(var(--t), #fff)"],
    ["a 2nd layer that is fine and one that is not", "linear-gradient(#000, #111), conic-gradient(#000, #fff)"],
  ])("GRADIENT_UNMEASURED (fail closed) on a form the rule cannot read: %s (raw HTML)", async (label, g) => {
    expect(await codes('<div class="g"></div><p>文字</p>', `:root { --t: rgba(0, 0, 0, .5); } .g { height: 300px; color: rgba(0, 0, 0, .5); background-image: ${g}; }`), label).toEqual(["GRADIENT_UNMEASURED"]);
  });

  it("what the computed value resolves is measured as drawn (raw HTML): currentcolor, var() and two-position stops", async () => {
    const on = (g: string, extra = "") => codes('<div class="g"></div><p>文字</p>', `:root { --c: #000; } .g { height: 300px; ${extra} background-image: ${g}; }`);
    expect(await on("linear-gradient(currentcolor, #fff)", "color: #000;")).toEqual([]);
    expect(await on("linear-gradient(currentcolor, #fff 10%)", "color: #000;")).toEqual(["GRADIENT_TOO_STEEP"]);
    expect(await on("linear-gradient(var(--c), #fff 10%)")).toEqual(["GRADIENT_TOO_STEEP"]);
    expect(await on("linear-gradient(#000 0% 40%, #fff)")).toEqual([]);
    expect(await on("linear-gradient(#000 0% 50%, #fff 50% 100%)")).toEqual(["GRADIENT_HARD_STOP", "GRADIENT_TOO_STEEP"]);
  });

  it("TS gradientProblems and the page agree on the shops' gradients (3 sizes each)", async () => {
    for (const g of [SENTO_BAR, ...Object.values(SENTO_LIQUID), TSUGUTE_GOLD]) {
      for (const [w, h] of [[40, 418], [1180, 26], [338, 900]] as const) {
        const page = await codes('<div class="g"></div><p>文字</p>', `.g { width: ${w}px; height: ${h}px; background: ${g}; }`);
        const parsed = (await tab.evaluate(`(() => { const s = getComputedStyle(document.querySelector(".g")).backgroundImage; const c = document.createElement("canvas").getContext("2d"); const m = /^linear-gradient\\((.*)\\)$/.exec(s); const parts = m[1].split(/,(?![^(]*\\))/).map((x) => x.trim()); let config = null; if (!/^rgb/.test(parts[0])) config = parts.shift(); return { config, stops: parts.map((p) => { const pm = /^(rgb\\([^)]*\\))(?:\\s+([\\d.]+)%)?$/.exec(p); return { rgb: pm[1].match(/\\d+/g).map(Number), pct: pm[2] ? Number(pm[2]) : null }; }) }; })()`)) as { config: string | null; stops: Array<{ rgb: [number, number, number]; pct: number | null }> };
        expect(page, `${g} ${w}×${h}`).toEqual(gradientProblems({ kind: "linear", config: parsed.config, w, h, stops: parsed.stops }));
      }
    }
  });

  it("colour_syntax + gradient_ground: oklch / oklab stops are drawn through oklab, which the rule (sRGB end points) does not see — a documented gap of a non-safety rule", async () => {
    // the rule compares the stops' sRGB end points and assumes the colour changes linearly between them; Chromium
    // interpolates gradients with oklch / oklab stops in oklab, where an sRGB channel can rise and fall between two stops.
    // Not a text-safety question (no text may sit on any gradient), but the "≤ 2 levels per px" smoothness is not held.
    const slope = async (g: string, w: number) => {
      await scan(`<div class="g"></div><p>文字</p>`, `body { margin: 0; } .g { width: ${w}px; height: 8px; background: ${g}; }`, { css: ONC });
      const got = phaseBCodes(await phaseBScan(tab, { css: ONC, displayWords: [] }));
      const shot = await tab.screenshot({ clip: { x: 0, y: 2, width: w, height: 1 } });
      const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
      let max = 0;
      for (let x = 10; x < w; x++) for (let k = 0; k < 3; k++) max = Math.max(max, Math.abs(data[x * info.channels + k]! - data[(x - 10) * info.channels + k]!) / 10);
      return { got, max };
    };
    const legacy = await slope("linear-gradient(to right, hsl(30 100% 60%), hsl(210 100% 60%))", 300);
    const oklab = await slope("linear-gradient(to right, oklch(0.7 0.2 30), oklch(0.7 0.2 210))", 300);
    expect(cssProblems(".x { background: linear-gradient(to right, oklch(0.7 0.2 30), oklch(0.7 0.2 210)); }", ONC)).toEqual([]);
    expect(legacy.got).toEqual([]);
    expect(legacy.max).toBeLessThanOrEqual(2);
    expect(oklab.got).toEqual([]); // the rule passes it
    expect(oklab.max).toBeGreaterThan(2); // the drawing changes faster than 2 levels per px
    console.log(`DEV-172 oklab gap: hsl stops max 10px slope ${legacy.max.toFixed(2)}/px (rule passes), oklch stops ${oklab.max.toFixed(2)}/px (rule passes)`);
  });
});

// ---------------------------------------------------------------- widths

describe("DEV-172 gradient_ground ON: widths (the 1px sweep)", () => {
  it("percentage stops scale with the box: a 10% step from black to white fails exactly below 1307px (box 1275px) and passes from there", async () => {
    const css = "body { margin: 0; } .g { margin: 0 16px; height: 60px; background: linear-gradient(to right, #000, #fff 10%, #fff); }";
    expect(cssProblems(css, ON)).toEqual([]);
    const page = rawDoc('<div class="g"></div><p>文字</p>', css);
    const { s, by } = await sweep(page);
    expect(by("GRADIENT_TOO_STEEP")).toEqual(range(320, 1306));
    expect(s.failing.flatMap((f) => f.codes).every((c) => c === "GRADIENT_TOO_STEEP")).toBe(true);
    for (const w of [1280, 1440]) {
      const o = await openCompPage(browser, page, { width: w, height: 900, scale: 1, mobile: false });
      try {
        expect(phaseBCodes(await phaseBScan(o.page, { css: ON, displayWords: [] })), String(w)).toEqual(w < 1307 ? ["GRADIENT_TOO_STEEP"] : []);
      } finally {
        await o.context.close();
      }
    }
  });

  it("a failure between the checked widths: a steep gradient only at 1101–1109px is found by the sweep; the checked widths here are the media edges", async () => {
    const css = "body { margin: 0; } .g { height: 200px; background: linear-gradient(#000, #fff); } @media (min-width: 1101px) and (max-width: 1109px) { .g { background: linear-gradient(#000 45%, #fff 55%); } }";
    expect(cssProblems(css, ON)).toEqual([]);
    const { by } = await sweep(rawDoc('<div class="g"></div><p>文字</p>', css));
    expect(by("GRADIENT_TOO_STEEP")).toEqual(range(1101, 1109));
    console.log(`DEV-172 media window: sweep ${widthRanges(by("GRADIENT_TOO_STEEP"))}; checked widths ${pageWidths(css).join(",")}`);
  });
});

// ---------------------------------------------------------------- the three shops

describe("DEV-172 the three shops", () => {
  const factList = (shop: ShopKey) => Object.values(shopFacts(shop).facts).map((v) => v.replace(/\s+/g, ""));

  it.each(SHOP_KEYS)("%s: the strict page draws no gradient; ON changes no code at any of the 12 widths", async (shop) => {
    const { words } = shopFacts(shop);
    for (const w of NOWRAP_WIDTHS) {
      const on = await widthCodes(browser, gradPage(shop, "strict"), w, { css: ON, displayWords: words, facts: factList(shop) });
      const off = await widthCodes(browser, gradPage(shop, "strict"), w, { css: OFF, displayWords: words, facts: factList(shop) });
      expect(allCodes(on), `${w}`).toEqual(allCodes(off));
      expect(on.phaseB.filter((c) => c.startsWith("GROUND") || c.startsWith("GRADIENT"))).toEqual([]);
    }
  });

  it.each(SHOP_KEYS)("%s: grad and grad_eased (text-free boxes) pass the grammar only with the flag; grad_wide (C′'s gradients under text) fails GROUND_HAS_TEXT at every width", async (shop) => {
    const { words } = shopFacts(shop);
    for (const v of ["grad", "grad_eased", "grad_wide"] as const) {
      const p = gradPage(shop, v);
      expect(htmlSourceProblems(p.html), v).toEqual([]);
      expect(cssProblems(p.css, ON), v).toEqual([]);
      expect(cssProblems(p.css, OFF), v).toEqual(shop === "bicycle" && v !== "grad_wide" ? [] : ["CSS_VALUE"]);
    }
    const { by } = await sweep(gradPage(shop, "grad_wide"), ON, words);
    expect(by("GROUND_HAS_TEXT")).toEqual(range(320, 1920));
  });

  it("sento grad: the thermometer and the heat bar are drawn; C′'s fire tube (cold blue to ember in 18%) is too steep wherever the fire section is under 520px tall; eased to 40%, every width passes", async () => {
    const { words } = shopFacts("sento");
    const grad = await sweep(gradPage("sento", "grad"), ON, words);
    const steep = grad.by("GRADIENT_TOO_STEEP");
    expect(grad.s.failing.flatMap((f) => f.codes).every((c) => c === "GRADIENT_TOO_STEEP")).toBe(true);
    expect(steep).toEqual(expect.arrayContaining([320, 390, 600, 768, 1024, 1440, 1920]));
    // the rule on the fire tube alone: 187 levels (#9fd6ea → #e46a2f, blue channel) over 18% of the tube ≤ 2/px → 520px
    expect(gradientProblems({ kind: "linear", config: null, w: 6, h: 519, stops: [{ rgb: [0x9f, 0xd6, 0xea], pct: null }, { rgb: [0xe4, 0x6a, 0x2f], pct: 18 }, { rgb: [0xff, 0xb3, 0x5c], pct: 70 }, { rgb: [0xff, 0xe2, 0xb0], pct: null }] })).toEqual(["GRADIENT_TOO_STEEP"]);
    expect(gradientProblems({ kind: "linear", config: null, w: 6, h: 520, stops: [{ rgb: [0x9f, 0xd6, 0xea], pct: null }, { rgb: [0xe4, 0x6a, 0x2f], pct: 18 }, { rgb: [0xff, 0xb3, 0x5c], pct: 70 }, { rgb: [0xff, 0xe2, 0xb0], pct: null }] })).toEqual([]);
    const eased = await sweep(gradPage("sento", "grad_eased"), ON, words);
    expect(eased.s.failing).toEqual([]);
    // the checked widths: grad_eased adds no code to strict's (strict's own tablet failures stay)
    for (const w of NOWRAP_WIDTHS) {
      const a = await widthCodes(browser, gradPage("sento", "grad_eased"), w, { css: ON, displayWords: words, facts: factList("sento") });
      const b = await widthCodes(browser, gradPage("sento", "strict"), w, { css: ON, displayWords: words, facts: factList("sento") });
      expect(allCodes(a), String(w)).toEqual(allCodes(b));
    }
    console.log(`DEV-172 sento grad: GRADIENT_TOO_STEEP ${widthRanges(steep)}; grad_eased: none (${eased.s.ms} ms)`);
  });

  it("tsugute grad (the bowls) passes every width; tsugute grad_wide's gold band also breaks the stop rule (45% → 52% is under 10%)", async () => {
    const { words } = shopFacts("tsugute");
    expect((await sweep(gradPage("tsugute", "grad"), ON, words)).s.failing).toEqual([]);
    const wide = await sweep(gradPage("tsugute", "grad_wide"), ON, words);
    expect(wide.by("GRADIENT_HARD_STOP")).toEqual(range(320, 1920));
  });

  it("C′'s gradient declarations (the latest fidelity pages): only sento's heat bar passes the grammar; its six thermometer liquids would pass written as background (they are custom properties)", () => {
    const tally: Record<string, { all: number; pass: number }> = {};
    for (const shop of SHOP_KEYS) {
      const decls = gradientDeclarations(cPrimeCss(shop));
      const pass = decls.filter((d) => cssProblems(`.x { ${d.prop}: ${d.value}; }`, ONC).length === 0);
      tally[shop] = { all: decls.length, pass: pass.length };
      for (const d of decls) console.log(`DEV-172 C′ ${shop} ${d.prop}: ${cssProblems(`.x { ${d.prop}: ${d.value}; }`, ONC).join(" ") || "ok"} ${d.value.slice(0, 70)}`);
      if (shop === "sento") {
        expect(pass.map((d) => d.value)).toEqual([SENTO_BAR]);
        const liquids = decls.filter((d) => d.prop === "--liquid");
        expect(liquids.map((d) => d.value)).toEqual(Object.values(SENTO_LIQUID));
        for (const d of liquids) expect(cssProblems(`.x { background: ${d.value}; }`, ON)).toEqual([]);
      } else expect(pass).toEqual([]);
    }
    expect(tally).toEqual({ tsugute: { all: 10, pass: 0 }, bicycle: { all: 1, pass: 0 }, sento: { all: 19, pass: 1 } });
  });
});
