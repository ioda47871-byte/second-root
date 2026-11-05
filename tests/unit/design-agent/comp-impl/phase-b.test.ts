import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cssProblems, type CompPage } from "@/lib/design-agent/comp-impl/page";
import type { PageCssOptions } from "@/lib/design-agent/comp-impl/page-css";
import { displayWordsOf, GRADIENT_CODES_JS, gradientLineLength, gradientProblems, phaseBCheck, phaseBCodes, stopPositions, TYPE_ROLE_CAPS, type Gradient, type PhaseBScan } from "@/lib/design-agent/comp-impl/phase-b";
import { displaySweepPass, layerScan, legibilityPass, legibilitySweep, openCompPage, pageWidths, phaseBScan, sweepWidths, unmeasuredWidths, MOBILE } from "@/lib/design-agent/comp-impl/render";
import { layerCodes } from "@/lib/design-agent/comp-impl/verify";
import { runCompImpl } from "@/lib/design-agent/comp-impl/run";
import { buildSyntheticBundle } from "@/lib/design-agent/comp-impl/synthetic";
import { APPROVED_CAPABILITIES, CAPABILITY_NAMES, CAPABILITY_OPTION_KEYS, checkCompSpec, infoPairs, pageCssOptionsOf, PHASE_B_CAPABILITIES, type CapabilityName } from "@/lib/design-agent/comp-impl/spec";
import { factStrings, parseShop } from "@/lib/design-agent/compare/shops";
import { FACTS_SOURCE, FIXTURE, launch, pageCopy, privateTemp, removeDir, REPO } from "./support";

// DEV-164 (Issue #193, phase B implementation draft): docs/design/phase-b-design.md. Every phase-B capability is behind
// its PageCssOptions key and NONE is approved, so the run never turns one on. These tests turn the options on directly
// (the static grammar, and the render passes with a plan) to show each must-fail example of the design fails WITH the
// flag, that the flags off change nothing, and that the computed type cap closes the existing rem gap.

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const ALL_ON: PageCssOptions = { displayScale: true, displayNowrap: true, colourSyntax: true, gradientGround: true, translucentDecoration: true };
const decl = (d: string) => `.x { ${d} }`;

// ---------------------------------------------------------------- static grammar

/** Per capability: declarations its flag admits, and the design's must-fail examples that stay refused with every flag on. */
const STATIC: Record<string, { option: keyof PageCssOptions; allowed: string[]; refused: Array<[string, string[]]> }> = {
  display_scale: {
    option: "displayScale",
    allowed: ["font-size: 300px;", "font-size: 640px;", "font-size: 40rem;", "font-size: 12px;"],
    refused: [
      ["font-size: 641px;", ["CSS_VALUE"]],
      ["font-size: 41rem;", ["CSS_VALUE"]],
      ["font-size: calc(300px);", ["CSS_VALUE"]], // calc() past the cap
      ["font-size: calc(20rem + 20rem);", ["CSS_VALUE"]],
      ["font-size: clamp(12px, 300px, 640px);", ["CSS_VALUE"]],
      ["font-size: max(12px, 300px);", ["CSS_VALUE"]],
      ["font-size: 30em;", ["CSS_VALUE"]], // em compounds
      ["font-size: 300%;", ["CSS_VALUE"]],
      ["font-size: 30vw;", ["CSS_VALUE", "CSS_VIEWPORT_UNIT"]],
    ],
  },
  display_nowrap: {
    option: "displayNowrap",
    allowed: ["white-space: nowrap;", "word-break: keep-all;", "white-space: normal;"],
    refused: [
      ["white-space: pre;", ["CSS_VALUE"]],
      ["white-space: pre-wrap;", ["CSS_VALUE"]],
      ["text-wrap: nowrap;", ["CSS_VALUE"]],
      ["letter-spacing: -0.02em;", ["CSS_VALUE"]], // negative tracking is not part of N2
    ],
  },
  colour_syntax: {
    option: "colourSyntax",
    allowed: ["color: hsl(30 50% 40%);", "color: hsl(30, 50%, 40%);", "color: hsla(30, 50%, 40%, 0.5);", "color: oklch(0.6 0.1 40);", "color: oklch(60% 0.1 40 / 0.8);", "color: oklab(0.6 0.1 -0.1);", "color: rebeccapurple;", "border-left: 3px solid tomato;", "background: hsl(30 50% 90%);"],
    refused: [
      ["color: light-dark(#000, #fff);", ["CSS_VALUE"]],
      ["color: color-mix(in srgb, hsl(30 50% 40%), #fff);", ["CSS_VALUE"]], // a phase-B colour inside color-mix
      ["color: hsl(from #000 h s l);", ["CSS_VALUE"]], // relative colour
      ["color: hsl(calc(30) 50% 40%);", ["CSS_VALUE"]],
      ["color: hsl(none 50% 40%);", ["CSS_VALUE"]],
      ["color: hsl(30 50% 40%, 0.5);", ["CSS_VALUE"]],
      ["color: oklch(0.6 0.1 40 0.5);", ["CSS_VALUE"]],
      ["color: lab(50 20 20);", ["CSS_VALUE"]],
      ["color: color(display-p3 1 0 0);", ["CSS_VALUE"]],
      ["color: hsl(var(--p-text));", ["CSS_VALUE"]],
      ["color: notacolour;", ["CSS_VALUE"]],
      ["font-family: tomato;", ["CSS_VALUE"]], // a colour name only where a colour goes
    ],
  },
  gradient_ground: {
    option: "gradientGround",
    allowed: [
      "background: linear-gradient(#000, #fff);",
      "background: linear-gradient(to right, #EAE1D2 10%, #D9CFBE 90%);",
      "background: linear-gradient(to top left, #000, #fff);",
      "background: linear-gradient(45deg, #000, #fff);",
      "background-image: radial-gradient(#000, #fff);",
      "background-image: radial-gradient(circle, #000, #fff);",
      "background-image: none;",
      "background: #f1ebdf;",
      "background: linear-gradient(#000,#111,#222,#333,#444,#555,#666,#777);",
      "background: linear-gradient(#000f, #ffffffff);", // a hex alpha of f / ff is opaque
      "background: linear-gradient(rgb(0 0 0 / 1), rgba(255, 255, 255, 100%));",
      "background: linear-gradient(white, black);",
    ],
    refused: [
      ["background: linear-gradient(url(a.png), #fff);", ["CSS_SYNTAX_URL"]],
      ["background-image: url(a.png);", ["CSS_SYNTAX_URL"]],
      [`background-image: image-set("a.png" 1x);`, ["CSS_VALUE"]],
      [`background-image: -webkit-image-set("a.png" 1x);`, ["CSS_VALUE"]],
      [`background: image-set("a.png" 1x);`, ["CSS_VALUE"]],
      [`background: -webkit-image-set("a.png" 1x);`, ["CSS_VALUE"]],
      [`background-image: linear-gradient(#000, #fff), image-set("a.png" 1x);`, ["CSS_VALUE"]],
      ["background: repeating-linear-gradient(#000, #fff);", ["CSS_VALUE"]],
      ["background-image: repeating-radial-gradient(#000, #fff);", ["CSS_VALUE"]],
      ["background: conic-gradient(#000, #fff);", ["CSS_VALUE"]],
      ["background: linear-gradient(#000,#111,#222,#333,#444,#555,#666,#777,#888);", ["CSS_VALUE"]], // 9 stops
      ["background: linear-gradient(#000);", ["CSS_VALUE"]],
      ["background: linear-gradient(#000 0% 50%, #fff);", ["CSS_VALUE"]], // a double position (a hard band)
      ["background: linear-gradient(#000 10px, #fff);", ["CSS_VALUE"]],
      ["background: linear-gradient(#000 calc(10%), #fff);", ["CSS_VALUE"]],
      ["background: linear-gradient(var(--p-bg), #fff);", ["CSS_VALUE"]],
      ["background: linear-gradient(to top bottom, #000, #fff);", ["CSS_VALUE"]],
      ["background-image: radial-gradient(circle at top, #000, #fff);", ["CSS_VALUE"]],
      ["background-image: radial-gradient(10px, #000, #fff);", ["CSS_VALUE"]],
      ["background: #fff linear-gradient(#000, #fff);", ["CSS_VALUE"]],
      ["background: linear-gradient(#000, #fff), linear-gradient(#000, #fff);", ["CSS_VALUE"]],
      // Fresh Review round 2, M1: a stop below full alpha (the stop rule compares RGB only)
      ["background: linear-gradient(#000, transparent);", ["CSS_VALUE"]],
      ["background: linear-gradient(#000 50%, transparent 50%);", ["CSS_VALUE"]],
      ["background: linear-gradient(#000, #0000);", ["CSS_VALUE"]],
      ["background: linear-gradient(#000, #00000000);", ["CSS_VALUE"]],
      ["background: linear-gradient(#000, #000e);", ["CSS_VALUE"]],
      ["background: linear-gradient(#000, rgba(0,0,0,.05));", ["CSS_VALUE"]],
      ["background: linear-gradient(#000, rgb(0 0 0 / 0.5));", ["CSS_VALUE"]],
      ["background: linear-gradient(#000, rgba(0, 0, 0, 99%));", ["CSS_VALUE"]],
      ["background-image: linear-gradient(transparent, #fff);", ["CSS_VALUE"]],
      ["background: linear-gradient(currentcolor, #fff);", ["CSS_VALUE"]],
      ["background: linear-gradient(color-mix(in srgb, #000 20%, #fff 20%), #fff);", ["CSS_VALUE"]],
      ["background: linear-gradient(color-mix(in srgb, #000, #fff), #fff);", ["CSS_VALUE"]],
      ["background: radial-gradient(circle, #000, transparent);", ["CSS_VALUE"]],
      ["background-size: 10px 10px;", ["CSS_PROPERTY"]],
      ["background-clip: text;", ["CSS_PROPERTY"]],
      ["cross-fade: none;", ["CSS_PROPERTY"]],
    ],
  },
  translucent_decoration: {
    option: "translucentDecoration",
    allowed: ["opacity: 0.5;", "opacity: 0.1;", "opacity: 1;"],
    refused: [
      ["opacity: 0.05;", ["CSS_VALUE"]],
      ["opacity: 0;", ["CSS_VALUE"]],
      ["opacity: 50%;", ["CSS_VALUE"]],
      ["filter: opacity(0.5);", ["CSS_PROPERTY"]],
      ["mix-blend-mode: multiply;", ["CSS_PROPERTY"]],
    ],
  },
};

