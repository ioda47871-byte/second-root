/**
 * DEV-160 (Issue #193 comment 6596798696, item 6): does a page keep its shop's motif, and does it hide or cross its own
 * words? Pure scoring of what scripts/design-artifact/fidelity-measure.ts measured in a rendered page (JS off).
 *
 * The same measures are taken on the comp (A), the strict-lane implementation (B) and the research-only fidelity
 * implementation (C), with selectors named per page in a spec. A selector names what the page itself calls the motif
 * (the seam, the wheel, the thermometer strip), its captions and its giant words; nothing here knows a shop.
 *
 * Measured, not judged: no threshold here decides quality. The owner looks at the images.
 *
 * Known limits (recorded, not hidden): a giant word split across two text nodes is never counted as broken; any box
 * drawn over a caption counts as covering it, even a transparent one (pointer-events are forced on for the measure);
 * the boxes are element boxes, so the shape of a motif (a zigzag, radial spokes) is not measured.
 */
import { z } from "zod";

export type Box = { top: number; bottom: number; left: number; right: number };
export type MeasuredPage = {
  width: number;
  pageHeight: number;
  scrollWidth: number;
  /** section boxes in page order (top-down), by the page's section attribute */
  sections: Array<{ id: string; top: number; bottom: number }>;
  /** every visible element the spec calls the motif */
  motif: Box[];
  /** one entry per line of caption text: what is on top at that line's sample points */
  captionLines: Array<{ covered: boolean; crossedByMotif: boolean }>;
  /** one entry per text node of a giant word: how many lines it was drawn on */
  words: Array<{ text: string; lines: number }>;
};

export type FidelityScore = {
  /** share of the span from the first section's top to the last one's bottom that motif elements cover vertically */
  motif_coverage: number;
  /** the tallest stretch of that span with no motif element, in px */
  motif_largest_gap_px: number;
  /** section boundaries some motif element spans (by more than 8px each side) */
  boundaries_crossed: number;
  /**
   * section boundaries the motif runs through: spanned, or met from both sides by motif elements that touch the
   * boundary (within 4px) and line up horizontally (within 24px) — a line drawn in one piece per section
   */
  boundaries_carried: number;
  boundaries_total: number;
  /** sections a motif element reaches into */
  sections_touched: number;
  sections_total: number;
  /** caption lines with something else drawn on top at a sample point */
  caption_lines_covered: number;
  /** caption lines with a motif element drawn on top (a line crossing the words) */
  caption_lines_crossed: number;
  caption_lines_total: number;
  /** giant words drawn on more than one line (a word broken in the middle) */
  words_broken: string[];
  /** the page is wider than its viewport */
  horizontal_overflow: boolean;
};

const CROSS_MARGIN = 8;
const round = (n: number) => Math.round(n * 1000) / 1000;

/** Merged vertical intervals of the boxes, clipped to [lo, hi]. */
function verticalUnion(boxes: readonly Box[], lo: number, hi: number): Array<[number, number]> {
  const iv = boxes
    .map((b) => [Math.max(lo, b.top), Math.min(hi, b.bottom)] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of iv) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export function scoreFidelity(m: MeasuredPage): FidelityScore {
  const sections = [...m.sections].filter((s) => s.bottom > s.top).sort((a, b) => a.top - b.top);
  const lo = sections[0]?.top ?? 0;
  const hi = sections[sections.length - 1]?.bottom ?? m.pageHeight;
  const span = Math.max(1, hi - lo);
  const union = verticalUnion(m.motif, lo, hi);
  const covered = union.reduce((n, [a, b]) => n + (b - a), 0);
  let gap = 0;
  let at = lo;
  for (const [a, b] of union) {
    gap = Math.max(gap, a - at);
    at = Math.max(at, b);
  }
  gap = Math.max(gap, hi - at);
  const boundaries = sections.slice(1).map((s) => s.top);
  const crossed = boundaries.filter((y) => m.motif.some((b) => b.top < y - CROSS_MARGIN && b.bottom > y + CROSS_MARGIN)).length;
  const near = (a: Box, b: Box) => a.left <= b.right + 24 && b.left <= a.right + 24;
  const carried = boundaries.filter(
    (y) =>
      m.motif.some((b) => b.top < y - CROSS_MARGIN && b.bottom > y + CROSS_MARGIN) ||
      m.motif.some((above) => above.bottom >= y - 4 && above.top < y && m.motif.some((below) => below !== above && below.top <= y + 4 && below.bottom > y && near(above, below))),
  ).length;
  const touched = sections.filter((s) => m.motif.some((b) => b.top < s.bottom && b.bottom > s.top)).length;
  return {
    motif_coverage: round(covered / span),
    motif_largest_gap_px: Math.round(gap),
    boundaries_crossed: crossed,
    boundaries_carried: carried,
    boundaries_total: boundaries.length,
    sections_touched: touched,
    sections_total: sections.length,
    caption_lines_covered: m.captionLines.filter((l) => l.covered).length,
    caption_lines_crossed: m.captionLines.filter((l) => l.crossedByMotif).length,
    caption_lines_total: m.captionLines.length,
    words_broken: m.words.filter((w) => w.lines > 1).map((w) => w.text),
    horizontal_overflow: m.scrollWidth > m.width + 1,
  };
}

/**
 * How much of the reference's (the comp's) motif another page keeps: each measure as a share of the reference's,
 * capped at 1. A reference that has none of a measure gives null for it (nothing to keep).
 */
export function motifPreservation(reference: FidelityScore, other: FidelityScore) {
  const share = (o: number, r: number) => (r > 0 ? round(Math.min(1, o / r)) : null);
  return {
    coverage: share(other.motif_coverage, reference.motif_coverage),
    boundaries_crossed: share(other.boundaries_crossed, reference.boundaries_crossed),
    boundaries_carried: share(other.boundaries_carried, reference.boundaries_carried),
    sections_touched: share(other.sections_touched, reference.sections_touched),
  };
}

const Selectors = z.array(z.string().min(1).max(200)).max(20);
export const FidelitySpec = z.strictObject({
  schema: z.literal("fidelity_spec_v0"),
  shop: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
  pages: z
    .array(
      z.strictObject({
        key: z.enum(["comp", "strict_b", "fidelity_c"]),
        dir: z.string().regex(/^design-library\/research\/quality-pipeline\/poc\/[a-z0-9/_.-]+$/).refine((p) => !p.split("/").includes(".."), "no .."),
        section_attribute: z.enum(["data-section", "data-comp-section"]),
        motif: Selectors.min(1),
        /** where the page draws its motif differently below 600px (e.g. as a row border), the selectors there */
        motif_narrow: Selectors.min(1).optional(),
        captions: Selectors,
        words: Selectors,
      }),
    )
    .min(2)
    .max(3)
    .refine((pages) => new Set(pages.map((p) => p.key)).size === pages.length, "page keys must be unique"),
});
export type FidelitySpec = z.infer<typeof FidelitySpec>;
