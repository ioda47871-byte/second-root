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
 * For every Q1 fixture of every fictional shop site (shop-site.ts SHOP_SITES: the bakery and the café), built with
 * that site's own page code, it runs BOTH this path and the
 * direct-Playwright path (q1-check.ts serveAndMeasure) and writes <out>/q1-compare.json (per fixture and width: the
 * codes each path found) and <out>/render-<fixture>-<pc|sp>.png. Exit 0 only when the status is clean (q1Summary: no
 * finding in either path, and no row whose phone checks had to drop facts); 1 for findings, 3 for an incomplete run,
 * 2 when the run stopped (bad arguments, a control missed, an output folder refused).
 *
 * First, the controls (CONTROLS below): small, deliberately broken pages, each holding one kind of breakage (the
 * layout one holds several), and each must give its expected codes, or the run stops (Q1_RENDER_CONTROL_MISSED).
 * They prove exactly these checks fire: render path — R_OVERFLOW_X, R_BLOCKED (a missing picture alone, and an outside
 * stylesheet alone), SP_TEXT_TOO_SMALL, SP_TEXT_CLIPPED, SP_TEXT_OVERLAP, SP_TEXT_OUT_OF_BOX, SP_TEXT_COVERED,
 * SP_TEXT_OFFSCREEN, SP_TEXT_FADED, SP_TEXT_SQUEEZED, SP_FACT_HIDDEN, SP_TAP_TARGET_TOO_SMALL, SP_TAP_TARGET_BELOW_44,
 * SP_SHOP_NAME_NOT_IN_FIRST_SCREEN; direct path (at PC and at SP) — Q1_OVERFLOW_X, Q1_OVERLAP, Q1_SMALL_TEXT,
 * Q1_TEXT_CLIPPED, Q1_BROKEN_IMAGE (without Q1_EXTERNAL_REQUEST) and Q1_EXTERNAL_REQUEST (without Q1_BROKEN_IMAGE).
 * Not proven by a control: SP_CHECK_FAILED / SP_CHECK_SCOPE_CONFLICT (the phone checks' own failure codes).
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { renderPrototype } from "../../lib/design-agent/phase2f/render-prototype";
import { buildSite } from "./build";
import { loadContent, viewOf, type ShopContent } from "./content-model";
import { Q1_TODAY, writeFixture } from "./fixtures";
import { CONTROL_PAGE, safeOutDir, serveAndMeasure, SLOT_CODES, SLOT_CONTROLS } from "./q1-check";
import { SHOP_SITES } from "./shop-site";

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

const HEAD = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="style.css"></head><body>';
type Control = {
  name: string;
  page: { html: string; css: string };
  facts: string[];
  shopName: string | null;
  /** Codes the render path must give (PC and SP together). */
  render: string[];
  /** Codes the direct path must give at PC and at SP, and codes it must NOT give there. */
  direct?: { present: string[]; absent: string[] };
  /** DEV-364 PR 2b: pictures the control page needs (path → bytes) and the photo slots the direct path measures. */
  media?: Record<string, Buffer>;
  slots?: Parameters<typeof serveAndMeasure>[5];
};
/** The controls (see the header): each must give its codes, or the checks are not working. */
export const CONTROLS: Control[] = [
  {
    name: "layout",
    page: { html: CONTROL_PAGE.html.replace('<link rel="stylesheet" href="https://example.invalid/x.css">', "").replace('<img src="media/absent.png" alt="">', ""), css: CONTROL_PAGE.css },
    facts: ["試験"],
    shopName: null,
    render: ["R_OVERFLOW_X", "SP_TEXT_TOO_SMALL", "SP_TEXT_CLIPPED", "SP_TEXT_OVERLAP", "SP_TEXT_OUT_OF_BOX"],
    direct: { present: ["Q1_OVERFLOW_X", "Q1_OVERLAP", "Q1_SMALL_TEXT", "Q1_TEXT_CLIPPED"], absent: ["Q1_BROKEN_IMAGE", "Q1_EXTERNAL_REQUEST"] },
  },
  {
    name: "missing-image",
    page: { html: `${HEAD}<h1>架空の店</h1><img src="media/absent.png" alt=""></body></html>`, css: "" },
    facts: [],
    shopName: null,
    render: ["R_BLOCKED"],
    direct: { present: ["Q1_BROKEN_IMAGE"], absent: ["Q1_EXTERNAL_REQUEST"] },
  },
  {
    name: "outside-stylesheet",
    page: { html: `${HEAD.replace("</head>", '<link rel="stylesheet" href="https://example.invalid/x.css"></head>')}<h1>架空の店</h1></body></html>`, css: "" },
    facts: [],
    shopName: null,
    render: ["R_BLOCKED"],
    direct: { present: ["Q1_EXTERNAL_REQUEST"], absent: ["Q1_BROKEN_IMAGE"] },
  },
  { name: "covered", page: { html: `${HEAD}<h1>架空の店</h1><p>覆われる文字の段落です。</p><div class="cv"></div></body></html>`, css: ".cv{position:absolute;top:0;left:0;width:390px;height:400px;background:#000}" }, facts: [], shopName: null, render: ["SP_TEXT_COVERED"] },
  { name: "offscreen", page: { html: `${HEAD}<h1>架空の店</h1><p class="o">右へはみ出す文字</p></body></html>`, css: ".o{position:relative;left:600px;white-space:nowrap}" }, facts: [], shopName: null, render: ["SP_TEXT_OFFSCREEN"] },
  { name: "faded", page: { html: `${HEAD}<h1>架空の店</h1><p class="f">うすい文字の段落です。</p></body></html>`, css: ".f{opacity:.3}" }, facts: [], shopName: null, render: ["SP_TEXT_FADED"] },
  { name: "squeezed", page: { html: `${HEAD}<h1>架空の店</h1><p class="n">細い列に押し込まれた文字</p></body></html>`, css: ".n{width:30px;font-size:16px}" }, facts: [], shopName: null, render: ["SP_TEXT_SQUEEZED"] },
  { name: "fact-hidden", page: { html: `${HEAD}<h1>架空の店</h1><p class="h">03-0000-0000</p></body></html>`, css: ".h{visibility:hidden}" }, facts: ["03-0000-0000"], shopName: null, render: ["SP_FACT_HIDDEN"] },
  { name: "tap-too-small", page: { html: `${HEAD}<h1>架空の店</h1><p>本文です。</p><a class="t" href="#a">x</a></body></html>`, css: ".t{display:inline-block;width:16px;height:16px;font-size:12px;overflow:hidden}" }, facts: [], shopName: null, render: ["SP_TAP_TARGET_TOO_SMALL"] },
  { name: "tap-below-44", page: { html: `${HEAD}<h1>架空の店</h1><p>本文です。</p><a class="t" href="#a">押</a></body></html>`, css: ".t{display:inline-block;width:32px;height:32px;font-size:14px}" }, facts: [], shopName: null, render: ["SP_TAP_TARGET_BELOW_44"] },
  // DEV-364 PR 2b (review #372 L3): one slot control per code; each gives its own and none of the other slot codes
  ...SLOT_CONTROLS.map((c) => ({
    name: c.name,
    page: { html: c.html, css: c.css },
    facts: [],
    shopName: null,
    render: [],
    direct: { present: [c.code], absent: [...SLOT_CODES.filter((x) => x !== c.code), "Q1_BROKEN_IMAGE"] },
    media: c.media,
    slots: c.slots,
  })),
  { name: "shop-name-low", page: { html: `${HEAD}<div class="sp"></div><h1>架空の店</h1></body></html>`, css: ".sp{height:1400px}" }, facts: ["架空の店"], shopName: "架空の店", render: ["SP_SHOP_NAME_NOT_IN_FIRST_SCREEN"] },
];

export type ControlResult = { name: string; render: RenderQ1; direct: Record<"pc" | "sp", string[]> | null; missing: string[] };

/** Runs every control through both paths; returns what each gave and what it missed. */
export async function runControls(browser: Browser, work: string, outDir: string): Promise<ControlResult[]> {
  const results: ControlResult[] = [];
  for (const c of CONTROLS) {
    const render = await renderQ1(browser, c.page, new Map(Object.entries(c.media ?? {})), c.facts, c.shopName, outDir, `control-${c.name}`);
    const all = new Set([...render.pc, ...render.sp]);
    const missing = c.render.filter((code) => !all.has(code)).map((code) => `${c.name}:${code}`);
    let direct: ControlResult["direct"] = null;
    if (c.direct) {
      const dist = join(work, `control-${c.name}`);
      await mkdir(dist, { recursive: true });
      await writeFile(join(dist, "index.html"), c.page.html);
      await writeFile(join(dist, "style.css"), c.page.css);
      for (const [path, bytes] of Object.entries(c.media ?? {})) {
        await mkdir(join(dist, path, ".."), { recursive: true });
        await writeFile(join(dist, path), bytes);
      }
      direct = { pc: [], sp: [] };
      for (const view of ["pc", "sp"] as const) {
        const codes = new Set((await serveAndMeasure(browser, dist, `control-${c.name}`, view, outDir, c.slots ?? [])).map((f) => f.code));
        direct[view] = [...codes].sort();
        for (const code of c.direct.present) if (!codes.has(code as never)) missing.push(`${c.name}:${view}:${code}`);
        for (const code of c.direct.absent) if (codes.has(code as never)) missing.push(`${c.name}:${view}:not ${code}`);
      }
    }
    results.push({ name: c.name, render, direct, missing });
  }
  return results;
}

/**
 * The phone checks' facts (texts that are the shop's facts, not labels): distinct, shop details first, at most
 * FACTS_MAX (visible items only, in page order) — the shop-CSS measure accepts at most 200 (page-scripts MeasureSchema `present`); more would make the
 * phone check fail (SP_CHECK_FAILED), which the café's 50-item fixture showed before the list was made distinct.
 */
export const FACTS_MAX = 200;
export function factsOf(content: ShopContent): { facts: string[]; truncated: number } {
  // review #363 L1: only what the page shows, in page order (viewOf: visible items in visible categories), so hidden
  // items do not use the budget; whatever is still cut is counted and recorded (facts_truncated)
  const v = viewOf(content);
  const items = v.sections.flatMap((s) => s.items);
  const all = [...new Set([v.shop.name, v.shop.address, v.shop.phone, ...items.flatMap((m) => [m.name, m.priceDisplay, ...(m.sizes ?? []).flatMap((s) => [s.label, s.priceDisplay])])].filter(Boolean))];
  return { facts: all.slice(0, FACTS_MAX), truncated: Math.max(0, all.length - FACTS_MAX) };
}

export type CompareRow = { fixture: string; viewport: "pc" | "sp"; render: string[]; direct: string[]; facts_truncated: number };

/**
 * The run's status (#363 re-review Low): `findings` when any row has a finding in either path; otherwise
 * `incomplete` when the phone checks of any row could not take every fact the page shows (facts_truncated > 0: its
 * SP check did not cover the whole page, so it is not a clean result); otherwise `clean`. Only `clean` exits 0.
 */
export function q1Summary(rows: readonly CompareRow[]): { status: "clean" | "findings" | "incomplete"; findings: number; facts_truncated: { fixture: string; count: number }[] } {
  const findings = rows.filter((x) => x.render.length || x.direct.length).length;
  const truncated = [...new Map(rows.filter((x) => x.facts_truncated > 0).map((x) => [x.fixture, x.facts_truncated])).entries()].map(([fixture, count]) => ({ fixture, count }));
  return { status: findings ? "findings" : truncated.length ? "incomplete" : "clean", findings, facts_truncated: truncated };
}

export async function runQ1Compare(o: { outDir: string; browser: Browser }): Promise<{ rows: CompareRow[]; controls: ControlResult[] }> {
  const out = await safeOutDir(o.outDir);
  const work = await mkdtemp(join(tmpdir(), "sr-pages-cms-q1r-"));
  try {
    const controls = await runControls(o.browser, work, out);
    const missed = controls.flatMap((c) => c.missing);
    if (missed.length) throw new Error(`Q1_RENDER_CONTROL_MISSED ${missed.join(",")}`);

    const rows: CompareRow[] = [];
    // PR (3): every fictional shop's site with its own fixtures ("<site>-<fixture>")
    for (const site of SHOP_SITES) {
      for (const [fixture, fx] of Object.entries(site.fixtures())) {
        const name = `${site.id}-${fixture}`;
        const repo = join(work, name, "repo");
        const dist = join(work, name, "dist");
        await writeFixture(repo, fx);
        const built = await buildSite({ repo, outDir: dist, today: Q1_TODAY, site });
        const content = await loadContent(repo, site.profile);
        const media = new Map<string, Buffer>();
        for (const m of built.media) media.set(`media/${m}`, await readFile(join(dist, "media", m)));
        const { facts, truncated } = factsOf(content);
        const render = await renderQ1(o.browser, { html: built.html, css: built.css }, media, facts, content.shop.name, out, name);
        for (const view of ["pc", "sp"] as const) {
          const direct = [...new Set((await serveAndMeasure(o.browser, dist, name, view, out, built.slots)).map((f) => f.code))].sort();
          rows.push({ fixture: name, viewport: view, render: render[view], direct, facts_truncated: truncated });
        }
      }
    }
    await writeFile(join(out, "q1-compare.json"), `${JSON.stringify({ schema: "pages_cms_q1_compare_v1", controls, rows }, null, 2)}\n`);
    return { rows, controls };
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
      const s = q1Summary(r.rows);
      process.stdout.write(`${JSON.stringify({ ...s, controls: r.controls.map((c) => c.name), rows: r.rows }, null, 2)}\n`);
      process.exit(s.status === "clean" ? 0 : s.status === "findings" ? 1 : 3);
    } finally {
      await browser.close();
    }
  })().catch((error: unknown) => {
    process.stdout.write(`${JSON.stringify({ status: "stopped", code: error instanceof Error ? error.message : "Q1_FAILED" })}\n`);
    process.exit(2);
  });
}
