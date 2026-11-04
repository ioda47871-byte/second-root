/**
 * DEV-165 — RESEARCH probe for N1 (docs/design/n1-decoration-svg.md §4.1). NOT a gate; N1 is not enabled.
 *
 *   npx tsx scripts/design-artifact/n1-browser-probe.ts --browser chromium|firefox|webkit --out <new directory> [--executable <path>]
 *
 * Draws the three shops' decorative SVGs and the hostile set (lib/design-agent/research/decoration-fixtures.ts) through
 * `<img>` in the named Playwright browser, once with JavaScript on and once off, and reports for each run:
 *   - every request the browser made, and those outside the page directory (`outside_requests`). Each page is served from
 *     memory at http://n1-probe.invalid/probe/<case>.html with its SVG next to it; every other request is aborted, so
 *     nothing leaves the machine. The browser's own `/favicon.ico` is listed apart (`browser_own`), not counted;
 *   - ink (any channel < 250 on the white page) inside and outside the `<img>` box;
 *   - whether the host page's title changed (a script in the SVG reaching the page).
 * A finding is: a request outside the page directory, ink outside the box, a shop shape with no ink inside, a changed
 * title, a shop shape the checker refuses or a hostile one it passes.
 *
 * Read-only: it reads nothing but its own fixtures and writes only `<out>/summary.json`; `--out` must not exist (its
 * parent must). The summary also goes to stdout. Exit: 0 no finding, 1 a finding, 2 refused (usage, `--out` exists, the
 * browser is not installed or failed). Never calls a model, a generator or the network; installs nothing.
 *
 * Only Chromium is installed in the cloud container. Firefox and WebKit are run on the owner's machine (the WSL command
 * is in the design doc, after the WSL resource preflight).
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { chromium, firefox, webkit, type Browser, type BrowserType } from "playwright";
import sharp from "sharp";
import { HOSTILE_SVGS, SHOP_SHAPES } from "../../lib/design-agent/research/decoration-fixtures";
import { checkDecorationSvg } from "../../lib/design-agent/research/decoration-svg";

export const PROBE_ORIGIN = "http://n1-probe.invalid";
export const PROBE_BROWSERS = ["chromium", "firefox", "webkit"] as const;
export type ProbeBrowser = (typeof PROBE_BROWSERS)[number];
const TYPES: Record<ProbeBrowser, BrowserType> = { chromium, firefox, webkit };
const MARGIN = 40;
const TITLE = "n1-probe";

export type ProbeRun = { javascript: boolean; requests: string[]; outside_requests: string[]; browser_own: string[]; ink_inside: number; ink_outside: number; title_changed: boolean; error: string | null };
export type ProbeCase = { name: string; kind: "shop" | "hostile"; checker_ok: boolean; box: { width: number; height: number }; runs: ProbeRun[] };
export type ProbeSummary = { schema: "n1_browser_probe_v1"; browser: ProbeBrowser; browser_version: string; cases: ProbeCase[]; findings: string[]; result: "pass" | "fail" };

const pageHtml = (name: string, box: { width: number; height: number }, control: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${TITLE}</title></head><body style="margin:0;background:#fff">${control}<img src="${name}.svg" alt="" aria-hidden="true" referrerpolicy="no-referrer" style="position:absolute;left:${MARGIN}px;top:${MARGIN}px;width:${box.width}px;height:${box.height}px;display:block"></body></html>`;

/**
 * One case, one run. `control` is extra host-page markup for the tests' positive controls only (a host-page request,
 * host-page ink outside the box), which show that the measures are not vacuous; the probe itself passes "".
 */
export async function drawCase(browser: Browser, name: string, svg: string, box: { width: number; height: number }, javascript: boolean, control = ""): Promise<ProbeRun> {
  const pageUrl = `${PROBE_ORIGIN}/probe/${name}.html`;
  const svgUrl = `${PROBE_ORIGIN}/probe/${name}.svg`;
  const favicon = `${PROBE_ORIGIN}/favicon.ico`;
  const requests: string[] = [];
  const run: ProbeRun = { javascript, requests, outside_requests: [], browser_own: [], ink_inside: 0, ink_outside: 0, title_changed: false, error: null };
  const ctx = await browser.newContext({ viewport: { width: box.width + 2 * MARGIN, height: box.height + 2 * MARGIN }, deviceScaleFactor: 1, javaScriptEnabled: javascript, serviceWorkers: "block" });
  try {
    const page = await ctx.newPage();
    page.on("request", (r) => {
      requests.push(r.url());
    });
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url === pageUrl) return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: pageHtml(name, box, control) });
      if (url === svgUrl) return route.fulfill({ status: 200, contentType: "image/svg+xml", body: svg });
      return route.abort("blockedbyclient");
    });
    await page.goto(pageUrl, { waitUntil: "load" });
    await page.waitForTimeout(400);
    const png = await page.screenshot({ fullPage: false });
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    for (let y = 0; y < info.height; y++)
      for (let x = 0; x < info.width; x++) {
        const o = (y * info.width + x) * info.channels;
        if (!(data[o]! < 250 || data[o + 1]! < 250 || data[o + 2]! < 250)) continue;
        if (x >= MARGIN && x < MARGIN + box.width && y >= MARGIN && y < MARGIN + box.height) run.ink_inside++;
        else run.ink_outside++;
      }
    run.title_changed = (await page.title()) !== TITLE;
  } catch (e) {
    run.error = (e as Error).message.split("\n")[0]!.slice(0, 200);
  } finally {
    await ctx.close();
  }
  const seen = [...new Set(requests)];
  run.requests = seen;
  run.browser_own = seen.filter((u) => u === favicon);
  run.outside_requests = seen.filter((u) => u !== favicon && !u.startsWith(`${PROBE_ORIGIN}/probe/`));
  return run;
}

