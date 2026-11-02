/**
 * DEV-155 (Issue #193): features measured from the pixels of a success-case original. Pure; advisory.
 *
 * The point is evidence that does not depend on a written description: where the page changes its ground (the
 * section rhythm), how much of each band is photographic, and the colours. Nothing here judges quality; nothing here
 * keeps the picture (only numbers leave this module).
 *
 *   bands        horizontal runs of the same ground colour at the row edges (a section with its own ground), top to bottom
 *   photo_share  part of the page (and of each band) made of photographic, many-coloured blocks
 *   colours      the existing reference-colours measure (website kind)
 */
import type { Pixels } from "../worker/png-paint";
import { observeColours, type ObservedColours } from "../reference-colours";

export type Band = {
  top: number;
  bottom: number;
  /** Part of the page height (0–1, three decimals). */
  height_share: number;
  /** The dominant row colour of the band (its ground). */
  ground_hex: string;
  /** Part of the band made of photographic blocks (0–1, two decimals). */
  photo_share: number;
};

export type OriginalFeatures = {
  schema: "reference_original_features_v0";
  width: number;
  height: number;
  bands: Band[];
  photo_share: number;
  colours: ObservedColours | null;
  advisory: true;
  note: string;
};

/** Rows are read every ROW_STEP px; a band must hold at least MIN_BAND px (shorter runs are merged into their neighbour). */
const ROW_STEP = 2;
const MIN_BAND_SHARE = 0.03;
const MIN_BAND_PX = 120;
/**
 * Blocks of BLOCK px. A block counts as photographic when it has at least PHOTO_VARIETY distinct coarse colours over
 * the whole block AND its two commonest colours cover at most TOP2_MAX of it: anti-aliased type on a flat ground has
 * many edge colours but is dominated by ground and ink, so it does not count. Smooth or very dark photo areas have
 * few coarse colours and are missed (documented limit).
 */
const BLOCK = 24;
const PHOTO_VARIETY = 18;
const TOP2_MAX = 0.6;

const q = (v: number) => v >> 4; // 16 levels per channel
const hex = (k: number) => `#${[(k >> 8) & 15, (k >> 4) & 15, k & 15].map((c) => (c * 16 + 8).toString(16).padStart(2, "0")).join("").toUpperCase()}`;

/**
 * The most common coarse colour of one row's two edges (the outer EDGE_SHARE on each side). The middle of a row is
 * often a photograph or a giant word; the ground of a section shows at its edges.
 */
const EDGE_SHARE = 0.06;
function rowGround(px: Pixels, y: number): number {
  const counts = new Map<number, number>();
  const edge = Math.max(4, Math.round(px.width * EDGE_SHARE));
  const xs: number[] = [];
  for (let x = 0; x < edge; x += 2) xs.push(x, px.width - 1 - x);
  for (const x of xs) {
    const i = (y * px.width + x) * px.channels;
    const k = (q(px.data[i]!) << 8) | (q(px.data[i + 1]!) << 4) | q(px.data[i + 2]!);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let best = 0;
  let bestN = -1;
  for (const [k, n] of counts) if (n > bestN || (n === bestN && k < best)) [best, bestN] = [k, n];
  return best;
}

/** Whether two coarse colours are the same ground (a step of one level per channel is noise, not a new section). */
const sameGround = (a: number, b: number) => [8, 4, 0].every((s) => Math.abs(((a >> s) & 15) - ((b >> s) & 15)) <= 1);

function photoBlocks(px: Pixels, top: number, bottom: number): number {
  let all = 0;
  let photo = 0;
  for (let y = top; y + BLOCK <= bottom; y += BLOCK)
    for (let x = 0; x + BLOCK <= px.width; x += BLOCK) {
      all += 1;
      const counts = new Map<number, number>();
      let n = 0;
      for (let yy = y; yy < y + BLOCK; yy += 2)
        for (let xx = x; xx < x + BLOCK; xx += 2) {
          const i = (yy * px.width + xx) * px.channels;
          const k = (q(px.data[i]!) << 8) | (q(px.data[i + 1]!) << 4) | q(px.data[i + 2]!);
          counts.set(k, (counts.get(k) ?? 0) + 1);
          n += 1;
        }
      const top = [...counts.values()].sort((a, b) => b - a);
      if (counts.size >= PHOTO_VARIETY && (top[0]! + (top[1] ?? 0)) / n <= TOP2_MAX) photo += 1;
    }
  return all === 0 ? 0 : photo / all;
}

export function measureOriginal(png: Buffer, px: Pixels): OriginalFeatures {
  const minBand = Math.max(MIN_BAND_PX, Math.round(px.height * MIN_BAND_SHARE));
  // 1. runs of the same row ground
  const runs: Array<{ top: number; bottom: number; ground: number }> = [];
  for (let y = 0; y < px.height; y += ROW_STEP) {
    const g = rowGround(px, y);
    const last = runs[runs.length - 1];
    if (last && sameGround(last.ground, g)) last.bottom = Math.min(px.height, y + ROW_STEP);
    else runs.push({ top: y, bottom: Math.min(px.height, y + ROW_STEP), ground: g });
  }
  // 2. short runs (type, photos, rules) belong to the band around them: merge them into the previous band
  const bands: Array<{ top: number; bottom: number; ground: number }> = [];
  for (const r of runs) {
    const last = bands[bands.length - 1];
    if (last && (r.bottom - r.top < minBand || sameGround(last.ground, r.ground))) last.bottom = r.bottom;
    else bands.push({ ...r });
  }
  // a short first run takes the ground of what follows it
  if (bands.length > 1 && bands[0]!.bottom - bands[0]!.top < minBand) {
    const [first, second] = [bands.shift()!, bands[0]!];
    second.top = first.top;
  }
  const out: Band[] = bands.map((b) => ({
    top: b.top,
    bottom: b.bottom,
    height_share: Math.round(((b.bottom - b.top) / px.height) * 1000) / 1000,
    ground_hex: hex(b.ground),
    photo_share: Math.round(photoBlocks(px, b.top, b.bottom) * 100) / 100,
  }));
  return {
    schema: "reference_original_features_v0",
    width: px.width,
    height: px.height,
    bands: out,
    photo_share: Math.round(photoBlocks(px, 0, px.height) * 100) / 100,
    colours: observeColours([png], "website"),
    advisory: true,
    note: "Measured from the pixels; advisory. Bands are runs of one ground colour at the row edges (a section with its own ground). Photographs or type reaching the edges can shift a band boundary; a gradient ground can split one section into two bands; sections whose grounds differ by one coarse level merge; a page that keeps one ground under changing sections shows one band. photo_share counts many-coloured blocks not dominated by two colours (photographs and dense illustration; smooth or very dark photo areas are missed). Not a quality score.",
  };
}
