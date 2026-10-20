import { decodePng } from "./worker/png-paint";

// DEV-069: colours measured in the reference screenshots, as evidence for the
// palette. The brief and the review see the same privacy-processed PNGs
// (photos blurred and pixelated); reading their colours adds no new access.
// Only hex values and shares leave this module: no text, no shapes, no image.
//
// Neutral and near-neutral pixels (white, cream, grey, dark brown, black) are
// counted apart as light / dark shares, not as colours. On an Instagram
// capture, Instagram's own blue (its buttons and links) is left out too; a
// website's colours are all its own, so nothing else is left out there.

export type ReferenceKind = "website" | "instagram";

export type ObservedColours = {
  /** Up to 5 colours, most common first; share = part of the colourful pixels (0–1, two decimals). */
  colours: Array<{ hex: string; share: number }>;
  /** Part of all sampled pixels that are colourful (0–1, two decimals). */
  colourfulShare: number;
  /** Part of all sampled pixels that are light neutral (white, cream, light grey) (0–1, two decimals). */
  lightNeutralShare: number;
  /** Part of all sampled pixels that are dark neutral (black, dark grey, dark brown) (0–1, two decimals). */
  darkNeutralShare: number;
};

const STEP = 3; // sample every 3rd pixel in both directions
const MIN_CHROMA = 28; // max − min channel below this is neutral or near-neutral
const MERGE_DISTANCE = 44; // colours closer than this (RGB distance) count as one
const MIN_SHARE = 0.04;
const MAX_COLOURS = 5;
/** Below this colourful share the material is called neutral in the prompt. */
const NEUTRAL_MATERIAL = 0.1;

/** Instagram's interface blues (buttons, links, the verified badge); only for Instagram references. */
const INSTAGRAM_BLUES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 149, 246],
  [0, 55, 107],
  [65, 147, 239],
];

const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
const hex = (rgb: readonly number[]) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
const round2 = (v: number) => Math.round(v * 100) / 100;

/** Measures the reference PNGs; null when none can be read (unsupported formats included). */
export function observeColours(pngs: readonly Buffer[], kind: ReferenceKind | undefined = "instagram"): ObservedColours | null {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  let sampled = 0;
  let colourful = 0;
  let light = 0;
  let dark = 0;
  let readable = 0;
  const excluded = kind === "website" ? [] : INSTAGRAM_BLUES;
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
        if (excluded.some((c) => dist(c, rgb) < 30)) continue;
        sampled += 1;
        if (Math.max(...rgb) - Math.min(...rgb) < MIN_CHROMA) {
          if (rgb[0] + rgb[1] + rgb[2] >= 384) light += 1;
          else dark += 1;
          continue;
        }
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
  return { colours, colourfulShare: round2(colourful / sampled), lightNeutralShare: round2(light / sampled), darkNeutralShare: round2(dark / sampled) };
}

/** The prompt line (fixed words, hex values and percentages only). */
export function observedColoursLine(observed: ObservedColours | null | undefined, kind: ReferenceKind | undefined = "instagram"): string {
  if (!observed) return "";
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const left = kind === "website" ? "" : " Instagram's own interface blue is left out.";
  const neutrals = `Neutral or near-neutral pixels (white, cream, grey, dark brown, black): ${pct(observed.lightNeutralShare)} light, ${pct(observed.darkNeutralShare)} dark.`;
  const evidence = "Treat these as measurements of the shop's material, evidence for the palette, not as a palette to copy; the contrast rules above still apply.";
  if (observed.colours.length === 0) {
    const colourfulPart =
      observed.colourfulShare < NEUTRAL_MATERIAL
        ? `almost no colourful pixels (${pct(observed.colourfulShare)}): the material is neutral.`
        : `colourful pixels are ${pct(observed.colourfulShare)} of the images, spread over many colours with none above ${pct(MIN_SHARE)} of them.`;
    return `Colours measured in the reference images (photos are blurred): ${colourfulPart} ${neutrals}${left} ${evidence}`;
  }
  return [
    `Colours measured in the reference images (photos are blurred; neutral and near-neutral pixels are counted apart):`,
    `${observed.colours.map((c) => `${c.hex} (${pct(c.share)} of the colourful pixels)`).join(", ")}.`,
    `Colourful pixels are ${pct(observed.colourfulShare)} of the images. ${neutrals}${left} ${evidence}`,
  ].join(" ");
}