describe("DEV-164 phase B: the static grammar behind the flags", () => {
  it("covers exactly the implemented capabilities, each with its own option key", () => {
    expect(Object.keys(STATIC).sort()).toEqual([...PHASE_B_CAPABILITIES].sort());
    for (const [name, s] of Object.entries(STATIC)) expect(CAPABILITY_OPTION_KEYS[name as CapabilityName]).toBe(s.option);
  });

  for (const [name, s] of Object.entries(STATIC)) {
    describe(name, () => {
      it.each(s.allowed)("flag on admits %s", (d) => {
        expect(cssProblems(decl(d), { [s.option]: true })).toEqual([]);
        expect(cssProblems(decl(d), ALL_ON)).toEqual([]);
      });
      it.each(s.allowed.filter((d) => cssProblems(decl(d)).length > 0))("flag off refuses %s (as today)", (d) => {
        expect(cssProblems(decl(d)).length).toBeGreaterThan(0);
        // every OTHER flag on does not admit it either: a flag widens only its own declarations
        const others = Object.fromEntries(Object.values(STATIC).filter((o) => o.option !== s.option).map((o) => [o.option, true]));
        expect(cssProblems(decl(d), others)).toEqual(cssProblems(decl(d)));
      });
      it.each(s.refused)("refuses %s even with every flag on", (d, codes) => {
        expect(cssProblems(decl(d), ALL_ON)).toEqual(codes);
        expect(cssProblems(decl(d)).length).toBeGreaterThan(0);
      });
    });
  }

  it("gradient_ground with colour_syntax: opaque phase-B stop colours pass, any alpha below 1 is refused (Fresh Review round 2, M1)", () => {
    const on = { gradientGround: true, colourSyntax: true };
    for (const ok of ["hsl(30 50% 40%)", "hsl(30 50% 40% / 1)", "hsla(30, 50%, 40%, 1)", "oklch(0.6 0.1 40)", "oklch(60% 0.1 40 / 100%)", "oklab(0.6 0.1 -0.1)", "rebeccapurple"])
      expect(cssProblems(decl(`background: linear-gradient(${ok}, #fff);`), on), ok).toEqual([]);
    for (const bad of ["hsl(30 50% 40% / 0.5)", "hsla(30, 50%, 40%, 0.5)", "hsla(30, 50%, 40%, 0%)", "oklch(0.6 0.1 40 / 0.99)", "oklab(0.6 0.1 -0.1 / 50%)", "transparent"])
      expect(cssProblems(decl(`background: linear-gradient(${bad}, #fff);`), on), bad).toEqual(["CSS_VALUE"]);
    // the colour itself stays allowed where a colour goes (colour_syntax does not refuse alpha; only gradient stops do)
    expect(cssProblems(decl("color: hsl(30 50% 40% / 0.5);"), on)).toEqual([]);
    expect(cssProblems(decl("background: rgba(0, 0, 0, 0.05);"), on)).toEqual([]);
  });

  it("keeps the generic refusals with every flag on (url, @import, @font-face, pseudo-elements, positioning)", () => {
    expect(cssProblems(`@import "x.css";`, ALL_ON)).toEqual(["CSS_AT_RULE"]);
    expect(cssProblems(`@font-face { font-family: "P"; src: local("P"); }`, ALL_ON)).toEqual(["CSS_AT_RULE"]);
    expect(cssProblems(`.x::before { content: ""; }`, ALL_ON)).toEqual(["CSS_PROPERTY", "CSS_PSEUDO_ELEMENT"]);
    expect(cssProblems(decl("position: relative;"), ALL_ON)).toEqual(["CSS_VALUE"]);
    expect(cssProblems(decl("z-index: 1;"), ALL_ON)).toEqual(["CSS_PROPERTY"]);
    expect(cssProblems(decl("filter: grayscale(1);"), ALL_ON)).toEqual(["CSS_PROPERTY"]);
    expect(cssProblems(decl("margin-top: -10px;"), ALL_ON)).toEqual(["CSS_VALUE"]);
  });
});

// ---------------------------------------------------------------- spec, approval, worker path

const SPEC = JSON.parse(readFileSync(join(FIXTURE, "layout-spec.json"), "utf8")) as Record<string, unknown>;

