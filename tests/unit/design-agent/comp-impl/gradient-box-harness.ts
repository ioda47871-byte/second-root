import type { Browser, Page } from "playwright";
import type { CompPage } from "@/lib/design-agent/comp-impl/page";
import { DISPLAY_SWEEP_SCRIPT, PHASE_B_SCRIPT, PAINT_SCANNER } from "@/lib/design-agent/comp-impl/phase-b";
import { openCompPage } from "@/lib/design-agent/comp-impl/render";

// DEV-180 (Issue #193 comment 6654178698 B.5): the candidate fix for the gradient measuring-box gap (DEV-172 Fresh Review
// M1, docs/design/gradient-ground-decision.md §3.3). TEST-ONLY. lib/ is not changed on this branch: the candidate is the
// production paint scanner (phase-b.ts PAINT_SCANNER, as inlined in PHASE_B_SCRIPT and DISPLAY_SWEEP_SCRIPT) with one
// textual patch applied here, so that the production diff (docs/design/capability-approval-gradient-ground.md §3) is
// exactly this patch. It only ADDS a failure (GRADIENT_PAINT_BOX) and measures a box that is never longer than before
// (the padding box instead of the border box): it can make a page fail that passed, never the other way.
//
// What it closes (each reproduced in gradient-ground.test.ts "known gap before ON (Fresh Review M1)"):
// - transparent / non-solid borders: Chromium sizes the gradient to the padding box and repeats it under the border
//   (background-repeat is not in the grammar; its initial value is repeat), so a hard edge shows where the tile repeats.
//   A border is accepted only if every side that has a width is `solid` and opaque: the repeat is then painted over.
// - `em` borders the grammar reads as 16px: the computed width is what is checked, at every width of the sweep.
// - a box drawn in fragments (a wrapped inline box: one gradient per line fragment): the gradient must lie on a box
//   with exactly one client rect, of a display type whose background is one box (below). Anything else fails closed.
// - the stop rule is measured on the padding box (border box minus the border widths), the box Chromium sizes it to.

/** Display types whose background is painted once, sized to the element's own padding box. */
export const PAINT_BOX_DISPLAY = ["block", "flow-root", "inline-block", "flex", "inline-flex", "grid", "inline-grid", "list-item", "inline"] as const;

/** The production source the patch replaces (must occur exactly once in PAINT_SCANNER). */
export const PAINT_BOX_FROM = `        const box = el.getBoundingClientRect();
        if (textInside(el)) grounds.hasText += 1;
        else if (allLines.some((r) => meets(r, rectOf(box)))) grounds.underText += 1;
        if (grounds.list.length < 8) grounds.list.push(el.tagName.toLowerCase());
        for (const g of split(s.backgroundImage)) {
          gradients.count += 1;
          for (const c of gradientCodes(parseGradient(g, box))) gradientSet.add(c);
        }`;

/** The patched source (the candidate; the production diff is this replacement). */
export const PAINT_BOX_TO = `        const box = el.getBoundingClientRect();
        if (textInside(el)) grounds.hasText += 1;
        else if (allLines.some((r) => meets(r, rectOf(box)))) grounds.underText += 1;
        if (grounds.list.length < 8) grounds.list.push(el.tagName.toLowerCase());
        // DEV-180 (DEV-172 Fresh Review M1): Chromium sizes a gradient to the padding box, repeats it under the border and
        // draws it once per fragment. The rule measures the padding box; a border must be solid and opaque on every side
        // that has a width (the repeat is painted over), and the box must be one box of a known display type
        // (GRADIENT_PAINT_BOX otherwise, fail closed)
        const sides = ["Top", "Right", "Bottom", "Left"];
        const bw = sides.map((k) => parseFloat(s["border" + k + "Width"]) || 0);
        const coveredSide = (k, i) => bw[i] === 0 || (s["border" + k + "Style"] === "solid" && (colour(s["border" + k + "Color"]) || [0, 0, 0, 0])[3] === 255);
        const oneBox = ${JSON.stringify(PAINT_BOX_DISPLAY)}.includes(s.display) && el.getClientRects().length === 1;
        const paintBox = !oneBox || !sides.every(coveredSide);
        const inner = { width: Math.max(0, box.width - bw[1] - bw[3]), height: Math.max(0, box.height - bw[0] - bw[2]) };
        for (const g of split(s.backgroundImage)) {
          gradients.count += 1;
          if (paintBox) gradientSet.add("GRADIENT_PAINT_BOX");
          for (const c of gradientCodes(parseGradient(g, inner))) gradientSet.add(c);
        }`;

