import { createHash } from "node:crypto";
import type { Browser, Page } from "playwright";
import type { CompPage } from "@/lib/design-agent/comp-impl/page";
import { DISPLAY_SWEEP_SCRIPT, PHASE_B_SCRIPT, PAINT_SCANNER } from "@/lib/design-agent/comp-impl/phase-b";
import { openCompPage } from "@/lib/design-agent/comp-impl/render";

// DEV-180 (Issue #193 comment 6654178698 B.5): the candidate fix for the gradient measuring-box gap (DEV-172 Fresh Review
// M1, docs/design/gradient-ground-decision.md §3.3). TEST-ONLY. lib/ is not changed on this branch: the candidate is the
// production paint scanner (phase-b.ts PAINT_SCANNER, as inlined in PHASE_B_SCRIPT and DISPLAY_SWEEP_SCRIPT) with one
// textual patch applied here, so that the production diff (docs/design/capability-approval-gradient-ground.md §3) is
// exactly this patch. It ADDS a failure (GRADIENT_PAINT_BOX) and measures a box that is never longer than before (the
// padding box instead of the border box), so it makes pages fail that passed — with ONE exception the other way (DEV-180
// review L1): a ground whose padding box has no length along the gradient (e.g. height: 0 with opaque solid borders)
// was measured on the border box and could fail the stop rule (GRADIENT_TOO_STEEP); patched, the line is 0 long and the
// stop rule returns []. Nothing of the gradient is drawn there (the padding box is empty, the borders are opaque), so
// this passes no drawn gradient; gradient-paint-box.test.ts pins the case.
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

/**
 * The SHA-256 of the pre-fix production PAINT_SCANNER (develop at DEV-180, before the production draft). The proof that
 * "only the patch differs" is made against this pinned scanner, not against whatever the current source is (DEV-180
 * review #224 L1: on the production branch the source already holds the patch, and comparing it with itself proved
 * nothing). If develop changes the scanner, this hash and the patch must be re-derived.
 */
export const PRE_FIX_PAINT_SCANNER_SHA256 = "19c4870bac89b5e980ae84b0021e72ce223e8b81e4d632233eab1ff45cf34484";
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * The pre-fix form of a script that inlines PAINT_SCANNER: the source itself while it holds PAINT_BOX_FROM (develop, the
 * research branch), or the source with the patch taken back out (the production branch). Throws unless exactly one of
 * the two blocks occurs exactly once.
 */
export function preFix(src: string): string {
  const from = src.split(PAINT_BOX_FROM).length - 1;
  const to = src.split(PAINT_BOX_TO).length - 1;
  if (from === 1 && to === 0) return src;
  if (from === 0 && to === 1) return src.replace(PAINT_BOX_TO, PAINT_BOX_FROM);
  throw new Error(`PAINT_BOX_FROM ×${from}, PAINT_BOX_TO ×${to} (the production scanner changed: re-derive the patch)`);
}

/** Applies the patch to the pre-fix form of a script that inlines PAINT_SCANNER. */
export function withPaintBox(src: string): string {
  return preFix(src).replace(PAINT_BOX_FROM, PAINT_BOX_TO);
}

/** Whether the production scanner holds the patch (the production branch) or not (develop, the research branch). */
export const PRODUCTION_PATCHED = preFix(PAINT_SCANNER) !== PAINT_SCANNER;
export const PRE_FIX_PHASE_B_SCRIPT = preFix(PHASE_B_SCRIPT);
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

/** The pre-fix scanner's scan (develop's PAINT_SCANNER, pinned by hash), on either branch. */
export async function preFixScan(page: Page): Promise<string[]> {
  return candidateCodes((await page.evaluate(`(${PRE_FIX_PHASE_B_SCRIPT})(${JSON.stringify({ display: [], displayCap: false, words: false })})`)) as Scan);
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