describe("DEV-164 phase B: who can turn a flag on", () => {
  it("approves gradient_ground alone (DEV-180 production draft; before: nothing)", () => {
    expect([...APPROVED_CAPABILITIES]).toEqual(["gradient_ground"]);
    expect(CAPABILITY_NAMES).toEqual(expect.arrayContaining([...PHASE_B_CAPABILITIES]));
  });

  it.each(PHASE_B_CAPABILITIES.filter((c) => c !== "gradient_ground"))("refuses a spec declaring %s (not approved)", (name) => {
    const r = checkCompSpec({ ...SPEC, capabilities: [name] });
    expect(r.ok).toBe(false);
    expect(r.ok ? [] : r.problems).toEqual(["SPEC_CAPABILITY_NOT_APPROVED"]);
  });

  it("accepts a spec declaring gradient_ground (DEV-180), and with it alone turns gradientGround on", () => {
    expect(checkCompSpec({ ...SPEC, capabilities: ["gradient_ground"] }).ok).toBe(true);
    expect(checkCompSpec({ ...SPEC, capabilities: ["gradient_ground", "colour_syntax"] })).toEqual({ ok: false, problems: ["SPEC_CAPABILITY_NOT_APPROVED"] });
  });

  it("turns no option on for any declared capability but the approved gradient_ground", () => {
    for (const name of CAPABILITY_NAMES) expect(pageCssOptionsOf({ capabilities: [name] })).toEqual(name === "gradient_ground" ? { gradientGround: true } : {});
    expect(pageCssOptionsOf({})).toEqual({});
  });

  it("turns a key on only for a capability both declared and approved", () => {
    expect(pageCssOptionsOf({ capabilities: ["display_scale", "colour_syntax"] }, ["display_scale"])).toEqual({ displayScale: true });
    expect(pageCssOptionsOf({ capabilities: ["colour_syntax"] }, ["display_scale"])).toEqual({});
    expect(pageCssOptionsOf({ capabilities: [...CAPABILITY_NAMES] }, [...CAPABILITY_NAMES])).toEqual({ verticalName: true, ...ALL_ON });
  });

  it("keeps the spec's display size at 16–160 unless display_scale is declared and approved", () => {
    const big = { ...SPEC, type_scale: { ...(SPEC.type_scale as object), display_px: 400 } };
    expect(checkCompSpec(big)).toEqual({ ok: false, problems: ["SPEC_SHAPE"] });
    expect(checkCompSpec({ ...big, capabilities: ["display_scale"] })).toEqual({ ok: false, problems: ["SPEC_SHAPE"] });
    expect(checkCompSpec(big, ["display_scale"])).toEqual({ ok: false, problems: ["SPEC_SHAPE"] });
    expect(checkCompSpec({ ...big, capabilities: ["display_scale"] }, ["display_scale"]).ok).toBe(true);
    const over = { ...SPEC, type_scale: { ...(SPEC.type_scale as object), display_px: 641 }, capabilities: ["display_scale"] };
    expect(checkCompSpec(over, ["display_scale"])).toEqual({ ok: false, problems: ["SPEC_SHAPE"] });
    expect(checkCompSpec(SPEC).ok).toBe(true);
  });

  it("run.ts derives the options only from the spec through pageCssOptionsOf (no approved list, no literal flag)", () => {
    const src = readFileSync(resolve(REPO, "lib/design-agent/comp-impl/run.ts"), "utf8");
    expect(src.match(/pageCssOptionsOf\([^)]*\)/g)).toEqual(["pageCssOptionsOf(bundle.spec)"]);
    expect(src).toContain("const cssOptions = pageCssOptionsOf(bundle.spec);");
    expect(src).toContain("cssProblems(page.css, cssOptions)");
    expect(src).not.toMatch(/APPROVED_CAPABILITIES|CAPABILITY_OPTION_KEYS/);
    const runOptions = src.match(/export type RunOptions = \{[\s\S]*?\n\};/)![0];
    expect(runOptions).not.toMatch(/approved|capabilit|css|flag/i);
  });

  it("the worker path passes no flag: it calls runCompImpl only, never the CSS check or the options", () => {
    const src = readFileSync(resolve(REPO, "scripts/sales-design-worker/comp-impl-poc.ts"), "utf8");
    expect(src).toMatch(/runCompImpl\(/);
    expect(src).not.toMatch(/cssProblems|pageCssProblems|pageCssOptionsOf|PageCssOptions|APPROVED_CAPABILITIES|capabilit/i);
  });
});

// ---------------------------------------------------------------- pure render-side maths

const scanOf = (o: Partial<PhaseBScan> = {}): PhaseBScan => ({
  type: { max: 16, above: 0, list: [] },
  nowrap: { notDisplay: 0, list: [] },
  broken: [],
  grounds: { hasText: 0, underText: 0, list: [] },
  gradients: { count: 0, codes: [] },
  translucent: { hasText: 0, underText: 0, count: 0 },
  ...o,
});

