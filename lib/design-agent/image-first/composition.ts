/**
 * Issue #293 P1-3: the section-sequence composition of one viewport, defined BEFORE generation and checked after it.
 *
 * Rules (all declared in the record, never guessed from the pictures):
 * - parts are numbered 1..n in page order; `single` means exactly one part; there is one seam declaration per cut;
 * - every part declares the direction sections it holds and each section's box inside the part (fractions);
 * - the page's section order: on PC exactly the direction's order, on SP the same sections, possibly reordered (sp_plan),
 *   never dropped. Read across the parts (a section continuing over a `continuous` seam counted once), the parts must
 *   give exactly that order: no section missing, doubled or out of place; the header section in part 1, the last in part n;
 * - composite = each part scaled to the target CSS width (1440 / 390; the scale is recorded), stacked top to bottom with
 *   no overlap (any overlap band lives in the PROMPTS only, as context);
 * - a `continuous` seam's edges must meet (mean colour ΔE across the cut at most SEAM_MAX_DELTA_E); a `section_break`
 *   seam is a change of section and is not colour-checked;
 * - the page is more than a first screen: PC at least 1.5 screens of 900 px, SP at least 2 screens of 844 px.
 *
 * SP independence: the SP composite must not be the PC shrunk. Same picture bytes, or the same layout at the same
 * aspect (grid SSIM high and the page aspect within 15 %), is COMP_SP_IS_PC_SCALED. This is a guard against the plain
 * cases; that the SP is its own design is also the located read's and the owner's judgement.
 *
 * Thresholds are PROVISIONAL (offline, synthetic only; to be fixed with the owner on real comps). Pure.
 */
import { deltaE, gridOf, rgbToLab, ssim } from "../comp-impl/similarity";
import { bandCells, encodePng, scaleToWidth, stack, type RgbImage } from "./pixels";
import { VIEWPORT_WIDTHS, type Composition, type ImageFirstViewport } from "./record";

export const COMPOSITION_LIMITS = {
  /** impl-compare.ts MAX_PAGE_HEIGHT: a taller page cannot be compared. */
  maxCompositeHeight: 16000,
  screens: { desktop_1440: { screen: 900, min: 1.5 }, mobile_390: { screen: 844, min: 2 } },
  seamBandRows: 4,
  seamCells: 24,
  seamMaxDeltaE: 14,
  boxEpsilon: 0.002,
  /**
   * A `single` picture must be taller (height / width) than anything the image tool has been seen to return (about 1.5,
   * docs/operations/imagegen-timeout-investigation.md): a one-shot 1024×1536 is a first screen or a poster, not a page,
   * even when scaled to 1440 it clears the screen floor.
   */
  singleMinAspect: 1.6,
  /** SP = PC shrunk: page aspect within this share and grid SSIM at least spScaledSsim. */
  spAspectTolerance: 0.15,
  spScaledSsim: 0.9,
  /** One SP part = one PC part shrunk: part aspect within this share and grid SSIM at least spPartSsim. */
  spPartAspectTolerance: 0.1,
  spPartSsim: 0.95,
  gridWidth: 32,
  upscaleWarn: 2,
} as const;

export type Box = { x: number; y: number; w: number; h: number };
export type CompositeView = {
  viewport: ImageFirstViewport;
  width: number;
  height: number;
  image: RgbImage;
  png: Buffer;
  parts: { index: number; sha256: string; scale: number; y: number; height: number }[];
  /** Section boxes in composite CSS px (declared, converted), in section_order. */
  sections: { id: string; box: Box }[];
};

/** Problems with the declared sequence (fixed detail strings). */
export function sequenceProblems(c: Composition, viewport: ImageFirstViewport, directionIds: readonly string[]): string[] {
  const p: string[] = [];
  if (c.target_css_width !== VIEWPORT_WIDTHS[viewport]) p.push("TARGET_WIDTH");
  const n = c.parts.length;
  if (c.parts.some((part, i) => part.index !== i + 1)) p.push("PART_INDEX_ORDER");
  if ((c.mode === "single") !== (n === 1)) p.push("MODE_PART_COUNT");
  const seamAfter = c.seams.map((s) => s.after_part).sort((a, b) => a - b);
  if (seamAfter.length !== n - 1 || seamAfter.some((a, i) => a !== i + 1)) p.push("SEAMS_DECLARATION");
  const order = c.section_order;
  if (new Set(order).size !== order.length) p.push("ORDER_DUPLICATE");
  if (order.some((id) => !directionIds.includes(id))) p.push("ORDER_UNKNOWN_SECTION");
  if (viewport === "desktop_1440" && order.join("\n") !== directionIds.join("\n")) p.push("PC_ORDER_NOT_DIRECTION");
  if (viewport === "mobile_390" && [...order].sort().join("\n") !== [...directionIds].sort().join("\n")) p.push("SP_SECTIONS_NOT_DIRECTION");
  const eps = COMPOSITION_LIMITS.boxEpsilon;
  for (const part of c.parts) {
    const ids = part.sections.map((s) => s.id);
    if (new Set(ids).size !== ids.length) p.push("PART_SECTION_DUPLICATE");
    if (part.sections.some((s) => s.box.w <= 0 || s.box.h <= 0 || s.box.x + s.box.w > 1 + eps || s.box.y + s.box.h > 1 + eps)) p.push("PART_BOX_OUTSIDE");
    for (let i = 1; i < part.sections.length; i++) if (part.sections[i]!.box.y + eps < part.sections[i - 1]!.box.y + part.sections[i - 1]!.box.h) p.push("PART_BOXES_OVERLAP");
  }
  // the sequence read across the parts, a section continuing over a continuous seam counted once
  const seq: string[] = [];
  c.parts.forEach((part, i) => {
    const ids = part.sections.map((s) => s.id);
    const seam = c.seams.find((s) => s.after_part === i);
    if (i > 0 && seam) {
      const joins = seq[seq.length - 1] === ids[0];
      if (seam.kind === "continuous" && !joins) p.push("CONTINUOUS_SEAM_NOT_SHARED");
      if (seam.kind === "section_break" && joins) p.push("SECTION_BREAK_SHARED");
      if (seam.kind === "continuous" && joins) ids.shift();
    }
    seq.push(...ids);
  });
  if (seq.join("\n") !== order.join("\n")) p.push("PARTS_NOT_SECTION_ORDER");
  return [...new Set(p)];
}

