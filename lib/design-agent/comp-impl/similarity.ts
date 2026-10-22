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
 */
import type { CompKind } from "./bundle";
import { decodePng } from "../worker/png-paint";

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

/** Box-filters a decoded PNG onto a w × h grid (RGB, 0–255; alpha composited on white). */
export function resample(png: Buffer, w: number, h: number): Grid {
  const p = decodePng(png);
  const rgb = new Float64Array(w * h * 3);
  const count = new Float64Array(w * h);
  for (let y = 0; y < p.height; y++) {
    const gy = Math.min(h - 1, Math.floor((y * h) / p.height));
    for (let x = 0; x < p.width; x++) {
      const gx = Math.min(w - 1, Math.floor((x * w) / p.width));
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

/** IoU of the Sobel edge maps, each binarized at its own 80th percentile of magnitude (and at least a small floor). */
export function edgesIou(a: Grid, b: Grid): number {
  const edges = (g: Grid) => {
    const l = luma(g);
    const mag = new Float64Array(g.w * g.h);
    for (let y = 1; y < g.h - 1; y++)
      for (let x = 1; x < g.w - 1; x++) {
        const p = (dx: number, dy: number) => l[(y + dy) * g.w + x + dx]!;
        const gx = -p(-1, -1) - 2 * p(-1, 0) - p(-1, 1) + p(1, -1) + 2 * p(1, 0) + p(1, 1);
        const gy = -p(-1, -1) - 2 * p(0, -1) - p(1, -1) + p(-1, 1) + 2 * p(0, 1) + p(1, 1);
        mag[y * g.w + x] = Math.hypot(gx, gy);
      }
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
