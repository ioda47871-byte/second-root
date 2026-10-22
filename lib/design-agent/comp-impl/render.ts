/**
 * Renders a comp implementation in Chromium (DEV-082) with the network shut:
 * every request goes through a route handler that answers only the page's own
 * files (index.html, style.css, the listed assets) under a fixed origin that
 * cannot resolve, and aborts everything else (counted: any attempt fails the
 * run). JavaScript is off in the context (the page has none; the harness's
 * evaluate still runs). Fonts are the machine's own (no @font-face is allowed).
 */
import type { Browser, BrowserContext, Page } from "playwright";
import { checkWidths, groundColour, inkMass, inkOf, lowContrastShare, MIN_REFERENCE_INK, SHOP_CSS_BASE_WIDTHS, type Ink, type Picture } from "../shop-css/render-check";
import { CLEAN_CSS, HIDE_TEXT_CSS, MEASURE_SCRIPT, MeasureSchema, REFERENCE_SCRIPT, type Measure } from "../shop-css/page-scripts";
import { decodePng } from "../worker/png-paint";
import { SHOT_VIEWPORTS } from "../shot-viewports";
import type { CompPage } from "./page";
import { pageBreakpointsPx } from "./page-css";
import { SEPARATORS } from "./checks";
import { LAYER_SCRIPT, LayerSchema, LAYOUT_HASH_SCRIPT, LayoutHashSchema, PERTURB_SCRIPT, WIDEST_FACE_SCRIPT, type LayerScan } from "./layers";
import { PAGE_FONT_FAMILIES } from "./page-css";
import { groundStructure, type GroundStructure } from "./verify";
import {
  COMP_MEASURE_SCRIPT,
  CompMeasureSchema,
  DOM_AUDIT_SCRIPT,
  DomAuditSchema,
  FINGERPRINT_SCRIPT,
  FingerprintSchema,
  PAGE_ELEMENTS,
  GEOMETRY_SCRIPT,
  GeometrySchema,
  HTML_BOX_SCRIPT,
  HtmlBoxSchema,
  PAIRS_SCRIPT,
  PairsSchema,
  PROTECTED_SCRIPT,
  ProtectedSchema,
  type GeometryRun,
  type Pairs,
  SHARED_ATTRIBUTES,
  type CompMeasure,
  type DomAudit,
  type Fingerprint,
  type ProtectedScan,
} from "./page-scripts";

export const PAGE_ORIGIN = "http://comp-impl.invalid";
/** The widths of the horizontal overflow sweep: the shop-CSS check's (320 … 1920). */
export const OVERFLOW_WIDTHS = SHOP_CSS_BASE_WIDTHS;
/** Full-page screenshots are capped (as the shop-CSS check caps its own). */
export const MAX_PAGE_HEIGHT = 16000;

export type Viewport = { width: number; height: number; scale: number; mobile: boolean };
export const DESKTOP: Viewport = { ...SHOT_VIEWPORTS.desktop, mobile: false };
export const MOBILE: Viewport = { ...SHOT_VIEWPORTS.mobile, mobile: true };

export type Opened = { context: BrowserContext; page: Page; blocked: () => number };

/** Opens the page at one viewport; requests other than the page's own files are aborted and counted. */
export async function openCompPage(browser: Browser, compPage: CompPage, v: Viewport): Promise<Opened> {
  const context = await browser.newContext({
    viewport: { width: v.width, height: v.height },
    deviceScaleFactor: v.scale,
    ...(v.mobile ? { isMobile: true, hasTouch: true } : {}),
    reducedMotion: "reduce",
    javaScriptEnabled: false,
    serviceWorkers: "block",
    offline: false,
  });
  let blocked = 0;
  await context.route("**/*", async (route) => {
    let url: URL;
    try {
      url = new URL(route.request().url());
    } catch {
      blocked += 1;
      return route.abort();
    }
    if (url.origin !== PAGE_ORIGIN || url.search !== "" || url.hash !== "") {
      blocked += 1;
      return route.abort();
    }
    const path = url.pathname.replace(/^\//, "");
    if (path === "index.html") return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: compPage.html });
    if (path === "style.css") return route.fulfill({ status: 200, contentType: "text/css; charset=utf-8", body: compPage.css });
    const file = compPage.files.get(path);
    if (file) return route.fulfill({ status: 200, contentType: "image/png", body: file });
    blocked += 1;
    return route.fulfill({ status: 404, body: "" });
  });
  try {
    const page = await context.newPage();
    const res = await page.goto(`${PAGE_ORIGIN}/index.html`, { waitUntil: "load" });
    if (res?.status() !== 200) throw Object.assign(new Error("page"), { code: "RENDER_FAILED" });
    await page.evaluate("document.fonts.ready.then(() => true)");
    return { context, page, blocked: () => blocked };
  } catch (error) {
    await context.close();
    throw error;
  }
}

