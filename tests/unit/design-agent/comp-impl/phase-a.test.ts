import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { protectedGeometryCheck } from "@/lib/design-agent/comp-impl/checks";
import { layerCodes } from "@/lib/design-agent/comp-impl/verify";
import { cssProblems, loadCompPage, type CompPage } from "@/lib/design-agent/comp-impl/page";
import { gatedGeometryPass, layeredInkPass, layerScan, layoutHashPass, legibilityPass, paintCrossCheck, perturbedGeometryPass, protectedGeometryPass } from "@/lib/design-agent/comp-impl/render";
import { capabilitiesCheck, contrastRatio, gradientStopProblems, groundStructure, layersCheck, luminance, metricsCheck, scrimBound, visibilityMatrixCheck } from "@/lib/design-agent/comp-impl/verify";
import { checkCompSpec, infoPairs, type CompSpec } from "@/lib/design-agent/comp-impl/spec";
import { factStrings, parseShop } from "@/lib/design-agent/compare/shops";
import type { Measure } from "@/lib/design-agent/shop-css/page-scripts";
import { FACTS_SOURCE, FIXTURE, launch } from "./support";

// DEV-083 phase A: verification only (docs/design/dev-083-expressive-safe-reproduction.md §7). Nothing here relaxes the
// DEV-082 allowlist: constructs it refuses are rendered from raw test HTML (a CompPage object built here, never through
// loadCompPage) to exercise the new model, and every probe constructible inside the allowlist says so.

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const demo = parseShop(JSON.parse(readFileSync(FACTS_SOURCE, "utf8")) as unknown)!.demo;
const all = factStrings(demo).map((f) => f.text.replace(/\s+/g, ""));
const required = [demo.name, demo.hours!, demo.closedDays!, demo.address!, demo.access!, demo.phone!, demo.description!].map((f) => f.replace(/\s+/g, ""));
const plan = { pairs: infoPairs(demo), facts: all };
const HTML = readFileSync(join(FIXTURE, "page/index.html"), "utf8");
const CSS = readFileSync(join(FIXTURE, "page/style.css"), "utf8");
const ROW = '<div class="facts-row"><dt data-comp-type="label">電話</dt><dd data-comp-type="body">052-000-0731</dd></div>';

/** A page object straight from strings: the allowlist is NOT applied (raw test HTML; cssProblems is asserted where a probe claims to be inside it). */
const rawPage = (html: string, css: string): CompPage => ({ dir: "", html, css, assets: [], files: new Map(), htmlSha256: "", cssSha256: "" });
const synthetic = (o: { html?: (s: string) => string; css?: string } = {}) => rawPage((o.html ?? ((s) => s))(HTML), `${CSS}\n${o.css ?? ""}\n`);

// the fifth review's probes (inside the allowlist), as in e2e.test.tsx
const PROBE_A = {
  html: '<div class="facts-row tel-row"><dt data-comp-type="label">電話</dt><dd data-comp-type="body">052-000-0731</dd><div class="tel-tab"></div></div>',
  css: ".tel-row { display: flex; flex-wrap: wrap; gap: 0; } .tel-row dt { flex: 0 0 170px; margin-right: 24px; } .tel-row dd { flex: 1 1 36px; min-width: 0; letter-spacing: 8px; } .tel-tab { flex: 0 0 180px; background: #1F1D1B; }",
};
const PROBE_B = {
  html: '<div class="facts-row tel-row"><dt data-comp-type="label">電話</dt><div class="tel-cell"><dd data-comp-type="body">052-000-0731</dd><div class="tel-tab"></div></div></div>',
  css: ".tel-row { display: flex; } .tel-row dt { flex: 0 0 394px; } .tel-cell { flex: 1 1 0px; } .tel-row dd { display: inline-block; width: 80%; letter-spacing: 6px; } .tel-tab { display: inline-block; width: 20%; min-height: 20px; background: #1F1D1B; } @media (max-width: 400px) { .tel-row { display: block; } }",
};
const withProbe = (p: { html: string; css: string }, extra = "") => synthetic({ html: (s) => s.replace(ROW, p.html), css: `${p.css}\n${extra}` });

