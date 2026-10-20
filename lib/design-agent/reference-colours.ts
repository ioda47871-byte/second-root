import { decodePng } from "./worker/png-paint";

// DEV-069: colours measured in the reference screenshots, as evidence for the
// palette. The brief and the review see the same privacy-processed PNGs
// (photos blurred and pixelated); reading their colours adds no new access.
// Only hex values and shares leave this module: no text, no shapes, no image.
//
// Instagram's own interface would dominate a profile capture (white ground,
// grey and black text, its blue buttons and story ring), so neutral pixels and
// those interface colours are left out; what remains is mostly the shop's
// posts (blurred) and, for a website, its own colours.

export type ObservedColours = {
  /** Up to 5 colours, most common first; share = part of the colourful pixels (0–1, two decimals). */
  colours: Array<{ hex: string; share: number }>;
  /** Part of all sampled pixels that are colourful (0–1, two decimals). */
  colourfulShare: number;
};

const STEP = 3; // sample every 3rd pixel in both directions
const MIN_CHROMA = 28; // max − min channel below this is neutral (white, grey, black)
const MERGE_DISTANCE = 44; // colours closer than this (RGB distance) count as one
const MIN_SHARE = 0.04;
const MAX_COLOURS = 5;

/** Instagram's interface colours: its blue buttons and links, and the story-ring gradient. */
const INTERFACE: ReadonlyArray<readonly [number, number, number]> = [
  [0, 149, 246],
  [0, 55, 107],
  [65, 147, 239],
  [254, 218, 117],
  [250, 126, 30],
  [214, 41, 118],
  [150, 47, 191],
  [79, 91, 213],
];

const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
const hex = (rgb: readonly number[]) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
const round2 = (v: number) => Math.round(v * 100) / 100;

/** Measures the reference PNGs; null when none can be read. */
export function observeColours(pngs: readonly Buffer[]): ObservedColours | null {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  let sampled = 0;
  let colourful = 0;
  let readable = 0;
  for (const png of pngs) {
    let px;
    try {
      px = decodePng(png);
    } catch {
      continue;
    }
    readable += 1;
    for (let y = 0; y < px.height; y += STEP)
      for (let x = 0; x < px.width; x += STEP) {
        const i = (y * px.width + x) * px.channels;
        if (px.channels === 4 && px.data[i + 3]! < 200) continue;
        const rgb = [px.data[i]!, px.data[i + 1]!, px.data[i + 2]!] as const;
        sampled += 1;
        if (Math.max(...rgb) - Math.min(...rgb) < MIN_CHROMA) continue;
        if (INTERFACE.some((c) => dist(c, rgb) < 30)) continue;
        colourful += 1;
        const key = ((rgb[0] >> 4) << 8) | ((rgb[1] >> 4) << 4) | (rgb[2] >> 4);
        const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
        bucket.n += 1;
        bucket.r += rgb[0];
        bucket.g += rgb[1];
        bucket.b += rgb[2];
        buckets.set(key, bucket);
      }
  }
  if (readable === 0 || sampled === 0) return null;
  // merge neighbouring buckets, most common first
  const groups: Array<{ n: number; rgb: [number, number, number] }> = [];
  for (const b of [...buckets.values()].sort((p, q) => q.n - p.n)) {
    const mean: [number, number, number] = [b.r / b.n, b.g / b.n, b.b / b.n];
    const near = groups.find((g) => dist(g.rgb, mean) < MERGE_DISTANCE);
    if (near) {
      const n = near.n + b.n;
      near.rgb = [(near.rgb[0] * near.n + b.r) / n, (near.rgb[1] * near.n + b.g) / n, (near.rgb[2] * near.n + b.b) / n];
      near.n = n;
    } else groups.push({ n: b.n, rgb: mean });
  }
  const colours = groups
    .sort((p, q) => q.n - p.n)
    .filter((g) => colourful > 0 && g.n / colourful >= MIN_SHARE)
    .slice(0, MAX_COLOURS)
    .map((g) => ({ hex: hex(g.rgb), share: round2(g.n / colourful) }));
  return { colours, colourfulShare: round2(colourful / sampled) };
}

/** The prompt line (fixed words and hex values only). */
export function observedColoursLine(observed: ObservedColours | null | undefined): string {
  if (!observed) return "";
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  if (observed.colours.length === 0)
    return `Colours measured in the reference images: almost no colourful pixels (${pct(observed.colourfulShare)}); the material is neutral (white, grey, black). Instagram's own interface colours are left out of this count.`;
  return [
    `Colours measured in the reference images (photos are blurred; neutral white, grey and black and Instagram's own interface colours are left out): ${observed.colours.map((c) => `${c.hex} (${pct(c.share)} of the colourful pixels)`).join(", ")}.`,
    `Colourful pixels are ${pct(observed.colourfulShare)} of the images. Treat these as measurements of the shop's material, evidence for the palette, not as a palette to copy; the contrast rules above still apply.`,
  ].join(" ");
}
