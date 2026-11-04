/**
 * DEV-162 — RESEARCH ONLY, NOT ENABLED. The second line behind checkDecorationPage (decoration-svg.ts): render the page
 * in Chromium twice, JS on and JS off, and look at what the browser actually requested and shows. Nothing in a lane
 * imports this module (pinned by tests/unit/design-agent/research/decoration-svg.test.ts).
 *
 * The page is served at http://decoration-page.invalid/page/index.html from the given HTML string; the recorded assets
 * at /page/<file> from the page directory. Every request (route and request log) must be the page itself as the
 * document, or a recorded asset's URL as an image; anything else is aborted (nothing leaves the machine) and reported
 * as PAGE_UNEXPECTED_REQUEST. After load (lazy images scrolled into view), the DOM is cross-checked: every element is
 * on the static allowlist (PAGE_DOM_ELEMENT_NOT_ALLOWED), every `img` is a decorative one whose currentSrc is a recorded
 * asset (PAGE_UNEXPECTED_IMG), the decorative imgs' currentSrc set equals the static check's `used` set
 * (PAGE_DECORATION_MISMATCH), and every performance resource entry is a recorded asset (PAGE_UNEXPECTED_REQUEST).
 * The static check stays the primary gate; this one exists because a tokenizer can still disagree with a browser.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Request } from "playwright";
import { checkDecorationPage, DECORATION_FILE, DECORATION_PAGE_ELEMENTS, type DecorationAssetRef } from "./decoration-svg";

export const DECORATION_PAGE_ORIGIN = "http://decoration-page.invalid";
const PAGE_URL = `${DECORATION_PAGE_ORIGIN}/page/index.html`;
/**
 * Chromium's own favicon fetch for an http page. It shows up as a resource entry, not as a page request; the page cannot
 * ask for it (no `link` passes, and an img of it fails the DOM check), so it is not reported. The route aborts it.
 */
const FAVICON = `${DECORATION_PAGE_ORIGIN}/favicon.ico`;

export type DecorationBrowserRun = { javaScript: boolean; requests: string[]; unexpected: string[]; decorative: string[]; problems: string[] };
export type DecorationBrowserCheck = { problems: string[]; runs: DecorationBrowserRun[] };

/** Chromium, headless, from PLAYWRIGHT_CHROMIUM_EXECUTABLE when it is set. */
export function launchDecorationBrowser(): Promise<Browser> {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  return chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
}

/** In the page: every element's name (but the harness's own style element), every img's markers and currentSrc, every resource entry. */
const domScript = (skip: Element | null) => ({
  elements: Array.from(document.getElementsByTagName("*"))
    .filter((e) => e !== skip)
    .map((e) => `${e.localName}|${e.namespaceURI ?? ""}`),
  imgs: Array.from(document.images).map((i) => ({ src: i.currentSrc, alt: i.getAttribute("alt"), hidden: i.getAttribute("aria-hidden"), referrer: i.getAttribute("referrerpolicy") })),
  resources: performance.getEntriesByType("resource").map((r) => r.name),
});
type Dom = { elements: string[]; imgs: { src: string; alt: string | null; hidden: string | null; referrer: string | null }[]; resources: string[] };

/**
 * Renders `html` (with `css` added as a style tag) as the page in `dir` and returns every problem the browser shows, per
 * run and together. Never throws for a hostile page: a failed run is PAGE_BROWSER_ERROR.
 */
export async function verifyDecorationPageInBrowser(browser: Browser, dir: string, html: string, css: string, assets: readonly DecorationAssetRef[]): Promise<DecorationBrowserCheck> {
  const { used } = checkDecorationPage(html, css, assets);
  const files = new Map<string, string>();
  for (const a of assets) if (typeof a?.file === "string" && DECORATION_FILE.test(a.file)) files.set(`${DECORATION_PAGE_ORIGIN}/page/${a.file}`, a.file);
  const expected = new Set(used.map((f) => `${DECORATION_PAGE_ORIGIN}/page/${f}`));
  const runs: DecorationBrowserRun[] = [];
  for (const javaScript of [true, false]) runs.push(await run(browser, dir, html, css, files, expected, javaScript));
  return { problems: [...new Set(runs.flatMap((r) => r.problems))].sort(), runs };
}

async function run(browser: Browser, dir: string, html: string, css: string, files: Map<string, string>, expected: Set<string>, javaScript: boolean): Promise<DecorationBrowserRun> {
  const p = new Set<string>();
  const requests: string[] = [];
  const unexpected: string[] = [];
  const allowed = (r: Request) => (r.url() === PAGE_URL && r.resourceType() === "document") || (files.has(r.url()) && r.resourceType() === "image");
  const ctx = await browser.newContext({ javaScriptEnabled: javaScript, serviceWorkers: "block", viewport: { width: 1280, height: 900 } });
  let decorative: string[] = [];
  try {
    const page = await ctx.newPage();
    page.on("request", (r) => {
      requests.push(r.url());
      if (!allowed(r)) unexpected.push(r.url());
    });
    await page.route("**/*", (route) => {
      const r = route.request();
      if (!allowed(r)) return route.abort("blockedbyclient");
      if (r.url() === PAGE_URL) return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
      return route.fulfill({ status: 200, contentType: "image/svg+xml", body: readFileSync(join(dir, files.get(r.url())!)) });
    });
    await page.goto(PAGE_URL, { waitUntil: "load" });
    // addStyleTag waits on a script-side load event, which never comes with JS off; evaluate runs either way
    const injected = css
      ? await page.evaluateHandle((c) => {
          const style = Object.assign(document.createElement("style"), { textContent: c });
          (document.head ?? document.documentElement).append(style);
          return style;
        }, css)
      : null;
    await page.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)");
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(200);
    const dom: Dom = await page.evaluate(domScript, injected);
    for (const e of dom.elements) {
      const [name, ns] = e.split("|");
      if (ns !== "http://www.w3.org/1999/xhtml" || !Object.hasOwn(DECORATION_PAGE_ELEMENTS, name!)) p.add("PAGE_DOM_ELEMENT_NOT_ALLOWED");
    }
    const shown = new Set<string>();
    for (const img of dom.imgs) {
      if (img.alt === "" && img.hidden === "true" && img.referrer === "no-referrer" && files.has(img.src)) shown.add(img.src);
      else p.add("PAGE_UNEXPECTED_IMG");
    }
    decorative = [...shown].sort();
    if (decorative.length !== expected.size || decorative.some((s) => !expected.has(s))) p.add("PAGE_DECORATION_MISMATCH");
    for (const r of dom.resources) if (!files.has(r) && r !== FAVICON) unexpected.push(r);
  } catch {
    p.add("PAGE_BROWSER_ERROR");
  } finally {
    await ctx.close();
  }
  if (unexpected.length) p.add("PAGE_UNEXPECTED_REQUEST");
  return { javaScript, requests, unexpected: [...new Set(unexpected)], decorative, problems: [...p].sort() };
}