describe("DEV-164 phase B: pure checks", () => {
  it("bounds the gradient line from below", () => {
    expect(gradientLineLength({ kind: "linear", config: null, w: 400, h: 100 })).toBe(100);
    expect(gradientLineLength({ kind: "linear", config: "to right", w: 400, h: 100 })).toBe(400);
    expect(gradientLineLength({ kind: "linear", config: "to top left", w: 400, h: 100 })).toBe(100);
    expect(gradientLineLength({ kind: "linear", config: "90deg", w: 400, h: 100 })).toBeCloseTo(400);
    expect(gradientLineLength({ kind: "linear", config: "45deg", w: 100, h: 100 })).toBeCloseTo(141.42, 1);
    expect(gradientLineLength({ kind: "radial", config: "circle", w: 400, h: 100 })).toBe(50);
    expect(gradientLineLength({ kind: "linear", config: "from somewhere", w: 400, h: 100 })).toBeNull();
    expect(gradientLineLength({ kind: "unknown", config: null, w: 400, h: 100 })).toBeNull();
  });

  it("fixes up stop positions as CSS does", () => {
    expect(stopPositions([null, null], 100)).toEqual([0, 100]);
    expect(stopPositions([null, null, null], 200)).toEqual([0, 100, 200]);
    expect(stopPositions([10, null, 90], 100)).toEqual([10, 50, 90]);
    expect(stopPositions([50, 20, null], 100)).toEqual([50, 50, 100]); // never backwards
  });

  it("applies the V3b stop rule and fails closed on what it cannot measure", () => {
    const g = (stops: Array<[number[], number | null]>, config: string | null = null, h = 300) => ({ kind: "linear" as const, config, w: 400, h, stops: stops.map(([rgb, pct]) => ({ rgb: rgb as [number, number, number], pct })) });
    expect(gradientProblems(g([[[234, 225, 210], null], [[217, 207, 190], null]]))).toEqual([]);
    expect(gradientProblems(g([[[0, 0, 0], 50], [[255, 255, 255], 50]]))).toContain("GRADIENT_HARD_STOP");
    expect(gradientProblems(g([[[0, 0, 0], null], [[255, 255, 255], null]], null, 100))).toEqual(["GRADIENT_TOO_STEEP"]);
    expect(gradientProblems(g([[[0, 0, 0], null], [[255, 255, 255], null]], "sideways"))).toEqual(["GRADIENT_UNMEASURED"]);
    expect(gradientProblems({ ...g([[[0, 0, 0], null]]), stops: [{ rgb: null, pct: null }, { rgb: [0, 0, 0], pct: null }] })).toEqual(["GRADIENT_UNMEASURED"]);
  });

  it("maps each finding to its code", () => {
    expect(phaseBCodes(scanOf())).toEqual([]);
    expect(phaseBCodes(scanOf({ type: { max: 300, above: 1, list: [] } }))).toEqual(["TYPE_ABOVE_ROLE_CAP"]);
    expect(phaseBCodes(scanOf({ nowrap: { notDisplay: 1, list: [] }, broken: ["x"] }))).toEqual(["DISPLAY_WORD_BROKEN", "NOWRAP_NOT_DISPLAY"]);
    expect(phaseBCodes(scanOf({ grounds: { hasText: 1, underText: 1, list: [] }, translucent: { hasText: 1, underText: 1, count: 2 } }))).toEqual(["GROUND_HAS_TEXT", "GROUND_UNDER_TEXT", "TRANSLUCENT_HAS_TEXT", "TRANSLUCENT_UNDER_TEXT"]);
    expect(phaseBCodes(scanOf({ gradients: { count: 41, codes: ["GRADIENT_HARD_STOP"] } }))).toEqual(["GRADIENT_HARD_STOP"]);
  });

  it("a width without a scan fails (PHASE_B_UNMEASURED); a display sweep failure fails", () => {
    expect(phaseBCheck([{ width: 390 }]).codes).toEqual(["PHASE_B_UNMEASURED"]);
    expect(phaseBCheck([{ width: 390, phaseB: scanOf() }]).ok).toBe(true);
    expect(phaseBCheck([{ width: 390, phaseB: scanOf() }], { failing: [{ w: 400, codes: ["DISPLAY_OFFSCREEN"] }], targets: 1, ms: 1, blocked: 0 }).codes).toEqual(["DISPLAY_OFFSCREEN"]);
  });

  it("the 1px sweep fails closed on widths it did not measure (PHASE_B_UNMEASURED; Fresh Review round 2, L3)", () => {
    expect(unmeasuredWidths([{ from: 320, to: 1920, measured: 1601 }], 320, 1920)).toEqual([]);
    expect(unmeasuredWidths([{ from: 320, to: 600, measured: 281 }, { from: 601, to: 1920, measured: 1320 }], 320, 1920)).toEqual([]);
    // a short count leaves the tail of its run unmeasured
    expect(unmeasuredWidths([{ from: 320, to: 400, measured: 79 }], 320, 400)).toEqual([{ w: 399, codes: ["PHASE_B_UNMEASURED"] }, { w: 400, codes: ["PHASE_B_UNMEASURED"] }]);
    expect(unmeasuredWidths([{ from: 320, to: 330, measured: 0 }], 320, 330)).toHaveLength(11);
    expect(unmeasuredWidths([{ from: 320, to: 330, measured: -5 }], 320, 330)).toHaveLength(11);
    // a count above the run's length measures nothing beyond it; a width no run asked for is unmeasured
    expect(unmeasuredWidths([{ from: 320, to: 324, measured: 99 }], 320, 326).map((f) => f.w)).toEqual([325, 326]);
    expect(unmeasuredWidths([{ from: 320, to: 400, measured: 81 }, { from: 402, to: 500, measured: 99 }], 320, 500).map((f) => f.w)).toEqual([401]);
    expect(unmeasuredWidths([], 320, 322).map((f) => f.w)).toEqual([320, 321, 322]);
    // and it fails the check
    const sweep = { failing: unmeasuredWidths([{ from: 320, to: 400, measured: 80 }], 320, 400), targets: 0, ms: 1, blocked: 0 };
    expect(phaseBCheck([{ width: 390, phaseB: scanOf() }], sweep)).toMatchObject({ ok: false, codes: ["PHASE_B_UNMEASURED"] });
  });

  it("display words are the shop name and the fixed labels only", () => {
    const words = displayWordsOf("架空 菓庵");
    expect(words[0]).toBe("架空菓庵");
    expect(words).toContain("店舗情報を見る");
    expect(words).not.toContain("名古屋市東区テスト町一丁目2-3");
  });
});

// ---------------------------------------------------------------- the render checks (Chromium)

const demo = parseShop(JSON.parse(readFileSync(FACTS_SOURCE, "utf8")) as unknown)!.demo;
const facts = factStrings(demo).map((f) => f.text.replace(/\s+/g, ""));
const required = [demo.name, demo.hours!, demo.closedDays!, demo.address!, demo.access!, demo.phone!, demo.description!].map((f) => f.replace(/\s+/g, ""));
const WORDS = displayWordsOf(demo.name);
const HTML = readFileSync(join(FIXTURE, "page/index.html"), "utf8");
const CSS = readFileSync(join(FIXTURE, "page/style.css"), "utf8");
const rawPage = (html: string, css: string): CompPage => ({ dir: "", html, css, assets: [], files: new Map(), htmlSha256: "", cssSha256: "" });
const synthetic = (css = "", html: (s: string) => string = (s) => s) => rawPage(html(HTML), `${CSS}\n${css}\n`);
const planOf = (css: PageCssOptions = {}) => ({ pairs: infoPairs(demo), facts, css, displayWords: WORDS });

let browser: Browser;
let raw: BrowserContext;
let tab: Page;
beforeAll(async () => {
  browser = await launch();
  raw = await browser.newContext({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 1 });
  await raw.route("**/*", (route) => route.abort());
  tab = await raw.newPage();
});
let bundleDir: string | undefined;
async function bundle(): Promise<string> {
  if (!bundleDir) {
    bundleDir = await privateTemp("pb-bundle-");
    await buildSyntheticBundle(browser, REPO, bundleDir);
  }
  return bundleDir;
}
afterAll(async () => {
  if (bundleDir) await removeDir(bundleDir);
  await raw?.close();
  await browser?.close();
});