/** Applies the patch to a script that inlines PAINT_SCANNER; throws unless the source occurs exactly once. */
export function withPaintBox(src: string): string {
  // DEV-180 production branch: the scanner already holds the patch (phase-b.ts), so the candidate is production itself
  if (src.split(PAINT_BOX_TO).length - 1 === 1 && !src.includes(PAINT_BOX_FROM)) return src;
  const n = src.split(PAINT_BOX_FROM).length - 1;
  if (n !== 1) throw new Error(`PAINT_BOX_FROM occurs ${n} times (the production scanner changed: re-derive the patch)`);
  return src.replace(PAINT_BOX_FROM, PAINT_BOX_TO);
}

export const CANDIDATE_PAINT_SCANNER = withPaintBox(PAINT_SCANNER);
export const CANDIDATE_PHASE_B_SCRIPT = withPaintBox(PHASE_B_SCRIPT);
export const CANDIDATE_SWEEP_SCRIPT = withPaintBox(DISPLAY_SWEEP_SCRIPT);

/** The phase B codes of the candidate (as phase-b.ts phaseBCodes, plus GRADIENT_PAINT_BOX). */
type Scan = { type: { above: number }; nowrap: { notDisplay: number }; broken: string[]; grounds: { hasText: number; underText: number }; gradients: { count: number; codes: string[] }; translucent: { hasText: number; underText: number } };
export function candidateCodes(scan: Scan): string[] {
  const codes = new Set<string>();
  if (scan.type.above > 0) codes.add("TYPE_ROLE_CAP");
  if (scan.nowrap.notDisplay > 0) codes.add("NOWRAP_NOT_DISPLAY");
  if (scan.broken.length > 0) codes.add("DISPLAY_WORD_BROKEN");
  if (scan.grounds.hasText > 0) codes.add("GROUND_HAS_TEXT");
  if (scan.grounds.underText > 0) codes.add("GROUND_UNDER_TEXT");
  if (scan.translucent.hasText > 0) codes.add("TRANSLUCENT_HAS_TEXT");
  if (scan.translucent.underText > 0) codes.add("TRANSLUCENT_UNDER_TEXT");
  for (const c of scan.gradients.codes) codes.add(c);
  return [...codes].sort();
}

/** The candidate scan at the page's current viewport (gradient_ground on; no display words). */
export async function candidateScan(page: Page): Promise<string[]> {
  return candidateCodes((await page.evaluate(`(${CANDIDATE_PHASE_B_SCRIPT})(${JSON.stringify({ display: [], displayCap: false, words: false })})`)) as Scan);
}

/**
 * The candidate's 1px sweep with real resizes (every integer width of [from, to], desktop, height 900), gradient_ground on:
 * the codes per width (only widths with codes).
 */
export async function candidateSweep(browser: Browser, compPage: CompPage, from = 320, to = 1920): Promise<Array<{ w: number; codes: string[] }>> {
  const o = await openCompPage(browser, compPage, { width: from, height: 900, scale: 1, mobile: false });
  const failing: Array<{ w: number; codes: string[] }> = [];
  try {
    for (let w = from; w <= to; w++) {
      await o.page.setViewportSize({ width: w, height: 900 });
      const r = (await o.page.evaluate(`(${CANDIDATE_SWEEP_SCRIPT})(${JSON.stringify({ display: [], from: w, to: w, step: false, words: false, overlap: true })})`)) as { failing: Array<{ w: number; codes: string[] }>; measured: number };
      if (r.measured !== 1) throw new Error(`candidate sweep measured ${r.measured} at ${w}`);
      failing.push(...r.failing);
    }
  } finally {
    await o.context.close();
  }
  return failing;
}