export async function domAudit(page: Page): Promise<DomAudit> {
  return DomAuditSchema.parse(await page.evaluate(`(${DOM_AUDIT_SCRIPT})(${JSON.stringify({ elements: PAGE_ELEMENTS, shared: SHARED_ATTRIBUTES })})`));
}

export async function compMeasure(page: Page): Promise<CompMeasure> {
  return CompMeasureSchema.parse(await page.evaluate(`(${COMP_MEASURE_SCRIPT})()`));
}

/**
 * The shop-CSS render check's text measurement on the whole body: the body
 * becomes the measuring scope for this call (an id and a marker attribute on
 * this throwaway page). The caller keeps only fact / label nodes (the notice
 * and footer nodes would repeat them).
 */
export async function textMeasure(page: Page, facts: readonly string[]): Promise<Measure> {
  await page.evaluate(`(() => { if (document.getElementById("shop-css")) throw new Error("scope"); document.body.id = "shop-css"; document.body.setAttribute("data-shop-css", ""); })()`);
  return MeasureSchema.parse(await page.evaluate(`(${MEASURE_SCRIPT})(${JSON.stringify({ facts })})`));
}

/** The structural fingerprint of any HTML source (parsed, not rendered; evaluated on a blank page). */
export async function fingerprintOf(browser: Browser, html: string): Promise<Fingerprint> {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    return FingerprintSchema.parse(await page.evaluate(`(${FINGERPRINT_SCRIPT})(${JSON.stringify(html)})`));
  } finally {
    await context.close();
  }
}

/** A full-page screenshot, refusing absurd heights. */
export async function fullPageShot(page: Page): Promise<Buffer> {
  const height = (await page.evaluate("document.documentElement.scrollHeight")) as number;
  if (!(height > 0 && height <= MAX_PAGE_HEIGHT)) throw Object.assign(new Error("height"), { code: "RENDER_PAGE_TOO_TALL" });
  return page.screenshot({ fullPage: true, animations: "disabled", caret: "hide" });
}

/** Horizontal overflow at every sweep width (a fresh context each, the desktop kind). */
export async function overflowSweep(browser: Browser, compPage: CompPage, widths: readonly number[] = OVERFLOW_WIDTHS): Promise<Array<{ width: number; overflow: number; blocked: number }>> {
  return inBatches(widths, async (width) => {
    const o = await openCompPage(browser, compPage, { width, height: 900, scale: 1, mobile: false });
    try {
      const overflow = (await o.page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")) as number;
      return { width, overflow, blocked: o.blocked() };
    } finally {
      await o.context.close();
    }
  });
}

/** Contexts open at the same time (as the shop-CSS render check's PARALLEL). */
const PARALLEL = 4;
/** Runs fn over items, PARALLEL at a time, results in item order. */
export async function inBatches<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += PARALLEL) out.push(...(await Promise.all(items.slice(i, i + PARALLEL).map(fn))));
  return out;
}

/**
 * The widths to check a page at: the shop-CSS check's base widths (320 … 1920)
 * and 1px each side of every @media breakpoint (render-check.ts checkWidths,
 * fed the page's own breakpoints), so a rule that hides text only between two
 * breakpoints is seen.
 */
export function pageWidths(css: string): number[] {
  return checkWidths(pageBreakpointsPx(css).map((b) => `@media (min-width: ${b}px) {`).join("\n"));
}

/** Adds a style element (page.addStyleTag waits for a script-side load event, which never fires with JavaScript off). */
async function addStyle(page: Page, id: string, css: string): Promise<void> {
  await page.evaluate(`(() => { const s = document.createElement("style"); s.id = ${JSON.stringify(id)}; s.textContent = ${JSON.stringify(css)}; document.head.appendChild(s); })()`);
}


export type Legibility = {
  width: number;
  measure: Measure;
  scan: ProtectedScan;
  /** Per measured node of a protected element: the Stage 3 contrast share and ink proof. */
  lowContrast: Map<number, number>;
  ink: Map<number, Ink>;
  /** Per measured node of a protected element: the largest ink ratio of any character, page over reference (extra ink: a bar, a shadow, overprint). */
  inkExcess: Map<number, number>;
  pairs: Pairs;
  /** DEV-083 phase A: roles, paint order, non-content extents and writing mode at this width (layers.ts). */
  layers: LayerScan;
  /** DEV-083 phase A (V3b): per measured node of a protected element, the ground structure under its glyphs. */
  ground: Map<number, GroundStructure>;
  blocked: number;
};