const BASE = 'body { margin: 0; font-family: "IPAGothic", sans-serif; font-size: 16px; line-height: 1.5; color: #1F1D1B; }';
/** Phase B codes of a raw page at one width (raw HTML: the allowlist is NOT applied; the flags only change the arguments). */
async function codesOf(body: string, css: string, o: { width?: number; css?: PageCssOptions } = {}): Promise<string[]> {
  await tab.setViewportSize({ width: o.width ?? 1000, height: 800 });
  await tab.setContent(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>${BASE}\n${css}</style></head><body>${body}</body></html>`);
  return phaseBCodes(await phaseBScan(tab, { css: o.css ?? {}, displayWords: WORDS }));
}
/** Phase B codes of a page at a viewport, opened as the run opens it (phone emulation at 390 and below). */
async function pageCodes(page: CompPage, width: number, css: PageCssOptions = {}): Promise<string[]> {
  const o = await openCompPage(browser, page, { width, height: 900, scale: 1, mobile: width <= MOBILE.width });
  try {
    return phaseBCodes(await phaseBScan(o.page, { css, displayWords: WORDS }));
  } finally {
    await o.context.close();
  }
}

describe("DEV-164 phase B: computed type caps (TYPE_ABOVE_ROLE_CAP), flag or no flag", () => {
  it("passes the synthetic page at every checked width, desktop and phone", async () => {
    const page = synthetic();
    for (const w of pageWidths(page.css)) expect(await pageCodes(page, w), `${w}`).toEqual([]);
  });

  it("closes the rem gap: html 20px × 15rem = 300px on a fact paragraph passes the static check and fails the render", async () => {
    const extra = "html { font-size: 20px; } .goods-copy { font-size: 15rem; }";
    expect(cssProblems(`${CSS}\n${extra}`)).toEqual([]);
    expect(await pageCodes(synthetic(extra), 1440)).toEqual(["TYPE_ABOVE_ROLE_CAP"]);
    // a display-scale flag does not lift it: a fact paragraph is never a display word
    expect(await pageCodes(synthetic(extra), 1440, { displayScale: true })).toEqual(["TYPE_ABOVE_ROLE_CAP"]);
  });

  it("closes it on the phone too (a rule only below 400px)", async () => {
    const extra = "html { font-size: 20px; } @media (max-width: 400px) { .goods-copy { font-size: 15rem; } }";
    expect(cssProblems(`${CSS}\n${extra}`)).toEqual([]);
    expect(await pageCodes(synthetic(extra), 1440)).toEqual([]);
    expect(await pageCodes(synthetic(extra), 390)).toEqual(["TYPE_ABOVE_ROLE_CAP"]);
  });

  it("fails the whole run on that page (phase_b in failed), and passes the unchanged synthetic page", async () => {
    const dir = await pageCopy("pb-gap-");
    try {
      await writeFile(join(dir, "style.css"), `${CSS}\nhtml { font-size: 17px; } .goods-caption { font-size: 16rem; line-height: 1; }\n`);
      const bad = (await runCompImpl({ bundleDir: await bundle(), pageDir: dir, repoDir: REPO, factsSourcePath: FACTS_SOURCE, browser })).report;
      expect(bad.failed).toContain("phase_b");
      expect(bad.checks.phase_b!.codes).toContain("TYPE_ABOVE_ROLE_CAP");
      const good = (await runCompImpl({ bundleDir: await bundle(), pageDir: join(FIXTURE, "page"), repoDir: REPO, factsSourcePath: FACTS_SOURCE, browser })).report;
      expect(good.failed).toEqual([]);
      expect(good.checks.phase_b).toMatchObject({ ok: true, codes: [], display_sweep: null });
      expect(good.checks.phase_b!.max_font_px as number).toBeLessThanOrEqual(TYPE_ROLE_CAPS.text);
      expect(good.capabilities).toEqual([]);
    } finally {
      await removeDir(dir);
    }
  });

  it("catches em nesting and a root size (raw)", async () => {
    expect(await codesOf('<div class="a"><p class="b">052-000-0731</p></div>', ".a { font-size: 200px; } .b { font-size: 2em; }")).toEqual(["TYPE_ABOVE_ROLE_CAP"]);
    expect(await codesOf("<p>052-000-0731</p>", "html { font-size: 300px; } body { font-size: 1rem; }")).toEqual(["TYPE_ABOVE_ROLE_CAP"]);
    expect(await codesOf("<p>052-000-0731</p>", "p { font-size: 256px; }")).toEqual([]);
  });

  it("display_scale: a display word up to 640px only with the flag; never a fact, a dd or the disclosure; never above 640", async () => {
    const name = `<h1 class="n">${demo.name}</h1>`;
    expect(await codesOf(name, ".n { font-size: 300px; }")).toEqual(["TYPE_ABOVE_ROLE_CAP"]);
    expect(await codesOf(name, ".n { font-size: 300px; }", { width: 1440, css: { displayScale: true } })).toEqual([]);
    expect(await codesOf(name, ".n { font-size: 640px; }", { width: 1920, css: { displayScale: true } })).not.toContain("TYPE_ABOVE_ROLE_CAP");
    expect(await codesOf(name, "html { font-size: 64px; } .n { font-size: 11rem; }", { width: 1920, css: { displayScale: true } })).toContain("TYPE_ABOVE_ROLE_CAP");
    // the design's must-fail examples
    expect(await codesOf(`<p class="n">${demo.address}</p>`, ".n { font-size: 300px; }", { css: { displayScale: true } })).toEqual(["TYPE_ABOVE_ROLE_CAP"]);
    expect(await codesOf(`<dl><dt>住所</dt><dd class="n">${demo.name}</dd></dl>`, ".n { font-size: 300px; }", { css: { displayScale: true } })).toEqual(["TYPE_ABOVE_ROLE_CAP"]);
    expect(await codesOf(`<p data-comp-disclosure class="n">${demo.name}</p>`, ".n { font-size: 300px; }", { css: { displayScale: true } })).toEqual(["TYPE_ABOVE_ROLE_CAP"]);
    expect(await codesOf(`<h1 class="n">${demo.name}<span>x</span></h1>`, ".n { font-size: 300px; }", { css: { displayScale: true } })).toContain("TYPE_ABOVE_ROLE_CAP");
    expect(await codesOf(`<h1 class="n">${demo.name}と${demo.phone}</h1>`, ".n { font-size: 300px; }", { css: { displayScale: true } })).toEqual(["TYPE_ABOVE_ROLE_CAP"]);
  });

  it("display_scale: a display word broken inside a run (DISPLAY_WORD_BROKEN) with the flag; not looked at without it", async () => {
    const name = `<div class="box"><h1 class="n">店舗情報を見る</h1></div>`;
    const css = ".box { width: 500px; } .n { font-size: 200px; }";
    expect(await codesOf(name, css, { css: { displayScale: true } })).toEqual(["DISPLAY_WORD_BROKEN"]);
    expect(await codesOf(name, ".box { width: 500px; } .n { font-size: 200px; }")).toEqual([]);
    expect(await codesOf(`<div class="box"><h1 class="n">${demo.name}</h1></div>`, ".box { width: 900px; } .n { font-size: 200px; }", { css: { displayScale: true } })).toEqual([]);
  });
});

describe("DEV-164 phase B: display_nowrap", () => {
  it("refuses nowrap / keep-all on anything but a display word, inherited too (NOWRAP_NOT_DISPLAY)", async () => {
    const on = { css: { displayNowrap: true } };
    expect(await codesOf(`<p class="w">${demo.address}</p>`, ".w { white-space: nowrap; }", on)).toEqual(["NOWRAP_NOT_DISPLAY"]);
    expect(await codesOf(`<p class="w">${demo.address}</p>`, ".w { word-break: keep-all; }", on)).toEqual(["NOWRAP_NOT_DISPLAY"]);
    expect(await codesOf(`<div class="w"><h1>${demo.name}</h1><p>${demo.hours}</p></div>`, ".w { white-space: nowrap; }", on)).toEqual(["NOWRAP_NOT_DISPLAY"]);
    expect(await codesOf(`<h1 class="w">${demo.name}</h1>`, ".w { white-space: nowrap; }", on)).toEqual([]);
    expect(await codesOf(`<h1 class="w">${demo.name}</h1>`, ".w { word-break: keep-all; }", on)).toEqual([]);
  });

  it("the 1px display sweep: a nowrap display word that leaves its box or the page fails at the widths where it does", async () => {
    const page = rawPage(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div class="box"><h1 class="n">店舗情報を見る</h1></div></body></html>`, `${BASE}\n.box { margin: 0 16px; } .n { margin: 0; white-space: nowrap; font-size: 100px; }`);
    expect(cssProblems(page.css, { displayNowrap: true })).toEqual([]);
    expect(await displaySweepPass(browser, page, planOf({}))).toBeNull();
    const r = (await displaySweepPass(browser, page, planOf({ displayNowrap: true }), { range: [320, 900] }))!;
    expect(r.targets).toBe(1);
    const failing = r.failing.map((f) => f.w);
    // 7 glyphs × 100px = 700px + 32px of margins: fails below about 732px, passes above
    expect(failing).toContain(390);
    expect(failing).toContain(700);
    expect(failing).not.toContain(800);
    expect(r.failing.find((f) => f.w === 390)!.codes).toEqual(expect.arrayContaining(["DISPLAY_OFFSCREEN"]));
    expect(phaseBCheck([], r).codes).toEqual(expect.arrayContaining(["DISPLAY_OFFSCREEN"]));
  });

  it("the 1px display sweep stepped agrees with real resizes on that page", async () => {
    const page = rawPage(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div class="box"><h1 class="n">店舗情報を見る</h1></div></body></html>`, `${BASE}\n.box { margin: 0 16px; } .n { margin: 0; font-size: 100px; } @media (min-width: 600px) { .n { white-space: nowrap; } }`);
    const stepped = (await displaySweepPass(browser, page, planOf({ displayNowrap: true }), { range: [560, 780] }))!;
    const real = (await displaySweepPass(browser, page, planOf({ displayNowrap: true }), { range: [560, 780], forceReal: true }))!;
    expect(stepped.failing).toEqual(real.failing);
    expect(stepped.failing.length).toBeGreaterThan(0);
  });

  it("the 1px display sweep reports a width of its range that no run measured as PHASE_B_UNMEASURED (DEV-169: the wiring, not only unmeasuredWidths)", async () => {
    // mediaSegments stops at 1920, so a range reaching past it leaves 1921–1923 to no run: only the call from
    // displaySweepPass to unmeasuredWidths can report them (the page itself passes at every width it measures)
    const page = rawPage(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><h1 class="n">店舗情報を見る</h1></body></html>`, `${BASE}\n.n { margin: 0; white-space: nowrap; font-size: 32px; }`);
    for (const forceReal of [false, true]) {
      const r = (await displaySweepPass(browser, page, planOf({ displayNowrap: true }), { range: [1916, 1923], forceReal }))!;
      expect(r.targets).toBe(1);
      expect(r.failing).toEqual([1921, 1922, 1923].map((w) => ({ w, codes: ["PHASE_B_UNMEASURED"] })));
      expect(phaseBCheck([], r)).toMatchObject({ ok: false, codes: ["PHASE_B_UNMEASURED"] });
    }
    // the same page over a range the segments cover: nothing unmeasured, nothing failing
    expect((await displaySweepPass(browser, page, planOf({ displayNowrap: true }), { range: [1916, 1920] }))!.failing).toEqual([]);
  });
});

