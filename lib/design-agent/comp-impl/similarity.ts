/**
 * Comp similarity (DEV-082): how close the desktop screenshot is to the comp,
 * as three coarse numbers on downscaled images (both resampled to the same
 * GRID_WIDTH × n grid, n from the comp's aspect; the screenshot is stretched
 * to the comp's aspect, and the aspect difference is reported):
 *
 *   ssim          mean SSIM of 8×8 windows on luminance
 *   colour_blocks 1 − the mean RGB distance of 8×8-cell mean colours (0–1)
 *   edges_iou     IoU of the two binarized Sobel edge maps
 *
 * The numbers are REPORTED, NEVER A PASS. A high score on a synthetic comp only
 * shows the pipeline runs (the synthetic comp and its implementation were made
 * by the same hand). Even on a real comp, a coarse metric cannot judge
 * typography, image quality or "feel": the human compares the two images. So
 * `passing` is the literal false, and `status` says which case this is.
 *
 * Per section (DEV-097, roadmap Stage 5(b)): each layout-spec section box is
 * cropped from the comp and the matching [data-comp-section] box from the 1440
 * desktop screenshot, and a few explainable numbers are put side by side
 * (mean and dominant colour as CIELAB ΔE, edge density, the section's share of
 * the page height, its aspect). REPORT-ONLY as well: no threshold, no code that
 * fails a run. Mobile is not compared (there is no mobile comp).
 */
import type { CompKind } from "./bundle";
import type { CompMeasure } from "./page-scripts";
import type { CompSpec } from "./spec";
import { decodePng, type Pixels } from "../worker/png-paint";

export const GRID_WIDTH = 96;
const WINDOW = 8;

export const SIMILARITY_STATUSES = ["synthetic_only", "no_real_comp", "real_comp_human_review_required"] as const;
export type SimilarityStatus = (typeof SIMILARITY_STATUSES)[number];

export type Similarity = {
  status: SimilarityStatus;
  /** Never true: the metric alone never accepts an implementation. */
  passing: false;
  ssim: number | null;
  colour_blocks: number | null;
  edges_iou: number | null;
  aspect_delta: number | null;
  grid: string | null;
  code: string | null;
};

type Grid = { w: number; h: number; rgb: Float64Array };

/** A rectangle of device pixels (integers, inside the image). */
export type PixelRect = { left: number; top: number; width: number; height: number };

/** Box-filters a decoded PNG onto a w × h grid (RGB, 0–255; alpha composited on white). */
export function resample(png: Buffer, w: number, h: number): Grid {
  const p = decodePng(png);
  return gridOf(p, { left: 0, top: 0, width: p.width, height: p.height }, w, h);
}

/** Box-filters one rectangle of decoded pixels onto a w × h grid (as `resample` does for the whole image). */
export function gridOf(p: Pixels, r: PixelRect, w: number, h: number): Grid {
  const rgb = new Float64Array(w * h * 3);
  const count = new Float64Array(w * h);
  for (let y = r.top; y < r.top + r.height; y++) {
    const gy = Math.min(h - 1, Math.floor(((y - r.top) * h) / r.height));
    for (let x = r.left; x < r.left + r.width; x++) {
      const gx = Math.min(w - 1, Math.floor(((x - r.left) * w) / r.width));
      const i = (y * p.width + x) * p.channels;
      const a = p.channels === 4 ? p.data[i + 3]! / 255 : 1;
      const g = gy * w + gx;
      for (let c = 0; c < 3; c++) rgb[g * 3 + c]! += p.data[i + c]! * a + 255 * (1 - a);
      count[g]! += 1;
    }
  }
  for (let g = 0; g < w * h; g++) for (let c = 0; c < 3; c++) rgb[g * 3 + c] = count[g]! > 0 ? rgb[g * 3 + c]! / count[g]! : 255;
  return { w, h, rgb };
}

const luma = (g: Grid) => {
  const out = new Float64Array(g.w * g.h);
  for (let i = 0; i < out.length; i++) out[i] = 0.299 * g.rgb[i * 3]! + 0.587 * g.rgb[i * 3 + 1]! + 0.114 * g.rgb[i * 3 + 2]!;
  return out;
};

