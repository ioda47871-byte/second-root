/**
 * DEV-303 §3.7 Q1, first experiment — LOCAL, FICTIONAL, a manual script (not a unit test, to keep the unit shards
 * short): build every Q1 fixture (fixtures.ts) with the fictional bakery's page code and look at it in Chromium at
 * PC 1440 and SP 390 (JS off, every request outside the built site blocked).
 *
 *   npx tsx experiments/pages-cms/q1-check.ts --out <empty dir outside the repository>
 *
 * Limits (review L5): "cut off" is horizontal only (vertical clipping is not detected), and overlap covers the menu
 * items only (not other sections).
 * PR (3): the fixtures of every fictional shop site (shop-site.ts SHOP_SITES), each built with its own page code.
 * Per fixture and width it records: horizontal overflow, broken pictures, overlapping boxes (menu items with each
 * other, and the texts inside one item), unreadable text (font smaller than 12px, or text cut off by its box), and
 * requests that left the site; it saves the page shot (taken at the page's own height, not fullPage: DEV-135).
 * Writes <out>/q1-report.json and <out>/<fixture>-<pc|sp>.png. Exit 0 when nothing was found, 1 otherwise.
 *
 * The existing render helpers (phase2f render-prototype, comp-impl render) are pinned to their importers by the
 * owner-approved isolation tests, so this experiment uses Playwright and the unpinned DEV-098 frame wait directly.
 */
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import { waitForFrame } from "../../lib/design-agent/frame-ready";
import { buildSite } from "./build";
import { Q1_TODAY, writeFixture } from "./fixtures";
import { SHOP_SITES } from "./shop-site";

const REPO = resolve(__dirname, "../..");
const VIEWPORTS = { pc: { width: 1440, height: 900 }, sp: { width: 390, height: 844 } } as const;
const MAX_SHOT_HEIGHT = 16000;
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

export type Q1Finding = { fixture: string; viewport: "pc" | "sp"; code: "Q1_OVERFLOW_X" | "Q1_BROKEN_IMAGE" | "Q1_OVERLAP" | "Q1_SMALL_TEXT" | "Q1_TEXT_CLIPPED" | "Q1_EXTERNAL_REQUEST"; detail: string };

/** What the page reports about itself (runs in the page; JS on the page itself stays off). */
const MEASURE = `(() => {
  const out = { overflow: document.documentElement.scrollWidth - innerWidth, broken: [], overlap: [], small: [], clipped: [], height: document.documentElement.scrollHeight };
  for (const img of document.images) if (!img.complete || img.naturalWidth === 0) out.broken.push(img.getAttribute("src") || "");
  const hit = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
  const items = [...document.querySelectorAll("[data-q1=item]")];
  const boxes = items.map((el) => el.getBoundingClientRect());
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (hit(boxes[i], boxes[j])) out.overlap.push("items " + (i + 1) + "/" + (j + 1));
  items.forEach((el, n) => {
    const parts = [...el.querySelectorAll("h3, .price, .badge, .desc, .frame")].map((p) => [p.className || p.tagName, p.getBoundingClientRect()]);
    for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) if (hit(parts[i][1], parts[j][1])) out.overlap.push("item " + (n + 1) + ": " + parts[i][0] + "/" + parts[j][0]);
  });
  for (const el of document.querySelectorAll("h1, h2, h3, p, li, th, td, a, time")) {
    const cs = getComputedStyle(el);
    if (!el.textContent.trim() || cs.display === "none" || cs.visibility === "hidden") continue;
    if (parseFloat(cs.fontSize) < 12) out.small.push(el.tagName + " " + cs.fontSize);
    if (el.scrollWidth > el.clientWidth + 1 && cs.overflowX !== "visible") out.clipped.push(el.tagName + " " + el.textContent.trim().slice(0, 20));
  }
  return out;
})()`;