describe("DEV-164 phase B: gradient_ground (not under text)", () => {
  const GRAD = "background: linear-gradient(to right, #EAE1D2, #D9CFBE);";
  it("refuses a gradient on text or on a box holding text (GROUND_HAS_TEXT)", async () => {
    expect(await codesOf(`<p class="g">${demo.address}</p>`, `.g { ${GRAD} }`)).toEqual(["GROUND_HAS_TEXT"]);
    expect(await codesOf(`<section class="g"><div><p>${demo.hours}</p></div></section>`, `.g { ${GRAD} }`)).toEqual(["GROUND_HAS_TEXT"]);
    expect(await codesOf(`<p>${demo.hours}</p>`, `body { ${GRAD} }`)).toEqual(["GROUND_HAS_TEXT"]);
  });

  it("refuses a text-free gradient box that meets a line box (GROUND_UNDER_TEXT, raw negative margin)", async () => {
    expect(await codesOf(`<div class="g"></div><p class="t">${demo.hours}</p>`, `.g { height: 60px; ${GRAD} } .t { margin-top: -40px; }`)).toEqual(["GROUND_UNDER_TEXT"]);
  });

  it("passes a smooth text-free band apart from the text", async () => {
    expect(await codesOf(`<div class="g"></div><p>${demo.hours}</p>`, `.g { height: 60px; ${GRAD} }`)).toEqual([]);
    expect(await codesOf(`<div class="g"></div>`, ".g { width: 300px; height: 300px; background-image: radial-gradient(circle, #EAE1D2, #D9CFBE); }")).toEqual([]);
  });

  it("applies the V3b stop rule to the drawn gradient (hard stop, steep, all colour syntaxes in sRGB)", async () => {
    expect(await codesOf(`<div class="g"></div>`, ".g { height: 300px; background: linear-gradient(#000 50%, #fff 50%); }")).toEqual(expect.arrayContaining(["GRADIENT_HARD_STOP"]));
    expect(await codesOf(`<div class="g"></div>`, ".g { height: 100px; background: linear-gradient(#000, #fff); }")).toEqual(["GRADIENT_TOO_STEEP"]);
    expect(await codesOf(`<div class="g"></div>`, ".g { height: 300px; background: linear-gradient(oklch(0.9 0.02 80), hsl(40 30% 85%)); }")).toEqual([]);
    expect(await codesOf(`<div class="g"></div>`, ".g { height: 100px; background: linear-gradient(oklch(0.5 0.4 30), oklch(0.5 0.4 200)); }")).toEqual(["GRADIENT_TOO_STEEP"]);
  });

  it("a stop that is not opaque is unmeasured in the page (Fresh Review round 2, M1; raw: the allowlist refuses it first)", async () => {
    for (const [css, height] of [["linear-gradient(#000, transparent)", 30], ["linear-gradient(#000 50%, transparent 50%)", 300], ["linear-gradient(#000, #0000)", 300], ["linear-gradient(#000, rgba(0,0,0,.05))", 300], ["linear-gradient(transparent, rgba(0, 0, 0, 0.5))", 300]] as const) {
      expect(await codesOf('<div class="g"></div>', `.g { height: ${height}px; background: ${css}; }`), css).toContain("GRADIENT_UNMEASURED");
      expect(cssProblems(decl(`background: ${css};`), ALL_ON), css).toEqual(["CSS_VALUE"]);
    }
    expect(await codesOf('<div class="g"></div>', ".g { height: 300px; background: linear-gradient(#000f, rgb(0 0 0 / 1)); }")).toEqual([]);
  });

  it("judges EVERY drawn gradient (Fresh Review M2): 40 smooth ones and a hard stop after them still fail", async () => {
    const smooth = Array.from({ length: 40 }, () => '<div class="s"></div>').join("");
    const css = ".s { height: 300px; background: linear-gradient(#EAE1D2, #D9CFBE); } .h { height: 300px; background: linear-gradient(#000 50%, #fff 50%); }";
    expect(await codesOf(smooth, css)).toEqual([]);
    expect(await codesOf(`${smooth}<div class="h"></div>`, css)).toEqual(expect.arrayContaining(["GRADIENT_HARD_STOP"]));
    expect((await phaseBScan(tab, { css: { gradientGround: true }, displayWords: WORDS })).gradients.count).toBe(41);
    const many = Array.from({ length: 200 }, () => '<div class="s"></div>').join("");
    expect(await codesOf(`${many}<div class="h"></div>`, css)).toEqual(expect.arrayContaining(["GRADIENT_HARD_STOP"]));
  });

  it("the stop rule in the page gives the same codes as gradientProblems", async () => {
    const rgb = (v: number): [number, number, number] => [v, v, v];
    const cases: Gradient[] = [];
    const configs = [null, "to right", "to top left", "to left bottom", "90deg", "45deg", "-30deg", "0.25turn", "1rad", "50grad", "sideways"];
    for (const config of configs)
      for (const [w, h] of [[400, 300], [400, 100], [60, 30], [1, 1], [0, 200]] as const)
        for (const stops of [
          [[rgb(234), null], [rgb(217), null]],
          [[rgb(0), null], [rgb(255), null]],
          [[rgb(0), 50], [rgb(255), 50]],
          [[rgb(0), 10], [rgb(128), null], [rgb(10), 90]],
          [[rgb(0), 60], [rgb(40), 20], [rgb(255), null]],
          [[rgb(0), null]],
          [[null, null], [rgb(0), null]],
        ] as Array<Array<[[number, number, number] | null, number | null]>>)
          cases.push({ kind: "linear", config, w, h, stops: stops.map(([c, pct]) => ({ rgb: c, pct })) });
    for (const g of cases.slice(0, 77)) cases.push({ ...g, kind: g.config === null ? "radial" : "unknown" }, { ...g, kind: "radial", config: "circle" });
    const inPage = (await tab.evaluate(`(${JSON.stringify(cases)}).map(${GRADIENT_CODES_JS})`)) as string[][];
    expect(inPage).toEqual(cases.map((g) => gradientProblems(g)));
    expect(new Set(inPage.flat())).toEqual(new Set(["GRADIENT_HARD_STOP", "GRADIENT_TOO_STEEP", "GRADIENT_UNMEASURED"]));
  });

  it("counts an alt as text, as layers.ts does (Fresh Review L1)", async () => {
    expect(await codesOf('<div class="g"><img alt="店の外観" width="10" height="10"></div>', `.g { height: 60px; ${GRAD} }`)).toEqual(["GROUND_HAS_TEXT"]);
    expect(await codesOf('<img class="g" alt="店の外観" width="10" height="10">', `.g { ${GRAD} }`)).toEqual(["GROUND_HAS_TEXT"]);
    expect(await codesOf('<div class="g" aria-label="店の外観"></div>', `.g { height: 60px; ${GRAD} }`)).toEqual(["GROUND_HAS_TEXT"]);
    expect(await codesOf('<div class="g"><img alt="" width="10" height="10"></div>', `.g { height: 60px; ${GRAD} }`)).toEqual([]);
  });

  it("a gradient makes no stacking context (no change to the layer model)", async () => {
    await tab.setContent(`<!doctype html><html><head><style>${BASE} .g { height: 60px; ${GRAD} }</style></head><body><div class="g"></div><p>${demo.hours}</p></body></html>`);
    expect(layerCodes(await layerScan(tab, [demo.hours!.replace(/\s+/g, "")]))).toEqual([]);
  });
});