/** What the pair check needs: each info label with its fact (spec.ts infoPairs) and every fact, whitespace-free. */
export type PairPlan = { pairs: ReadonlyArray<{ label: string; fact: string }>; facts: readonly string[] };

/** The phase A layer scan at the current viewport (layers.ts LAYER_SCRIPT). */
export async function layerScan(page: Page, required: readonly string[], o: { pairs?: boolean; mark?: boolean } = {}): Promise<LayerScan> {
  return LayerSchema.parse(await page.evaluate(`(${LAYER_SCRIPT})(${JSON.stringify({ facts: required, pairs: o.pairs === true, mark: o.mark === true })})`));
}

async function pairsOf(page: Page, plan: PairPlan): Promise<Pairs> {
  return PairsSchema.parse(await page.evaluate(`(${PAIRS_SCRIPT})(${JSON.stringify({ pairs: plan.pairs, facts: plan.facts, separators: SEPARATORS.source })})`));
}

/** The largest ratio of a character's ink on the page to its ink in the reference (characters too small to measure are left out). */
export function maxInkRatio(page: Picture, reference: Picture, node: Measure["nodes"][number]): number {
  const [cr, cg, cb, ca] = node.color;
  const alpha = Math.max(0, Math.min(1, ca * node.opacity));
  let max = 0;
  for (const box of node.chars) {
    const ref = inkMass(reference, box, [cr, cg, cb], alpha);
    if (ref < MIN_REFERENCE_INK) continue;
    max = Math.max(max, inkMass(page, box, [cr, cg, cb], alpha) / ref);
  }
  return max;
}

/**
 * The shop-CSS render check's measurement and pixel proof at one width, for
 * the whole body: MEASURE_SCRIPT (every text node), PROTECTED_SCRIPT (the
 * disclosure and the required facts), then for the protected elements the
 * Stage 3 contrast share on the ground actually painted under them
 * (lowContrastShare, the page without text) and the ink proof (inkOf: the
 * page against the same boxes with nothing painted but the text, in its own
 * colour on that ground). Transparent text, a transparent text fill, text in
 * the ground's colour, a cover or a mask leaves no ink or no contrast.
 */
export async function legibilityPass(browser: Browser, compPage: CompPage, width: number, facts: readonly string[], required: readonly string[], plan: PairPlan): Promise<Legibility> {
  const mobile = width <= MOBILE.width;
  const o = await openCompPage(browser, compPage, { width, height: 900, scale: 1, mobile });
  try {
    const page = o.page;
    const measure = await textMeasure(page, facts);
    const pairs = await pairsOf(page, plan);
    const scan = ProtectedSchema.parse(await page.evaluate(`(${PROTECTED_SCRIPT})(${JSON.stringify({ facts: required })})`));
    const layers = await layerScan(page, required);
    const ground = new Map<number, GroundStructure>();
    const owners = new Set(scan.owners.map((x) => x.owner));
    const nodes = measure.nodes.map((n, i) => ({ n, i })).filter(({ n }) => (n.kind === "fact" || n.kind === "label") && owners.has(n.owner));
    const lowContrast = new Map<number, number>();
    const ink = new Map<number, Ink>();
    const inkExcess = new Map<number, number>();
    if (nodes.length > 0 && measure.height <= MAX_PAGE_HEIGHT) {
      const shot = async () => decodePng(await page.screenshot({ fullPage: true, animations: "disabled", caret: "hide" }));
      const withText = await shot();
      await addStyle(page, "sr-hide", HIDE_TEXT_CSS);
      const without = await shot();
      await page.evaluate(`document.getElementById("sr-hide").remove()`);
      const firstOf = new Map<number, Measure["nodes"][number]>();
      for (const { n } of nodes) if (!firstOf.has(n.owner)) firstOf.set(n.owner, measure.nodes[n.owner] ?? n);
      const style = (fill: string) => [...firstOf.entries()].map(([i, n]) => ({ i, bg: groundColour(without, n), fill }));
      await addStyle(page, "sr-clean", CLEAN_CSS);
      await page.evaluate(`(${REFERENCE_SCRIPT})(${JSON.stringify(style("currentcolor"))})`);
      const cleanWith = await shot();
      await page.evaluate(`(${REFERENCE_SCRIPT})(${JSON.stringify(style("transparent"))})`);
      const cleanWithout = await shot();
      for (const { n, i } of nodes) {
        lowContrast.set(i, lowContrastShare(without, n));
        ink.set(i, inkOf({ withText, without }, { withText: cleanWith, without: cleanWithout }, n));
        inkExcess.set(i, maxInkRatio({ withText, without }, { withText: cleanWith, without: cleanWithout }, n));
        ground.set(i, groundStructure(without, n.chars));
      }
    }
    return { width, measure, scan, lowContrast, ink, inkExcess, pairs, layers, ground, blocked: o.blocked() };
  } finally {
    await o.context.close();
  }
}