/** Draws every case in `browser`, JS on and off. Findings are listed in the summary; nothing is thrown for a hostile file. */
export async function runProbe(browser: Browser, name: ProbeBrowser): Promise<ProbeSummary> {
  const cases: ProbeCase[] = [];
  const findings: string[] = [];
  const all = [...SHOP_SHAPES.map((s) => ({ ...s, kind: "shop" as const })), ...HOSTILE_SVGS.map((h) => ({ ...h, kind: "hostile" as const, box: { width: 100, height: 100 } }))];
  for (const c of all) {
    const checkerOk = checkDecorationSvg(Buffer.from(c.svg, "latin1")).ok;
    if (c.kind === "shop" && !checkerOk) findings.push(`${c.name}: CHECKER_REFUSED_SHOP_SHAPE`);
    if (c.kind === "hostile" && checkerOk) findings.push(`${c.name}: CHECKER_PASSED_HOSTILE`);
    const runs: ProbeRun[] = [];
    for (const javascript of [true, false]) {
      const r = await drawCase(browser, c.name, c.svg, c.box, javascript);
      const tag = `${c.name} (js ${javascript ? "on" : "off"})`;
      if (r.error) findings.push(`${tag}: RUN_ERROR`);
      if (r.outside_requests.length) findings.push(`${tag}: REQUEST_OUTSIDE_PAGE_DIR`);
      if (r.ink_outside > 0) findings.push(`${tag}: INK_OUTSIDE_BOX`);
      if (c.kind === "shop" && r.ink_inside === 0) findings.push(`${tag}: NO_INK_INSIDE`);
      if (r.title_changed) findings.push(`${tag}: TITLE_CHANGED`);
      runs.push(r);
    }
    cases.push({ name: c.name, kind: c.kind, checker_ok: checkerOk, box: c.box, runs });
  }
  return { schema: "n1_browser_probe_v1", browser: name, browser_version: browser.version(), cases, findings, result: findings.length ? "fail" : "pass" };
}

export type ProbeArgs = { browser: ProbeBrowser; out: string; executable: string | null };

/** Parses argv; a string is the refusal. `--out` must not exist and its parent must. */
export function parseProbeArgs(argv: readonly string[]): ProbeArgs | string {
  const arg = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const b = arg("--browser");
  const out = arg("--out");
  const executable = arg("--executable") ?? null;
  if (!b || !(PROBE_BROWSERS as readonly string[]).includes(b)) return "usage: --browser chromium|firefox|webkit --out <new directory> [--executable <path>]";
  if (!out) return "usage: --out <new directory> is required";
  const full = resolve(out);
  if (existsSync(full)) return "REFUSED: --out exists";
  if (!existsSync(dirname(full))) return "REFUSED: the parent of --out does not exist";
  return { browser: b as ProbeBrowser, out: full, executable };
}

export async function main(argv: readonly string[]): Promise<number> {
  const a = parseProbeArgs(argv);
  if (typeof a === "string") return (process.stderr.write(`${a}\n`), 2);
  const executablePath = a.executable ?? (a.browser === "chromium" ? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE : undefined);
  let browser: Browser;
  try {
    browser = await TYPES[a.browser].launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  } catch (e) {
    process.stderr.write(`BLOCKED: ${a.browser} could not be launched (not installed here?): ${(e as Error).message.split("\n")[0]}\n`);
    return 2;
  }
  try {
    const summary = await runProbe(browser, a.browser);
    const text = `${JSON.stringify(summary, null, 2)}\n`;
    mkdirSync(a.out);
    writeFileSync(join(a.out, "summary.json"), text, { flag: "wx" });
    process.stdout.write(text);
    return summary.findings.length ? 1 : 0;
  } catch (e) {
    process.stderr.write(`${(e as Error).message.split("\n")[0]}\n`);
    return 2;
  } finally {
    await browser.close();
  }
}

if (require.main === module) main(process.argv.slice(2)).then((c) => process.exit(c));
