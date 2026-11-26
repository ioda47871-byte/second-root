/**
 * DEV-303 §3.7 Q1 on the EXISTING render helpers (owner decision 2026-11-26: the minimal read / compare-only import of
 * the render check, fixed by an audit test — tests/unit/design-agent/phase2f/isolation.test.ts pins that this file
 * takes exactly `renderPrototype` from phase2f/render-prototype and nothing else of phase2f, comp-impl or shop-css).
 *
 * renderPrototype opens the built page with comp-impl's safe opener (JS off, only the page's own files served, every
 * other request aborted and counted), shoots PC 1440 and SP 390 at their own heights after the DEV-098 frame wait,
 * and runs the phone checks of DEV-134 (mobile-quality: the shop-CSS text measure — clipped, covered, out of box,
 * smaller than 12px, faded, squeezed, overprinted text — tap targets, the shop name in the first screen) on SP 390.
 * Nothing here writes a page, a record or a shop file; it only renders and compares.
 *
 *   npx tsx experiments/pages-cms/q1-render.ts --out <empty dir outside the repository>
 *
 * For every Q1 fixture (fixtures.ts) built with the fictional bakery's page code, and for the broken control page, it
 * runs BOTH this path and the direct-Playwright path (q1-check.ts serveAndMeasure) and writes <out>/q1-compare.json
 * (per fixture and width: the codes each path found) and <out>/render-<fixture>-<pc|sp>.png. The control page must
 * trip every check of both paths (Q1_RENDER_CONTROL_MISSED otherwise). Exit 0 when no fixture has a finding in either
 * path, 1 otherwise.
 */
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import { renderPrototype } from "../../lib/design-agent/phase2f/render-prototype";
import { buildSite } from "./build";
import { loadContent } from "./content-model";
import { Q1_TODAY, q1Fixtures, writeFixture } from "./fixtures";
import { CONTROL_PAGE, serveAndMeasure } from "./q1-check";

const REPO = resolve(__dirname, "../..");

/** What the render-helper path reports for one width (codes of its own vocabulary). */
export type RenderQ1 = { pc: string[]; sp: string[] };

/**
 * Renders a built page with renderPrototype and turns its measurements into codes: R_OVERFLOW_X (wider than the
 * viewport), R_BLOCKED (a request that was not the page's own file: a missing picture or anything outside the site),
 * and the SP 390 phone-check codes (SP_*) as mobile-quality names them.
 */
export async function renderQ1(browser: Browser, page: { html: string; css: string }, media: ReadonlyMap<string, Buffer>, facts: readonly string[], shopName: string | null, outDir: string, name: string): Promise<RenderQ1> {
  const r = await renderPrototype(browser, page, media, [], { facts, shopName });
  const codes = (v: (typeof r)["desktop_1440"], width: number) => [...(v.scrollWidth > width ? ["R_OVERFLOW_X"] : []), ...(v.blocked > 0 ? ["R_BLOCKED"] : []), ...(v.mobileQuality?.findings ?? [])].sort();
  await writeFile(join(outDir, `render-${name}-pc.png`), r.desktop_1440.png);
  await writeFile(join(outDir, `render-${name}-sp.png`), r.mobile_390.png);
  return { pc: codes(r.desktop_1440, 1440), sp: codes(r.mobile_390, 390) };
}

/** The codes the control page must give in the render-helper path (one per kind of breakage it holds). */
export const RENDER_CONTROL_EXPECTED = ["R_OVERFLOW_X", "R_BLOCKED", "SP_TEXT_TOO_SMALL", "SP_TEXT_CLIPPED", "SP_TEXT_OVERLAP"] as const;

export type CompareRow = { fixture: string; viewport: "pc" | "sp"; render: string[]; direct: string[] };

export async function runQ1Compare(o: { outDir: string; browser: Browser }): Promise<{ rows: CompareRow[]; control: { render: RenderQ1; directMissing: string[] } }> {
  const out = resolve(o.outDir);
  const realRepo = await realpath(REPO);
  const parent = await realpath(resolve(out, "..")).catch(() => null);
  if (parent === null || !relative(realRepo, parent).startsWith("..")) throw new Error("Q1_OUT_IN_REPO_OR_MISSING_PARENT");
  await mkdir(out, { recursive: true, mode: 0o700 });
  if ((await readdir(out)).length > 0) throw new Error("Q1_OUT_NOT_EMPTY");
  const work = await mkdtemp(join(tmpdir(), "sr-pages-cms-q1r-"));
  try {
    // the control: both paths must see every breakage it holds
    const controlDist = join(work, "control");
    await mkdir(controlDist, { recursive: true });
    await writeFile(join(controlDist, "index.html"), CONTROL_PAGE.html);
    await writeFile(join(controlDist, "style.css"), CONTROL_PAGE.css);
    const controlRender = await renderQ1(o.browser, CONTROL_PAGE, new Map(), ["試験"], null, out, "control");
    const renderAll = new Set([...controlRender.pc, ...controlRender.sp]);
    const renderMissing = RENDER_CONTROL_EXPECTED.filter((c) => !renderAll.has(c));
    const directCodes = new Set((await serveAndMeasure(o.browser, controlDist, "control", "pc", out)).map((f) => f.code));
    const directMissing = (["Q1_OVERFLOW_X", "Q1_BROKEN_IMAGE", "Q1_OVERLAP", "Q1_SMALL_TEXT", "Q1_TEXT_CLIPPED", "Q1_EXTERNAL_REQUEST"] as const).filter((c) => !directCodes.has(c));
    if (renderMissing.length || directMissing.length) throw new Error(`Q1_RENDER_CONTROL_MISSED ${[...renderMissing, ...directMissing].join(",")}`);

    const rows: CompareRow[] = [];
    for (const [name, fx] of Object.entries(q1Fixtures())) {
      const repo = join(work, name, "repo");
      const dist = join(work, name, "dist");
      await writeFixture(repo, fx);
      const built = await buildSite({ repo, outDir: dist, today: Q1_TODAY });
      const content = await loadContent(repo);
      const media = new Map<string, Buffer>();
      for (const m of built.media) media.set(`media/${m}`, await readFile(join(dist, "media", m)));
      const facts = [content.shop.name, content.shop.address, content.shop.phone, ...content.menu.flatMap((m) => [m.name, m.priceDisplay])].filter(Boolean);
      const render = await renderQ1(o.browser, { html: built.html, css: built.css }, media, facts, content.shop.name, out, name);
      for (const view of ["pc", "sp"] as const) {
        const direct = [...new Set((await serveAndMeasure(o.browser, dist, name, view, out)).map((f) => f.code))].sort();
        rows.push({ fixture: name, viewport: view, render: render[view], direct });
      }
    }
    await writeFile(join(out, "q1-compare.json"), `${JSON.stringify({ schema: "pages_cms_q1_compare_v0", control: { render: controlRender, direct_missing: directMissing }, rows }, null, 2)}\n`);
    return { rows, control: { render: controlRender, directMissing } };
  } finally {
    // the working copies are removed; --out keeps the comparison and the shots
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
      const r = await runQ1Compare({ outDir, browser });
      const found = r.rows.filter((x) => x.render.length || x.direct.length);
      process.stdout.write(`${JSON.stringify({ status: found.length ? "findings" : "clean", control: r.control, rows: r.rows }, null, 2)}\n`);
      process.exit(found.length ? 1 : 0);
    } finally {
      await browser.close();
    }
  })().catch((error: unknown) => {
    process.stdout.write(`${JSON.stringify({ status: "stopped", code: error instanceof Error ? error.message : "Q1_FAILED" })}\n`);
    process.exit(2);
  });
}