export async function serveAndMeasure(browser: Browser, dist: string, fixture: string, view: "pc" | "sp", outDir: string): Promise<Q1Finding[]> {
  const findings: Q1Finding[] = [];
  const ctx = await browser.newContext({ viewport: VIEWPORTS[view], javaScriptEnabled: false, deviceScaleFactor: 1 });
  try {
    await ctx.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
      const file = resolve(dist, rel);
      const inside = url.host === "q1.invalid" && !relative(dist, file).startsWith("..") && !isAbsolute(relative(dist, file));
      const body = inside ? await readFile(file).catch(() => null) : null;
      if (!inside) findings.push({ fixture, viewport: view, code: "Q1_EXTERNAL_REQUEST", detail: url.host });
      if (body === null) return route.fulfill({ status: 404, body: "" });
      return route.fulfill({ status: 200, body, contentType: TYPES[extname(file)] ?? "application/octet-stream" });
    });
    const page = await ctx.newPage();
    await page.goto("http://q1.invalid/index.html", { waitUntil: "load" });
    const m = (await page.evaluate(MEASURE)) as { overflow: number; broken: string[]; overlap: string[]; small: string[]; clipped: string[]; height: number };
    if (m.overflow > 0) findings.push({ fixture, viewport: view, code: "Q1_OVERFLOW_X", detail: `${m.overflow}px` });
    for (const d of m.broken) findings.push({ fixture, viewport: view, code: "Q1_BROKEN_IMAGE", detail: d });
    for (const d of m.overlap) findings.push({ fixture, viewport: view, code: "Q1_OVERLAP", detail: d });
    for (const d of [...new Set(m.small)]) findings.push({ fixture, viewport: view, code: "Q1_SMALL_TEXT", detail: d });
    for (const d of m.clipped) findings.push({ fixture, viewport: view, code: "Q1_TEXT_CLIPPED", detail: d });
    // the shot at the page's own height (DEV-135), after its first frame (DEV-098); no retry
    const height = Math.min(MAX_SHOT_HEIGHT, Math.max(VIEWPORTS[view].height, Math.ceil(m.height)));
    await page.setViewportSize({ width: VIEWPORTS[view].width, height });
    await waitForFrame(page);
    await writeFile(join(outDir, `${fixture}-${view}.png`), await page.screenshot({ clip: { x: 0, y: 0, width: VIEWPORTS[view].width, height } }));
  } finally {
    await ctx.close();
  }
  return findings;
}

/**
 * The deliberately broken control page (too wide, a missing picture, overlapping items, tiny text, text cut off by
 * its own box and by a parent box, an outside stylesheet). Opened at PC and at SP, it must give all six codes of this
 * path (Q1_OVERFLOW_X, Q1_BROKEN_IMAGE, Q1_OVERLAP, Q1_SMALL_TEXT, Q1_TEXT_CLIPPED, Q1_EXTERNAL_REQUEST), or the run
 * stops (Q1_CONTROL_MISSED). q1-render.ts reuses its layout part in its own set of controls.
 */
export const CONTROL_PAGE = {
  html: '<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"><link rel="stylesheet" href="https://example.invalid/x.css"></head><body><ul><li data-q1="item"><h3>試験</h3><p class="price">1円</p></li><li data-q1="item" class="up"><h3>重なり</h3></li></ul><p class="tiny">小さい字</p><p class="cut">切れてしまうとても長い文章です切れてしまうとても長い文章です</p><div class="clipbox"><p class="inner">箱に切られるとても長い文章です箱に切られるとても長い文章です</p></div><img src="media/absent.png" alt=""><div class="wide">広い</div></body></html>',
  css: "ul{list-style:none}.up{margin-top:-40px}.tiny{font-size:9px}.cut{width:80px;white-space:nowrap;overflow:hidden}.wide{width:3000px}.clipbox{width:80px;overflow:hidden}.inner{white-space:nowrap}",
};

export async function controlCheck(browser: Browser, work: string, outDir: string): Promise<Q1Finding["code"][]> {
  const dist = join(work, "control");
  await mkdir(dist, { recursive: true });
  await writeFile(join(dist, "index.html"), CONTROL_PAGE.html);
  await writeFile(join(dist, "style.css"), CONTROL_PAGE.css);
  // at both widths (review #360 M3)
  const missed: string[] = [];
  for (const view of ["pc", "sp"] as const) {
    const codes = new Set((await serveAndMeasure(browser, dist, `control-${view}`, view, outDir)).map((f) => f.code));
    for (const c of ["Q1_OVERFLOW_X", "Q1_BROKEN_IMAGE", "Q1_OVERLAP", "Q1_SMALL_TEXT", "Q1_TEXT_CLIPPED", "Q1_EXTERNAL_REQUEST"] as const) if (!codes.has(c)) missed.push(`${view}:${c}`);
  }
  return missed as Q1Finding["code"][];
}