/** The coarse sweep's step and range (on top of the checked widths): every 32px from 320 to 1920. */
export const SWEEP_STEP = 32;
export const sweepWidths = (): number[] => Array.from({ length: Math.floor((1920 - 320) / SWEEP_STEP) + 1 }, (_, i) => 320 + i * SWEEP_STEP);

export type SweepWidth = { width: number; measure: Measure; scan: ProtectedScan; pairs: Pairs; layers: LayerScan };

/**
 * The coarse sweep of protected text (third review of PR #96: text wrapped
 * between two checked widths and was painted over). One page context, the
 * viewport resized to each width (no reload, as the shop-css container scan
 * does), re-measuring with MEASURE_SCRIPT, PROTECTED_SCRIPT and PAIRS_SCRIPT:
 * clipped, covered, out of its box, overprinted, too small, faded, effects,
 * decoration, label order. The pixel proofs (contrast, ink) run at the
 * checked widths only. Desktop emulation at every width.
 */
export async function legibilitySweep(browser: Browser, compPage: CompPage, facts: readonly string[], required: readonly string[], plan: PairPlan, widths: readonly number[] = sweepWidths()): Promise<{ widths: SweepWidth[]; blocked: number }> {
  const o = await openCompPage(browser, compPage, { width: widths[0] ?? 320, height: 900, scale: 1, mobile: false });
  try {
    const page = o.page;
    await textMeasure(page, facts); // marks the scope and the measured elements once
    const out: SweepWidth[] = [];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      const measure = MeasureSchema.parse(await page.evaluate(`(${MEASURE_SCRIPT})(${JSON.stringify({ facts })})`));
      const scan = ProtectedSchema.parse(await page.evaluate(`(${PROTECTED_SCRIPT})(${JSON.stringify({ facts: required })})`));
      out.push({ width, measure, scan, pairs: await pairsOf(page, plan), layers: await layerScan(page, required) });
    }
    return { widths: out, blocked: o.blocked() };
  } finally {
    await o.context.close();
  }
}

/**
 * The ranges of widths (320 … 1920) in which every @media rule of the page is
 * constant: a min-width N rule changes between N-1 and N, a max-width N rule
 * between N and N+1, so N and N+1 both start a new range.
 */
export function mediaSegments(css: string, from = 320, to = 1920): Array<[number, number]> {
  const cuts = [...new Set(pageBreakpointsPx(css).flatMap((b) => [Math.ceil(b), Math.ceil(b) + 1]))].filter((c) => c > from && c <= to).sort((a, b) => a - b);
  const starts = [from, ...cuts];
  return starts.map((s, i) => [s, (starts[i + 1] ?? to + 1) - 1] as [number, number]);
}

/** A segment's mode in the 1px pass: the root's width stepped inside the page, or the real viewport resized at every width. */
export type SegmentMode = "stepped" | "real";
export type GeometryPass = { run: GeometryRun; ms: number; segments: number; segmentsStepped: number; segmentsReal: number; modes: Array<{ from: number; to: number; mode: SegmentMode }> };

/**
 * The 1px geometric pass over protected text (fifth and sixth reviews of PR
 * #96): every width from 320 to 1920. One page context. The widths are split
 * into media segments (every @media rule constant). For each segment, both ends
 * are first measured with a REAL resize and no override (HTML_BOX_SCRIPT): only
 * when the root element has no margin, border or padding and its margin box is
 * the viewport's width at both ends (its styles are constant inside the
 * segment, and a width clamped by min / max-width moves monotonically, so the
 * ends decide) does stepping the root's width inside the page stand in for the
 * viewport — fast (1,601 widths in well under a second of stepping). Otherwise
 * the segment is measured with a real setViewportSize at every 1px, nothing
 * overridden (about 7 ms a width). `range` limits the widths and `forceReal`
 * measures every width with real resizes (the equivalence test).
 */
