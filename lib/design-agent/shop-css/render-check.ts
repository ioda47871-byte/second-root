import type { Browser, BrowserContext } from "playwright";
import { decodePng, type Pixels } from "../worker/png-paint";
import { mediaBreakpointsPx, type GuardedShopCss } from "./guard";
import { CLEAN_CSS, FREEZE_MOTION_CSS, HIDE_TEXT_CSS, REFERENCE_SCRIPT, HIT_TEST_CSS, MEASURE_SCRIPT, MeasureSchema, TEXT_KINDS, type Measure } from "./page-scripts";

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
/** Every character must keep at least this share of the ink it has with nothing over it. */
export const INK_RATIO = 0.8;
/** Characters with less reference ink than this (summed channel change; about 3 pixels of full contrast) are too small for the ratio. */
export const MIN_REFERENCE_INK = 2000;
/** A mark with at least this much reference ink (a fraction of one pixel) must keep MARK_KEPT of it. */
export const MIN_MARK_INK = 150;
export const MARK_KEPT = 0.5;
/**
 * Glyph boxes of two different characters may not overlap by more than this
 * share of the smaller one. The boxes are the characters' cores: the range box
 * (advance × font ascent + descent) with CORE_INSET of its height taken off at
 * the top and the bottom (left and right for vertical text), so tight leading
 * that only lets the empty ascender / descender space overlap is not overprint.
 */
export const OVERLAP_SHARE = 0.2;
export const CORE_INSET = 0.2;
/**
 * Share of the notice bar's or footer's ground allowed to differ from the
 * baseline. The ground is compared on the pictures without text (and without
 * text decorations), inset from the top and bottom edge: text set at another
 * sub-pixel offset antialiases differently (the footer moves with the page
 * height, so it rarely sits at the same fraction of a pixel), but a plain
 * ground does not. The text itself has its own, offset-free proof: every
 * character of the notice and the footer must show ink on its own page
 * (notice_ink / footer_ink). Anything painted over the ground changes far more.
 */
export const FRAME_DIFF_TOLERANCE = 0.01;
/** Rows left out at the top and bottom edge of the compared ground (the boundary to the canvas is antialiased). */
const FRAME_EDGE = 2;
export const MAX_HEIGHT_FACTOR = 3;
export const MAX_SCREENSHOT_HEIGHT = 16000;

const NODE_CHECKS = ["hidden", "offscreen", "clipped", "covered", "overlap", "faded", "small", "squeezed", "contrast", "ink"] as const;
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

export type Ink = { missing: number; ratio: number };

type Picture = { withText: Pixels; without: Pixels };

const charBox = (px: Pixels, r: { left: number; top: number; width: number; height: number }) => ({
  x0: Math.max(0, Math.floor(r.left)),
  x1: Math.min(px.width - 1, Math.ceil(r.left + r.width) - 1),
  y0: Math.max(0, Math.floor(r.top)),
  y1: Math.min(px.height - 1, Math.ceil(r.top + r.height) - 1),
});

/**
 * A character's ink: how much the text changes its box, summed over pixels and
 * colour channels (the picture with the text against the one without).
 */
function inkMass(p: Picture, r: Node["chars"][number]): number {
  const { x0, x1, y0, y1 } = charBox(p.withText, r);
  let mass = 0;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const i = (y * p.withText.width + x) * p.withText.channels;
      mass += Math.abs(p.withText.data[i]! - p.without.data[i]!) + Math.abs(p.withText.data[i + 1]! - p.without.data[i + 1]!) + Math.abs(p.withText.data[i + 2]! - p.without.data[i + 2]!);
    }
  return mass;
}

/**
 * The pixel proof of a node: for each visible character, its ink on the page
 * over its ink in the reference pictures — the same layout with every other
 * paint taken away, the text in its own colour (currentcolor, so a
 * ::first-letter keeps its own) on the colour painted under it on the page
 * (CLEAN_CSS and REFERENCE_SCRIPT). The text is drawn exactly as on the page
 * (face, synthesis, size, transform, colour, ground, so the same
 * antialiasing, greyscale or subpixel); only nothing covers it. A cover of any
 * kind — a ground, a shadow, a transformed neighbour, a pseudo-element — takes
 * ink away where it lies. Returns the characters with no ink at all and the
 * smallest ratio of any character (the worst one decides, never the mean).
 * Characters with less than MIN_REFERENCE_INK are too faint or small to
 * measure (a faint one fails the contrast check).
 */
export function inkOf(page: Picture, reference: Picture, node: Node): Ink {
  if (page.withText.width !== reference.withText.width || page.withText.height !== reference.withText.height || page.without.width !== page.withText.width || reference.without.width !== reference.withText.width) return { missing: node.chars.length, ratio: 0 };
  let missing = 0;
  let ratio = 1;
  for (const box of node.chars) {
    const ref = inkMass(reference, box);
    if (ref < MIN_REFERENCE_INK) {
      // a small mark (- : . , ・) is too small for a ratio, but it must not vanish (re-review 2, Medium 1)
      if (ref >= MIN_MARK_INK && inkMass(page, box) < ref * MARK_KEPT) missing += 1;
      continue;
    }
    const ink = inkMass(page, box);
    if (ink < MIN_REFERENCE_INK / 10) missing += 1;
    ratio = Math.min(ratio, ink / ref);
  }
  return { missing, ratio };
}

