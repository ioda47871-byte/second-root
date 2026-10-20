import type { Browser, BrowserContext } from "playwright";
import { decodePng, type Pixels } from "../worker/png-paint";
import { mediaBreakpointsPx, type GuardedShopCss } from "./guard";
import { FREEZE_MOTION_CSS, HIDE_TEXT_CSS, HIT_TEST_CSS, MEASURE_SCRIPT, MeasureSchema, TEXT_KINDS, type Measure } from "./page-scripts";

// The render check of a per-shop stylesheet (DEV-072, Stage 3). The static
// guard proves the stylesheet can only use a small, safe vocabulary; this
// proves, in Chromium at phone, tablet and desktop widths and on both sides of
// each of the stylesheet's own breakpoints, that the page it draws still shows
// every fact, every fixed label and heading, the notice bar and the footer
// notice readably, and leaves the notice bar and the footer exactly as they
// are without it. It compares against the same page without the shop
// stylesheet (the baseline) and reports only what the stylesheet broke.
//
// Besides the geometry (boxes, hit-testing), a pixel proof: the page is
// photographed with its text and with that text made transparent; every
// visible character must change pixels in its own box, as far up and down as
// it does on the baseline. Whatever paints over a character (a shadow, an
// outline, a pseudo-element, a neighbour) leaves the two pictures equal there.
//
// Codes are fixed strings, "<width>:<code>". Local test data only: the page
// is set from a string, it must hold no script, and every request is refused.

/** Widths always checked: phones, tablets, laptops, wide screens. */
export const SHOP_CSS_BASE_WIDTHS = [320, 360, 390, 768, 1024, 1440, 1920] as const;
export const MIN_WIDTH = 280;
export const MAX_WIDTH = 2560;
const VIEWPORT_HEIGHT = 900;
const TOUCH_UP_TO = 820;
/** Widths checked at the same time (separate browser contexts). */
const PARALLEL = 4;

/** WCAG AA for body text; every line must reach it on the ground actually painted under it. */
export const MIN_CONTRAST = 4.5;
export const MIN_FONT_PX = 12;
export const MIN_OPACITY = 0.85;
/** Share of a line's ground samples allowed below MIN_CONTRAST (underlines, a rule passing under). */
export const CONTRAST_TOLERANCE = 0.1;
/** A pixel is ink when the two pictures differ by this much (sum over R, G, B). */
export const INK_DELTA = 60;
/** A node's characters must show ink over at least this share of the vertical extent they show on the baseline. */
export const INK_EXTENT_RATIO = 0.6;
/**
 * Share of the notice bar's or footer's pixels allowed to differ from the
 * baseline: the footer moves with the page height, and text set at another
 * sub-pixel offset antialiases differently. Anything painted over a line is far
 * more, and every character there has its own pixel proof as well.
 */
export const FRAME_DIFF_TOLERANCE = 0.05;
export const MAX_HEIGHT_FACTOR = 3;
export const MAX_SCREENSHOT_HEIGHT = 16000;

const NODE_CHECKS = ["hidden", "offscreen", "clipped", "covered", "faded", "small", "squeezed", "contrast", "ink"] as const;
export const SHOP_CSS_CHECK_CODES = [
  "scope_missing",
  "page_script",
  "overflow_x",
  "page_too_tall",
  "fact_missing",
  "label_missing",
  ...TEXT_KINDS.flatMap((k) => NODE_CHECKS.map((c) => `${k}_${c}` as const)),
  "notice_changed",
  "notice_covered",
  "footer_changed",
  "footer_covered",
  "check_error",
] as const;
export type ShopCssCheckCode = (typeof SHOP_CSS_CHECK_CODES)[number];

/** Builds the full HTML document of the page, with the shop stylesheet or without it (the baseline). */
export type ShopCssPageBuilder = (css: GuardedShopCss | null) => string;

export type ShopCssCheckInput = {
  browser: Browser;
  build: ShopCssPageBuilder;
  css: GuardedShopCss;
  /** The fact strings of the page (DemoView): name, description, menu items, address, hours… */
  facts: readonly string[];
  /** Check every width even after a failure (default: stop after the first group of widths with a problem). */
  exhaustive?: boolean;
};

export type ShopCssCheckResult = { ok: boolean; problems: string[]; widths: number[] };