export async function protectedGeometryPass(browser: Browser, compPage: CompPage, required: readonly string[], o: { range?: [number, number]; forceReal?: boolean; prepare?: (page: Page) => Promise<void> } = {}): Promise<GeometryPass> {
  const started = Date.now();
  const [lo, hi] = o.range ?? [320, 1920];
  const segments = mediaSegments(compPage.css)
    .map(([a, b]) => [Math.max(a, lo), Math.min(b, hi)] as [number, number])
    .filter(([a, b]) => a <= b);
  const ctx = await openCompPage(browser, compPage, { width: segments[0]![1], height: 900, scale: 1, mobile: false });
  // DEV-083 phase A: a test-only hook (the V10 perturbation harness changes the metrics before measuring)
  if (o.prepare) await o.prepare(ctx.page);
  const geometry = async (from: number, to: number, step: boolean) =>
    GeometrySchema.parse(await ctx.page.evaluate(`(${GEOMETRY_SCRIPT})(${JSON.stringify({ facts: required, from, to, step })})`));
  const plainRoot = async (width: number) => {
    await ctx.page.setViewportSize({ width, height: 900 });
    const box = HtmlBoxSchema.parse(await ctx.page.evaluate(`(${HTML_BOX_SCRIPT})()`));
    return box.zero && Math.abs(box.marginBox - box.innerWidth) <= 0.5;
  };
  try {
    const failing: GeometryRun["failing"] = [];
    const modes: GeometryPass["modes"] = [];
    let targets = 0;
    for (const [from, to] of segments) {
      // "the ends decide" relies on the value grammar (shop-css/values.ts): it refuses subtraction and negative terms, so
      // every html box value (width, min / max-width, margins, paddings, borders) is a non-decreasing function of the
      // viewport width with slope ≤ 1 — zero with the margin box equal to the viewport at both ends means zero between them
      const stepped = !o.forceReal && (await plainRoot(from)) && (await plainRoot(to));
      modes.push({ from, to, mode: stepped ? "stepped" : "real" });
      if (stepped) {
        await ctx.page.setViewportSize({ width: to, height: 900 });
        const run = await geometry(from, to, true);
        targets = Math.max(targets, run.targets);
        failing.push(...run.failing);
      } else {
        for (let w = from; w <= to; w++) {
          await ctx.page.setViewportSize({ width: w, height: 900 });
          const run = await geometry(w, w, false);
          targets = Math.max(targets, run.targets);
          failing.push(...run.failing);
        }
      }
    }
    const real = modes.filter((m) => m.mode === "real").length;
    return { run: { targets, failing }, ms: Date.now() - started, segments: modes.length, segmentsStepped: modes.length - real, segmentsReal: real, modes };
  } finally {
    await ctx.context.close();
  }
}

// ---------------------------------------------------------------- DEV-083 phase A (verification only)

/** The ends of each media segment decide whether the root's width can stand in for the viewport (as protectedGeometryPass). */
async function segmentModes(page: Page, compPage: CompPage, range: [number, number] | undefined, forceReal: boolean): Promise<Array<{ from: number; to: number; stepped: boolean }>> {
  const [lo, hi] = range ?? [320, 1920];
  const plainRoot = async (width: number) => {
    await page.setViewportSize({ width, height: 900 });
    const box = HtmlBoxSchema.parse(await page.evaluate(`(${HTML_BOX_SCRIPT})()`));
    return box.zero && Math.abs(box.marginBox - box.innerWidth) <= 0.5;
  };
  const out: Array<{ from: number; to: number; stepped: boolean }> = [];
  for (const [a, b] of mediaSegments(compPage.css)) {
    const from = Math.max(a, lo);
    const to = Math.min(b, hi);
    if (from > to) continue;
    out.push({ from, to, stepped: !forceReal && (await plainRoot(from)) && (await plainRoot(to)) });
  }
  return out;
}

export type LayoutHashes = { hashes: Map<number, string>; targets: number; ms: number; segments: number; changes: number };

/**
 * V6 layout-change detection: the signature of the geometry around every protected line (layers.ts LAYOUT_HASH_SCRIPT)
 * at every width, with the 1 px pass's own stepping (root width where html has no box, real resizes elsewhere).
 * `changes` counts the widths whose signature differs from the width before (within a segment).
 */