/** The median colour of the ground painted under a node's lines (the picture without text), or null. */
export function groundColour(without: Pixels, node: Node): string | null {
  const channels: number[][] = [[], [], []];
  for (const r of node.rects) {
    const { x0, x1, y0, y1 } = charBox(without, r);
    const sx = Math.max(1, Math.floor((x1 - x0) / 24));
    const sy = Math.max(1, Math.floor((y1 - y0) / 8));
    for (let y = y0; y <= y1; y += sy)
      for (let x = x0; x <= x1; x += sx) {
        const i = (y * without.width + x) * without.channels;
        for (let c = 0; c < 3; c++) channels[c]!.push(without.data[i + c]!);
      }
  }
  if (channels[0]!.length === 0) return null;
  const median = (v: number[]) => v.sort((a, b) => a - b)[Math.floor(v.length / 2)]!;
  return `rgb(${median(channels[0]!)}, ${median(channels[1]!)}, ${median(channels[2]!)})`;
}

type Region = { left: number; top: number; width: number; height: number };
/**
 * Share of pixels that differ between two regions of two pictures,
 * at the best of three vertical alignments (the regions may sit at different
 * sub-pixel offsets).
 */
function regionDiff(a: Pixels, ra: Region, b: Pixels, rb: Region): number {
  return Math.min(...[-1, 0, 1].map((dy) => regionDiffAt(a, ra, b, { ...rb, top: rb.top + dy })));
}

/** A pixel differs when its channels differ by more than this in sum (a flat ground matches far closer). */
const GROUND_DELTA = 30;

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
      if (Math.abs(a.data[i]! - b.data[j]!) + Math.abs(a.data[i + 1]! - b.data[j + 1]!) + Math.abs(a.data[i + 2]! - b.data[j + 2]!) > GROUND_DELTA) diff += 1;
    }
  return diff / all;
}

type Measured = { m: Measure; ground: Pixels | null; lowContrast: number[]; ink: Ink[] };

async function measure(context: BrowserContext, html: string, facts: readonly string[]): Promise<Measured> {
  const page = await context.newPage();
  try {
    await page.setContent(html, { waitUntil: "load" });
    await page.addStyleTag({ content: `${HIT_TEST_CSS}\n${FREEZE_MOTION_CSS}` });
    await page.evaluate(`document.fonts ? document.fonts.ready.then(() => true) : true`);
    const raw = await page.evaluate(`(${MEASURE_SCRIPT})(${JSON.stringify({ facts })})`);
    const m = MeasureSchema.parse(raw);
    let lowContrast: number[] = m.nodes.map(() => 1);
    let ink: Ink[] = m.nodes.map((n) => ({ missing: n.chars.length || 1, ratio: 0 }));
    let ground: Pixels | null = null;
    if (m.height <= MAX_SCREENSHOT_HEIGHT && m.nodes.length > 0) {
      const shot = async () => decodePng(await page.screenshot({ fullPage: true, animations: "disabled", caret: "hide" }));
      const withText = await shot();
      const hide = await page.addStyleTag({ content: HIDE_TEXT_CSS });
      const without = await shot();
      await hide.evaluate("(el) => el.remove()");
      // the reference: the same boxes, nothing painted but the text, in its own colour on the
      // colour painted under it on the page; then the same without the text
      const owners = [...new Set(m.nodes.map((n) => n.owner))];
      const style = (fill: () => string) => owners.map((i) => ({ i, bg: groundColour(without, m.nodes[i]!), fill: fill() }));
      await page.addStyleTag({ content: CLEAN_CSS });
      await page.evaluate(`(${REFERENCE_SCRIPT})(${JSON.stringify(style(() => "currentcolor"))})`);
      const cleanWith = await shot();
      await page.evaluate(`(${REFERENCE_SCRIPT})(${JSON.stringify(style(() => "transparent"))})`);
      const cleanWithout = await shot();
      lowContrast = m.nodes.map((n) => lowContrastShare(without, n));
      ink = m.nodes.map((n) => inkOf({ withText, without }, { withText: cleanWith, without: cleanWithout }, n));
      ground = without;
    }
    return { m, ground, lowContrast, ink };
  } finally {
    await page.close();
  }
}

/** The notice bar's or footer's ground (pictures without text), inset from its top and bottom edge. */
function frameGroundDiff(shop: Measured, rs: Region, base: Measured, rb: Region): number {
  if (!shop.ground || !base.ground) return 1;
  const inset = (r: Region): Region => ({ left: r.left, top: r.top + FRAME_EDGE, width: r.width, height: Math.max(0, r.height - 2 * FRAME_EDGE) });
  return regionDiff(shop.ground, inset(rs), base.ground, inset(rb));
}

type Core = { node: number; char: number; left: number; right: number; top: number; bottom: number };

/**
 * Which nodes have a character overprinted by another character (of another
 * node, or of the same node elsewhere): text on text, which the pixel proof
 * cannot see (both keep their ink) and hit-testing may not (re-review 2, High 1).
 */
