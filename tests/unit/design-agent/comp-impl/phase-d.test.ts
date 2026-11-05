import type { Browser, BrowserContext, Page } from "playwright";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cssProblems, htmlSourceProblems } from "@/lib/design-agent/comp-impl/page";
import type { PageCssOptions } from "@/lib/design-agent/comp-impl/page-css";
import { layerScan, openCompPage } from "@/lib/design-agent/comp-impl/render";
import { layerCodes } from "@/lib/design-agent/comp-impl/verify";
import { APPROVED_CAPABILITIES, CAPABILITY_NAMES, pageCssOptionsOf } from "@/lib/design-agent/comp-impl/spec";
import { SHOPS, shopFacts, type ShopKey } from "./nowrap-harness";
import { instanceCodes, overlapCodes, overlapScan, pixelPass, shopPlan } from "./overlap-harness";
import {
  codeNames,
  contrastOf,
  cPrimePageD,
  FEATURE_FLAG,
  fullInstances,
  geometryInstances,
  PHASE_D_FEATURES,
  PHASE_D_LIMITS,
  phaseDCssProblems,
  phaseDDecl,
  phaseDPage,
  phaseDPixels,
  phaseDRanges,
  phaseDScan,
  phaseDSweep,
  launchLight,
  PagePool,
  shopPlanD,
  type PhaseDFeature,
  type PhaseDFeatures,
  type PhaseDOptions,
  type PhaseDPlan,
} from "./phase-d-harness";

// DEV-175 (Issue #193 comment 6628165899): phase D — vertical writing, small rotation and outlined type, each its own
// capability (docs/design/phase-d-design.md). DESIGN AND OFFLINE VERIFICATION ONLY. Nothing in lib/ changes and nothing is
// enabled: APPROVED_CAPABILITIES stays empty, no capability or PageCssOptions key is added, the run never sees the
// prototype. These tests hold:
// 1. today, with every flag off, with vertical_name and with every phase B flag on, the production grammar refuses every
//    phase D construct (vertical_name admits writing-mode: vertical-rl alone, as before);
// 2. the proposed grammar (test-only wrapper around pageCssProblems) admits, per flag, exactly that feature's list and
//    nothing of the other two; with no flag it is the production grammar;
// 3. the proposed render checks (test-only prototype, phase-d-harness.ts) fail every must-fail probe with its code and
//    pass every must-pass probe, at the probe width, over the 1px sweep 320–1920 and in the pixel pass;
// 4. the three shops: each feature alone on the strict B page adds no code at any width (the strict page is the oracle,
//    measured here, so no number depends on the installed fonts); C′ is recorded.
// Run it under the installed fonts and under a CI-like font set (FONTCONFIG_FILE): nothing here pins a width or a text.

vi.setConfig({ testTimeout: 600_000, hookTimeout: 300_000 });

const SHOP_KEYS = Object.keys(SHOPS) as ShopKey[];
const ALL_B: PageCssOptions = { verticalName: true, displayScale: true, displayNowrap: true, colourSyntax: true, gradientGround: true, translucentDecoration: true };
const FACT = "000-0000-0712";
const NAME = "架空の店";
const ALL: PhaseDFeatures = { vertical: true, rotation: true, outline: true };
const plan = (features: PhaseDFeatures, protect: readonly string[] = [FACT, NAME]): PhaseDPlan => ({ protect, names: [NAME], features });
const CHECKED = [1440, 1280, 1024, 768, 601, 600, 480, 390, 375, 360, 340, 320] as const;

let browser: Browser;
let raw: BrowserContext;
let tab: Page;
beforeAll(async () => {
  browser = await launchLight();
  raw = await browser.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1, javaScriptEnabled: false });
  await raw.route("**/*", (route) => route.abort());
  tab = await raw.newPage();
});
afterAll(async () => {
  await raw?.close();
  await browser?.close();
});