export async function layoutHashPass(browser: Browser, compPage: CompPage, required: readonly string[], o: { range?: [number, number]; forceReal?: boolean } = {}): Promise<LayoutHashes> {
  const started = Date.now();
  const ctx = await openCompPage(browser, compPage, { width: 320, height: 900, scale: 1, mobile: false });
  try {
    const hashes = new Map<number, string>();
    let targets = 0;
    let changes = 0;
    const modes = await segmentModes(ctx.page, compPage, o.range, o.forceReal === true);
    for (const m of modes) {
      const runs: Array<{ w: number; h: string }> = [];
      if (m.stepped) {
        await ctx.page.setViewportSize({ width: m.to, height: 900 });
        const r = LayoutHashSchema.parse(await ctx.page.evaluate(`(${LAYOUT_HASH_SCRIPT})(${JSON.stringify({ facts: required, from: m.from, to: m.to, step: true })})`));
        targets = Math.max(targets, r.targets);
        runs.push(...r.widths);
      } else {
        for (let w = m.from; w <= m.to; w++) {
          await ctx.page.setViewportSize({ width: w, height: 900 });
          const r = LayoutHashSchema.parse(await ctx.page.evaluate(`(${LAYOUT_HASH_SCRIPT})(${JSON.stringify({ facts: required, from: w, to: w, step: false })})`));
          targets = Math.max(targets, r.targets);
          runs.push(...r.widths);
        }
      }
      runs.forEach((x, i) => {
        hashes.set(x.w, x.h);
        if (i > 0 && runs[i - 1]!.h !== x.h) changes += 1;
      });
    }
    return { hashes, targets, ms: Date.now() - started, segments: modes.length, changes };
  } finally {
    await ctx.context.close();
  }
}

/**
 * The 1 px pass gated by layout-change detection (V6): GEOMETRY_SCRIPT runs only at the widths where the layout
 * signature changes, at both neighbours and at the ends of every segment; every other width takes the findings of the
 * start of its run of equal signatures. Phase A uses it only as a measured alternative: tests compare it with the full
 * pass (protectedGeometryPass) width by width on every probe. `checked` is the number of widths measured fully.
 */
export async function gatedGeometryPass(browser: Browser, compPage: CompPage, required: readonly string[], o: { range?: [number, number] } = {}): Promise<GeometryPass & { checked: number; hashMs: number }> {
  const started = Date.now();
  const ctx = await openCompPage(browser, compPage, { width: 320, height: 900, scale: 1, mobile: false });
  try {
    const failing: GeometryRun["failing"] = [];
    const modes: GeometryPass["modes"] = [];
    let targets = 0;
    let checked = 0;
    let hashMs = 0;
    for (const m of await segmentModes(ctx.page, compPage, o.range, false)) {
      modes.push({ from: m.from, to: m.to, mode: m.stepped ? "stepped" : "real" });
      const t0 = Date.now();
      const sig: Array<{ w: number; h: string }> = [];
      if (m.stepped) {
        await ctx.page.setViewportSize({ width: m.to, height: 900 });
        sig.push(...LayoutHashSchema.parse(await ctx.page.evaluate(`(${LAYOUT_HASH_SCRIPT})(${JSON.stringify({ facts: required, from: m.from, to: m.to, step: true })})`)).widths);
      } else {
        for (let w = m.from; w <= m.to; w++) {
          await ctx.page.setViewportSize({ width: w, height: 900 });
          sig.push(...LayoutHashSchema.parse(await ctx.page.evaluate(`(${LAYOUT_HASH_SCRIPT})(${JSON.stringify({ facts: required, from: w, to: w, step: false })})`)).widths);
        }
      }
      hashMs += Date.now() - t0;
      const must = new Set<number>([m.from, m.to]);
      sig.forEach((x, i) => {
        if (i > 0 && sig[i - 1]!.h !== x.h) {
          must.add(x.w);
          must.add(sig[i - 1]!.w);
        }
      });
      const widths = [...must].sort((a, b) => a - b);
      checked += widths.length;
      const found = new Map<number, string[]>();
      if (m.stepped) {
        await ctx.page.setViewportSize({ width: m.to, height: 900 });
        // consecutive widths in one call
        for (let i = 0; i < widths.length; ) {
          let j = i;
          while (j + 1 < widths.length && widths[j + 1] === widths[j]! + 1) j++;
          const run = GeometrySchema.parse(await ctx.page.evaluate(`(${GEOMETRY_SCRIPT})(${JSON.stringify({ facts: required, from: widths[i], to: widths[j], step: true })})`));
          targets = Math.max(targets, run.targets);
          for (const f of run.failing) found.set(f.w, f.codes);
          i = j + 1;
        }
      } else {
        for (const w of widths) {
          await ctx.page.setViewportSize({ width: w, height: 900 });
          const run = GeometrySchema.parse(await ctx.page.evaluate(`(${GEOMETRY_SCRIPT})(${JSON.stringify({ facts: required, from: w, to: w, step: false })})`));
          targets = Math.max(targets, run.targets);
          for (const f of run.failing) found.set(f.w, f.codes);
        }
      }
      let start = sig[0]!.w;
      sig.forEach((x, i) => {
        if (i > 0 && sig[i - 1]!.h !== x.h) start = x.w;
        const codes = must.has(x.w) ? found.get(x.w) : found.get(start);
        if (codes && codes.length > 0) failing.push({ w: x.w, codes });
      });
    }
    const real = modes.filter((m) => m.mode === "real").length;
    return { run: { targets, failing }, ms: Date.now() - started, segments: modes.length, segmentsStepped: modes.length - real, segmentsReal: real, modes, checked, hashMs };
  } finally {
    await ctx.context.close();
  }
}

