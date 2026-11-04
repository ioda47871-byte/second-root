import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright";
import type { CompPage } from "@/lib/design-agent/comp-impl/page";
import { openCompPage } from "@/lib/design-agent/comp-impl/render";
import { REPO, SHOPS, type ShopKey } from "./nowrap-harness";

// DEV-171 (Issue #193 comment 6628165899): the research harness for display_scale. Test-only, like nowrap-harness.ts
// (whose shop table and width checks it reuses): it builds pages from the three shops' strict B pages with large type
// added in CSS, and the latest C′ pages (DEV-168) for the comparison. The flag is passed by the tests directly; the run
// never turns it on (APPROVED_CAPABILITIES is empty). Nothing here is a production option.

const POC = join(REPO, "design-library/research/quality-pipeline/poc");

/** The latest C′ (fidelity) page of each shop on develop after DEV-168. */
export const C_PRIME: Record<ShopKey, string> = { tsugute: "tsugute/fidelity/d1-v5", bicycle: "bicycle/fidelity/d1-v4", sento: "sento/fidelity/d1-v4" };

/**
 * The words C′ draws above 256px, as measured on the C′ pages (DEV-171 cprime-sizes, Chromium 1194): the strict page's
 * element for each, and its C′ size at 1440 (applied from 1024) and at 768 (applied 601–1023) where that is above 256.
 * None of them is a display word (they are decorative words, or the short name: an excerpt of the name).
 */
export const C_PRIME_BIG: Record<ShopKey, Array<{ sel: string; word: string; pc: number; tablet?: number }>> = {
  tsugute: [
    { sel: ".ghost-tsugu", word: "継ぐ", pc: 270 },
    { sel: ".ghost-wait", word: "待つ", pc: 500 },
  ],
  bicycle: [
    { sel: ".ghost-turn", word: "まわる", pc: 300 },
    { sel: ".ghost-tight", word: "締める", pc: 260 },
  ],
  sento: [
    { sel: ".giant-hot", word: "熱い", pc: 470, tablet: 260 },
    { sel: ".giant-warm", word: "ぬるい", pc: 280 },
  ],
};

/**
 * The page variants.
 * - strict: the strict B page as merged.
 * - scale_name: the full shop name (a display word: INSIDE the scope of display_scale) at 300px from 1024 up, letter
 *   spacing 0, line height 1. It may break at its space (two runs), never inside a run.
 * - scale_name_nowrap: the same, nowrap (display_scale with display_nowrap).
 * - scale_wide: the words C′ draws above 256px (C_PRIME_BIG) at their C′ sizes, horizontal (OUTSIDE the scope).
 */
export const SCALE_VARIANTS = ["strict", "scale_name", "scale_name_nowrap", "scale_wide"] as const;
export type ScaleVariant = (typeof SCALE_VARIANTS)[number];
export const SCALE_NAME_PX = 300;

export function scaleCss(shop: ShopKey, v: ScaleVariant): string {
  const name = SHOPS[shop].fullName;
  if (v === "scale_name") return `@media (min-width: 1024px) { ${name} { font-size: ${SCALE_NAME_PX}px; letter-spacing: 0; line-height: 1; } }`;
  if (v === "scale_name_nowrap") return `@media (min-width: 1024px) { ${name} { font-size: ${SCALE_NAME_PX}px; letter-spacing: 0; line-height: 1; white-space: nowrap; } }`;
  if (v === "scale_wide") {
    const big = C_PRIME_BIG[shop];
    const pc = big.map((b) => `${b.sel} { font-size: ${b.pc}px; }`).join(" ");
    const tablet = big.filter((b) => b.tablet).map((b) => `${b.sel} { font-size: ${b.tablet}px; }`).join(" ");
    return `@media (min-width: 1024px) { ${pc} }${tablet ? ` @media (min-width: 601px) and (max-width: 1023px) { ${tablet} }` : ""}`;
  }
  return "";
}

const files = (dir: string) => {
  const assets = join(dir, "assets");
  let names: string[] = [];
  try {
    names = readdirSync(assets).filter((f) => f.endsWith(".png"));
  } catch {
    names = [];
  }
  return new Map(names.map((f) => [`assets/${f}`, readFileSync(join(assets, f))]));
};

/**
 * The strict B page of a shop with a variant's CSS appended, every asset served (sento's strict page uses three PNGs), and
 * the viewport meta the synthetic page carries (the research pages have none; see nowrap-harness.ts strictPage).
 */
export function scalePage(shop: ShopKey, v: ScaleVariant): CompPage {
  const dir = join(POC, SHOPS[shop].strict);
  const html = readFileSync(join(dir, "index.html"), "utf8").replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">');
  const css = `${readFileSync(join(dir, "style.css"), "utf8")}\n${scaleCss(shop, v)}\n`;
  return { dir, html, css, assets: [], files: files(dir), htmlSha256: "", cssSha256: "" };
}

/** The C′ page of a shop (raw research HTML: it is outside the allowlist on purpose; only measured, never run). */
export function cPrimePage(shop: ShopKey): CompPage {
  const dir = join(POC, C_PRIME[shop]);
  return { dir, html: readFileSync(join(dir, "index.html"), "utf8"), css: readFileSync(join(dir, "style.css"), "utf8"), assets: [], files: files(dir), htmlSha256: "", cssSha256: "" };
}

/**
 * The largest font size (px) at which an element's text fits its content box with every run (between spaces) on one
 * line, letter spacing 0: the content width over the widest run drawn at 100px, × 100. Measured in the page as it is.
 */
export async function fitPx(browser: Browser, page: CompPage, sel: string, width: number): Promise<{ box: number; runs: number[]; px: number }> {
  const o = await openCompPage(browser, page, { width, height: 900, scale: 1, mobile: false });
  try {
    const r = (await o.page.evaluate(`((sel) => {
      const el = document.querySelector(sel);
      const s = getComputedStyle(el);
      const box = el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
      const probe = document.createElement("span");
      probe.style.cssText = "font-size: 100px; letter-spacing: 0; white-space: nowrap; position: absolute; left: 0; top: 0;";
      probe.style.fontFamily = s.fontFamily;
      probe.style.fontWeight = s.fontWeight;
      document.body.appendChild(probe);
      const runs = el.textContent.trim().split(/\\s+/).map((t) => { probe.textContent = t; return probe.getBoundingClientRect().width; });
      probe.remove();
      return { box, runs };
    })(${JSON.stringify(sel)})`)) as { box: number; runs: number[] };
    return { ...r, px: Math.floor((100 * r.box) / Math.max(...r.runs)) };
  } finally {
    await o.context.close();
  }
}