/** Mean SSIM over non-overlapping WINDOW × WINDOW windows (the standard constants for 8-bit data). */
export function ssim(a: Grid, b: Grid): number {
  const la = luma(a);
  const lb = luma(b);
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  let sum = 0;
  let n = 0;
  for (let y = 0; y + WINDOW <= a.h; y += WINDOW) {
    for (let x = 0; x + WINDOW <= a.w; x += WINDOW) {
      let ma = 0;
      let mb = 0;
      for (let j = 0; j < WINDOW; j++) for (let i = 0; i < WINDOW; i++) {
        ma += la[(y + j) * a.w + x + i]!;
        mb += lb[(y + j) * a.w + x + i]!;
      }
      const k = WINDOW * WINDOW;
      ma /= k;
      mb /= k;
      let va = 0;
      let vb = 0;
      let cov = 0;
      for (let j = 0; j < WINDOW; j++) for (let i = 0; i < WINDOW; i++) {
        const da = la[(y + j) * a.w + x + i]! - ma;
        const db = lb[(y + j) * a.w + x + i]! - mb;
        va += da * da;
        vb += db * db;
        cov += da * db;
      }
      va /= k - 1;
      vb /= k - 1;
      cov /= k - 1;
      sum += ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2));
      n += 1;
    }
  }
  return n === 0 ? 0 : sum / n;
}

/** 1 − mean RGB distance (normalized by the largest possible) of the WINDOW-cell mean colours. */
export function colourBlocks(a: Grid, b: Grid): number {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < a.h; y += WINDOW) {
    for (let x = 0; x < a.w; x += WINDOW) {
      const ma = [0, 0, 0];
      const mb = [0, 0, 0];
      let k = 0;
      for (let j = y; j < Math.min(a.h, y + WINDOW); j++) for (let i = x; i < Math.min(a.w, x + WINDOW); i++) {
        for (let c = 0; c < 3; c++) {
          ma[c]! += a.rgb[(j * a.w + i) * 3 + c]!;
          mb[c]! += b.rgb[(j * a.w + i) * 3 + c]!;
        }
        k += 1;
      }
      sum += Math.hypot(ma[0]! / k - mb[0]! / k, ma[1]! / k - mb[1]! / k, ma[2]! / k - mb[2]! / k) / Math.hypot(255, 255, 255);
      n += 1;
    }
  }
  return n === 0 ? 0 : 1 - sum / n;
}

/** The Sobel gradient magnitude of the grid's luminance (0 on the border cells). */
function sobelMagnitude(g: Grid): Float64Array {
  const l = luma(g);
  const mag = new Float64Array(g.w * g.h);
  for (let y = 1; y < g.h - 1; y++)
    for (let x = 1; x < g.w - 1; x++) {
      const p = (dx: number, dy: number) => l[(y + dy) * g.w + x + dx]!;
      const gx = -p(-1, -1) - 2 * p(-1, 0) - p(-1, 1) + p(1, -1) + 2 * p(1, 0) + p(1, 1);
      const gy = -p(-1, -1) - 2 * p(0, -1) - p(1, -1) + p(-1, 1) + 2 * p(0, 1) + p(1, 1);
      mag[y * g.w + x] = Math.hypot(gx, gy);
    }
  return mag;
}