/** The widths to check: the fixed set, and 1px each side of every breakpoint of the stylesheet. */
export function checkWidths(css: string): number[] {
  const out = new Set<number>(SHOP_CSS_BASE_WIDTHS);
  for (const b of mediaBreakpointsPx(css)) for (const w of [Math.floor(b) - 1, Math.floor(b), Math.ceil(b) + 1]) if (w >= MIN_WIDTH && w <= MAX_WIDTH) out.add(w);
  return [...out].sort((a, b) => a - b);
}

const luminance = ([r, g, b]: readonly number[]) => {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
};
const contrast = (a: readonly number[], b: readonly number[]) => {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

type Node = Measure["nodes"][number];

/**
 * The share of ground pixels under a node's lines on which its text (colour
 * with alpha and opacity, composited over that pixel) falls below MIN_CONTRAST.
 */
export function lowContrastShare(ground: Pixels, node: Node): number {
  const [tr, tg, tb, ta] = node.color;
  const alpha = Math.max(0, Math.min(1, ta * node.opacity));
  let low = 0;
  let all = 0;
  for (const r of node.rects) {
    const x0 = Math.max(0, Math.ceil(r.left + 1));
    const x1 = Math.min(ground.width - 1, Math.floor(r.left + r.width - 1));
    const y0 = Math.max(0, Math.ceil(r.top + 1));
    const y1 = Math.min(ground.height - 1, Math.floor(r.top + r.height - 1));
    if (x1 < x0 || y1 < y0) continue;
    const sx = Math.max(1, Math.floor((x1 - x0) / 24));
    const sy = Math.max(1, Math.floor((y1 - y0) / 8));
    for (let y = y0; y <= y1; y += sy)
      for (let x = x0; x <= x1; x += sx) {
        const i = (y * ground.width + x) * ground.channels;
        const g = [ground.data[i]!, ground.data[i + 1]!, ground.data[i + 2]!];
        const text = [tr * alpha + g[0]! * (1 - alpha), tg * alpha + g[1]! * (1 - alpha), tb * alpha + g[2]! * (1 - alpha)];
        all += 1;
        if (contrast(text, g) < MIN_CONTRAST) low += 1;
      }
  }
  return all === 0 ? 1 : low / all;
}

export type Ink = { missing: number; extent: number };

/**
 * The pixel proof of a node: how many of its visible characters change no
 * pixel between the picture with text and the one without, and the mean
 * extent across the line of the changed pixels within the box of each inked
 * character (0..1).
 */
export function inkOf(withText: Pixels, without: Pixels, node: Node): Ink {
  let missing = 0;
  let extent = 0;
  let counted = 0;
  for (const r of node.chars) {
    const x0 = Math.max(0, Math.floor(r.left));
    const x1 = Math.min(withText.width - 1, Math.ceil(r.left + r.width) - 1);
    const y0 = Math.max(0, Math.floor(r.top));
    const y1 = Math.min(withText.height - 1, Math.ceil(r.top + r.height) - 1);
    if (x1 < x0 || y1 < y0 || withText.width !== without.width || withText.height !== without.height) {
      missing += 1;
      continue;
    }
    // the extent across the line: vertical for horizontal text, horizontal for vertical text
    let first = -1;
    let last = -1;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const i = (y * withText.width + x) * withText.channels;
        const d = Math.abs(withText.data[i]! - without.data[i]!) + Math.abs(withText.data[i + 1]! - without.data[i + 1]!) + Math.abs(withText.data[i + 2]! - without.data[i + 2]!);
        if (d >= INK_DELTA) {
          const at = node.vertical ? x : y;
          if (first < 0 || at < first) first = at;
          if (at > last) last = at;
        }
      }
    if (first < 0) missing += 1;
    else {
      counted += 1;
      extent += (last - first + 1) / (node.vertical ? x1 - x0 + 1 : y1 - y0 + 1);
    }
  }
  return { missing, extent: counted === 0 ? 0 : extent / counted };
}

type Region = { left: number; top: number; width: number; height: number };
/**
 * Share of pixels that differ strongly between two regions of two pictures,
 * at the best of three vertical alignments (the regions may sit at different
 * sub-pixel offsets).
 */
function regionDiff(a: Pixels, ra: Region, b: Pixels, rb: Region): number {
  return Math.min(...[-1, 0, 1].map((dy) => regionDiffAt(a, ra, b, { ...rb, top: rb.top + dy })));
}