let browser: Browser;
let raw: BrowserContext;
let rawTab: Page;
beforeAll(async () => {
  browser = await launch();
  raw = await browser.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
  await raw.route("**/*", (route) => route.abort());
  rawTab = await raw.newPage();
});
afterAll(async () => {
  await raw?.close();
  await browser?.close();
});

const BASE_CSS = 'body { margin: 0; font-family: "IPAGothic", sans-serif; font-size: 24px; font-weight: 700; line-height: 1.2; color: #1F1D1B; }';
async function show(body: string, css: string): Promise<Page> {
  await rawTab.setContent(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>${BASE_CSS}\n${css}</style></head><body>${body}</body></html>`);
  return rawTab;
}
const indexOf = (page: Page, selector: string) => page.evaluate(`Array.from(document.querySelectorAll("*")).indexOf(document.querySelector(${JSON.stringify(selector)}))`) as Promise<number>;

// ---------------------------------------------------------------- V2 paint order: the model against Chromium

type Fixture = { name: string; body: string; css: string; expect: "box" | "text"; allowlisted?: boolean };
const T = "0520000731";
const FIXTURES: Fixture[] = [
  // inside today's allowlist (the cover is measured, never refused): atomic flex / grid / inline-block painting
  { name: "a later flex item over an earlier item's sideways overflow (probe A's class)", allowlisted: true, expect: "box", body: `<div class="row"><div class="t">${T}</div><div class="cover"></div></div>`, css: ".row { display: flex; width: 300px; } .t { flex: 0 0 100px; min-width: 0; } .cover { flex: 0 0 150px; height: 40px; background: #333333; }" },
  { name: "a later inline-block over an earlier inline-block's overflow (probe B's class)", allowlisted: true, expect: "box", body: `<div class="cell"><span class="t">05200007</span><span class="cover"></span></div>`, css: ".cell { width: 220px; } .t { display: inline-block; width: 80px; letter-spacing: 6px; } .cover { display: inline-block; width: 100px; height: 30px; background: #333333; }" },
  { name: "a later grid item over an earlier item's sideways overflow", allowlisted: true, expect: "box", body: `<div class="g"><div class="t">${T}</div><div class="cover"></div></div>`, css: ".g { display: grid; grid-template-columns: 100px 150px; width: 250px; } .t { min-width: 0; } .cover { height: 30px; background: #333333; }" },
  { name: "text overflowing a block onto a later block's ground stays on top (step 4 before step 7)", allowlisted: true, expect: "text", body: `<div class="t">05<br>2000</div><div class="cover"></div>`, css: ".t { height: 20px; } .cover { height: 40px; background: #333333; }" },
  { name: "a later inline-block on the next line over the previous line's glyphs (line-height below 1: refused, raw)", expect: "box", body: `<div class="p"><span class="t">0520</span> <span class="cover"></span></div>`, css: ".p { width: 120px; line-height: 0.6; } .cover { display: inline-block; width: 100px; height: 30px; background: #333333; }" },
  // refused by the allowlist: the model only (raw HTML)
  { name: "order: 1 moves an earlier flex cover later in painting", expect: "box", body: `<div class="row"><div class="cover"></div><div class="t">${T}</div></div>`, css: ".row { display: flex; width: 300px; } .cover { order: 1; flex: 0 0 150px; height: 40px; background: #333333; } .t { flex: 0 0 100px; min-width: 0; }" },
  { name: "order: -1 moves a later grid cover earlier (passes)", expect: "text", body: `<div class="g"><div class="t">0520</div><div class="cover"></div></div>`, css: ".g { display: grid; } .g > * { grid-area: 1 / 1; } .cover { order: -1; height: 40px; background: #333333; }" },
  { name: "a later grid item stacked on the same cell", expect: "box", body: `<div class="g"><div class="t">0520</div><div class="cover"></div></div>`, css: ".g { display: grid; } .g > * { grid-area: 1 / 1; } .cover { height: 40px; background: #333333; }" },
  { name: "an earlier grid item on the same cell (passes)", expect: "text", body: `<div class="g"><div class="cover"></div><div class="t">0520</div></div>`, css: ".g { display: grid; } .g > * { grid-area: 1 / 1; } .cover { height: 40px; background: #333333; }" },
  { name: "a static flex item with z-index: 1 (a stacking context without position)", expect: "box", body: `<div class="row"><div class="cover"></div><div class="t">0520</div></div>`, css: ".row { display: flex; } .cover { flex: 0 0 100px; height: 40px; z-index: 1; background: #333333; } .t { flex: 0 0 150px; margin-left: -80px; }" },
  { name: "a position: relative child of an earlier flex item escapes atomic painting", expect: "box", body: `<div class="row"><div class="a"><div class="cover"></div></div><div class="t">0520000</div></div>`, css: ".row { display: flex; } .a { flex: 0 0 100px; min-width: 0; } .cover { position: relative; width: 180px; height: 40px; background: #333333; } .t { flex: 0 0 150px; }" },
  { name: "an earlier opacity: .9 scrim over non-positioned text", expect: "box", body: `<div class="cover"></div><div class="t">0520</div>`, css: ".cover { opacity: 0.9; height: 40px; background: #333333; } .t { margin-top: -40px; }" },
  { name: "an opacity: .2 cover (passes the ink bound, fails the order)", expect: "box", body: `<div class="cover"></div><div class="t">0520</div>`, css: ".cover { opacity: 0.2; height: 40px; background: #333333; } .t { margin-top: -40px; }" },
  { name: "a z-index: -1 child under its parent's ground", expect: "box", body: `<div class="cover"><div class="t">0520</div></div>`, css: ".cover { height: 60px; background: #333333; } .t { position: relative; z-index: -1; }" },
  { name: "a float pulled over earlier text paints below inline content (passes V2; V4 owns it)", expect: "text", body: `<div class="t">${T}</div><div class="cover"></div>`, css: ".cover { float: left; width: 100px; height: 40px; margin-top: -30px; background: #333333; }" },
  { name: "a transformed earlier sibling", expect: "box", body: `<div class="cover"></div><div class="t">0520</div>`, css: ".cover { transform: translateY(30px); height: 40px; background: #333333; }" },
  { name: "a positioned z-index: auto box after the text", expect: "box", body: `<div class="t">0520</div><div class="cover"></div>`, css: ".cover { position: relative; top: -30px; height: 40px; background: #333333; }" },
  { name: "a positioned z-index: auto box before the text still paints later", expect: "box", body: `<div class="cover"></div><div class="t">0520</div>`, css: ".cover { position: relative; top: 20px; height: 40px; background: #333333; }" },
  { name: "isolation: isolate plus mix-blend-mode", expect: "box", body: `<div class="cover"></div><div class="t">0520</div>`, css: ".cover { isolation: isolate; mix-blend-mode: multiply; height: 40px; background: #333333; } .t { margin-top: -40px; }" },
  { name: "contain: paint on an earlier cover", expect: "box", body: `<div class="cover"></div><div class="t">0520</div>`, css: ".cover { contain: paint; height: 40px; background: #333333; } .t { margin-top: -40px; }" },
  { name: "will-change: transform on an earlier cover", expect: "box", body: `<div class="cover"></div><div class="t">0520</div>`, css: ".cover { will-change: transform; height: 40px; background: #333333; } .t { margin-top: -40px; }" },
  { name: "a negative-margin block pulled over the previous block's text (a block ground: passes V2; V4 owns it)", expect: "text", body: `<div class="t">0520</div><div class="cover"></div>`, css: ".cover { margin-top: -30px; height: 40px; background: #333333; }" },
];

describe("V2: the paint-order model agrees with Chromium's painting", () => {
  it("the probes marked as inside the allowlist really are (the cover is measured, not refused)", () => {
    for (const f of FIXTURES.filter((x) => x.allowlisted)) expect(cssProblems(`${BASE_CSS}\n${f.css}`), f.name).toEqual([]);
  });

  it.each(FIXTURES.map((f) => [f.name, f] as const))("%s", async (_n, f) => {
    const page = await show(f.body, f.css);
    const scan = await layerScan(page, ["0520"]);
    const verdicts = await paintCrossCheck(page, ["0520"]);
    const [t, c] = [await indexOf(page, ".t"), await indexOf(page, ".cover")];
    const key = verdicts.find((v) => v.text === t && v.box === c);
    expect(key, "the text and the cover intersect").toBeDefined();
    expect(key!.model, "model").toBe(f.expect);
    expect(key!.chromium, `Chromium (${key!.glyphPixels} glyph pixels)`).toBe(f.expect);
    // every other conclusive pair agrees too; a disagreement fails the build (§2 V2)
    for (const v of verdicts.filter((x) => x.chromium !== "unclear")) expect(v.model, JSON.stringify(v)).toBe(v.chromium);
    expect(layerCodes(scan).includes("PAINT_ORDER_COVER")).toBe(f.expect === "box");
  });
});

// ---------------------------------------------------------------- V1 roles, V4 extents, V9 writing mode

describe("V1 roles, V4 non-content extents, V9 computed writing mode", () => {
  const codes = async (body: string, css = "") => layerCodes(await layerScan(await show(body, css), ["0520"]));
  it.each<[string, string, string]>([
    ["an unknown role", '<div data-comp-role="overlay">0520</div>', "ROLE_UNKNOWN"],
    ["decoration over text", '<div data-comp-role="decoration"><p>0520</p></div>', "ROLE_DECORATION_HAS_TEXT"],
    ["decoration holding an img with alt", '<div data-comp-role="decoration"><img alt="x" width="10" height="10"></div>', "ROLE_DECORATION_HAS_TEXT"],
    ["ground with an aria-label", '<div data-comp-role="ground" aria-label="店舗情報"></div>', "ROLE_GROUND_HAS_TEXT"],
    ["media on a div that is no image slot", '<div data-comp-role="media"></div>', "ROLE_MISMATCH"],
    ["content on a text-free box", '<div data-comp-role="content"></div>', "ROLE_MISMATCH"],
    ["an img declared decoration", '<img data-comp-role="decoration" alt="" width="10" height="10">', "ROLE_MISMATCH"],
    ["a generated ::before box", '<div class="d">0520</div>', "PSEUDO_GEOMETRY_UNKNOWN"],
    ["a vertical ancestor of a dd (inherited)", '<div class="v"><dl><dt>電話</dt><dd>0520</dd></dl></div>', "PROTECTED_VERTICAL"],
    ["a decoration box over a protected fact (V4)", '<div class="t">0520</div><div class="deco"></div>', "FACT_NONCONTENT_OVERLAP"],
    ["an earlier opacity scrim: a stacking context the allowlist forbids", '<div class="s"></div><div>x</div>', "STACKING_CONTEXT"],
  ])("fails %s", async (_n, body, code) => {
    const css = ".d::before { content: ''; display: block; height: 4px; } .v { writing-mode: vertical-rl; } .deco { height: 20px; margin-top: -20px; background: #333333; } .s { opacity: 0.5; }";
    expect(await codes(body, css)).toContain(code);
  });

  it("accepts consistent declarations: ground and decoration on text-free boxes, media on an img and a placeholder slot, content on text", async () => {
    const body = '<div data-comp-role="ground" class="g"></div><div data-comp-role="decoration"></div><img data-comp-role="media" alt="和菓子のイメージ（AI生成）" width="10" height="10"><div data-comp-role="media" data-comp-slot="x" data-comp-placeholder></div><p data-comp-role="content">0520</p>';
    const scan = await layerScan(await show(body, ".g { height: 10px; background: #eeeeee; }"), ["0520"]);
    expect(layerCodes(scan)).toEqual([]);
    expect(scan.roles).toMatchObject({ declared: 5, counts: { ground: 1, decoration: 1, media: 2 } });
  });
});

// ---------------------------------------------------------------- the synthetic page and the DEV-082 regression set

describe("phase A on the synthetic page and the DEV-082 probes", () => {
  it("the synthetic page passes every phase A check at a checked width, with a flat ground under every protected glyph", async () => {
    const p = await legibilityPass(browser, await loadCompPage(join(FIXTURE, "page")), 1440, all, required, plan);
    const r = layersCheck(p.layers, p.ground);
    expect(r).toMatchObject({ ok: true, codes: [], stacking_contexts: 0, declared_roles: 0 });
    expect((r.ground as { nodes: number; max_deviation: number }).nodes).toBeGreaterThan(0);
    expect((r.ground as { max_deviation: number }).max_deviation).toBe(0);
  });

  it("the fifth review's class fails V2 and V4 at a width inside its window, from the same pass (probes A and B)", async () => {
    for (const [probe, width] of [[PROBE_A, 460], [PROBE_B, 495]] as const) {
      const page = withProbe(probe);
      expect(cssProblems(page.css)).toEqual([]);
      const p = await legibilityPass(browser, page, width, all, required, plan);
      expect(layersCheck(p.layers, p.ground).codes).toEqual(expect.arrayContaining(["PAINT_ORDER_COVER", "FACT_NONCONTENT_OVERLAP"]));
      expect(p.layers.covers.list.some((c) => c.protected)).toBe(true);
    }
  });

  it("V3b: a hard-stop gradient bar under a digit of the phone number fails GROUND_NOT_FLAT (raw HTML: gradients are refused)", async () => {
    const page = synthetic({ html: (s) => s.replace(ROW, '<div class="facts-row"><dt data-comp-type="label">電話</dt><dd class="tel" data-comp-type="body">052-000-0731</dd></div>'), css: ".tel { background: linear-gradient(90deg, transparent 0 20px, #1F1D1B 20px 23px, transparent 23px); }" });
    expect(cssProblems(page.css).length).toBeGreaterThan(0);
    const p = await legibilityPass(browser, page, 1440, all, required, plan);
    const r = layersCheck(p.layers, p.ground);
    expect(r.codes).toContain("GROUND_NOT_FLAT");
    expect((r.ground as { max_deviation: number }).max_deviation).toBeGreaterThan(100);
  });

  it("V3 layered reference: ink holds on a smooth gradient ground and fails under a translucent decoration (raw HTML)", async () => {
    const tel = '<div class="facts-row"><dt data-comp-type="label">電話</dt><dd class="tel" data-comp-type="body">052-000-0731</dd></div>';
    const gradient = ".facts { background: linear-gradient(90deg, #EAE1D2, #D9CFBE); }";
    const phoneInk = async (page: CompPage) => {
      const r = await layeredInkPass(browser, page, 1440, all, required);
      const i = r.measure.nodes.findIndex((n) => n.text.replace(/\s+/g, "") === "052-000-0731");
      return { ink: r.ink.get(i)!, excess: r.inkExcess.get(i)!, decoration: r.decoration };
    };
    const clean = await phoneInk(synthetic({ html: (s) => s.replace(ROW, tel), css: gradient }));
    expect(clean.ink.missing).toBe(0);
    expect(clean.ink.ratio).toBeGreaterThan(0.95);
    expect(clean.excess).toBeLessThan(1.05);
    const veiled = await phoneInk(
      synthetic({ html: (s) => s.replace(ROW, tel.replace("</dd>", '</dd><div class="veil" data-comp-role="decoration"></div>')), css: `${gradient} .facts-row { position: relative; } .veil { position: absolute; left: 0; right: 0; top: 0; bottom: 0; background: #EAE1D2; opacity: 0.6; }` }),
    );
    expect(veiled.decoration).toBeGreaterThan(0);
    expect(veiled.ink.ratio).toBeLessThan(0.8);
  });
});