export const PERTURBATIONS = ["wide_font", "tracking_plus", "tracking_minus"] as const;
export type Perturbation = (typeof PERTURBATIONS)[number];

/** The widest installed face of the allowlist's text faces (the stand-in for a font that failed to load, V10). */
export async function widestFace(page: Page): Promise<string | null> {
  return (await page.evaluate(`(${WIDEST_FACE_SCRIPT})(${JSON.stringify({ faces: PAGE_FONT_FAMILIES })})`)) as string | null;
}

/**
 * V10's metric perturbation harness: the 1 px protected pass with every element's face replaced by the widest installed
 * text face, or ±0.05 em added to every element's letter-spacing (computed once at the opening width). Phase A runs it
 * in tests only; it gates a page once an overlap capability is approved (METRICS_FRAGILE, verify.ts metricsCheck).
 */
export async function perturbedGeometryPass(browser: Browser, compPage: CompPage, required: readonly string[], kind: Perturbation, o: { range?: [number, number] } = {}): Promise<GeometryPass & { face: string | null }> {
  let face: string | null = null;
  const pass = await protectedGeometryPass(browser, compPage, required, {
    ...o,
    prepare: async (page) => {
      face = kind === "wide_font" ? await widestFace(page) : null;
      if (kind === "wide_font" && face === null) throw Object.assign(new Error("face"), { code: "PERTURB_NO_FACE" });
      await page.evaluate(`(${PERTURB_SCRIPT})(${JSON.stringify({ kind, face })})`);
    },
  });
  return { ...pass, face };
}

/**
 * V3's layered reference (phase A: built and tested on raw test HTML; it replaces nothing in the run). The reference
 * keeps the page's ground and media layers, hides every decoration element (data-comp-role, V1) and every text but the
 * protected text, which is drawn in its own colour: ink is then compared on the very ground painted under it (a
 * gradient, a photo), and anything a decoration or another text adds over it shows as missing or extra ink. Returns,
 * per measured node of a protected element, the ink proof against that reference.
 */
export async function layeredInkPass(browser: Browser, compPage: CompPage, width: number, facts: readonly string[], required: readonly string[]): Promise<{ measure: Measure; ink: Map<number, Ink>; inkExcess: Map<number, number>; decoration: number }> {
  const o = await openCompPage(browser, compPage, { width, height: 900, scale: 1, mobile: width <= MOBILE.width });
  try {
    const page = o.page;
    const measure = await textMeasure(page, facts);
    const scan = ProtectedSchema.parse(await page.evaluate(`(${PROTECTED_SCRIPT})(${JSON.stringify({ facts: required })})`));
    const layers = await layerScan(page, required, { mark: true });
    const owners = [...new Set(scan.owners.map((x) => x.owner))];
    const nodes = measure.nodes.map((n, i) => ({ n, i })).filter(({ n }) => (n.kind === "fact" || n.kind === "label") && owners.includes(n.owner));
    const shot = async () => decodePng(await page.screenshot({ fullPage: true, animations: "disabled", caret: "hide" }));
    const withText = await shot();
    await addStyle(page, "sr-hide", HIDE_TEXT_CSS);
    const without = await shot();
    await addStyle(page, "pa-layered", "[data-pa-role=decoration], [data-pa-role=decoration] * { visibility: hidden !important; }");
    const keep = (on: boolean) => page.evaluate(`(() => { for (const i of ${JSON.stringify(owners)}) { const el = document.querySelector('[data-sr-i="' + i + '"]'); if (!el) continue; if (${on}) el.style.setProperty("-webkit-text-fill-color", "currentcolor", "important"); else el.style.removeProperty("-webkit-text-fill-color"); } })()`);
    await keep(true);
    const refWith = await shot();
    await keep(false);
    const refWithout = await shot();
    const ink = new Map<number, Ink>();
    const inkExcess = new Map<number, number>();
    for (const { n, i } of nodes) {
      ink.set(i, inkOf({ withText, without }, { withText: refWith, without: refWithout }, n));
      inkExcess.set(i, maxInkRatio({ withText, without }, { withText: refWith, without: refWithout }, n));
    }
    return { measure, ink, inkExcess, decoration: layers.roles.counts.decoration };
  } finally {
    await o.context.close();
  }
}

