/**
 * DEV-165 — RESEARCH ONLY, NOT ENABLED. What the existing phase A layer scan (DEV-083 V1 / V2 / V4, comp-impl/layers.ts
 * through render.ts `layerScan`, codes from verify.ts) and the existing 1 px geometry script (comp-impl/page-scripts.ts
 * GEOMETRY_SCRIPT: FACT_ / DISCLOSURE_IMAGE_OVERLAP, _COVERED …) say about a decorative SVG `<img>` placed by research
 * CSS over, under or clear of text. It reuses those scripts as they are and changes nothing in comp-impl: it only
 * reports which codes fire, so docs/design/n1-decoration-svg.md §7 can say what phase C must still prove before N1.
 *
 * The page is served from memory at http://decoration-layers.invalid/page/index.html with the recorded SVGs next to it;
 * every other request is aborted and counted. JavaScript is off (the harness's evaluate still runs). The research CSS is
 * added as a style element after load, like decoration-page-browser.ts. The same CSS is also given to the production
 * stylesheet allowlist (page-css.ts `pageCssProblems`) so the report shows what refuses it before any render today.
 * Nothing in a lane imports this module (pinned by tests/unit/design-agent/research/decoration-svg.test.ts).
 */
import type { Browser } from "playwright";
import { pageCssProblems } from "../comp-impl/page-css";
import { GEOMETRY_SCRIPT, GeometrySchema } from "../comp-impl/page-scripts";
import { layerScan } from "../comp-impl/render";
import { BLOCKING_LAYER_CODES, layerCodes } from "../comp-impl/verify";
import type { LayerScan } from "../comp-impl/layers";
import { checkDecorationPage, type DecorationAssetRef } from "./decoration-svg";

export const DECORATION_LAYERS_ORIGIN = "http://decoration-layers.invalid";
const PAGE_URL = `${DECORATION_LAYERS_ORIGIN}/page/index.html`;

export type DecorationLayerReport = {
  /** The N1 page allowlist (decoration-svg.ts checkDecorationPage) on the HTML; the research CSS is passed as "" (it is checked below). */
  page_static: string[];
  /** The production stylesheet allowlist on the research CSS: what refuses the placement before any render today. */
  page_css: string[];
  /** Every layer-scan code (verify.ts layerCodes), and the split the run applies (BLOCKING_LAYER_CODES; the rest is advisory). */
  layer_codes: string[];
  layer_blocking: string[];
  layer_advisory: string[];
  /** GEOMETRY_SCRIPT codes at the viewport width (blocking in the run: protected text meeting any img, covered, hidden …). */
  geometry: string[];
  /** Counts from the scan, for the report. */
  stacking: number;
  covers: number;
  roles: LayerScan["roles"]["counts"];
  /** Requests other than the page and its recorded SVGs (aborted). */
  unexpected_requests: string[];
};

/**
 * Renders `html` + `css` at `width` × `height` with `svgs` (published path → bytes) next to the page and runs the phase A
 * layer scan (facts: whitespace-free required strings; `declared`: read data-comp-role, the test path of layers.ts) and
 * the geometry script once at that width.
 */
export async function scanDecorationLayers(
  browser: Browser,
  o: { html: string; css: string; svgs: ReadonlyMap<string, string>; assets: readonly DecorationAssetRef[]; facts: readonly string[]; width?: number; height?: number; declared?: boolean },
): Promise<DecorationLayerReport> {
  const width = o.width ?? 800;
  const height = o.height ?? 600;
  const files = new Map([...o.svgs].map(([path, body]) => [`${DECORATION_LAYERS_ORIGIN}/page/${path}`, body]));
  const unexpected: string[] = [];
  const ctx = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block", viewport: { width, height }, deviceScaleFactor: 1 });
  try {
    const page = await ctx.newPage();
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url === PAGE_URL) return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: o.html });
      const svg = files.get(url);
      if (svg !== undefined) return route.fulfill({ status: 200, contentType: "image/svg+xml", body: svg });
      if (url !== `${DECORATION_LAYERS_ORIGIN}/favicon.ico`) unexpected.push(url);
      return route.abort("blockedbyclient");
    });
    await page.goto(PAGE_URL, { waitUntil: "load" });
    if (o.css)
      await page.evaluate((c) => {
        (document.head ?? document.documentElement).append(Object.assign(document.createElement("style"), { textContent: c }));
      }, o.css);
    await page.evaluate("document.fonts ? document.fonts.ready.then(() => true) : true");
    const scan = await layerScan(page, o.facts, { declared: o.declared === true });
    const geometry = GeometrySchema.parse(await page.evaluate(`(${GEOMETRY_SCRIPT})(${JSON.stringify({ facts: o.facts, from: width, to: width, step: false })})`));
    const codes = layerCodes(scan).sort();
    const blocking = codes.filter((c) => (BLOCKING_LAYER_CODES as readonly string[]).includes(c));
    return {
      page_static: checkDecorationPage(o.html, "", o.assets).problems,
      page_css: pageCssProblems(o.css),
      layer_codes: codes,
      layer_blocking: blocking,
      layer_advisory: codes.filter((c) => !blocking.includes(c)),
      geometry: [...new Set(geometry.failing.flatMap((f) => f.codes))].sort(),
      stacking: scan.stacking,
      covers: scan.covers.count,
      roles: scan.roles.counts,
      unexpected_requests: [...new Set(unexpected)],
    };
  } finally {
    await ctx.close();
  }
}