function regionDiffAt(a: Pixels, ra: Region, b: Pixels, rb: Region): number {
  const w = Math.round(Math.min(ra.width, rb.width));
  const h = Math.round(Math.min(ra.height, rb.height));
  if (w <= 0 || h <= 0) return 1;
  let diff = 0;
  let all = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const ax = Math.round(ra.left) + x;
      const ay = Math.round(ra.top) + y;
      const bx = Math.round(rb.left) + x;
      const by = Math.round(rb.top) + y;
      if (ax < 0 || ay < 0 || bx < 0 || by < 0 || ax >= a.width || ay >= a.height || bx >= b.width || by >= b.height) {
        diff += 1;
        all += 1;
        continue;
      }
      const i = (ay * a.width + ax) * a.channels;
      const j = (by * b.width + bx) * b.channels;
      all += 1;
      if (Math.abs(a.data[i]! - b.data[j]!) + Math.abs(a.data[i + 1]! - b.data[j + 1]!) + Math.abs(a.data[i + 2]! - b.data[j + 2]!) > 120) diff += 1;
    }
  return diff / all;
}

type Measured = { m: Measure; withText: Pixels | null; lowContrast: number[]; ink: Ink[] };

async function measure(context: BrowserContext, html: string, facts: readonly string[]): Promise<Measured> {
  const page = await context.newPage();
  try {
    await page.setContent(html, { waitUntil: "load" });
    await page.addStyleTag({ content: `${HIT_TEST_CSS}\n${FREEZE_MOTION_CSS}` });
    await page.evaluate(`document.fonts ? document.fonts.ready.then(() => true) : true`);
    const raw = await page.evaluate(`(${MEASURE_SCRIPT})(${JSON.stringify({ facts })})`);
    const m = MeasureSchema.parse(raw);
    let lowContrast: number[] = m.nodes.map(() => 1);
    let ink: Ink[] = m.nodes.map((n) => ({ missing: n.chars.length || 1, extent: 0 }));
    let withText: Pixels | null = null;
    if (m.height <= MAX_SCREENSHOT_HEIGHT && m.nodes.length > 0) {
      withText = decodePng(await page.screenshot({ fullPage: true, animations: "disabled", caret: "hide" }));
      await page.addStyleTag({ content: HIDE_TEXT_CSS });
      const without = decodePng(await page.screenshot({ fullPage: true, animations: "disabled", caret: "hide" }));
      lowContrast = m.nodes.map((n) => lowContrastShare(without, n));
      ink = m.nodes.map((n) => inkOf(withText!, without, n));
    }
    return { m, withText, lowContrast, ink };
  } finally {
    await page.close();
  }
}

/** Problems the shop stylesheet causes at one width (compared with the baseline). */
export function compareMeasures(base: Measured, shop: Measured): ShopCssCheckCode[] {
  const out = new Set<ShopCssCheckCode>();
  const s = shop.m;
  const b = base.m;
  if (!s.scope) out.add("scope_missing");
  if (s.scripts > 0) out.add("page_script");
  if (s.overflow > 1 && s.overflow > b.overflow) out.add("overflow_x");
  if (s.height > Math.max(b.height * MAX_HEIGHT_FACTOR, 2000) || s.height > MAX_SCREENSHOT_HEIGHT) out.add("page_too_tall");
  if (s.present.some((p, i) => !p && b.present[i] !== false)) out.add("fact_missing");
  // the same markup with and without the stylesheet: text nodes line up one to one
  const sameNodes = s.nodes.length === b.nodes.length && s.nodes.every((n, i) => n.kind === b.nodes[i]!.kind && n.text === b.nodes[i]!.text);
  if (!sameNodes) out.add(s.nodes.filter((n) => n.kind === "fact").length !== b.nodes.filter((n) => n.kind === "fact").length ? "fact_missing" : "label_missing");
  else
    s.nodes.forEach((n, i) => {
      const was = b.nodes[i]!;
      const code = (check: (typeof NODE_CHECKS)[number]) => out.add(`${n.kind}_${check}` as ShopCssCheckCode);
      if (n.hidden && !was.hidden) code("hidden");
      if (n.hidden) return;
      if (n.offscreen && !was.offscreen) code("offscreen");
      if (n.clipped && !was.clipped) code("clipped");
      if (n.covered && !was.covered) code("covered");
      if (n.opacity < MIN_OPACITY && was.opacity >= MIN_OPACITY) code("faded");
      if (n.fontSize < MIN_FONT_PX - 0.01 && was.fontSize >= MIN_FONT_PX - 0.01) code("small");
      if (n.squeezed && !was.squeezed) code("squeezed");
      if (shop.lowContrast[i]! > CONTRAST_TOLERANCE && base.lowContrast[i]! <= CONTRAST_TOLERANCE) code("contrast");
      const ink = shop.ink[i]!;
      const wasInk = base.ink[i]!;
      if ((ink.missing > 0 && wasInk.missing === 0) || ink.extent < wasInk.extent * INK_EXTENT_RATIO) code("ink");
    });
  const same = (x: Measure["notice"], y: Measure["notice"], withTop: boolean) =>
    x !== null && y !== null && x.style === y.style && Math.abs(x.box.left - y.box.left) < 0.5 && Math.abs(x.box.width - y.box.width) < 0.5 && Math.abs(x.box.height - y.box.height) < 0.5 && (!withTop || Math.abs(x.box.top - y.box.top) < 0.5);
  if (!same(s.notice, b.notice, true)) out.add("notice_changed");
  if (!same(s.footer, b.footer, false)) out.add("footer_changed");
  // the notice bar and the footer, pixel for pixel as on the baseline
  if (s.notice && b.notice && (!shop.withText || !base.withText || regionDiff(shop.withText, s.notice.box, base.withText, b.notice.box) > FRAME_DIFF_TOLERANCE)) out.add("notice_changed");
  if (s.footer && b.footer && (!shop.withText || !base.withText || regionDiff(shop.withText, s.footer.box, base.withText, b.footer.box) > FRAME_DIFF_TOLERANCE)) out.add("footer_changed");
  if (s.noticeCovered && !b.noticeCovered) out.add("notice_covered");
  if (s.footerCovered && !b.footerCovered) out.add("footer_covered");
  return [...out];
}