/** The probes' base: production-allowlisted CSS only; IPAGothic is on this machine and on CI. */
const BASE = '* { margin: 0; padding: 0; } body { font-family: "IPAGothic", sans-serif; font-size: 20px; line-height: 1.6; color: #1f1d1b; background: #ffffff; } .wrap { padding: 40px; }';
async function load(body: string, css: string, width = 800) {
  await tab.setViewportSize({ width, height: 600 });
  await tab.setContent(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>${BASE}\n${css}</style></head><body>${body}</body></html>`);
}
async function geometry(body: string, css: string, features: PhaseDFeatures, width = 800, protect?: readonly string[]) {
  await load(body, css, width);
  return geometryInstances(await phaseDScan(tab, plan(features, protect)));
}
async function full(body: string, css: string, features: PhaseDFeatures, width = 800, protect?: readonly string[]) {
  await load(body, css, width);
  const s = await phaseDScan(tab, plan(features, protect));
  return fullInstances(s, await phaseDPixels(tab, s));
}

/** The first and last+1 row of dark ink (any channel < 128) in the page as drawn at 800. */
async function inkRows(body: string, css: string): Promise<[number, number]> {
  await load(body, css);
  const { data, info } = await sharp(await tab.screenshot()).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < info.width * info.height; i++)
    if (Math.min(data[i * 3]!, data[i * 3 + 1]!, data[i * 3 + 2]!) < 128) {
      lo = Math.min(lo, Math.floor(i / info.width));
      hi = Math.max(hi, Math.floor(i / info.width) + 1);
    }
  return [lo, hi];
}

// ---------------------------------------------------------------- 1. today: everything is refused

/** One declaration of every phase D construct (and the outline alternatives), each refused by the production grammar. */
const CONSTRUCTS = [
  "writing-mode: vertical-lr",
  "writing-mode: sideways-rl",
  "text-orientation: upright",
  "text-orientation: mixed",
  "text-orientation: sideways",
  "text-combine-upright: all",
  "transform: rotate(3deg)",
  "transform-origin: left top",
  "rotate: 3deg",
  "-webkit-text-stroke: 1px #000",
  "-webkit-text-stroke-width: 1px",
  "-webkit-text-stroke-color: #000",
  "-webkit-text-fill-color: transparent",
  "paint-order: stroke",
  "text-shadow: 1px 1px 0 #000, -1px -1px 0 #000",
];

describe("DEV-175 phase D stays OFF (the production checker today)", () => {
  it("approves nothing and names no phase D capability", () => {
    expect(APPROVED_CAPABILITIES).toEqual([]);
    expect(CAPABILITY_NAMES.some((c) => /vertical_text|rotation|outline|stroke/.test(c))).toBe(false);
    // vertical_name exists (DEV-102) and is not approved: a spec declaring it turns nothing on
    expect(pageCssOptionsOf({ capabilities: ["vertical_name"] })).toEqual({});
  });

  it("refuses every phase D construct with every flag off, with vertical_name, and with every phase B flag on", () => {
    for (const d of CONSTRUCTS)
      for (const opts of [{}, { verticalName: true }, ALL_B] as PageCssOptions[]) expect(cssProblems(`.x { ${d}; }`, opts).length, `${d} ${JSON.stringify(opts)}`).toBeGreaterThan(0);
    // vertical_name (unapproved) admits vertical-rl and nothing else of phase D; without it, horizontal only
    expect(cssProblems(".x { writing-mode: vertical-rl; }")).toEqual(["CSS_VALUE"]);
    expect(cssProblems(".x { writing-mode: vertical-rl; }", { verticalName: true })).toEqual([]);
    // a hollow fill alone is already admitted today (color: transparent); with no stroke it draws nothing (phase D §4.4)
    expect(cssProblems(".x { color: transparent; }")).toEqual([]);
  });

  it("refuses each shop's phase D stylesheet without its flag (and with every phase B flag but vertical_name)", () => {
    for (const shop of SHOP_KEYS)
      for (const f of PHASE_D_FEATURES)
        for (const opts of [{}, { ...ALL_B, verticalName: false }] as PageCssOptions[]) expect(cssProblems(phaseDPage(shop, f).css, opts).length, `${shop} ${f}`).toBeGreaterThan(0);
  });

  it("vertical_name's grammar admits writing-mode: vertical-rl, but its render check holds the role: only the name may be vertical", async () => {
    for (const shop of SHOP_KEYS) {
      const page = phaseDPage(shop, "vertical");
      expect(cssProblems(page.css, { verticalName: true }), shop).toEqual([]);
      const o = await openCompPage(browser, page, { width: 1440, height: 900, scale: 1, mobile: false });
      try {
        const codes = layerCodes(await layerScan(o.page, [], { verticalName: shopFacts(shop).name }));
        // tsugute and bicycle make decorative words vertical; sento makes the h1 (ゆげ湯, the short name) vertical too —
        // vertical_name admits only an element whose text is exactly the full name
        expect(codes, shop).toContain("VERTICAL_NOT_NAME");
      } finally {
        await o.context.close();
      }
    }
  });
});

// ---------------------------------------------------------------- 2. the proposed grammar

const ADMITTED: Record<PhaseDFeature, string[]> = {
  vertical: ["writing-mode: vertical-rl", "writing-mode: horizontal-tb", "text-orientation: upright", "text-orientation: mixed", "text-combine-upright: all", "text-combine-upright: none"],
  rotation: ["transform: rotate(8deg)", "transform: rotate(-8deg)", "transform: rotate(2.4deg)", "transform: rotate(0)", "transform: none", "transform-origin: left top", "transform-origin: 50% 0", "transform-origin: center"],
  outline: ["-webkit-text-stroke: 1px #000", "-webkit-text-stroke: #b88a35 3px", "-webkit-text-stroke: 0.5px rgb(10, 20, 30)", "-webkit-text-stroke-width: 2px", "-webkit-text-stroke-color: white", "paint-order: stroke fill", "paint-order: stroke", "paint-order: normal"],
};
const REFUSED = [
  "writing-mode: vertical-lr",
  "writing-mode: sideways-rl",
  "writing-mode: sideways-lr",
  "text-orientation: sideways",
  "text-combine-upright: digits 2",
  "transform: rotate(8.5deg)",
  "transform: rotate(-9deg)",
  "transform: rotate(0.02turn)",
  "transform: rotate(0.1rad)",
  "transform: rotate(3grad)",
  "transform: rotate(calc(2deg + 2deg))",
  "transform: rotate(2deg) rotate(2deg)",
  "transform: rotate(2deg) translate(10px)",
  "transform: skew(3deg)",
  "transform: scale(1.1)",
  "transform: matrix(1, 0, 0, 1, 0, 0)",
  "transform: rotate3d(0, 0, 1, 3deg)",
  "transform: rotateZ(3deg)",
  "transform-origin: -20px 0",
  "transform-origin: 50% 50% 10px",
  "rotate: 3deg",
  "-webkit-text-stroke: 4px #000",
  "-webkit-text-stroke: 0.2px #000",
  "-webkit-text-stroke: 1px rgba(0, 0, 0, 0.5)",
  "-webkit-text-stroke: 1px #0008",
  "-webkit-text-stroke: 1px transparent",
  "-webkit-text-stroke: 1px currentcolor",
  "-webkit-text-stroke: 0.1em #000",
  "-webkit-text-stroke-color: var(--gold)",
  "-webkit-text-fill-color: transparent",
  "paint-order: markers",
  "paint-order: fill stroke",
  "text-shadow: 0 0 2px #000",
];

describe("DEV-175 the proposed grammar (test-only prototype, one flag per feature)", () => {
  it("without a phase D flag it is exactly the production grammar", () => {
    for (const shop of SHOP_KEYS)
      for (const f of [...PHASE_D_FEATURES, "strict"] as const)
        for (const opts of [{}, { verticalName: true }, ALL_B] as PageCssOptions[]) expect(phaseDCssProblems(phaseDPage(shop, f).css, opts)).toEqual(cssProblems(phaseDPage(shop, f).css, opts));
  });

  it("each flag admits its own list and nothing of the other two features", () => {
    for (const f of PHASE_D_FEATURES)
      for (const g of PHASE_D_FEATURES)
        for (const d of ADMITTED[g]) {
          const prop = d.split(":")[0]!;
          const value = d.slice(d.indexOf(":") + 1);
          // writing-mode: horizontal-tb is in the production table already
          const today = cssProblems(`.x { ${d}; }`).length === 0;
          expect(phaseDDecl(prop, value, { [FEATURE_FLAG[f]]: true }) || (today && f !== g), `${d} under ${f}`).toBe(f === g || today);
          expect(phaseDCssProblems(`.x { ${d}; }`, { [FEATURE_FLAG[f]]: true }).length === 0, `${d} under ${f}`).toBe(f === g || today);
        }
  });

  it("refuses everything outside the lists with all three flags (and every phase B flag)", () => {
    const opts: PhaseDOptions = { ...ALL_B, verticalText: true, smallRotation: true, outlinedType: true };
    for (const d of REFUSED) expect(phaseDCssProblems(`.x { ${d}; }`, opts).length, d).toBeGreaterThan(0);
  });

  it("each shop's phase D stylesheet passes with its own flag only; the HTML is the strict page's, through the allowlist", () => {
    for (const shop of SHOP_KEYS) {
      expect(htmlSourceProblems(phaseDPage(shop, "strict").html)).toEqual([]);
      for (const f of PHASE_D_FEATURES) {
        expect(phaseDCssProblems(phaseDPage(shop, f).css, { [FEATURE_FLAG[f]]: true }), `${shop} ${f}`).toEqual([]);
        for (const g of PHASE_D_FEATURES) if (g !== f) expect(phaseDCssProblems(phaseDPage(shop, f).css, { [FEATURE_FLAG[g]]: true }).length, `${shop} ${f} under ${g}`).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------- 3. the render checks on synthetic probes

type Probe = { name: string; body: string; css: string; features: PhaseDFeatures; width?: number; code: string; pixels?: boolean; protect?: readonly string[] };

const F_V: PhaseDFeatures = { vertical: true };
const F_R: PhaseDFeatures = { rotation: true };
const F_O: PhaseDFeatures = { outline: true };

/** Must fail: each names the code it must produce (geometry; with pixels: true, the pixel pass's code). */
const MUST_FAIL: Probe[] = [
  // vertical_text
  { name: "a fact set vertically", body: `<div class="wrap"><p class="v">${FACT}</p></div>`, css: ".v { writing-mode: vertical-rl; font-size: 24px; }", features: F_V, code: "PHASE_D_PROTECTED_VERTICAL" },
  { name: "an h1 that is not the name, holding a fact, set vertically (an h1 alone is not the name role)", body: '<div class="wrap"><h1 class="v">水曜定休</h1></div>', css: ".v { writing-mode: vertical-rl; font-size: 40px; }", features: F_V, code: "PHASE_D_PROTECTED_VERTICAL", protect: [FACT, NAME, "水曜定休"] },
  { name: "the name and a fact in one vertical h1 (the fact wins)", body: `<div class="wrap"><h1 class="v">${NAME}水曜定休</h1></div>`, css: ".v { writing-mode: vertical-rl; font-size: 40px; }", features: F_V, code: "PHASE_D_PROTECTED_VERTICAL", protect: [FACT, NAME, "水曜定休"] },
  { name: "an h1 that is neither the name nor a fact set vertically (protected as an h1; not the name role)", body: '<div class="wrap"><h1 class="v">見出しの語</h1></div>', css: ".v { writing-mode: vertical-rl; font-size: 40px; }", features: F_V, code: "PHASE_D_PROTECTED_VERTICAL" },
  { name: "the name as a dd set vertically (dt/dd stay horizontal: the fact role wins over the name role)", body: `<div class="wrap"><dl><dt>店名</dt><dd class="v">${NAME}</dd></dl></div>`, css: ".v { writing-mode: vertical-rl; font-size: 40px; }", features: F_V, code: "PHASE_D_PROTECTED_VERTICAL" },
  { name: "a dd set vertically", body: '<div class="wrap"><dl><dt>定休日</dt><dd class="v">水曜</dd></dl></div>', css: ".v { writing-mode: vertical-rl; font-size: 24px; }", features: F_V, code: "PHASE_D_PROTECTED_VERTICAL" },
  { name: "a vertical container (blocks become right-to-left columns)", body: '<div class="wrap"><div class="v"><h2>見出し</h2><p>本文の段落</p></div></div>', css: ".v { writing-mode: vertical-rl; font-size: 24px; }", features: F_V, code: "PHASE_D_VERTICAL_CONTAINER" },
  { name: "a vertical body", body: '<div class="wrap"><p>見出し</p></div>', css: "body { writing-mode: vertical-rl; }", features: F_V, code: "PHASE_D_VERTICAL_CONTAINER" },
  { name: "a vertical span inside a vertical word that is not a combine span", body: '<div class="wrap"><p class="v">継ぐ<span>手</span></p></div>', css: ".v { writing-mode: vertical-rl; font-size: 40px; }", features: F_V, code: "PHASE_D_VERTICAL_CONTAINER" },
  { name: "a horizontal box inside a vertical word", body: '<div class="wrap"><p class="v">継ぐ<span class="h">手</span></p></div>', css: ".v { writing-mode: vertical-rl; font-size: 40px; } .h { display: inline-block; writing-mode: horizontal-tb; }", features: F_V, code: "PHASE_D_VERTICAL_CONTAINER" },
  { name: "glyphs drawn bottom to top (bidi override)", body: '<div class="wrap"><p class="v">継ぐ手</p></div>', css: ".v { writing-mode: vertical-rl; direction: rtl; unicode-bidi: bidi-override; font-size: 40px; }", features: F_V, code: "PHASE_D_VERTICAL_ORDER" },
  { name: "glyphs piled up (negative letter-spacing)", body: '<div class="wrap"><p class="v">継ぐ手</p></div>', css: ".v { writing-mode: vertical-rl; letter-spacing: -0.7em; font-size: 40px; }", features: F_V, code: "PHASE_D_VERTICAL_GLYPH_OVERLAP" },
  { name: "a long paragraph set vertically", body: '<div class="wrap"><p class="v">割れた器を漆でつなぎ、継ぎ目に金を蒔いて仕上げます。</p></div>', css: ".v { writing-mode: vertical-rl; font-size: 24px; }", features: F_V, code: "PHASE_D_VERTICAL_LONG_TEXT" },
  { name: "small vertical text", body: '<div class="wrap"><p class="v">小さな縦書き</p></div>', css: ".v { writing-mode: vertical-rl; font-size: 14px; }", features: F_V, code: "PHASE_D_VERTICAL_SMALL" },
  { name: "vertical-lr (columns left to right)", body: '<div class="wrap"><p class="v">左から右へ読む</p></div>', css: ".v { writing-mode: vertical-lr; font-size: 24px; }", features: F_V, code: "PHASE_D_VERTICAL_MODE" },
  { name: "Latin letters drawn sideways (text-orientation: mixed)", body: '<div class="wrap"><p class="v">OPEN 継ぐ</p></div>', css: ".v { writing-mode: vertical-rl; font-size: 32px; }", features: F_V, code: "PHASE_D_VERTICAL_SIDEWAYS" },
  { name: "CJK set sideways (text-orientation: sideways)", body: '<div class="wrap"><p class="v">継ぐ手</p></div>', css: ".v { writing-mode: vertical-rl; text-orientation: sideways; font-size: 32px; }", features: F_V, code: "PHASE_D_VERTICAL_SIDEWAYS" },
  { name: "two digits not combined", body: '<div class="wrap"><p class="v">毎月12日</p></div>', css: ".v { writing-mode: vertical-rl; font-size: 32px; }", features: F_V, code: "PHASE_D_VERTICAL_DIGITS" },
  { name: "a combine span of five characters (15:00)", body: '<div class="wrap"><p class="v">開店<span class="t">15:00</span></p></div>', css: ".v { writing-mode: vertical-rl; font-size: 32px; } .t { text-combine-upright: all; }", features: F_V, code: "PHASE_D_COMBINE_TEXT" },
  { name: "a vertical word in a box shorter than one glyph", body: '<div class="wrap"><p class="v">継ぐ手</p></div>', css: ".v { writing-mode: vertical-rl; font-size: 40px; height: 24px; }", features: F_V, code: "PHASE_D_VERTICAL_OVERFLOW" },
  {
    name: "reading order: a heading after its paragraph in the DOM; set vertically, it rises above the paragraph on its right",
    body: '<div class="wrap"><div class="g"><p class="p">あとから読む文。</p><h2 class="v">見出しの語</h2></div></div>',
    css: ".g { display: flex; align-items: flex-end; gap: 24px; } .v { writing-mode: vertical-rl; font-size: 20px; font-weight: 400; }",
    features: F_V,
    code: "PHASE_D_READING_ORDER",
  },
  {
    name: "reading order across a label: the heading rises above a paragraph two elements before it (a small label between them)",
    body: '<div class="wrap"><div class="g"><p class="p">あとから読む文。</p><p class="s">印</p><h2 class="v">見出しの語</h2></div></div>',
    css: ".g { display: flex; align-items: flex-end; gap: 24px; } .s { align-self: flex-start; line-height: 1; } .v { writing-mode: vertical-rl; font-size: 20px; font-weight: 400; }",
    features: F_V,
    code: "PHASE_D_READING_ORDER",
  },
  { name: "vertical with the flag off", body: '<div class="wrap"><p class="v">継ぐ</p></div>', css: ".v { writing-mode: vertical-rl; font-size: 40px; }", features: { rotation: true, outline: true }, code: "PHASE_D_VERTICAL_NOT_ENABLED" },
  // small_rotation
  { name: "a fact rotated 2°", body: `<div class="wrap"><p class="r">${FACT}</p></div>`, css: ".r { width: max-content; transform: rotate(2deg); }", features: F_R, code: "PHASE_D_PROTECTED_ROTATED" },
  { name: "a card holding the fact rotated 2°", body: `<div class="wrap"><div class="r"><p>電話</p><p>${FACT}</p></div></div>`, css: ".r { width: 300px; transform: rotate(2deg); }", features: F_R, code: "PHASE_D_PROTECTED_ROTATED" },
  { name: "the name rotated (protected too)", body: `<div class="wrap"><h1 class="r">${NAME}</h1></div>`, css: ".r { width: max-content; font-size: 48px; transform: rotate(3deg); }", features: F_R, code: "PHASE_D_PROTECTED_ROTATED" },
  { name: "a paragraph rotated 2° (readable text, not a word)", body: '<div class="wrap"><p class="r">割れた器を漆でつなぎ、継ぎ目に金を蒔いて仕上げます。</p></div>', css: ".r { width: 600px; transform: rotate(2deg); }", features: F_R, code: "PHASE_D_ROTATED_TEXT" },
  { name: "a 12° rotation (past the bound)", body: '<div class="wrap"><div class="r"></div></div>', css: ".r { width: 80px; height: 80px; background: #c79a45; transform: rotate(12deg); }", features: F_R, code: "PHASE_D_ROTATION_ANGLE" },
  { name: "6° inside 6° (the sum is past the bound)", body: '<div class="wrap"><div class="r"><div class="r2"></div></div></div>', css: ".r { width: 120px; height: 120px; transform: rotate(6deg); } .r2 { width: 60px; height: 60px; background: #c79a45; transform: rotate(6deg); }", features: F_R, code: "PHASE_D_ROTATION_ANGLE" },
  { name: "a skew (not a rotation)", body: '<div class="wrap"><div class="r"></div></div>', css: ".r { width: 80px; height: 80px; background: #c79a45; transform: skewX(4deg); }", features: F_R, code: "PHASE_D_ROTATION_UNMEASURED" },
  { name: "the rotate property", body: '<div class="wrap"><div class="r"></div></div>', css: ".r { width: 80px; height: 80px; background: #c79a45; rotate: 3deg; }", features: F_R, code: "PHASE_D_ROTATION_UNMEASURED" },
  { name: "a wide band rotated 4° swings far past its box", body: '<div class="wrap"><div class="r"></div></div>', css: ".r { width: 700px; height: 20px; background: #c79a45; transform: rotate(4deg); }", features: F_R, code: "PHASE_D_ROTATION_REACH" },
  {
    name: "a word overflowing a 0-height box swings far when rotated (the extent is box ∪ glyphs)",
    body: '<div class="wrap"><p class="r">継ぐ手継ぐ手継ぐ手継ぐ手</p></div>',
    css: ".wrap { padding: 0 0 0 4px; } .r { width: 64px; height: 0; font-size: 64px; line-height: 1; transform: rotate(8deg); transform-origin: left top; }",
    features: F_R,
    code: "PHASE_D_ROTATION_REACH",
  },
  {
    name: "the same word's glyphs leave the viewport on the left",
    body: '<div class="wrap"><p class="r">継ぐ手継ぐ手継ぐ手継ぐ手</p></div>',
    css: ".wrap { padding: 0 0 0 4px; } .r { width: 64px; height: 0; font-size: 64px; line-height: 1; transform: rotate(8deg); transform-origin: left top; }",
    features: F_R,
    code: "PHASE_D_ROTATED_OFFSCREEN",
  },
  { name: "a rotated box past the right edge", body: '<div class="wrap"><div class="r"></div></div>', css: ".r { width: 400px; height: 400px; margin-left: 360px; background: #c79a45; transform: rotate(8deg); }", features: F_R, code: "PHASE_D_ROTATED_OFFSCREEN" },
  { name: "a rotated word cut by a clipping box", body: '<div class="wrap"><div class="c"><p class="r">継ぐ</p></div></div>', css: ".c { height: 64px; overflow: hidden; } .r { width: max-content; font-size: 64px; line-height: 1; transform: rotate(8deg); }", features: F_R, code: "PHASE_D_ROTATED_CLIPPED" },
  {
    name: "a rotated word whose ink meets the next line (geometry fails closed)",
    body: '<div class="wrap"><p class="r">継ぐ手</p><p class="n">すぐ下の行の文字</p></div>',
    css: ".r { width: max-content; font-size: 64px; line-height: 1; transform: rotate(8deg); transform-origin: left top; } .n { font-size: 24px; line-height: 1; }",
    features: F_R,
    code: "PHASE_D_INK_UNPROVEN",
  },
  {
    name: "a rotated word whose ink meets the next line (pixels)",
    body: '<div class="wrap"><p class="r">継ぐ手</p><p class="n">すぐ下の行の文字</p></div>',
    css: ".r { width: max-content; font-size: 64px; line-height: 1; transform: rotate(8deg); transform-origin: left top; } .n { font-size: 24px; line-height: 1; }",
    features: F_R,
    code: "PHASE_D_INK_ON_TEXT",
    pixels: true,
  },
  { name: "rotation with the flag off", body: '<div class="wrap"><div class="r"></div></div>', css: ".r { width: 80px; height: 80px; background: #c79a45; transform: rotate(3deg); }", features: { vertical: true, outline: true }, code: "PHASE_D_ROTATION_NOT_ENABLED" },
  // outlined_type
  { name: "a fact stroked", body: `<div class="wrap"><p class="o">${FACT}</p></div>`, css: ".o { font-size: 40px; -webkit-text-stroke: 1px #c79a45; }", features: F_O, code: "PHASE_D_PROTECTED_STROKED" },
  { name: "a stroke on a container reaches the fact (it inherits)", body: `<div class="wrap o"><p class="w">継ぐ</p><p>${FACT}</p></div>`, css: ".o { -webkit-text-stroke: 1px #c79a45; } .w { font-size: 64px; }", features: F_O, code: "PHASE_D_PROTECTED_STROKED" },
  { name: "a paragraph stroked (readable text, not a word)", body: '<div class="wrap"><p class="o">割れた器を漆でつなぎ、継ぎ目に金を蒔いて仕上げます。</p></div>', css: ".o { font-size: 28px; -webkit-text-stroke: 1px #c79a45; }", features: F_O, code: "PHASE_D_STROKE_ON_TEXT" },
  { name: "small text stroked", body: '<div class="wrap"><p class="o">小さな語</p></div>', css: ".o { font-size: 16px; -webkit-text-stroke: 0.5px #c79a45; }", features: F_O, code: "PHASE_D_STROKE_ON_TEXT" },
  { name: "a stroke thick for its size (3px at 30px)", body: '<div class="wrap"><p class="o">継ぐ</p></div>', css: ".o { font-size: 30px; -webkit-text-stroke: 3px #c79a45; }", features: F_O, code: "PHASE_D_STROKE_TOO_THICK" },
  { name: "a hollow word with a 1px stroke", body: '<div class="wrap"><p class="o">継ぐ</p></div>', css: ".o { font-size: 96px; color: transparent; -webkit-text-stroke: 1px #1f1d1b; }", features: F_O, code: "PHASE_D_OUTLINE_HOLLOW_THIN" },
  { name: "a 1px stroke on a word filled with the ground's colour (hollow in effect)", body: '<div class="wrap"><p class="o">継ぐ</p></div>', css: ".o { font-size: 96px; color: #ffffff; -webkit-text-stroke: 1px #1f1d1b; }", features: F_O, code: "PHASE_D_OUTLINE_HOLLOW_THIN" },
  { name: "a translucent stroke", body: '<div class="wrap"><p class="o">継ぐ</p></div>', css: ".o { font-size: 96px; -webkit-text-stroke: 2px rgba(0, 0, 0, 0.4); }", features: F_O, code: "PHASE_D_OUTLINE_TRANSLUCENT" },
  { name: "a text-shadow outline (four shadows)", body: '<div class="wrap"><p class="o">継ぐ</p></div>', css: ".o { font-size: 64px; color: #ffffff; text-shadow: 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000; }", features: F_O, code: "PHASE_D_TEXT_SHADOW" },
  { name: "a hollow word whose stroke is close to the ground (pixels)", body: '<div class="wrap"><p class="o">継ぐ</p></div>', css: ".o { font-size: 128px; color: transparent; -webkit-text-stroke: 2px #e9e2d6; }", features: F_O, code: "PHASE_D_OUTLINE_LOW_CONTRAST", pixels: true },
  { name: "a pale word with a pale stroke on a dark-free ground (pixels)", body: '<div class="wrap"><p class="o">継ぐ</p></div>', css: ".o { font-size: 128px; color: #f2eee8; -webkit-text-stroke: 2px #d9d2c6; paint-order: stroke fill; }", features: F_O, code: "PHASE_D_OUTLINE_LOW_CONTRAST", pixels: true },
  { name: "a hollow word stroked white on white (pixels)", body: '<div class="wrap"><p class="o">継ぐ</p></div>', css: ".o { font-size: 128px; color: transparent; -webkit-text-stroke: 2px #ffffff; }", features: F_O, code: "PHASE_D_OUTLINE_INVISIBLE", pixels: true },
  { name: "a rotated hollow word whose stroke is close to the ground (pixels: the outline checks run on rotated targets)", body: '<div class="wrap"><p class="o">継ぐ</p></div>', css: ".o { width: max-content; font-size: 128px; color: transparent; -webkit-text-stroke: 2px #e9e2d6; transform: rotate(1deg); }", features: { rotation: true, outline: true }, code: "PHASE_D_OUTLINE_LOW_CONTRAST", pixels: true },
  { name: "a rotated hollow word stroked white on white (pixels)", body: '<div class="wrap"><p class="o">継ぐ</p></div>', css: ".o { width: max-content; font-size: 128px; color: transparent; -webkit-text-stroke: 2px #ffffff; transform: rotate(1deg); }", features: { rotation: true, outline: true }, code: "PHASE_D_OUTLINE_INVISIBLE", pixels: true },
  { name: "an outlined word far off the page to the left (nothing to photograph: fail closed)", body: '<div class="wrap"><p class="o">継ぐ</p></div>', css: ".o { margin-left: -3000px; font-size: 64px; -webkit-text-stroke: 1px #c79a45; }", features: F_O, code: "PHASE_D_INK_UNMEASURED", pixels: true },
  { name: "outline with the flag off", body: '<div class="wrap"><p class="o">継ぐ</p></div>', css: ".o { font-size: 64px; -webkit-text-stroke: 1px #c79a45; }", features: { vertical: true, rotation: true }, code: "PHASE_D_OUTLINE_NOT_ENABLED" },
  // the page
  { name: "a rotated word that makes the page scroll sideways", body: '<div class="wrap"><p class="r">継ぐ</p></div>', css: ".r { width: max-content; margin-left: 740px; font-size: 64px; transform: rotate(4deg); }", features: F_R, code: "PHASE_D_HORIZONTAL_SCROLL" },
];

/** Must pass: no code at the probe width (geometry and pixels), and (sweep: true) at every width 320–1920. */
const MUST_PASS: Array<Omit<Probe, "code"> & { sweep: boolean }> = [
  {
    name: "reading order already inverted in the horizontal layout (a zigzag; V9's matter, not phase D's)",
    body: '<div class="wrap"><div class="g"><p class="p">あとから読む文。</p><h2 class="v">見出し</h2></div></div>',
    css: ".g { display: grid; grid-template-columns: 1fr auto; } .p { margin-top: 120px; } .v { writing-mode: vertical-rl; font-size: 32px; }",
    features: F_V,
    sweep: false,
  },
  {
    name: "a vertical heading beside its paragraph (heading first in the DOM, on the right)",
    body: '<div class="wrap"><div class="g"><h2 class="v">線は、壊れ方をなぞる。</h2><p>ふたつに分かれた器を、一本の線で結び直す。</p></div></div>',
    css: ".g { display: flex; flex-wrap: wrap; gap: 24px; } .v { writing-mode: vertical-rl; font-size: 28px; }",
    features: F_V,
    sweep: true,
  },
  { name: "the name set vertically (the name's role, as vertical_name)", body: `<div class="wrap"><h1 class="v">${NAME}</h1><p>本文の段落。</p></div>`, css: ".v { writing-mode: vertical-rl; font-size: 64px; }", features: F_V, sweep: true },
  { name: "tate-chu-yoko: two digits combined", body: '<div class="wrap"><p class="v">毎月<span class="t">12</span>日</p></div>', css: ".v { writing-mode: vertical-rl; font-size: 32px; } .t { text-combine-upright: all; }", features: F_V, sweep: true },
  { name: "a vertical word inline in a horizontal line (Chromium makes it an inline-block)", body: '<div class="wrap"><p>ここに<span class="v">縦の語</span>がある</p></div>', css: ".v { writing-mode: vertical-rl; }", features: F_V, sweep: true },
  { name: "upright Latin letters", body: '<div class="wrap"><p class="v">ABC</p></div>', css: ".v { writing-mode: vertical-rl; text-orientation: upright; font-size: 32px; }", features: F_V, sweep: true },
  { name: "a rotated image (text-free) with room around it", body: '<div class="wrap"><div class="b"><div class="r"></div></div><p>写真の下の説明。</p></div>', css: ".b { padding: 24px; } .r { max-width: 280px; height: 180px; background: #c79a45; transform: rotate(-3deg); }", features: F_R, sweep: true },
  { name: "a rotated word far from other text", body: '<div class="wrap"><p class="r">継ぐ</p><p class="n">離れた本文。</p></div>', css: ".r { width: max-content; font-size: 64px; line-height: 1; transform: rotate(-4deg); } .n { margin-top: 48px; }", features: F_R, sweep: true },
  { name: "an outlined word, opaque fill, stroke behind it", body: '<div class="wrap"><p class="o">継ぐ</p><p>本文。</p></div>', css: ".o { font-size: 72px; color: #1f1d1b; -webkit-text-stroke: 2px #c79a45; paint-order: stroke fill; }", features: F_O, sweep: true },
  { name: "a hollow word, dark 2px stroke on a light ground", body: '<div class="wrap"><p class="o">継ぐ</p><p>本文。</p></div>', css: ".o { font-size: 96px; color: transparent; -webkit-text-stroke: 2px #1f1d1b; }", features: F_O, sweep: true },
  { name: "a hollow word, light stroke on a dark ground", body: '<div class="wrap d"><p class="o">継ぐ</p><p>本文。</p></div>', css: ".d { background: #1f1d1b; color: #ffffff; } .o { font-size: 96px; color: transparent; -webkit-text-stroke: 2px #f2c230; }", features: F_O, sweep: true },
  {
    name: "one word with all three (vertical, 4°, outlined)",
    body: '<div class="wrap"><p class="w">継ぐ</p><p class="n">本文。</p></div>',
    css: ".w { writing-mode: vertical-rl; font-size: 64px; transform: rotate(4deg); color: #1f1d1b; -webkit-text-stroke: 2px #c79a45; paint-order: stroke fill; } .n { margin-top: 24px; }",
    features: ALL,
    sweep: true,
  },
  {
    name: "a rotated word whose box meets the next line but whose ink does not (pixels clear what geometry cannot)",
    body: '<div class="wrap"><p class="r">一</p><p class="n">すぐ下の行</p></div>',
    css: ".r { width: max-content; font-size: 64px; line-height: 1; transform: rotate(8deg); } .n { font-size: 24px; line-height: 1; }",
    features: F_R,
    sweep: false,
  },
];

describe("DEV-175 the render checks (prototype) on synthetic probes", () => {
  const table: string[] = [];
  afterAll(() => console.log(`DEV-175 probes\n${table.join("\n")}`));

  it("every must-fail probe fails with its code", async () => {
    for (const p of MUST_FAIL) {
      const got = p.pixels ? await full(p.body, p.css, p.features, p.width, p.protect) : await geometry(p.body, p.css, p.features, p.width, p.protect);
      table.push(`FAIL | ${p.name} | ${codeNames(got).join(", ")}`);
      expect(codeNames(got), p.name).toContain(p.code);
    }
  });

  it("every must-pass probe passes at 800 (geometry and pixels) and its CSS is in the proposed grammar of its flags", async () => {
    for (const p of MUST_PASS) {
      const opts: PhaseDOptions = { verticalText: p.features.vertical, smallRotation: p.features.rotation, outlinedType: p.features.outline };
      expect(phaseDCssProblems(`${BASE}\n${p.css}`, opts), p.name).toEqual([]);
      const got = await full(p.body, p.css, p.features);
      table.push(`PASS | ${p.name} | ${got.join(", ") || "-"}`);
      expect(got, p.name).toEqual([]);
    }
  });

  it("geometry alone fails closed where only ink can tell; the pixels then clear it", async () => {
    const p = MUST_PASS.at(-1)!;
    expect(codeNames(await geometry(p.body, p.css, p.features))).toEqual(["PHASE_D_INK_UNPROVEN"]);
    expect(await full(p.body, p.css, p.features)).toEqual([]);
  });

  it("a rotated box the layout already puts past the edge is the layout's overflow (page scroll), not the rotation's", async () => {
    const body = '<div class="wrap"><div class="r"></div></div>';
    expect(codeNames(await geometry(body, ".r { width: 300px; height: 60px; margin-left: 700px; background: #c79a45; transform: rotate(2deg); }", F_R))).toEqual(["PHASE_D_HORIZONTAL_SCROLL"]);
    expect(codeNames(await geometry(body, ".r { width: 300px; height: 60px; margin-left: 700px; background: #c79a45; }", F_R))).toEqual(["PHASE_D_HORIZONTAL_SCROLL"]);
  });

  it("the must-pass probes pass at every width 320–1920 (1px sweep, geometry: no sideways scroll, no overflow, order kept)", async () => {
    for (const p of MUST_PASS.filter((x) => x.sweep)) {
      await load(p.body, p.css, 1920);
      const s = await phaseDSweep(tab, plan(p.features), 320, 1920);
      expect(s.measured).toBe(1601);
      expect(phaseDRanges(s), p.name).toEqual({});
    }
  }, 1_200_000);

  it("the must-pass probes pass in the pixel pass at the checked widths", async () => {
    for (const p of MUST_PASS.filter((x) => x.sweep))
      for (const w of CHECKED) expect(await full(p.body, p.css, p.features, w), `${p.name} @${w}`).toEqual([]);
  });

  it("outline contrast is measured from pixels: the same hollow word passes or fails by its stroke colour against the ground under it", async () => {
    const at = async (stroke: string, ground: string) => {
      await load('<div class="wrap g"><p class="o">継ぐ</p></div>', `.g { background: ${ground}; } .o { font-size: 128px; color: transparent; -webkit-text-stroke: 2px ${stroke}; }`);
      const s = await phaseDScan(tab, plan(F_O));
      return (await phaseDPixels(tab, s))[0]!;
    };
    const dark = await at("#1f1d1b", "#ffffff");
    const pale = await at("#d9d2c6", "#ffffff");
    const onDark = await at("#d9d2c6", "#1f1d1b");
    // the measured contrast follows the colours' own contrast (no font-specific number is pinned)
    expect(dark.contrast).toBeGreaterThanOrEqual(PHASE_D_LIMITS.contrastMin);
    expect(dark.contrast).toBeLessThanOrEqual(contrastOf([0x1f, 0x1d, 0x1b], [255, 255, 255]) + 0.01);
    expect(pale.contrast).toBeLessThan(PHASE_D_LIMITS.contrastMin);
    expect(onDark.contrast).toBeGreaterThanOrEqual(PHASE_D_LIMITS.contrastMin);
    expect(pale.codes).toEqual(["PHASE_D_OUTLINE_LOW_CONTRAST"]);
    expect(dark.codes).toEqual([]);
  });

  it("phase C interplay: a rotated text-free bar over the fact is phase C's (paint above), not phase D's", async () => {
    const body = `<div class="wrap"><p>${FACT}</p><div class="r"></div></div>`;
    const css = ".r { width: 200px; height: 6px; margin-top: -24px; background: #c79a45; transform: rotate(4deg); }";
    expect(await full(body, css, F_R)).toEqual([]);
    await load(body, css);
    expect(overlapCodes(await overlapScan(tab, { protect: [FACT], ordinary: "plate" }))).toContain("OVERLAP_PAINT_ABOVE_PROTECTED");
  });

  it("phase C interplay: its glyph boxes do not follow a rotation, and its pixel pass does not see a stroke", async () => {
    // a rotated word: phase C measures the ink unrotated, so ink lies outside its boxes (fail closed: it already stops)
    await load('<div class="wrap"><p class="r">継ぎ目の線</p></div>', ".r { width: max-content; font-size: 64px; line-height: 1; transform: rotate(8deg); }");
    expect(Object.keys((await pixelPass(tab, { protect: [FACT], ordinary: "plate" })).codes)).toContain("PIXEL_INK_OUTSIDE_GLYPHS");
    // a stroke reaching the next line's ink. The gap is set from this machine's own ink (no font metric is pinned): two
    // lines of 一 (flat bars) 2px apart in ink; a 3px stroke (1.5px outward) closes it along the bar. Phase C's geometry
    // (ink + 1px) and its pixel pass (which draws text with the stroke off) see nothing; phase D's ink check does.
    const body = '<div class="wrap"><p class="a">一一</p><p class="b">一一</p></div>';
    const css = (m: number, extra: string) => `.a, .b { font-size: 72px; line-height: 1; } .b { margin-top: ${m}px; } ${extra}`;
    const a = await inkRows(body, css(0, ".b { color: transparent; }"));
    const b = await inkRows(body, css(0, ".a { color: transparent; }"));
    const m = -(b[0] - a[1]) + 2;
    const stroked = css(m, ".a { -webkit-text-stroke: 3px #1f1d1b; }");
    expect((await inkRows(body, css(m, ".a { color: transparent; }")))[0] - (await inkRows(body, css(m, ".b { color: transparent; }")))[1]).toBe(2);
    await load(body, stroked);
    const c = await overlapScan(tab, { protect: [FACT], ordinary: "plate" });
    const px = await pixelPass(tab, { protect: [FACT], ordinary: "plate" });
    expect([...overlapCodes(c), ...Object.keys(px.codes)]).toEqual([]);
    expect(codeNames(await full(body, stroked, F_O))).toEqual(["PHASE_D_INK_ON_TEXT"]);
    // without the stroke the same two words are clear
    expect(await full(body, css(m, ".a { -webkit-text-stroke: 0.5px #1f1d1b; }"), F_O)).toEqual([]);
  });
});

// ---------------------------------------------------------------- 4. the three shops

/** One page per shop variant and emulation mode, reloaded at each width (PagePool): no new renderer process per width. */
const newPool = () => new PagePool((p, w, mobile) => openCompPage(browser, p, { width: w, height: 900, scale: 1, mobile }));

describe("DEV-175 the three shops (strict B + one feature at a time)", () => {
  it("at the checked widths (SP with phone emulation): each feature adds no phase D code (geometry and pixels) and no phase C instance; the strict page is the oracle", async () => {
    const log: string[] = [];
    const pool = newPool();
    try {
      for (const shop of SHOP_KEYS)
        for (const w of CHECKED) {
          const strict = await pool.at(`${shop}/strict`, phaseDPage(shop, "strict"), w, w <= 390);
          const s0 = await phaseDScan(strict, shopPlanD(shop, ALL));
          const base = fullInstances(s0, await phaseDPixels(strict, s0));
          const baseC = instanceCodes(await overlapScan(strict, shopPlan(shop)));
          // strict uses none of the three features: only the page-level scroll can appear
          expect(codeNames(base).filter((c) => c !== "PHASE_D_HORIZONTAL_SCROLL"), `${shop} ${w} strict`).toEqual([]);
          for (const f of PHASE_D_FEATURES) {
            const page = await pool.at(`${shop}/${f}`, phaseDPage(shop, f), w, w <= 390);
            const s = await phaseDScan(page, shopPlanD(shop, { [f]: true }));
            const px = await phaseDPixels(page, s);
            const got = fullInstances(s, px);
            const c = instanceCodes(await overlapScan(page, shopPlan(shop)));
            log.push(`${shop} ${w} ${f}: targets ${px.map((r) => `${r.text}(${r.kind} ink ${r.inkPixels} contrast ${r.contrast})`).join(" ") || "-"}; phase C ${c.length === baseC.length ? "=" : c.join(",")}`);
            expect(got, `${shop} ${w} ${f}`).toEqual(base);
            expect(c, `${shop} ${w} ${f} phase C`).toEqual(baseC);
            // the feature is really there (not a no-op)
            if (f === "vertical") expect(s.vertical, `${shop} ${w}`).toBeGreaterThan(0);
            if (f === "outline") expect(px.length, `${shop} ${w} ${f}`).toBeGreaterThan(0);
            if (f === "rotation") expect(await page.evaluate(`Array.from(document.querySelectorAll("body *")).filter((e) => getComputedStyle(e).transform !== "none").length`), `${shop} ${w}`).toBeGreaterThan(0);
          }
        }
    } finally {
      await pool.close();
    }
    console.log(`DEV-175 shops at the checked widths\n${log.join("\n")}`);
  }, 1_800_000);

  it("the 1px sweep 320–1920 (geometry): each feature gives exactly the strict page's instances at every width", async () => {
    for (const shop of SHOP_KEYS) {
      const o = await openCompPage(browser, phaseDPage(shop, "strict"), { width: 1920, height: 900, scale: 1, mobile: false });
      let strict;
      try {
        strict = await phaseDSweep(o.page, shopPlanD(shop, ALL), 320, 1920);
      } finally {
        await o.context.close();
      }
      expect(strict.measured).toBe(1601);
      const ranges: string[] = [`strict ${JSON.stringify(phaseDRanges(strict))} ${strict.ms}ms`];
      for (const f of PHASE_D_FEATURES) {
        const v = await openCompPage(browser, phaseDPage(shop, f), { width: 1920, height: 900, scale: 1, mobile: false });
        try {
          const s = await phaseDSweep(v.page, shopPlanD(shop, { [f]: true }), 320, 1920);
          ranges.push(`${f} ${JSON.stringify(phaseDRanges(s))} ${s.ms}ms`);
          expect(s.measured).toBe(1601);
          expect(s.failing, `${shop} ${f}`).toEqual(strict.failing);
        } finally {
          await v.context.close();
        }
      }
      console.log(`DEV-175 sweep ${shop}: ${ranges.join(" | ")}`);
    }
  }, 2_400_000);

  it("C′ (recorded; it uses all three and more): at 1440 / 768 / 390, phase D with every flag stops each page", async () => {
    const rec: string[] = [];
    for (const shop of SHOP_KEYS) {
      const seen = new Set<string>();
      for (const w of [1440, 768, 390]) {
        const o = await openCompPage(browser, cPrimePageD(shop), { width: w, height: 900, scale: 1, mobile: w <= 390 });
        try {
          const s = await phaseDScan(o.page, shopPlanD(shop, ALL));
          const got = codeNames(fullInstances(s, await phaseDPixels(o.page, s)));
          for (const c of got) seen.add(c);
          rec.push(`${shop} ${w}: ${got.join(", ")}`);
        } finally {
          await o.context.close();
        }
      }
      // the font-independent reasons: tsugute and bicycle set a fact vertically (漆が乾くまで… .month-fact / 修理の前に…
      // .check-fact); sento rotates
      // boards that hold captions (readable text)
      expect([...seen], shop).toContain({ tsugute: "PHASE_D_PROTECTED_VERTICAL", bicycle: "PHASE_D_PROTECTED_VERTICAL", sento: "PHASE_D_ROTATED_TEXT" }[shop]);
    }
    console.log(`DEV-175 C′\n${rec.join("\n")}`);
  });
});