/** IoU of the Sobel edge maps, each binarized at its own 80th percentile of magnitude (and at least a small floor). */
export function edgesIou(a: Grid, b: Grid): number {
  const edges = (g: Grid) => {
    const mag = sobelMagnitude(g);
    const sorted = Array.from(mag).sort((m, n) => m - n);
    const cut = Math.max(24, sorted[Math.floor(sorted.length * 0.8)] ?? 0);
    return Array.from(mag, (m) => m > cut);
  };
  const ea = edges(a);
  const eb = edges(b);
  let inter = 0;
  let union = 0;
  for (let i = 0; i < ea.length; i++) {
    if (ea[i] && eb[i]) inter += 1;
    if (ea[i] || eb[i]) union += 1;
  }
  return union === 0 ? 1 : inter / union;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** The status of a comparison: synthetic comps and unapproved comps can never stand for a real result. */
export function similarityStatus(kind: CompKind, compApproved: boolean): SimilarityStatus {
  if (kind === "synthetic") return "synthetic_only";
  return compApproved ? "real_comp_human_review_required" : "no_real_comp";
}

/** Compares the comp with the desktop full-page screenshot. Never passes. */
export function compSimilarity(comp: { bytes: Buffer; width: number; height: number; kind: CompKind }, compApproved: boolean, shot: { bytes: Buffer; width: number; height: number }): Similarity {
  const status = similarityStatus(comp.kind, compApproved);
  const h = Math.max(WINDOW, Math.round((GRID_WIDTH * comp.height) / comp.width / WINDOW) * WINDOW);
  try {
    const a = resample(comp.bytes, GRID_WIDTH, h);
    const b = resample(shot.bytes, GRID_WIDTH, h);
    return {
      status,
      passing: false,
      ssim: r3(ssim(a, b)),
      colour_blocks: r3(colourBlocks(a, b)),
      edges_iou: r3(edgesIou(a, b)),
      aspect_delta: r3(Math.abs(shot.height / shot.width - comp.height / comp.width) / (comp.height / comp.width)),
      grid: `${GRID_WIDTH}x${h}`,
      code: null,
    };
  } catch {
    // decodePng reads 8-bit RGB / RGBA non-interlaced PNGs (what Chromium writes); others are reported, not guessed
    return { status, passing: false, ssim: null, colour_blocks: null, edges_iou: null, aspect_delta: null, grid: null, code: "SIMILARITY_DECODE_UNSUPPORTED" };
  }
}

// ---------------------------------------------------------------- per section (DEV-097)

/**
 * Columns of each section's grid (fewer when the crop is narrower): a cell is ≈ section width / 128 — 11 CSS px for a
 * full-width section of the 1440 page — on the comp and on the page alike.
 */
export const SECTION_GRID_COLUMNS = 128;
/**
 * A grid cell is an edge when its Sobel magnitude on luminance exceeds this (a fixed level, so the comp's and the page's
 * densities are comparable; a full black-to-white step reads 1020). A measuring parameter, not a threshold of any verdict.
 */
export const EDGE_MAGNITUDE = 96;

export type Rgb = [number, number, number];
export type Lab = [number, number, number];

/** sRGB (0–255) to CIELAB (D65). */
export function rgbToLab(rgb: Rgb): Lab {
  const lin = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  const x = (0.4124564 * lin[0] + 0.3575761 * lin[1] + 0.1804375 * lin[2]) / 0.95047;
  const y = 0.2126729 * lin[0] + 0.7151522 * lin[1] + 0.072175 * lin[2];
  const z = (0.0193339 * lin[0] + 0.119192 * lin[1] + 0.9503041 * lin[2]) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIE76 colour difference (Euclidean distance in CIELAB): ~2.3 is a just-noticeable difference. */
export function deltaE(a: Lab, b: Lab): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** The mean colour of a grid (every cell weighs the same). */
export function meanColour(g: Grid): Rgb {
  const m: Rgb = [0, 0, 0];
  const n = g.w * g.h;
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) m[c] += g.rgb[i * 3 + c]!;
  return n === 0 ? [255, 255, 255] : (m.map((v) => v / n) as Rgb);
}

/**
 * The dominant colour of a grid: cells are binned at 16 levels per channel, the most-filled bin wins (ties: the lower
 * bin key), and its colour is the mean of its cells. `share` is the bin's share of the cells.
 */
export function dominantColour(g: Grid): { rgb: Rgb; share: number } {
  const bins = new Map<number, { n: number; sum: Rgb }>();
  const n = g.w * g.h;
  for (let i = 0; i < n; i++) {
    const c: Rgb = [g.rgb[i * 3]!, g.rgb[i * 3 + 1]!, g.rgb[i * 3 + 2]!];
    const key = (Math.min(15, Math.floor(c[0] / 16)) << 8) | (Math.min(15, Math.floor(c[1] / 16)) << 4) | Math.min(15, Math.floor(c[2] / 16));
    const bin = bins.get(key) ?? { n: 0, sum: [0, 0, 0] };
    bin.n += 1;
    for (let k = 0; k < 3; k++) bin.sum[k] += c[k];
    bins.set(key, bin);
  }
  let best: { key: number; n: number; sum: Rgb } | null = null;
  for (const [key, bin] of bins) if (!best || bin.n > best.n || (bin.n === best.n && key < best.key)) best = { key, ...bin };
  if (!best) return { rgb: [255, 255, 255], share: 0 };
  return { rgb: best.sum.map((v) => v / best.n) as Rgb, share: best.n / n };
}

/** The share of the grid's interior cells whose Sobel magnitude exceeds EDGE_MAGNITUDE (0 when the grid has no interior). */
export function edgeDensity(g: Grid): number {
  if (g.w < 3 || g.h < 3) return 0;
  const mag = sobelMagnitude(g);
  let edges = 0;
  for (let y = 1; y < g.h - 1; y++) for (let x = 1; x < g.w - 1; x++) if (mag[y * g.w + x]! > EDGE_MAGNITUDE) edges += 1;
  return edges / ((g.w - 2) * (g.h - 2));
}

/** A crop onto its own grid: SECTION_GRID_COLUMNS wide (at most the crop's width), rows from the crop's aspect (square cells). */
export function sectionGrid(p: Pixels, r: PixelRect): Grid {
  const w = Math.min(SECTION_GRID_COLUMNS, r.width);
  const h = Math.max(1, Math.min(r.height, Math.round((w * r.height) / r.width)));
  return gridOf(p, r, w, h);
}

/** A rectangle given in image units (any scale) as whole device pixels inside the image; null when nothing is left. */
export function pixelRect(p: { width: number; height: number }, left: number, top: number, width: number, height: number): PixelRect | null {
  const l = Math.max(0, Math.min(p.width, Math.round(left)));
  const t = Math.max(0, Math.min(p.height, Math.round(top)));
  const r = Math.max(0, Math.min(p.width, Math.round(left + width)));
  const b = Math.max(0, Math.min(p.height, Math.round(top + height)));
  return r > l && b > t ? { left: l, top: t, width: r - l, height: b - t } : null;
}

const hex = (rgb: Rgb) => `#${rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;
const r1 = (n: number) => Math.round(n * 10) / 10;

export type CropStats = { mean: Rgb; dominant: { rgb: Rgb; share: number }; edges: number };

export function cropStats(g: Grid): CropStats {
  return { mean: meanColour(g), dominant: dominantColour(g), edges: edgeDensity(g) };
}

export type SectionColour = {
  comp_mean: string;
  page_mean: string;
  /** CIE76 ΔE between the two mean colours. */
  mean_delta_e: number;
  /** CIELAB L* of the page's mean minus the comp's (negative: the page's section is darker). */
  lightness_delta: number;
  comp_dominant: string;
  page_dominant: string;
  comp_dominant_share: number;
  page_dominant_share: number;
  /** CIE76 ΔE between the two dominant colours (usually the section's ground). */
  dominant_delta_e: number;
};

export type SectionCompare = {
  id: string;
  role: string;
  /** null, SECTION_NOT_RENDERED (no shown [data-comp-section] with this id) or SECTION_CROP_EMPTY (a box outside its image). */
  code: string | null;
  /**
   * The crops: comp in comp-image px, page in CSS px of the 1440 page; [left, top, width, height]. The page box is the
   * crop actually compared (the measured box clamped to the screenshot, in whole device px, divided by the scale).
   */
  comp_box_px: [number, number, number, number] | null;
  page_box_css_px: [number, number, number, number] | null;
  colour: SectionColour | null;
  /** Share of edge cells on each grid; delta = page − comp (positive: the page's section is busier). */
  edges: { comp_density: number; page_density: number; delta: number } | null;
  /** The section's share of the whole height (comp: the spec box; page: the cropped box over the page height); ratio = page / comp. */
  height_share: { comp: number; page: number; ratio: number } | null;
  /** Height over width of each crop; ratio = page / comp. */
  aspect_h_per_w: { comp: number; page: number; ratio: number } | null;
};

export type SectionReport = {
  /** Only the desktop page is compared: the comp shows one 1440 page; there is no mobile comp (mobile = order check + a person). */
  viewport: "desktop_1440";
  mobile: "not_compared_no_mobile_comp";
  /** Reported, never a pass: no threshold applies to any number here. */
  passing: false;
  grid_columns: number;
  edge_magnitude: number;
  code: string | null;
  items: SectionCompare[];
};

/** A report with no items and a code: an undecodable PNG, or (run.ts) any error while comparing. */
export function emptySectionReport(code: string): SectionReport {
  return { viewport: "desktop_1440", mobile: "not_compared_no_mobile_comp", passing: false, grid_columns: SECTION_GRID_COLUMNS, edge_magnitude: EDGE_MAGNITUDE, code, items: [] };
}

/** Puts the statistics of a comp crop and a page crop side by side. Identical crops give zero distances and deltas. */
export function compareCrops(comp: CropStats, page: CropStats): { colour: SectionColour; edges: NonNullable<SectionCompare["edges"]> } {
  const labCompMean = rgbToLab(comp.mean);
  const labPageMean = rgbToLab(page.mean);
  return {
    colour: {
      comp_mean: hex(comp.mean),
      page_mean: hex(page.mean),
      mean_delta_e: r1(deltaE(labCompMean, labPageMean)),
      lightness_delta: r1(labPageMean[0] - labCompMean[0]),
      comp_dominant: hex(comp.dominant.rgb),
      page_dominant: hex(page.dominant.rgb),
      comp_dominant_share: r3(comp.dominant.share),
      page_dominant_share: r3(page.dominant.share),
      dominant_delta_e: r1(deltaE(rgbToLab(comp.dominant.rgb), rgbToLab(page.dominant.rgb))),
    },
    edges: { comp_density: r3(comp.edges), page_density: r3(page.edges), delta: r3(page.edges - comp.edges) },
  };
}

const ratio = (comp: number, page: number) => ({ comp: r3(comp), page: r3(page), ratio: comp > 0 ? r3(page / comp) : 0 });

/**
 * The per-section report: each spec section's box (fractions of the comp) cropped from the comp, the first shown
 * [data-comp-section] with the same id cropped from the desktop full-page screenshot (its box in CSS px, scaled by the
 * screenshot's width over the page's). Never passes; a missing or empty section is reported with a code, not failed.
 */
export function sectionComparison(compPng: Buffer, shotPng: Buffer, sections: CompSpec["sections"], measure: Pick<CompMeasure, "sections" | "width" | "height">): SectionReport {
  let comp: Pixels;
  let shot: Pixels;
  try {
    comp = decodePng(compPng);
    shot = decodePng(shotPng);
  } catch {
    return emptySectionReport("SIMILARITY_DECODE_UNSUPPORTED");
  }
  const scale = measure.width > 0 ? shot.width / measure.width : 1;
  const items = sections.map((s): SectionCompare => {
    const empty = { id: s.id, role: s.role, comp_box_px: null, page_box_css_px: null, colour: null, edges: null, height_share: null, aspect_h_per_w: null };
    const got = measure.sections.find((m) => m.shown && m.id === s.id);
    if (!got) return { ...empty, code: "SECTION_NOT_RENDERED" };
    const c = pixelRect(comp, s.box.x * comp.width, s.box.y * comp.height, s.box.w * comp.width, s.box.h * comp.height);
    const p = pixelRect(shot, got.box.left * scale, got.box.top * scale, got.box.width * scale, got.box.height * scale);
    if (!c || !p) return { ...empty, code: "SECTION_CROP_EMPTY" };
    const { colour, edges } = compareCrops(cropStats(sectionGrid(comp, c)), cropStats(sectionGrid(shot, p)));
    return {
      id: s.id,
      role: s.role,
      code: null,
      comp_box_px: [c.left, c.top, c.width, c.height],
      page_box_css_px: [r1(p.left / scale), r1(p.top / scale), r1(p.width / scale), r1(p.height / scale)],
      colour,
      edges,
      height_share: ratio(s.box.h, measure.height > 0 ? p.height / scale / measure.height : 0),
      aspect_h_per_w: ratio(c.height / c.width, p.height / p.width),
    };
  });
  return { ...emptySectionReport(""), code: null, items };
}
