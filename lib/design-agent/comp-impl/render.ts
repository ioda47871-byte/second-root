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
import { COMP_INFO_LABELS } from "./spec";
import {
  COMP_MEASURE_SCRIPT,
  CompMeasureSchema,
  DOM_AUDIT_SCRIPT,
  DomAuditSchema,
  FINGERPRINT_SCRIPT,
  FingerprintSchema,
  PAGE_ELEMENTS,
  PAIRS_SCRIPT,
  PairsSchema,
  PROTECTED_SCRIPT,
  ProtectedSchema,
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
  blocked: number;
};

async function pairsOf(page: Page): Promise<Pairs> {
  return PairsSchema.parse(await page.evaluate(`(${PAIRS_SCRIPT})(${JSON.stringify({ labels: COMP_INFO_LABELS })})`));
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
export async function legibilityPass(browser: Browser, compPage: CompPage, width: number, facts: readonly string[], required: readonly string[]): Promise<Legibility> {
  const mobile = width <= MOBILE.width;
  const o = await openCompPage(browser, compPage, { width, height: 900, scale: 1, mobile });
  try {
    const page = o.page;
    const measure = await textMeasure(page, facts);
    const pairs = await pairsOf(page);
    const scan = ProtectedSchema.parse(await page.evaluate(`(${PROTECTED_SCRIPT})(${JSON.stringify({ facts: required })})`));
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
      }
    }
    return { width, measure, scan, lowContrast, ink, inkExcess, pairs, blocked: o.blocked() };
  } finally {
    await o.context.close();
  }
}

/** The coarse sweep's step and range (on top of the checked widths): every 32px from 320 to 1920. */
export const SWEEP_STEP = 32;
export const sweepWidths = (): number[] => Array.from({ length: Math.floor((1920 - 320) / SWEEP_STEP) + 1 }, (_, i) => 320 + i * SWEEP_STEP);

export type SweepWidth = { width: number; measure: Measure; scan: ProtectedScan; pairs: Pairs };

/**
 * The coarse sweep of protected text (third review of PR #96: text wrapped
 * between two checked widths and was painted over). One page context, the
 * viewport resized to each width (no reload, as the shop-css container scan
 * does), re-measuring with MEASURE_SCRIPT, PROTECTED_SCRIPT and PAIRS_SCRIPT:
 * clipped, covered, out of its box, overprinted, too small, faded, effects,
 * decoration, label order. The pixel proofs (contrast, ink) run at the
 * checked widths only. Desktop emulation at every width.
 */
export async function legibilitySweep(browser: Browser, compPage: CompPage, facts: readonly string[], required: readonly string[], widths: readonly number[] = sweepWidths()): Promise<{ widths: SweepWidth[]; blocked: number }> {
  const o = await openCompPage(browser, compPage, { width: widths[0] ?? 320, height: 900, scale: 1, mobile: false });
  try {
    const page = o.page;
    await textMeasure(page, facts); // marks the scope and the measured elements once
    const out: SweepWidth[] = [];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      const measure = MeasureSchema.parse(await page.evaluate(`(${MEASURE_SCRIPT})(${JSON.stringify({ facts })})`));
      const scan = ProtectedSchema.parse(await page.evaluate(`(${PROTECTED_SCRIPT})(${JSON.stringify({ facts: required })})`));
      out.push({ width, measure, scan, pairs: await pairsOf(page) });
    }
    return { widths: out, blocked: o.blocked() };
  } finally {
    await o.context.close();
  }
}
