import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright";
import type { CompPage } from "@/lib/design-agent/comp-impl/page";
import type { PageCssOptions } from "@/lib/design-agent/comp-impl/page-css";
import { displayWordsOf, phaseBCodes } from "@/lib/design-agent/comp-impl/phase-b";
import { PAIRS_SCRIPT, PairsSchema } from "@/lib/design-agent/comp-impl/page-scripts";
import { openCompPage, phaseBScan, textMeasure, MOBILE } from "@/lib/design-agent/comp-impl/render";
import { overflowCheck, pairsCheck, SEPARATORS, textCheck } from "@/lib/design-agent/comp-impl/checks";
import { FactsPack } from "@/lib/design-agent/quality-pipeline/facts-pack";

// DEV-170 (Issue #193 comment 6628165899, item 1): the research harness for display_nowrap. Test-only: it builds pages
// from the three shops' strict B pages (design-library/research/quality-pipeline/poc/<shop>/impl) with nowrap added in
// CSS, and measures them with the run's own scripts at chosen widths. The flag is passed here directly; the run never
// turns it on (APPROVED_CAPABILITIES is empty). Nothing here is a production option.

export const REPO = process.cwd();
const POC = join(REPO, "design-library/research/quality-pipeline/poc");

/** The checked widths of the verification (PC, tablet, SP). SP at 390 and below is opened with phone emulation, as the run does. */
export const NOWRAP_WIDTHS = [1440, 1280, 1024, 768, 601, 600, 480, 390, 375, 360, 340, 320] as const;

export type ShopKey = "tsugute" | "bicycle" | "sento";
/**
 * Per shop: the strict B page (the latest b version on develop) and the C′ page (the latest fidelity version), the
 * element of the full shop name (a display word), the element of the short name (an excerpt of the name: NOT a display
 * word) and the decorative big words (not display words).
 */
export const SHOPS: Record<ShopKey, { strict: string; cPrime: string; fullName: string; shortName: string; bigWords: string }> = {
  tsugute: { strict: "tsugute/impl/d1-v2-b", cPrime: "tsugute/fidelity/d1-v4", fullName: ".hero-name-full", shortName: ".hero-name", bigWords: ".ghost" },
  bicycle: { strict: "bicycle/impl/d1-b", cPrime: "bicycle/fidelity/d1-v3", fullName: ".name-full", shortName: ".hub-name", bigWords: ".ghost" },
  sento: { strict: "sento/impl/d1-b", cPrime: "sento/fidelity/d1-v3", fullName: ".name-full", shortName: ".name", bigWords: ".giant" },
};

/**
 * The page variants.
 * - strict: the strict B page as merged.
 * - nowrap: + white-space: nowrap on the full shop name only (inside the scope of display_nowrap).
 * - nowrap_wide: + nowrap on the short name and the big decorative words too (OUTSIDE the scope: must be refused).
 * - auto_phrase: + word-break: auto-phrase on the body (already in the allowlist with every flag off; for comparison).
 */
export const VARIANTS = ["strict", "nowrap", "nowrap_wide", "auto_phrase"] as const;
export type Variant = (typeof VARIANTS)[number];

export function variantCss(shop: ShopKey, v: Variant): string {
  const s = SHOPS[shop];
  if (v === "nowrap") return `${s.fullName} { white-space: nowrap; }`;
  if (v === "nowrap_wide") return `${s.fullName}, ${s.shortName}, ${s.bigWords} { white-space: nowrap; }`;
  if (v === "auto_phrase") return "body { word-break: auto-phrase; }";
  return "";
}

/** The shop's facts pack: the name and every fact value (whitespace-free), and the display words of the name. */
export function shopFacts(shop: ShopKey): { name: string; facts: Record<string, string>; words: string[] } {
  const pack = FactsPack.parse(JSON.parse(readFileSync(join(POC, shop, "facts-pack.json"), "utf8")));
  const facts = Object.fromEntries(pack.facts.map((f) => [f.key, f.value]));
  return { name: facts.name!, facts, words: displayWordsOf(facts.name!) };
}

/**
 * The strict B page of a shop with a variant's CSS appended. The research pages carry no viewport meta; with phone
 * emulation Chromium would lay them out 980px wide, so the harness adds the same meta the synthetic page carries (the
 * HTML allowlist admits it) — every width is then laid out at its own width, desktop or phone.
 */
export function strictPage(shop: ShopKey, v: Variant): CompPage {
  const dir = join(POC, SHOPS[shop].strict);
  const html = readFileSync(join(dir, "index.html"), "utf8").replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">');
  const css = `${readFileSync(join(dir, "style.css"), "utf8")}\n${variantCss(shop, v)}\n`;
  return { dir, html, css, assets: [], files: new Map(readdirSync(join(dir, "assets")).filter((f) => f.endsWith(".png")).map((f) => [`assets/${f}`, readFileSync(join(dir, "assets", f))])), htmlSha256: "", cssSha256: "" };
}

/** A raw page (no allowlist applied) from a body and CSS, with the viewport meta. */
export function rawDoc(body: string, css: string): CompPage {
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="style.css"></head><body>${body}</body></html>`;
  return { dir: "", html, css, assets: [], files: new Map(), htmlSha256: "", cssSha256: "" };
}

export type WidthResult = { width: number; phaseB: string[]; text: string[]; box: string[]; overflow: string[]; overflowPx: number };

/**
 * The checks of one width that bear on nowrap, as the run computes them: phase B (NOWRAP_NOT_DISPLAY,
 * DISPLAY_WORD_BROKEN, ...), the text soundness of every text node (TEXT_OVERLAP: text over text, TEXT_OUT_OF_BOX,
 * TEXT_OFFSCREEN, TEXT_CLIPPED), the box check of PAIRS_SCRIPT (TEXT_BOX_OVERFLOW; no info pairs are passed, so only
 * that code is kept) and the horizontal overflow (OVERFLOW_HORIZONTAL).
 */
export async function widthCodes(browser: Browser, page: CompPage, width: number, plan: { css: PageCssOptions; displayWords: readonly string[]; facts: readonly string[] }): Promise<WidthResult> {
  const o = await openCompPage(browser, page, { width, height: 900, scale: 1, mobile: width <= MOBILE.width });
  try {
    const phaseB = phaseBCodes(await phaseBScan(o.page, plan));
    const overflow = (await o.page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")) as number;
    const pairs = PairsSchema.parse(await o.page.evaluate(`(${PAIRS_SCRIPT})(${JSON.stringify({ pairs: [], facts: plan.facts, separators: SEPARATORS.source })})`));
    const text = textCheck(await textMeasure(o.page, plan.facts)).codes;
    return {
      width,
      phaseB,
      text: [...new Set(text)].sort(),
      box: pairsCheck(pairs).codes.filter((c) => c === "TEXT_BOX_OVERFLOW"),
      overflow: overflowCheck([{ width, overflow }]).codes,
      overflowPx: overflow,
    };
  } finally {
    await o.context.close();
  }
}

/** All codes of one width, sorted. */
export const allCodes = (r: WidthResult): string[] => [...new Set([...r.phaseB, ...r.text, ...r.box, ...r.overflow])].sort();