/** Local debugging only (SR_SHOP_CSS_DEBUG): which nodes failed, to stderr. */
function debugReport(width: number, base: Measured, shop: Measured): void {
  const sf = shop.m.footer;
  const bf = base.m.footer;
  process.stderr.write(`${width} footer ${JSON.stringify(sf)} base ${JSON.stringify(bf)} diff ${sf && bf && shop.withText && base.withText ? regionDiff(shop.withText, sf.box, base.withText, bf.box).toFixed(4) : "-"}\n`);
  shop.m.nodes.forEach((n, i) => {
    const b = base.m.nodes[i];
    if (!b) return;
    const ink = shop.ink[i]!;
    const wasInk = base.ink[i]!;
    process.stderr.write(`${width} ${n.kind} ${JSON.stringify(n.text)} ink ${ink.missing}/${n.chars.length} ${ink.extent.toFixed(2)} (base ${wasInk.missing} ${wasInk.extent.toFixed(2)}) contrast ${shop.lowContrast[i]!.toFixed(2)} (base ${base.lowContrast[i]!.toFixed(2)})\n`);
  });
}

async function checkWidth(input: ShopCssCheckInput, width: number): Promise<string[]> {
  let context: BrowserContext | null = null;
  try {
    // isMobile stays off: a mobile viewport zooms out a page wider than the screen, and the
    // baseline and the shop page would then be pictured at different scales
    const touch = width <= TOUCH_UP_TO;
    context = await input.browser.newContext({ viewport: { width, height: VIEWPORT_HEIGHT }, deviceScaleFactor: 1, isMobile: false, hasTouch: touch, reducedMotion: "reduce", serviceWorkers: "block" });
    // local test data only: nothing is ever fetched (no font, no image, no CSS)
    await context.route("**/*", (route) => route.abort());
    const base = await measure(context, input.build(null), input.facts);
    const shop = await measure(context, input.build(input.css), input.facts);
    const codes = compareMeasures(base, shop);
    if (process.env.SR_SHOP_CSS_DEBUG && codes.length > 0) debugReport(width, base, shop);
    return codes.map((code) => `${width}:${code}`);
  } catch {
    return [`${width}:check_error`];
  } finally {
    await context?.close().catch(() => undefined);
  }
}

/**
 * Renders the page with and without the shop stylesheet at every width of
 * checkWidths() and returns the problems the stylesheet causes. Never throws:
 * a failure of the check itself is a problem (check_error), so the caller
 * falls back.
 */
export async function checkShopCssRender(input: ShopCssCheckInput): Promise<ShopCssCheckResult> {
  const widths = checkWidths(input.css);
  const problems: string[] = [];
  const checked: number[] = [];
  for (let i = 0; i < widths.length; i += PARALLEL) {
    const group = widths.slice(i, i + PARALLEL);
    const results = await Promise.all(group.map((w) => checkWidth(input, w)));
    checked.push(...group);
    problems.push(...results.flat());
    if (problems.length > 0 && !input.exhaustive) break;
  }
  return { ok: problems.length === 0, problems, widths: checked };
}
