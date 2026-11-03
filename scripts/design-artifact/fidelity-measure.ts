/**
 * DEV-160 (Issue #193 comment 6596798696, items 4–6) — OFFLINE research measure, REPORT-ONLY.
 *
 *   npx tsx scripts/design-artifact/fidelity-measure.ts --spec <fidelity-spec.json> [--out <report.json>]
 *
 * For each page in the spec (the comp A, the strict-lane implementation B, the research-only fidelity implementation
 * C of one shop), draws index.html at 1440×900, 390×844, 1024×768 and 768×1024 with JavaScript off and every request
 * outside the page's own directory refused. In each it measures, by the spec's selectors and section attribute:
 * where the motif elements are, which section boundaries they cross, whether something is drawn over each caption line
 * (and whether that is the motif: a line crossing the words), whether a giant word is broken over two lines, and
 * whether the page is wider than its viewport. Scores come from lib/design-agent/quality-pipeline/fidelity-measure.ts,
 * and each page's motif is compared with the comp's at 1440 and 390.
 *
 * A pointer-events rule is added for the measure only, so that elementFromPoint finds an element drawn on top even
 * if the page set pointer-events: none (as a decorative line does). Nothing is written but --out (a new file).
 * Exit: 0 report, 2 refused (arguments, spec, a page outside the research tree, an existing --out).
 * Never calls Codex, a model or the network. Decides nothing: the owner looks at the images.
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { chromium, type Browser } from "playwright";
import { FidelitySpec, motifPreservation, scoreFidelity, type FidelityScore, type MeasuredPage } from "../../lib/design-agent/quality-pipeline/fidelity-measure";

const REPO = resolve(__dirname, "../..");
const RESEARCH = join(REPO, "design-library/research/quality-pipeline/poc");
export const WIDTHS = [
  { key: "desktop_1440", width: 1440, height: 900 },
  { key: "mobile_390", width: 390, height: 844 },
  { key: "tablet_1024", width: 1024, height: 768 },
  { key: "tablet_768", width: 768, height: 1024 },
] as const;

type PageSpec = FidelitySpec["pages"][number];

/** Runs in the page (JS off for the page itself; this is the harness's evaluate). Returns page coordinates. */
const MEASURE = String.raw`(arg) => {
  const sy = () => window.scrollY;
  const abs = (r) => ({ top: r.top + sy(), bottom: r.bottom + sy(), left: r.left, right: r.right });
  const shown = (el) => {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
    }
    const r = el.getBoundingClientRect();
    // a straight vertical or horizontal line has no width or no height of its own: one of them is enough
    return r.width > 0 || r.height > 0;
  };
  const all = (sels) => sels.flatMap((s) => Array.from(document.querySelectorAll(s)));
  const motifEls = all(arg.motif).filter(shown);
  const isMotif = (el) => motifEls.some((m) => m === el || m.contains(el));
  const sections = Array.from(document.querySelectorAll("[" + arg.attr + "]")).filter(shown).map((el) => {
    const r = abs(el.getBoundingClientRect());
    return { id: el.getAttribute(arg.attr) || "", top: r.top, bottom: r.bottom };
  });
  const motif = motifEls.map((el) => abs(el.getBoundingClientRect()));
  const lineRects = (el) => {
    const out = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent || !n.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const tops = new Map();
      for (const r of Array.from(range.getClientRects())) {
        if (r.width < 1 || r.height < 1) continue;
        const key = Math.round(r.top + sy());
        const prev = tops.get(key);
        tops.set(key, prev ? { top: Math.min(prev.top, r.top), bottom: Math.max(prev.bottom, r.bottom), left: Math.min(prev.left, r.left), right: Math.max(prev.right, r.right) } : { top: r.top, bottom: r.bottom, left: r.left, right: r.right });
      }
      out.push({ node: n, lines: Array.from(tops.values()).map((r) => ({ top: r.top + sy(), bottom: r.bottom + sy(), left: r.left, right: r.right })) });
    }
    return out;
  };
  const captionLines = [];
  for (const el of all(arg.captions).filter(shown)) {
    for (const t of lineRects(el)) for (const line of t.lines) {
      const y = (line.top + line.bottom) / 2;
      window.scrollTo(0, Math.max(0, y - 200));
      let covered = false;
      let crossed = false;
      for (const f of [0.2, 0.5, 0.8]) {
        const x = line.left + (line.right - line.left) * f;
        const hit = document.elementFromPoint(x, y - window.scrollY);
        if (!hit) continue;
        if (hit === el || el.contains(hit)) continue;
        covered = true;
        if (isMotif(hit)) crossed = true;
      }
      captionLines.push({ covered, crossedByMotif: crossed });
    }
  }
  window.scrollTo(0, 0);
  const words = [];
  for (const el of all(arg.words).filter(shown)) for (const t of lineRects(el)) words.push({ text: t.node.textContent.trim().slice(0, 40), lines: t.lines.length });
  const de = document.documentElement;
  return { width: window.innerWidth, pageHeight: Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0), scrollWidth: de.scrollWidth, sections, motif, captionLines, words };
}`;