// ---------------------------------------------------------------- V6 layout-change detection

describe("V6: layout-change detection gives the same findings as the full 1px pass", () => {
  const same = (a: { run: { failing: Array<{ w: number; codes: string[] }> } }, b: { run: { failing: Array<{ w: number; codes: string[] }> } }) => {
    const m = (x: typeof a) => new Map(x.run.failing.map((f) => [f.w, f.codes.join(",")]));
    expect([...m(a).entries()]).toEqual([...m(b).entries()]);
  };
  it.each<[string, () => CompPage, [number, number] | undefined]>([
    ["the synthetic page, 320–1920", () => synthetic(), undefined],
    ["probe A (fifth review), 320–1920", () => withProbe(PROBE_A), undefined],
    ["probe B (fifth review), 320–1920", () => withProbe(PROBE_B), undefined],
    ["the sixth review's html margin (real resizes), 350–395", () => withProbe({ html: PROBE_A.html.replace("tel-tab", "tel-tab"), css: ".tel-row { display: flex; flex-wrap: wrap; gap: 0; } .tel-row dt { flex: 0 0 54px; margin-right: 24px; } .tel-row dd { flex: 1 1 44px; min-width: 0; letter-spacing: 8px; } .tel-tab { flex: 0 0 100px; background: #1F1D1B; }" }, "@media (max-width: 760px) { html { margin-right: 100px; } }"), [350, 395]],
    ["the seventh review's centred root, 440–490", () => synthetic({ css: "html { max-width: 1000px; margin: 0 auto; }" }), [440, 490]],
  ])("%s", async (_n, make, range) => {
    const page = make();
    const full = await protectedGeometryPass(browser, page, required, range ? { range } : {});
    const gated = await gatedGeometryPass(browser, page, required, range ? { range } : {});
    same(gated, full);
    expect(gated.checked).toBeLessThanOrEqual((range ? range[1] - range[0] : 1600) + 1);
  });

  it("the signature is stable where nothing near protected text moves, and changes inside a cover window", async () => {
    const quiet = await layoutHashPass(browser, synthetic(), required, { range: [1300, 1400] });
    expect(quiet.changes).toBe(0);
    const a = await layoutHashPass(browser, withProbe(PROBE_A), required, { range: [440, 480] });
    expect(a.changes).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- V10 perturbation harness

describe("V10: the metric perturbation harness", () => {
  it("finds a fact that fits its box only at the exact metrics (METRICS_FRAGILE; raw HTML: nowrap is refused), and nothing new on the synthetic page", async () => {
    // a dd exactly as wide as the number: passes as it is, overflows with +0.05 em tracking or a wider face
    const tab = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await tab.newPage();
    await p.setContent(`<!doctype html><html><head><style>${CSS}</style></head><body>${HTML.replace(/^[\s\S]*<body>|<\/body>[\s\S]*$/g, "")}</body></html>`);
    const fit = Math.ceil((await p.evaluate(`(() => { const dd = Array.from(document.querySelectorAll("dd")).find((d) => d.textContent.includes("052-000-0731")); const r = document.createRange(); r.selectNodeContents(dd); return r.getBoundingClientRect().width; })()`)) as number) + 1;
    await tab.close();
    const page = synthetic({ css: `.facts-row:last-child dd { justify-self: start; width: ${fit}px; white-space: nowrap; }`, html: (s) => s });
    const range: [number, number] = [1400, 1440];
    const base = await protectedGeometryPass(browser, page, required, { range });
    expect(base.run.failing).toEqual([]);
    const plus = await perturbedGeometryPass(browser, page, required, "tracking_plus", { range });
    expect(protectedGeometryCheck(plus).codes).toContain("FACT_OUT_OF_BOX");
    expect(metricsCheck(base, { tracking_plus: plus }).codes).toEqual(["METRICS_FRAGILE"]);
    const wide = await perturbedGeometryPass(browser, synthetic(), required, "wide_font", { range });
    expect(wide.face).not.toBeNull();
    expect(metricsCheck(await protectedGeometryPass(browser, synthetic(), required, { range }), { wide_font: wide, tracking_minus: await perturbedGeometryPass(browser, synthetic(), required, "tracking_minus", { range }) }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------- pure functions: V3b maths, V7, V9 matrix

describe("V3b maths, V7 capabilities, V9 visibility matrix", () => {
  const flatPixels = (w: number, h: number, rgb: number[]) => ({ width: w, height: h, channels: 3, data: Buffer.from(Array.from({ length: w * h }, () => rgb).flat()) });
  it("ground structure: zero on a flat ground; a text-coloured stroke and a stroke just above the tolerance are seen", () => {
    const px = flatPixels(40, 20, [234, 225, 210]);
    expect(groundStructure(px, [{ left: 10, top: 5, width: 10, height: 10 }])).toEqual({ maxDev: 0, lumStd: 0, sobel: 0 });
    for (let y = 0; y < 20; y++) for (const c of [0, 1, 2]) px.data[(y * 40 + 14) * 3 + c] = 31;
    expect(groundStructure(px, [{ left: 10, top: 5, width: 10, height: 10 }]).maxDev).toBeGreaterThan(150);
    const faint = flatPixels(40, 20, [200, 200, 200]);
    for (let y = 0; y < 20; y++) faint.data[(y * 40 + 14) * 3] = 207;
    expect(groundStructure(faint, [{ left: 10, top: 5, width: 10, height: 10 }]).maxDev).toBe(7);
  });

  it("the analytic scrim bound: a = 0.9 passes contrast but fails structure; straddling corners fail contrast; a near-opaque dark scrim under white text passes", () => {
    expect(scrimBound([20, 20, 20], 0.9, [255, 255, 255]).codes).toEqual(["SCRIM_STRUCTURE"]);
    expect(scrimBound([128, 128, 128], 0.5, [119, 119, 119]).codes).toContain("SCRIM_CONTRAST");
    expect(scrimBound([20, 20, 20], 0.98, [255, 255, 255])).toMatchObject({ ok: true, sameSide: true });
    expect(contrastRatio(luminance([255, 255, 255]), luminance([0, 0, 0]))).toBeCloseTo(21, 5);
  });

  it("gradient stops: a hard stop and a 1 px soft edge fail; a long smooth ramp passes", () => {
    expect(gradientStopProblems([{ at: 20, rgb: [234, 225, 210] }, { at: 20, rgb: [31, 29, 27] }], 300)).toEqual(["GRADIENT_HARD_STOP", "GRADIENT_TOO_STEEP"]);
    expect(gradientStopProblems([{ at: 20, rgb: [234, 225, 210] }, { at: 21, rgb: [31, 29, 27] }], 300)).toEqual(["GRADIENT_HARD_STOP", "GRADIENT_TOO_STEEP"]);
    expect(gradientStopProblems([{ at: 0, rgb: [234, 225, 210] }, { at: 300, rgb: [217, 207, 190] }], 300)).toEqual([]);
  });

  it("V7: the spec may declare no capability (phase A approves none); an omitted or empty list is the DEV-082 base", () => {
    const spec = JSON.parse(readFileSync(join(FIXTURE, "layout-spec.json"), "utf8")) as CompSpec;
    expect(checkCompSpec(spec).ok).toBe(true);
    expect(checkCompSpec({ ...spec, capabilities: [] }).ok).toBe(true);
    for (const c of ["hero_overlay", "web_font", "anything"]) expect(checkCompSpec({ ...spec, capabilities: [c] })).toEqual({ ok: false, problems: ["SPEC_CAPABILITY_NOT_APPROVED"] });
    expect(checkCompSpec({ ...spec, capabilities: ["Hero Overlay"] })).toEqual({ ok: false, problems: ["SPEC_SHAPE"] });
    expect(capabilitiesCheck(spec)).toMatchObject({ ok: true, declared: [], approved: [] });
    expect(capabilitiesCheck({ ...spec, capabilities: ["hero_overlay"] }).codes).toEqual(["CAPABILITY_NOT_APPROVED"]);
  });

  it("V9: a fact shown at one checked width and hidden at another fails the visibility matrix", () => {
    const m = (hidden: boolean) => ({ nodes: [{ kind: "fact", text: "052-000-0731", hidden }] }) as unknown as Measure;
    expect(visibilityMatrixCheck([{ width: 390, measure: m(false) }, { width: 1440, measure: m(false) }]).ok).toBe(true);
    expect(visibilityMatrixCheck([{ width: 390, measure: m(true) }, { width: 1440, measure: m(false) }])).toMatchObject({ codes: ["FACT_VISIBILITY_CHANGES"], dropped_at: [390] });
  });
});