/**
 * The output folder: outside the repository, empty or absent; created 0700. Review #360 L3: the folder ITSELF is
 * resolved (a link pointing into the repository is refused), as well as its parent.
 */
export async function safeOutDir(outDir: string): Promise<string> {
  const out = resolve(outDir);
  const realRepo = await realpath(REPO);
  const outside = (p: string) => relative(realRepo, p).startsWith("..");
  const parent = await realpath(resolve(out, "..")).catch(() => null);
  if (parent === null || !outside(parent)) throw new Error("Q1_OUT_IN_REPO_OR_MISSING_PARENT");
  await mkdir(out, { recursive: true, mode: 0o700 });
  const real = await realpath(out);
  if (!outside(real) || real !== join(parent, basename(out))) throw new Error("Q1_OUT_IN_REPO_OR_LINKED");
  if ((await readdir(out)).length > 0) throw new Error("Q1_OUT_NOT_EMPTY");
  return out;
}

/**
 * Runs the direct checks over every site's fixtures. Since PR (3) fixtures are named "<site>-<fixture>" (e.g.
 * "bakery-items-50", "cafe-sizes-prices") in the report, in the file names and in `only`.
 */
export async function runQ1(o: { outDir: string; browser: Browser; only?: string[] }): Promise<{ fixtures: string[]; findings: Q1Finding[] }> {
  const out = await safeOutDir(o.outDir);
  const work = await mkdtemp(join(tmpdir(), "sr-pages-cms-q1-"));
  try {
    const missed = await controlCheck(o.browser, work, out);
    if (missed.length > 0) throw new Error(`Q1_CONTROL_MISSED ${missed.join(",")}`);
    // PR (3): every fictional shop's site, each with its own fixtures ("<site>-<fixture>" in the report and file names)
    const names: string[] = [];
    const findings: Q1Finding[] = [];
    for (const site of SHOP_SITES) {
      const all = site.fixtures();
      for (const fixture of Object.keys(all)) {
        const name = `${site.id}-${fixture}`;
        if (o.only && !o.only.includes(name)) continue;
        names.push(name);
        const repo = join(work, name, "repo");
        const dist = join(work, name, "dist");
        await writeFixture(repo, all[fixture]!);
        await buildSite({ repo, outDir: dist, today: Q1_TODAY, site });
        for (const view of ["pc", "sp"] as const) findings.push(...(await serveAndMeasure(o.browser, dist, name, view, out)));
      }
    }
    await writeFile(join(out, "q1-report.json"), `${JSON.stringify({ schema: "pages_cms_q1_experiment_v0", fixtures: names, viewports: VIEWPORTS, findings }, null, 2)}\n`);
    return { fixtures: names, findings };
  } finally {
    // review L1: the working copies (fixture repos and builds) are removed; only --out keeps the report and shots
    await rm(work, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const i = process.argv.indexOf("--out");
  const outDir = i > 0 ? process.argv[i + 1] : undefined;
  if (!outDir) {
    process.stdout.write('{"status":"refused","code":"ARGS_INVALID"}\n');
    process.exit(2);
  }
  (async () => {
    const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    try {
      const r = await runQ1({ outDir, browser });
      process.stdout.write(`${JSON.stringify({ status: r.findings.length ? "findings" : "clean", fixtures: r.fixtures.length, findings: r.findings }, null, 2)}\n`);
      process.exit(r.findings.length ? 1 : 0);
    } finally {
      await browser.close();
    }
  })().catch((error: unknown) => {
    process.stdout.write(`${JSON.stringify({ status: "stopped", code: error instanceof Error ? error.message : "Q1_FAILED" })}\n`);
    process.exit(2);
  });
}