async function measurePage(browser: Browser, dir: string, p: PageSpec, v: (typeof WIDTHS)[number]): Promise<MeasuredPage> {
  const ctx = await browser.newContext({ viewport: { width: v.width, height: v.height }, deviceScaleFactor: 1, javaScriptEnabled: false, serviceWorkers: "block" });
  try {
    const page = await ctx.newPage();
    const base = `file://${dir}${sep}`;
    await page.route("**/*", (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
    await page.goto(`${base}index.html`, { waitUntil: "load" });
    // added synchronously (addStyleTag waits for a load event that a JS-off page never fires)
    await page.evaluate(`(() => { const s = document.createElement("style"); s.textContent = "* { pointer-events: auto !important; } svg { pointer-events: none !important; } svg * { pointer-events: visiblePainted !important; }"; document.head.appendChild(s); })()`);
    return (await page.evaluate(`(${MEASURE})(${JSON.stringify({ attr: p.section_attribute, motif: v.width < 600 && p.motif_narrow ? p.motif_narrow : p.motif, captions: p.captions, words: p.words })})`)) as MeasuredPage;
  } finally {
    await ctx.close();
  }
}

export async function measureSpec(spec: FidelitySpec, browser: Browser) {
  const pages: Record<string, Record<string, { score: FidelityScore; sections: string[] }>> = {};
  for (const p of spec.pages) {
    const dir = realpathSync(join(REPO, p.dir));
    if (!(dir + sep).startsWith(realpathSync(RESEARCH) + sep)) throw new Error(`REFUSED: ${p.key} is outside the research tree`);
    if (!existsSync(join(dir, "index.html"))) throw new Error(`REFUSED: ${p.key} has no index.html`);
    pages[p.key] = {};
    for (const v of WIDTHS) {
      const m = await measurePage(browser, dir, p, v);
      pages[p.key]![v.key] = { score: scoreFidelity(m), sections: m.sections.map((s) => s.id) };
    }
  }
  const preservation: Record<string, Record<string, ReturnType<typeof motifPreservation>>> = {};
  const comp = pages.comp;
  if (comp)
    for (const [key, byWidth] of Object.entries(pages)) {
      if (key === "comp") continue;
      preservation[key] = {};
      for (const v of ["desktop_1440", "mobile_390"]) preservation[key]![v] = motifPreservation(comp[v]!.score, byWidth[v]!.score);
    }
  return { schema: "fidelity_report_v0", shop: spec.shop, passing: false, pages, motif_preservation: preservation };
}

async function main(argv: string[]): Promise<number> {
  const arg = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const specPath = arg("--spec");
  const out = arg("--out");
  if (!specPath) return (process.stderr.write("usage: --spec <fidelity-spec.json> [--out <report.json>]\n"), 2);
  if (out && existsSync(out)) return (process.stderr.write("REFUSED: --out exists\n"), 2);
  const parsed = FidelitySpec.safeParse(JSON.parse(readFileSync(specPath, "utf8")));
  if (!parsed.success) return (process.stderr.write(`REFUSED: spec: ${parsed.error.issues[0]?.message ?? ""}\n`), 2);
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  try {
    const report = await measureSpec(parsed.data, browser);
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (out) writeFileSync(out, text, { flag: "wx" });
    else process.stdout.write(text);
    return 0;
  } catch (e) {
    process.stderr.write(`${(e as Error).message.split("\n")[0]}\n`);
    return 2;
  } finally {
    await browser.close();
  }
}

if (require.main === module) main(process.argv.slice(2)).then((c) => process.exit(c));
