// Differences between two compared pages (DEV-073): a simple structural
// distance between the profiles as drawn, and the share of differing pixels
// of their screenshots. Pure functions over enum values and pixels.
import type { DemoView } from "@/lib/sales/demo-content";
import { DEFAULT_LAYOUT, normalizeLayout } from "../layout";
import type { DesignProfile } from "../profile";
import { decodePng } from "../worker/png-paint";

/** What a page's structure is, as the renderer draws it (the layout normalized against the shop's facts). */
export type Structure = {
  direction: string;
  firstView: string;
  sections: Array<{ kind: string; variant: string; ground: string }>;
  type: { scale: string; headings: string };
  typography: { display: string; body: string; displayCase: string; displayWeight: string; tracking: string };
  hero: { layout: string; height: string; alignment: string };
};

export function structureOf(profile: DesignProfile, demo: DemoView): Structure {
  const layout = normalizeLayout(profile.layout ?? DEFAULT_LAYOUT, demo).layout;
  return {
    direction: profile.direction,
    firstView: layout.firstView,
    sections: layout.sections.map((s) => ({ kind: s.kind, variant: s.variant, ground: s.ground })),
    type: { scale: layout.type.scale, headings: layout.type.headings },
    typography: { ...profile.typography },
    hero: { ...profile.heroLayout },
  };
}

function editDistance(a: readonly string[], b: readonly string[]): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

/** Share (0–1) of section kinds whose setting differs; a kind on one page only counts as different. */
function settingDistance(a: Structure, b: Structure, field: "variant" | "ground"): number {
  const kinds = new Set([...a.sections.map((s) => s.kind), ...b.sections.map((s) => s.kind)]);
  if (kinds.size === 0) return 0;
  let differ = 0;
  for (const kind of kinds) {
    const x = a.sections.find((s) => s.kind === kind);
    const y = b.sections.find((s) => s.kind === kind);
    if (!x || !y || x[field] !== y[field]) differ += 1;
  }
  return differ / kinds.size;
}

const share = (pairs: Array<[string, string]>) => pairs.filter(([x, y]) => x !== y).length / pairs.length;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export type StructureDistance = {
  first_view: number;
  section_order: number;
  variants: number;
  grounds: number;
  direction: number;
  typography: number;
  hero: number;
  /** The mean of the seven parts: 0 = the same structure, 1 = different in every part. */
  total: number;
};

/** A simple distance: each part in 0–1 (section order: edit distance of the kinds over the longer list), the total their mean. */
export function structureDistance(a: Structure, b: Structure): StructureDistance {
  const ka = a.sections.map((s) => s.kind);
  const kb = b.sections.map((s) => s.kind);
  const parts = {
    first_view: a.firstView === b.firstView ? 0 : 1,
    section_order: Math.max(ka.length, kb.length) === 0 ? 0 : editDistance(ka, kb) / Math.max(ka.length, kb.length),
    variants: settingDistance(a, b, "variant"),
    grounds: settingDistance(a, b, "ground"),
    direction: a.direction === b.direction ? 0 : 1,
    typography: share([
      [a.type.scale, b.type.scale],
      [a.type.headings, b.type.headings],
      [a.typography.display, b.typography.display],
      [a.typography.body, b.typography.body],
      [a.typography.displayCase, b.typography.displayCase],
      [a.typography.displayWeight, b.typography.displayWeight],
      [a.typography.tracking, b.typography.tracking],
    ]),
    hero: share([
      [a.hero.layout, b.hero.layout],
      [a.hero.height, b.hero.height],
      [a.hero.alignment, b.hero.alignment],
    ]),
  };
  const values = Object.values(parts);
  return {
    first_view: round3(parts.first_view),
    section_order: round3(parts.section_order),
    variants: round3(parts.variants),
    grounds: round3(parts.grounds),
    direction: round3(parts.direction),
    typography: round3(parts.typography),
    hero: round3(parts.hero),
    total: round3(values.reduce((x, y) => x + y, 0) / values.length),
  };
}

export type PixelDifference = {
  /** Share of differing pixels over the taller page (rows only one page has count as different). */
  full: number;
  /** The same over the first screen only (the viewport's height). */
  first_screen: number;
};

/** A pixel differs when its channels differ by more than this on average (0–255). */
export const PIXEL_THRESHOLD = 24;
const STEP = 2;

/**
 * Share of differing pixels between two screenshots of the same viewport, sampled
 * every STEP pixels. Columns or rows only one image has count as different.
 */
export function pixelDifference(a: Buffer, b: Buffer, firstScreenPx: number): PixelDifference {
  const pa = decodePng(a);
  const pb = decodePng(b);
  const width = Math.max(pa.width, pb.width);
  const height = Math.max(pa.height, pb.height);
  const at = (p: typeof pa, x: number, y: number): number | null => {
    if (x >= p.width || y >= p.height) return null;
    return (y * p.width + x) * p.channels;
  };
  let differ = 0;
  let total = 0;
  let differTop = 0;
  let totalTop = 0;
  for (let y = 0; y < height; y += STEP) {
    for (let x = 0; x < width; x += STEP) {
      const i = at(pa, x, y);
      const j = at(pb, x, y);
      const d =
        i === null ||
        j === null ||
        (Math.abs(pa.data[i]! - pb.data[j]!) + Math.abs(pa.data[i + 1]! - pb.data[j + 1]!) + Math.abs(pa.data[i + 2]! - pb.data[j + 2]!)) / 3 > PIXEL_THRESHOLD;
      total += 1;
      if (d) differ += 1;
      if (y < firstScreenPx) {
        totalTop += 1;
        if (d) differTop += 1;
      }
    }
  }
  const r4 = (n: number) => Math.round(n * 10000) / 10000;
  return { full: r4(total ? differ / total : 0), first_screen: r4(totalTop ? differTop / totalTop : 0) };
}
