/**
 * Renders a comp implementation in Chromium (DEV-082) with the network shut:
 * every request goes through a route handler that answers only the page's own
 * files (index.html, style.css, the listed assets) under a fixed origin that
 * cannot resolve, and aborts everything else (counted: any attempt fails the
 * run). JavaScript is off in the context (the page has none; the harness's
 * evaluate still runs). Fonts are the machine's own (no @font-face is allowed).
 */
import type { Browser, BrowserContext, Page } from "playwright";
import { SHOP_CSS_BASE_WIDTHS } from "../shop-css/render-check";
import { MEASURE_SCRIPT, MeasureSchema, type Measure } from "../shop-css/page-scripts";
import { SHOT_VIEWPORTS } from "../shot-viewports";
import type { CompPage } from "./page";
import { COMP_MEASURE_SCRIPT, CompMeasureSchema, DOM_AUDIT_SCRIPT, DomAuditSchema, FINGERPRINT_SCRIPT, FingerprintSchema, PAGE_ELEMENTS, SHARED_ATTRIBUTES, type CompMeasure, type DomAudit, type Fingerprint } from "./page-scripts";

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
export async function overflowSweep(browser: Browser, compPage: CompPage): Promise<Array<{ width: number; overflow: number; blocked: number }>> {
  const out: Array<{ width: number; overflow: number; blocked: number }> = [];
  for (const width of OVERFLOW_WIDTHS) {
    const o = await openCompPage(browser, compPage, { width, height: 900, scale: 1, mobile: false });
    try {
      const overflow = (await o.page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")) as number;
      out.push({ width, overflow, blocked: o.blocked() });
    } finally {
      await o.context.close();
    }
  }
  return out;
}