export function overprinted(m: Measure): boolean[] {
  const cores: Core[] = [];
  m.nodes.forEach((n, node) => {
    if (n.hidden) return;
    n.chars.forEach((c, char) => {
      const dx = n.vertical ? c.width * CORE_INSET : 0;
      const dy = n.vertical ? 0 : c.height * CORE_INSET;
      cores.push({ node, char, left: c.left + dx, right: c.left + c.width - dx, top: c.top + dy, bottom: c.top + c.height - dy });
    });
  });
  cores.sort((a, b) => a.top - b.top);
  const out = m.nodes.map(() => false);
  for (let i = 0; i < cores.length; i++) {
    const a = cores[i]!;
    for (let j = i + 1; j < cores.length && cores[j]!.top < a.bottom; j++) {
      const b = cores[j]!;
      if (a.node === b.node && a.char === b.char) continue;
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (w <= 0 || h <= 0) continue;
      const smaller = Math.min((a.right - a.left) * (a.bottom - a.top), (b.right - b.left) * (b.bottom - b.top));
      if (smaller > 0 && (w * h) / smaller > OVERLAP_SHARE) out[a.node] = out[b.node] = true;
    }
  }
  return out;
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
  else {
    const over = overprinted(s);
    const wasOver = overprinted(b);
    s.nodes.forEach((n, i) => {
      const was = b.nodes[i]!;
      const code = (check: (typeof NODE_CHECKS)[number]) => out.add(`${n.kind}_${check}` as ShopCssCheckCode);
      if (n.hidden && !was.hidden) code("hidden");
      if (n.hidden) return;
      if (n.offscreen && !was.offscreen) code("offscreen");
      if (n.clipped && !was.clipped) code("clipped");
      if (n.covered && !was.covered) code("covered");
      if (over[i] && !wasOver[i]) code("overlap");
      if (n.opacity < MIN_OPACITY && was.opacity >= MIN_OPACITY) code("faded");
      if (n.fontSize < MIN_FONT_PX - 0.01 && was.fontSize >= MIN_FONT_PX - 0.01) code("small");
      if (n.squeezed && !was.squeezed) code("squeezed");
      if (shop.lowContrast[i]! > CONTRAST_TOLERANCE && base.lowContrast[i]! <= CONTRAST_TOLERANCE) code("contrast");
      const ink = shop.ink[i]!;
      const wasInk = base.ink[i]!;
      if ((ink.missing > 0 && wasInk.missing === 0) || (ink.ratio < INK_RATIO && wasInk.ratio >= INK_RATIO)) code("ink");
    });
  }
  const same = (x: Measure["notice"], y: Measure["notice"], withTop: boolean) =>
    x !== null && y !== null && x.style === y.style && Math.abs(x.box.left - y.box.left) < 0.5 && Math.abs(x.box.width - y.box.width) < 0.5 && Math.abs(x.box.height - y.box.height) < 0.5 && (!withTop || Math.abs(x.box.top - y.box.top) < 0.5);
  if (!same(s.notice, b.notice, true)) out.add("notice_changed");
  if (!same(s.footer, b.footer, false)) out.add("footer_changed");
  // the notice bar and the footer, pixel for pixel as on the baseline
  if (s.notice && b.notice && frameGroundDiff(shop, s.notice.box, base, b.notice.box) > FRAME_DIFF_TOLERANCE) out.add("notice_changed");
  if (s.footer && b.footer && frameGroundDiff(shop, s.footer.box, base, b.footer.box) > FRAME_DIFF_TOLERANCE) out.add("footer_changed");
  if (s.noticeCovered && !b.noticeCovered) out.add("notice_covered");
  if (s.footerCovered && !b.footerCovered) out.add("footer_covered");
  return [...out];
}

/** Local debugging only (SR_SHOP_CSS_DEBUG): which nodes failed, to stderr. */
function debugReport(width: number, base: Measured, shop: Measured): void {
  const sf = shop.m.footer;
  const bf = base.m.footer;
  process.stderr.write(`${width} footer ${JSON.stringify(sf)} base ${JSON.stringify(bf)} ground diff ${sf && bf ? frameGroundDiff(shop, sf.box, base, bf.box).toFixed(4) : "-"}\n`);
  shop.m.nodes.forEach((n, i) => {
    const b = base.m.nodes[i];
    if (!b) return;
    const ink = shop.ink[i]!;
    const wasInk = base.ink[i]!;
    process.stderr.write(`${width} ${n.kind} ${JSON.stringify(n.text)} cov ${n.covered}/${b.covered} ink ${ink.missing}/${n.chars.length} ${ink.ratio.toFixed(2)} (base ${wasInk.missing} ${wasInk.ratio.toFixed(2)}) contrast ${shop.lowContrast[i]!.toFixed(2)} (base ${base.lowContrast[i]!.toFixed(2)})\n`);
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
    if (process.env.SR_SHOP_CSS_DEBUG && (codes.length > 0 || process.env.SR_SHOP_CSS_DEBUG === "all")) debugReport(width, base, shop);
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