/** Scales and stacks the parts (the pictures already decoded, by part index) and converts the declared boxes. */
export function buildComposite(c: Composition, viewport: ImageFirstViewport, decoded: ReadonlyMap<number, RgbImage>): CompositeView {
  const width = VIEWPORT_WIDTHS[viewport];
  const scaled: RgbImage[] = [];
  const parts: CompositeView["parts"] = [];
  const boxes = new Map<string, Box>();
  let y = 0;
  for (const part of c.parts) {
    const src = decoded.get(part.index)!;
    const s = scaleToWidth(src, width);
    scaled.push(s);
    parts.push({ index: part.index, sha256: part.png_sha256, scale: Math.round((width / src.width) * 10000) / 10000, y, height: s.height });
    for (const sec of part.sections) {
      const b = { x: sec.box.x * width, y: y + sec.box.y * s.height, w: sec.box.w * width, h: sec.box.h * s.height };
      const had = boxes.get(sec.id);
      // a section continuing over a seam: one box from its top in part k to its bottom in part k+1
      boxes.set(sec.id, had ? union(had, b) : b);
    }
    y += s.height;
  }
  const image = stack(scaled);
  const round = (b: Box): Box => {
    const x1 = Math.max(0, Math.floor(b.x));
    const y1 = Math.max(0, Math.floor(b.y));
    return { x: x1, y: y1, w: Math.min(width, Math.ceil(b.x + b.w)) - x1, h: Math.min(image.height, Math.ceil(b.y + b.h)) - y1 };
  };
  return { viewport, width, height: image.height, image, png: encodePng(image), parts, sections: c.section_order.filter((id) => boxes.has(id)).map((id) => ({ id, box: round(boxes.get(id)!) })) };
}

const union = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

/** The composite is more than a first screen and not taller than the comparison can draw. */
export function compositeProblems(v: CompositeView): { heroOnly: boolean; singleTooShort: boolean; outOfRange: boolean } {
  const s = COMPOSITION_LIMITS.screens[v.viewport];
  return {
    heroOnly: v.height < s.screen * s.min,
    singleTooShort: v.parts.length === 1 && v.height / v.width <= COMPOSITION_LIMITS.singleMinAspect,
    outOfRange: v.height > COMPOSITION_LIMITS.maxCompositeHeight,
  };
}

/** Mean ΔE across each `continuous` seam (bottom band of part k vs top band of part k+1, after scaling); the broken ones. */
export function brokenSeams(c: Composition, v: CompositeView): { after_part: number; delta_e: number }[] {
  const { seamBandRows: rows, seamCells: cols, seamMaxDeltaE } = COMPOSITION_LIMITS;
  const out: { after_part: number; delta_e: number }[] = [];
  for (const seam of c.seams) {
    if (seam.kind !== "continuous") continue;
    const cut = v.parts.find((p) => p.index === seam.after_part + 1);
    if (!cut) continue;
    const above = bandCells(v.image, cut.y - rows, cut.y, cols);
    const below = bandCells(v.image, cut.y, cut.y + rows, cols);
    const d = above.reduce((sum, a, i) => sum + deltaE(rgbToLab(a), rgbToLab(below[i]!)), 0) / cols;
    if (d > seamMaxDeltaE) out.push({ after_part: seam.after_part, delta_e: Math.round(d * 10) / 10 });
  }
  return out;
}

const grid = (img: RgbImage, w: number, h: number) => gridOf({ ...img, channels: 3 }, { left: 0, top: 0, width: img.width, height: img.height }, w, h);
const aspect = (img: { width: number; height: number }) => img.height / img.width;
const near = (a: number, b: number, tol: number) => Math.abs(a / b - 1) <= tol;

/** Whether the SP looks like the PC shrunk: the same picture bytes, the whole page or one part at the same layout and aspect. */
export function spLooksScaledFromPc(pc: CompositeView, sp: CompositeView, pcParts: ReadonlyMap<number, RgbImage>, spParts: ReadonlyMap<number, RgbImage>): boolean {
  const L = COMPOSITION_LIMITS;
  const pcShas = new Set(pc.parts.map((p) => p.sha256));
  if (sp.parts.some((p) => pcShas.has(p.sha256))) return true;
  const gw = L.gridWidth;
  if (near(aspect(sp), aspect(pc), L.spAspectTolerance)) {
    const gh = Math.max(8, Math.round(gw * aspect(sp)));
    if (ssim(grid(pc.image, gw, gh), grid(sp.image, gw, gh)) >= L.spScaledSsim) return true;
  }
  for (const s of spParts.values())
    for (const p of pcParts.values()) {
      if (!near(aspect(s), aspect(p), L.spPartAspectTolerance)) continue;
      const gh = Math.max(8, Math.round(gw * aspect(s)));
      if (ssim(grid(p, gw, gh), grid(s, gw, gh)) >= L.spPartSsim) return true;
    }
  return false;
}