export type PaintVerdict = { text: number; node: number; box: number; kind: "bg" | "replaced" | "outline"; model: "text" | "box"; chromium: "text" | "box" | "unclear"; glyphPixels: number };

/**
 * V2's own test (§2): the model's predicted order against Chromium's actual painting. For every intersecting pair of a
 * text node and a box (LAYER_SCRIPT pairs), everything is made transparent but that text (pure red) and, in a second
 * picture, that box (pure blue, or the img itself, or a blue outline); where the text's opaque glyph pixels change when
 * the box is painted, the box is on top. Paint order is not changed by colours, so this reads Chromium's real order;
 * opacity, transforms and blend modes stay as the page has them. Mutates the page (a throwaway page only).
 */
export async function paintCrossCheck(page: Page, required: readonly string[]): Promise<PaintVerdict[]> {
  const scan = await layerScan(page, required, { pairs: true });
  const base =
    "*, *::before, *::after { color: transparent !important; -webkit-text-fill-color: transparent !important; background: transparent !important; border-color: transparent !important; box-shadow: none !important; outline-color: transparent !important; text-decoration-color: transparent !important; text-shadow: none !important; caret-color: transparent !important; } img { object-position: -99999px -99999px !important; } [data-pc-t] { color: #f00 !important; -webkit-text-fill-color: #f00 !important; }";
  // appended after body, so the element indices of the scan (document.querySelectorAll("*")) stay the same
  const tail = (id: string, css: string) => page.evaluate(`(() => { const s = document.createElement("style"); s.id = ${JSON.stringify(id)}; s.textContent = ${JSON.stringify(css)}; document.documentElement.appendChild(s); })()`);
  await tail("pc-base", base);
  const out: PaintVerdict[] = [];
  const seen = new Set<string>();
  for (const p of scan.pairs ?? []) {
    const key = `${p.text}/${p.node}/${p.box}/${p.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await page.evaluate(`(() => { const all = document.querySelectorAll("*"); all[${p.text}].setAttribute("data-pc-t", ""); all[${p.box}].setAttribute("data-pc-b", ""); })()`);
    const clip = { x: Math.floor(p.rect.left), y: Math.floor(p.rect.top), width: Math.max(1, Math.ceil(p.rect.right) - Math.floor(p.rect.left)), height: Math.max(1, Math.ceil(p.rect.bottom) - Math.floor(p.rect.top)) };
    const a = decodePng(await page.screenshot({ clip, animations: "disabled", caret: "hide" }));
    const on = p.kind === "bg" ? "[data-pc-b] { background: #00f !important; }" : p.kind === "outline" ? "[data-pc-b] { outline-color: #00f !important; }" : "img[data-pc-b] { object-position: 50% 50% !important; }";
    await tail("pc-on", on);
    const b = decodePng(await page.screenshot({ clip, animations: "disabled", caret: "hide" }));
    await page.evaluate(`(() => { document.getElementById("pc-on").remove(); for (const el of Array.from(document.querySelectorAll("[data-pc-t], [data-pc-b]"))) { el.removeAttribute("data-pc-t"); el.removeAttribute("data-pc-b"); } })()`);
    let glyph = 0;
    let changed = 0;
    for (let i = 0; i < a.width * a.height; i++) {
      const k = i * a.channels;
      if (a.data[k]! >= 247 && a.data[k + 1]! <= 8 && a.data[k + 2]! <= 8) {
        glyph += 1;
        if ([0, 1, 2].some((c) => Math.abs(a.data[k + c]! - b.data[k + c]!) > 8)) changed += 1;
      }
    }
    const chromium = glyph < 3 ? "unclear" : changed / glyph >= 0.5 ? "box" : changed / glyph <= 0.05 ? "text" : "unclear";
    out.push({ text: p.text, node: p.node, box: p.box, kind: p.kind, model: p.after ? "box" : "text", chromium, glyphPixels: glyph });
  }
  await page.evaluate(`document.getElementById("pc-base").remove()`);
  return out;
}