describe("DEV-164 phase B: translucent_decoration (not under text)", () => {
  it("refuses opacity on text or on a box holding text (TRANSLUCENT_HAS_TEXT)", async () => {
    expect(await codesOf(`<p class="o">${demo.address}</p>`, ".o { opacity: 0.5; }")).toEqual(["TRANSLUCENT_HAS_TEXT"]);
    expect(await codesOf(`<div class="o"><p>${demo.address}</p></div>`, ".o { opacity: 0.5; }")).toEqual(["TRANSLUCENT_HAS_TEXT"]);
  });

  it("refuses a translucent box whose box or descendants meet a line box (TRANSLUCENT_UNDER_TEXT, raw)", async () => {
    expect(await codesOf(`<div class="o"></div><p class="t">${demo.hours}</p>`, ".o { opacity: 0.5; height: 60px; background: #333; } .t { margin-top: -40px; }")).toEqual(["TRANSLUCENT_UNDER_TEXT"]);
    expect(await codesOf(`<div class="o"><div class="c"></div></div><p>${demo.hours}</p>`, ".o { opacity: 0.5; height: 10px; } .c { height: 80px; background: #333; }")).toEqual(["TRANSLUCENT_UNDER_TEXT"]);
  });

  it("passes a translucent text-free box apart from the text", async () => {
    expect(await codesOf(`<div class="o"></div><p>${demo.hours}</p>`, ".o { opacity: 0.4; height: 60px; background: #333; }")).toEqual([]);
  });

  it("STACKING_CONTEXT: not counted for a benign translucent box only with the flag; counted for text, overlap or another trigger", async () => {
    const scan = async (body: string, css: string, translucent: boolean) => {
      await tab.setContent(`<!doctype html><html><head><style>${BASE}\n${css}</style></head><body>${body}</body></html>`);
      return layerCodes(await layerScan(tab, [demo.hours!.replace(/\s+/g, "")], { translucent }));
    };
    const benign = [`<div class="o"></div><p>${demo.hours}</p>`, ".o { opacity: 0.4; height: 60px; background: #333; }"] as const;
    expect(await scan(...benign, false)).toContain("STACKING_CONTEXT");
    expect(await scan(...benign, true)).toEqual([]);
    expect(await scan(`<div class="o"><p>${demo.address}</p></div>`, ".o { opacity: 0.5; }", true)).toContain("STACKING_CONTEXT");
    expect(await scan(`<div class="o"></div><p class="t">${demo.hours}</p>`, ".o { opacity: 0.5; height: 60px; background: #333; } .t { margin-top: -40px; }", true)).toContain("STACKING_CONTEXT");
    expect(await scan(`<div class="o"></div><p>${demo.hours}</p>`, ".o { opacity: 0.5; height: 60px; background: #333; transform: rotate(1deg); }", true)).toContain("STACKING_CONTEXT");
    expect(await scan(`<p>${demo.hours}</p>`, "body { opacity: 0.5; }", true)).toContain("STACKING_CONTEXT");
  });
});

