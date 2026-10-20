import type { Browser, BrowserContext } from "playwright";
import { decodePng, type Pixels } from "../worker/png-paint";
import type { GuardedShopCss } from "./guard";
import { FREEZE_MOTION_CSS, HIDE_FACT_TEXT_CSS, HIT_TEST_CSS, MEASURE_SCRIPT, MeasureSchema, type Measure } from "./page-scripts";

// The render check of a per-shop stylesheet (DEV-072, Stage 3). The static
// guard proves the stylesheet can only use a small, safe vocabulary; this
// proves, in Chromium at phone and desktop sizes, that the page it draws still
// shows every fact readably and leaves the notice bar and the footer exactly
// as they are without it. It compares against the same page without the shop
// stylesheet (the baseline), and reports only what the stylesheet broke.
// Codes are fixed strings, "<viewport>:<code>". Local test data only: the
// page is set from a string and every network request is refused.

export const SHOP_CSS_CHECK_VIEWPORTS = [
  { name: "360", viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true },
  { name: "390", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  { name: "1440", viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false },
] as const;

/** WCAG AA for body text; every fact line must reach it on the ground actually painted under it. */
export const MIN_CONTRAST = 4.5;
export const MIN_FONT_PX = 12;
export const MIN_OPACITY = 0.85;
/** Share of a line's ground samples allowed below MIN_CONTRAST (underlines, a rule passing under). */
export const CONTRAST_TOLERANCE = 0.1;
export const MAX_HEIGHT_FACTOR = 3;
export const MAX_SCREENSHOT_HEIGHT = 16000;

export const SHOP_CSS_CHECK_CODES = [
  "scope_missing",
  "overflow_x",
  "page_too_tall",
  "fact_missing",
  "fact_hidden",
  "fact_offscreen",
  "fact_clipped",
  "fact_covered",
  "fact_faded",
  "fact_small",
  "fact_squeezed",
  "fact_contrast",
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
};

export type ShopCssCheckResult = { ok: boolean; problems: string[] };

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

/**
 * The share of ground pixels under a node's lines on which its text (colour
 * with alpha and opacity, composited over that pixel) falls below MIN_CONTRAST.
 */
export function lowContrastShare(px: Pixels, node: Measure["nodes"][number]): number {
  const [tr, tg, tb, ta] = node.color;
  const alpha = Math.max(0, Math.min(1, ta * node.opacity));
  let low = 0;
  let all = 0;
  for (const r of node.rects) {
    const x0 = Math.max(0, Math.ceil(r.left + 1));
    const x1 = Math.min(px.width - 1, Math.floor(r.left + r.width - 1));
    const y0 = Math.max(0, Math.ceil(r.top + 1));
    const y1 = Math.min(px.height - 1, Math.floor(r.top + r.height - 1));
    if (x1 < x0 || y1 < y0) continue;
    const sx = Math.max(1, Math.floor((x1 - x0) / 24));
    const sy = Math.max(1, Math.floor((y1 - y0) / 8));
    for (let y = y0; y <= y1; y += sy)
      for (let x = x0; x <= x1; x += sx) {
        const i = (y * px.width + x) * px.channels;
        const ground = [px.data[i]!, px.data[i + 1]!, px.data[i + 2]!];
        const text = [tr * alpha + ground[0]! * (1 - alpha), tg * alpha + ground[1]! * (1 - alpha), tb * alpha + ground[2]! * (1 - alpha)];
        all += 1;
        if (contrast(text, ground) < MIN_CONTRAST) low += 1;
      }
  }
  return all === 0 ? 1 : low / all;
}

type Measured = { m: Measure; lowContrast: number[] };

async function measure(context: BrowserContext, html: string, facts: readonly string[]): Promise<Measured> {
  const page = await context.newPage();
  try {
    await page.setContent(html, { waitUntil: "load" });
    await page.addStyleTag({ content: `${HIT_TEST_CSS}\n${FREEZE_MOTION_CSS}` });
    await page.evaluate(`document.fonts ? document.fonts.ready.then(() => true) : true`);
    const raw = await page.evaluate(`(${MEASURE_SCRIPT})(${JSON.stringify({ facts })})`);
    const m = MeasureSchema.parse(raw);
    let lowContrast: number[] = m.nodes.map(() => 1);
    if (m.height <= MAX_SCREENSHOT_HEIGHT && m.nodes.length > 0) {
      await page.addStyleTag({ content: HIDE_FACT_TEXT_CSS });
      const png = await page.screenshot({ fullPage: true, animations: "disabled", caret: "hide" });
      const px = decodePng(png);
      lowContrast = m.nodes.map((n) => lowContrastShare(px, n));
    }
    return { m, lowContrast };
  } finally {
    await page.close();
  }
}

/** Problems the shop stylesheet causes at one viewport (compared with the baseline). */
export function compareMeasures(base: Measured, shop: Measured): ShopCssCheckCode[] {
  const out = new Set<ShopCssCheckCode>();
  const s = shop.m;
  const b = base.m;
  if (!s.scope) out.add("scope_missing");
  if (s.overflow > 1 && s.overflow > b.overflow) out.add("overflow_x");
  if (s.height > Math.max(b.height * MAX_HEIGHT_FACTOR, 2000) || s.height > MAX_SCREENSHOT_HEIGHT) out.add("page_too_tall");
  if (s.present.some((p, i) => !p && b.present[i] !== false)) out.add("fact_missing");
  // the same markup with and without the stylesheet: fact nodes line up one to one
  if (s.nodes.length !== b.nodes.length) out.add("fact_missing");
  s.nodes.forEach((n, i) => {
    const was = b.nodes[i];
    if (!was) return;
    if (n.hidden && !was.hidden) out.add("fact_hidden");
    if (n.hidden) return;
    if (n.offscreen && !was.offscreen) out.add("fact_offscreen");
    if (n.clipped && !was.clipped) out.add("fact_clipped");
    if (n.covered && !was.covered) out.add("fact_covered");
    if (n.opacity < MIN_OPACITY && was.opacity >= MIN_OPACITY) out.add("fact_faded");
    if (n.fontSize < MIN_FONT_PX - 0.01 && was.fontSize >= MIN_FONT_PX - 0.01) out.add("fact_small");
    if (n.squeezed && !was.squeezed) out.add("fact_squeezed");
    if (shop.lowContrast[i]! > CONTRAST_TOLERANCE && base.lowContrast[i]! <= CONTRAST_TOLERANCE) out.add("fact_contrast");
  });
  const same = (x: Measure["notice"], y: Measure["notice"], withTop: boolean) =>
    x !== null && y !== null && x.style === y.style && Math.abs(x.box.left - y.box.left) < 0.5 && Math.abs(x.box.width - y.box.width) < 0.5 && Math.abs(x.box.height - y.box.height) < 0.5 && (!withTop || Math.abs(x.box.top - y.box.top) < 0.5);
  if (!same(s.notice, b.notice, true)) out.add("notice_changed");
  if (!same(s.footer, b.footer, false)) out.add("footer_changed");
  if (s.noticeCovered && !b.noticeCovered) out.add("notice_covered");
  if (s.footerCovered && !b.footerCovered) out.add("footer_covered");
  return [...out];
}

/**
 * Renders the page with and without the shop stylesheet at 360, 390 and 1440 px
 * and returns the problems the stylesheet causes. Never throws: a failure of
 * the check itself is a problem (check_error), so the caller falls back.
 */
export async function checkShopCssRender(input: ShopCssCheckInput): Promise<ShopCssCheckResult> {
  const problems: string[] = [];
  for (const vp of SHOP_CSS_CHECK_VIEWPORTS) {
    let context: BrowserContext | null = null;
    try {
      context = await input.browser.newContext({ viewport: vp.viewport, deviceScaleFactor: 1, isMobile: vp.isMobile, hasTouch: vp.hasTouch, reducedMotion: "reduce", serviceWorkers: "block" });
      // local test data only: nothing is ever fetched (no font, no image, no CSS)
      await context.route("**/*", (route) => route.abort());
      const base = await measure(context, input.build(null), input.facts);
      const shop = await measure(context, input.build(input.css), input.facts);
      for (const code of compareMeasures(base, shop)) problems.push(`${vp.name}:${code}`);
    } catch {
      problems.push(`${vp.name}:check_error`);
    } finally {
      await context?.close().catch(() => undefined);
    }
  }
  return { ok: problems.length === 0, problems };
}