describe("DEV-164 phase B: grounds and translucent boxes at every 1px width (Fresh Review M1)", () => {
  // the reviewer's repro: an 8px ground pulled under a centred line; the line's first glyph covers x = 0..8 only while the
  // centred text starts left of 8px, i.e. at about 462–476px, between two checked widths
  const REPRO_CSS = "body{margin:0;font-family:sans-serif} .g{height:20px;width:8px;background-image:linear-gradient(#eee,#ddd);margin-bottom:-20px} p{margin:0;text-align:center;font-size:34px;line-height:1}";
  const REPRO_HTML = '<div class="g"></div><p>AAAAAAAAAA BBBBBBBBBB</p>';
  const doc = (body: string) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body>${body}</body></html>`;
  const sampled = async (page: CompPage, css: PageCssOptions) => {
    const widths = [...pageWidths(page.css), ...sweepWidths()];
    const o = await openCompPage(browser, page, { width: 320, height: 900, scale: 1, mobile: false });
    try {
      const out: Array<{ width: number; phaseB: PhaseBScan }> = [];
      for (const width of widths) {
        await o.page.setViewportSize({ width, height: 900 });
        out.push({ width, phaseB: await phaseBScan(o.page, { css, displayWords: WORDS }) });
      }
      return out;
    } finally {
      await o.context.close();
    }
  };

  it("gradient_ground: the reviewer's repro fails GROUND_UNDER_TEXT at exactly 462–476, which no checked or 32px width sees", async () => {
    const page = rawPage(doc(REPRO_HTML), REPRO_CSS);
    const on = { gradientGround: true };
    const sampledCodes = (await sampled(page, on)).flatMap((w) => phaseBCodes(w.phaseB));
    expect(sampledCodes).not.toContain("GROUND_UNDER_TEXT"); // (its 20px line also breaks the stop rule: GRADIENT_HARD_STOP)
    const sweep = (await displaySweepPass(browser, page, planOf(on)))!;
    expect(sweep.failing.filter((f) => f.codes.includes("GROUND_UNDER_TEXT")).map((f) => f.w)).toEqual(Array.from({ length: 15 }, (_, i) => 462 + i));
    expect(sweep.failing.some((f) => f.codes.includes("PHASE_B_UNMEASURED"))).toBe(false);
    expect(phaseBCheck([], sweep).codes).toContain("GROUND_UNDER_TEXT");
  });

  it("gradient_ground: a smooth band under the same text passes every sampled width and fails only by the 1px sweep", async () => {
    const page = rawPage(doc(REPRO_HTML), REPRO_CSS.replace("height:20px", "height:30px").replace("margin-bottom:-20px", "margin-bottom:-30px"));
    const on = { gradientGround: true };
    const widths = await sampled(page, on);
    expect(phaseBCheck(widths).ok).toBe(true);
    const sweep = (await displaySweepPass(browser, page, planOf(on)))!;
    const failing = sweep.failing.map((f) => f.w);
    expect(failing).toContain(470);
    expect(Math.min(...failing)).toBeGreaterThan(440);
    expect(Math.max(...failing)).toBeLessThan(500);
    const check = phaseBCheck(widths, sweep);
    expect(check.ok).toBe(false);
    expect(check.codes).toEqual(["GROUND_UNDER_TEXT"]);
    // the stepped sweep agrees with real resizes on that band
    const stepped = (await displaySweepPass(browser, page, planOf(on), { range: [440, 500] }))!;
    const real = (await displaySweepPass(browser, page, planOf(on), { range: [440, 500], forceReal: true }))!;
    expect(stepped.failing).toEqual(real.failing);
    expect(stepped.failing.map((f) => f.w)).toEqual(failing);
  });

  it("translucent_decoration: the same band fails with the flag (TRANSLUCENT_UNDER_TEXT)", async () => {
    const page = rawPage(doc(REPRO_HTML), REPRO_CSS.replace("background-image:linear-gradient(#eee,#ddd)", "background:#ddd;opacity:0.5"));
    const on = { translucentDecoration: true };
    expect(phaseBCheck(await sampled(page, on)).ok).toBe(true);
    const sweep = (await displaySweepPass(browser, page, planOf(on)))!;
    expect(sweep.failing.length).toBeGreaterThan(0);
    expect(new Set(sweep.failing.flatMap((f) => f.codes))).toEqual(new Set(["TRANSLUCENT_UNDER_TEXT"]));
    expect(phaseBCheck([], sweep).codes).toEqual(["TRANSLUCENT_UNDER_TEXT"]);
  });

  it("runs only with a phase-B paint or display flag, and passes the synthetic page with every flag on", async () => {
    const page = rawPage(doc(REPRO_HTML), REPRO_CSS);
    expect(await displaySweepPass(browser, page, planOf({}))).toBeNull();
    expect(await displaySweepPass(browser, page, planOf({ colourSyntax: true }))).toBeNull();
    const all = (await displaySweepPass(browser, synthetic(), planOf(ALL_ON)))!;
    expect(all.failing).toEqual([]);
  });
});

describe("DEV-164 phase B: colour_syntax is checked on the computed sRGB colour", () => {
  const legibility = async (css: string) => (await legibilityPass(browser, synthetic(css), 1440, facts, required, planOf({ colourSyntax: true }))).scan.owners;
  it("a translucent or transparent fact colour is still COLOUR_ALPHA, whatever its syntax", async () => {
    for (const c of ["transparent", "hsl(30 50% 40% / 0.5)", "oklch(0.3 0.05 40 / 0.6)"]) {
      const owners = await legibility(`.lead-name { color: ${c}; }`);
      expect(owners.some((o) => o.colourAlpha < 255), c).toBe(true);
    }
    const plain = await legibility(".lead-name { color: oklch(0.25 0.02 40); }");
    expect(plain.every((o) => o.colourAlpha === 255)).toBe(true);
  });

  it("a fact in an oklch / named colour near its ground fails contrast (computed sRGB, out-of-gamut clamped)", async () => {
    const pass = await legibilityPass(browser, synthetic(".lead-text { color: oklch(0.95 0.02 85); } .goods-copy { color: oklch(0.7 0.4 150); }"), 1440, facts, required, planOf({ colourSyntax: true }));
    const shares = [...pass.lowContrast.values()];
    expect(Math.max(...shares)).toBeGreaterThan(0.5);
    for (const n of pass.measure.nodes) for (const v of n.color) expect(v).toBeGreaterThanOrEqual(0);
  });
});

describe("DEV-164 phase B: flags off change nothing on accepted pages", () => {
  const ACCEPTED = [
    "scripts/sales-design-worker/comp-impl/synthetic-wagashi/page",
    "design-library/research/three-methods/pilot-1/direction-first",
    "design-library/research/three-methods/pilot-1/layout-first",
    "design-library/research/quality-pipeline/poc/bicycle/impl/d1-a",
    "design-library/research/quality-pipeline/poc/bicycle/impl/d1-b",
    "design-library/research/quality-pipeline/poc/tsugute/impl/d1-v2-a",
    "design-library/research/quality-pipeline/poc/tsugute/impl/d1-v2-b",
    "design-library/research/quality-pipeline/poc/sento/impl/d1-a",
    "design-library/research/quality-pipeline/poc/sento/impl/d1-b",
  ];
  it.each(ACCEPTED)("%s: inside the allowlist and no phase-B code at any checked width or 32px sweep width (the 256px computed cap included)", async (dir) => {
    const html = readFileSync(resolve(REPO, dir, "index.html"), "utf8");
    const css = readFileSync(resolve(REPO, dir, "style.css"), "utf8");
    expect(cssProblems(css)).toEqual([]);
    const page = rawPage(html, css);
    for (const w of pageWidths(css)) expect(await pageCodes(page, w), `${dir} at ${w}`).toEqual([]);
    // Fresh Review L2: the 32px sweep's widths too, opened as legibilitySweep opens them (one desktop context, resized)
    const o = await openCompPage(browser, page, { width: 320, height: 900, scale: 1, mobile: false });
    try {
      for (const w of sweepWidths()) {
        await o.page.setViewportSize({ width: w, height: 900 });
        expect(phaseBCodes(await phaseBScan(o.page, { css: {}, displayWords: WORDS })), `${dir} at sweep ${w}`).toEqual([]);
      }
    } finally {
      await o.context.close();
    }
  });
});

describe("DEV-164 phase B: cost (Chromium 1194, best of 3; recorded in docs/design/phase-b-design.md §8)", () => {
  it("measures the added work with the flags off and on", async () => {
    const page = synthetic();
    const best = async (fn: () => Promise<unknown>) => {
      const times: number[] = [];
      for (let i = 0; i < 3; i++) {
        const t = Date.now();
        await fn();
        times.push(Date.now() - t);
      }
      return Math.min(...times);
    };
    const o = await openCompPage(browser, page, { width: 1440, height: 900, scale: 1, mobile: false });
    let scanMs: number;
    try {
      scanMs = await best(() => phaseBScan(o.page, planOf(ALL_ON)));
    } finally {
      await o.context.close();
    }
    const sweepOff = await best(() => legibilitySweep(browser, page, facts, required, planOf({})));
    const sweepOn = await best(() => legibilitySweep(browser, page, facts, required, planOf(ALL_ON)));
    const passOff = await best(() => legibilityPass(browser, page, 1440, facts, required, planOf({})));
    const passOn = await best(() => legibilityPass(browser, page, 1440, facts, required, planOf(ALL_ON)));
    const display = await best(() => displaySweepPass(browser, page, planOf({ displayScale: true, displayNowrap: true })));
    const paint = await best(() => displaySweepPass(browser, page, planOf({ gradientGround: true, translucentDecoration: true })));
    const all = await best(() => displaySweepPass(browser, page, planOf(ALL_ON)));
    const widths = pageWidths(page.css).length;
    const cost = { scan_ms_one_width: scanMs, checked_widths: widths, sweep_widths: 51, sweep_off_ms: sweepOff, sweep_on_ms: sweepOn, pass_1440_off_ms: passOff, pass_1440_on_ms: passOn, sweep_1px_display_ms: display, sweep_1px_paint_ms: paint, sweep_1px_all_ms: all };
    console.log(`DEV-164 cost ${JSON.stringify(cost)}`);
    for (const v of Object.values(cost)) expect(Number.isFinite(v)).toBe(true);
  });
});
