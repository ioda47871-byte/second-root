/**
 * DEV-083 phase A checks (docs/design/dev-083-expressive-safe-reproduction.md §2, §7): pure functions over what the
 * browser measured (layers.ts, render.ts). Verification only — they add refusals and measurements; nothing here
 * lets a page do anything the DEV-082 allowlist refuses, and no existing check, tolerance or threshold changes.
 */
import type { Measure } from "../shop-css/page-scripts";
import type { CheckResult } from "./checks";
import { widthRanges } from "./checks";
import type { LayerScan } from "./layers";
import type { GeometryPass } from "./render";
import { APPROVED_CAPABILITIES } from "./spec";

const result = (codes: Iterable<string>, extra: Record<string, unknown> = {}): CheckResult => {
  const list = [...new Set(codes)].sort();
  return { ok: list.length === 0, codes: list, ...extra };
};

// ---------------------------------------------------------------- V1, V2, V4, V9 (one scan per width)

/**
 * Which new codes may refuse a page (go into `failed`) and which are advisory (report.advisory only). A code is blocking
 * only where the DEV-082 allowlist and the existing checks already refuse every page it refuses (so no outcome changes);
 * the argument for each is in docs/design/dev-083-expressive-safe-reproduction.md §10. Everything else is advisory until
 * the human approves it as a gate.
 */
export const BLOCKING_LAYER_CODES = ["ROLE_UNKNOWN", "ROLE_MISMATCH", "ROLE_DECORATION_HAS_TEXT", "ROLE_GROUND_HAS_TEXT", "ROLE_MEDIA_HAS_TEXT", "PSEUDO_GEOMETRY_UNKNOWN", "STACKING_CONTEXT", "PROTECTED_VERTICAL", "VERTICAL_NOT_NAME", "VERTICAL_GLYPHS_OVERLAP", "VERTICAL_GLYPHS_ORDER", "VERTICAL_TEXT_OVERFLOW"] as const;
export const ADVISORY_LAYER_CODES = ["PAINT_ORDER_COVER", "DISCLOSURE_NONCONTENT_OVERLAP", "FACT_NONCONTENT_OVERLAP", "GROUND_NOT_FLAT", "GROUND_UNMEASURED"] as const;

/** The codes of one layer scan (layers.ts LAYER_SCRIPT), blocking and advisory together. */
export function layerCodes(scan: LayerScan): string[] {
  const codes: string[] = [];
  // V1
  if (scan.roles.unknown > 0) codes.push("ROLE_UNKNOWN");
  if (scan.roles.mismatch > 0) codes.push("ROLE_MISMATCH");
  if (scan.roles.hasText.decoration > 0) codes.push("ROLE_DECORATION_HAS_TEXT");
  if (scan.roles.hasText.ground > 0) codes.push("ROLE_GROUND_HAS_TEXT");
  if (scan.roles.hasText.media > 0) codes.push("ROLE_MEDIA_HAS_TEXT");
  // pseudo-elements are decoration whose geometry needs its own proof (V1); phase A has none, and the allowlist refuses them
  if (scan.pseudo > 0) codes.push("PSEUDO_GEOMETRY_UNKNOWN");
  // V2: the DEV-082 allowlist admits no stacking context, so the model must find none on a page past it
  if (scan.stacking > 0) codes.push("STACKING_CONTEXT");
  if (scan.covers.count > 0) codes.push("PAINT_ORDER_COVER");
  // V4
  if (scan.nonContentOverlap.disclosure > 0) codes.push("DISCLOSURE_NONCONTENT_OVERLAP");
  if (scan.nonContentOverlap.fact > 0) codes.push("FACT_NONCONTENT_OVERLAP");
  // V9
  if (scan.protectedVertical > 0) codes.push("PROTECTED_VERTICAL");
  // DEV-102 vertical_name: the allowlist admits vertical writing only with the approved capability, so without it these
  // never fire; with it, only the bare shop name may be vertical, its glyphs apart, in reading order and inside its box
  if (scan.vertical.notName > 0) codes.push("VERTICAL_NOT_NAME");
  if (scan.vertical.overlap > 0) codes.push("VERTICAL_GLYPHS_OVERLAP");
  if (scan.vertical.disorder > 0) codes.push("VERTICAL_GLYPHS_ORDER");
  if (scan.vertical.overflow > 0) codes.push("VERTICAL_TEXT_OVERFLOW");
  return codes;
}

/** V3b numbers under the protected glyphs at one width (render.ts groundStructure, the picture with the text hidden). */
export type GroundStructure = { maxDev: number; lumStd: number; sobel: number };

/**
 * Protected text sits on a flat ground: inside every glyph box (expanded by 1 px) of the disclosure and the required
 * facts, every channel of the text-hidden picture within GROUND_FLAT_TOLERANCE of the box's median (GROUND_NOT_FLAT).
 * Busyness (luminance deviation, Sobel energy) is reported, never a gate here (its caps are for the human to approve).
 */
export const GROUND_FLAT_TOLERANCE = 6;

const blocking = (codes: readonly string[]) => codes.filter((c) => (BLOCKING_LAYER_CODES as readonly string[]).includes(c));
const advisory = (codes: readonly string[]) => codes.filter((c) => !(BLOCKING_LAYER_CODES as readonly string[]).includes(c));

/**
 * One checked width: the layer scan (V1, V2, V4, V9) and, when the pixel pass ran, the ground under protected glyphs
 * (V3b; `expected` is the number of protected nodes, so a pass that measured fewer is GROUND_UNMEASURED). Returns the
 * blocking check (run.ts `checks`) and the advisory one (run.ts `advisory`, never in `failed`).
 */
export function layersCheck(scan: LayerScan, ground?: ReadonlyMap<number, GroundStructure>, expected?: number): { check: CheckResult; advisory: CheckResult } {
  const codes = layerCodes(scan);
  const g = [...(ground?.values() ?? [])];
  const maxDev = Math.max(0, ...g.map((x) => x.maxDev));
  if (maxDev > GROUND_FLAT_TOLERANCE) codes.push("GROUND_NOT_FLAT");
  if (expected !== undefined && g.length < expected) codes.push("GROUND_UNMEASURED");
  const details = {
    roles: scan.roles.counts,
    declared_roles: scan.roles.declared,
    paint_events: scan.events,
    covers: scan.covers.list.slice(0, 8),
    stacking_contexts: scan.stacking,
    ground: { nodes: g.length, expected: expected ?? null, max_deviation: maxDev, max_luminance_std: Math.max(0, ...g.map((x) => x.lumStd)), max_sobel: Math.max(0, ...g.map((x) => x.sobel)) },
  };
  return { check: result(blocking(codes), details), advisory: result(advisory(codes), details) };
}

/** The coarse sweep (every 32 px) with the layer scan at each width; the failing widths are listed (blocking and advisory apart). */
export function layersSweepCheck(widths: ReadonlyArray<{ width: number; layers: LayerScan }>): { check: CheckResult; advisory: CheckResult } {
  const split = (pick: (c: readonly string[]) => string[]) => {
    const failing = widths.map((w) => ({ width: w.width, codes: pick(layerCodes(w.layers)) })).filter((w) => w.codes.length > 0);
    return result(
      failing.flatMap((w) => w.codes),
      { widths: widths.length, failing_widths: failing.map((w) => w.width) },
    );
  };
  return { check: split(blocking), advisory: split(advisory) };
}

// ---------------------------------------------------------------- V9 visibility matrix

/** Every fact shown at one checked width is shown at every checked width (a re-layout may move a fact, never drop it). */
export function visibilityMatrixCheck(passes: ReadonlyArray<{ width: number; measure: Measure }>): CheckResult {
  const shownAt = passes.map((p) => ({ width: p.width, shown: new Set(p.measure.nodes.filter((n) => n.kind === "fact" && !n.hidden).map((n) => n.text.replace(/\s+/g, ""))) }));
  const union = new Set(shownAt.flatMap((w) => [...w.shown]));
  const dropped = shownAt.filter((w) => [...union].some((t) => !w.shown.has(t))).map((w) => w.width);
  return result(dropped.length > 0 ? ["FACT_VISIBILITY_CHANGES"] : [], { widths: passes.length, facts_shown: union.size, dropped_at: dropped });
}

// ---------------------------------------------------------------- V7 capabilities

/**
 * The capabilities a page uses (V7). Phase A leaves the spec schema as it was — a `capabilities` key in layout-spec.json
 * is still refused (SPEC_SHAPE) — so the declared list is always empty here; the check exists so the report shows it.
 */
export function capabilitiesCheck(declared: readonly string[] = []): CheckResult {
  const refused = declared.filter((c) => !(APPROVED_CAPABILITIES as readonly string[]).includes(c));
  return result(refused.length > 0 ? ["CAPABILITY_NOT_APPROVED"] : [], { declared, approved: [...APPROVED_CAPABILITIES] });
}

// ---------------------------------------------------------------- V10 metric perturbation (harness; gates nothing in phase A)

/** A layout whose protected-text findings change when the metrics move a little (a wider face, ±0.05 em tracking). */
export function metricsCheck(base: GeometryPass, variants: Readonly<Record<string, GeometryPass>>): CheckResult {
  const baseBad = new Set(base.run.failing.map((f) => f.w));
  const fragile: Record<string, string> = {};
  for (const [name, v] of Object.entries(variants)) {
    const extra = v.run.failing.filter((f) => !baseBad.has(f.w)).map((f) => f.w);
    if (extra.length > 0) fragile[name] = widthRanges(extra);
  }
  return result(Object.keys(fragile).length > 0 ? ["METRICS_FRAGILE"] : [], { fragile, variants: Object.keys(variants) });
}

// ---------------------------------------------------------------- V3b pixel maths

export type Pixels = { width: number; height: number; channels: number; data: Uint8Array | Buffer };
type Box = { left: number; top: number; width: number; height: number };

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s[Math.floor(s.length / 2)]!;
};

/** Ground structure inside glyph boxes (each expanded by 1 px) of the picture with the text hidden. */
export function groundStructure(without: Pixels, chars: readonly Box[]): GroundStructure {
  let maxDev = 0;
  let lumStd = 0;
  let sobel = 0;
  const at = (x: number, y: number, c: number) => without.data[(y * without.width + x) * without.channels + c]!;
  const lum = (x: number, y: number) => 0.2126 * at(x, y, 0) + 0.7152 * at(x, y, 1) + 0.0722 * at(x, y, 2);
  for (const r of chars) {
    // the glyph box grown by 1 px on all four sides, then every pixel it touches (render-check's charBox convention)
    const g = { left: r.left - 1, top: r.top - 1, right: r.left + r.width + 1, bottom: r.top + r.height + 1 };
    const x0 = Math.max(0, Math.floor(g.left));
    const x1 = Math.min(without.width - 1, Math.ceil(g.right) - 1);
    const y0 = Math.max(0, Math.floor(g.top));
    const y1 = Math.min(without.height - 1, Math.ceil(g.bottom) - 1);
    if (x1 < x0 || y1 < y0) continue;
    const ch: number[][] = [[], [], []];
    const ls: number[] = [];
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        for (let c = 0; c < 3; c++) ch[c]!.push(at(x, y, c));
        ls.push(lum(x, y));
      }
    const med = ch.map(median);
    for (let c = 0; c < 3; c++) for (const v of ch[c]!) maxDev = Math.max(maxDev, Math.abs(v - med[c]!));
    const mean = ls.reduce((a, b) => a + b, 0) / ls.length;
    lumStd = Math.max(lumStd, Math.sqrt(ls.reduce((a, b) => a + (b - mean) ** 2, 0) / ls.length));
    let energy = 0;
    let n = 0;
    for (let y = Math.max(1, y0); y <= Math.min(without.height - 2, y1); y++)
      for (let x = Math.max(1, x0); x <= Math.min(without.width - 2, x1); x++) {
        const gx = lum(x + 1, y - 1) + 2 * lum(x + 1, y) + lum(x + 1, y + 1) - lum(x - 1, y - 1) - 2 * lum(x - 1, y) - lum(x - 1, y + 1);
        const gy = lum(x - 1, y + 1) + 2 * lum(x, y + 1) + lum(x + 1, y + 1) - lum(x - 1, y - 1) - 2 * lum(x, y - 1) - lum(x + 1, y - 1);
        energy += Math.hypot(gx, gy);
        n += 1;
      }
    if (n > 0) sobel = Math.max(sobel, energy / n);
  }
  return { maxDev, lumStd: Math.round(lumStd * 100) / 100, sobel: Math.round(sobel * 100) / 100 };
}

type Rgb = readonly [number, number, number];
const channel = (v: number) => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
/** WCAG relative luminance of an sRGB colour (0–255 channels). */
export const luminance = (c: Rgb) => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
export const contrastRatio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/**
 * The analytic scrim bound of V3b (§2): a scrim of colour S at alpha a over any ground g composites to a·S + (1 − a)·g,
 * monotonic per channel, so its luminance lies between the composites over black and over white. Contrast holds over
 * every ground only when both corners lie on the same side of the text's luminance and the nearer one gives ≥ 4.5:1;
 * a stroke under the scrim is attenuated to (1 − a)·255 per channel, which must be ≤ the flat tolerance.
 */
export function scrimBound(scrim: Rgb, a: number, text: Rgb, o: { minContrast?: number; tolerance?: number } = {}) {
  const minContrast = o.minContrast ?? 4.5;
  const tolerance = o.tolerance ?? GROUND_FLAT_TOLERANCE;
  const over = (g: number) => scrim.map((s) => a * s + (1 - a) * g) as unknown as Rgb;
  const l1 = luminance(over(0));
  const l2 = luminance(over(255));
  const lt = luminance(text);
  const sameSide = (l1 > lt && l2 > lt) || (l1 < lt && l2 < lt);
  const nearer = Math.abs(l1 - lt) < Math.abs(l2 - lt) ? l1 : l2;
  const contrast = contrastRatio(nearer, lt);
  const codes: string[] = [];
  if (!sameSide || contrast < minContrast) codes.push("SCRIM_CONTRAST");
  if ((1 - a) * 255 > tolerance) codes.push("SCRIM_STRUCTURE");
  return { ok: codes.length === 0, codes, lMin: Math.min(l1, l2), lMax: Math.max(l1, l2), sameSide, contrast: Math.round(contrast * 100) / 100 };
}

/** Provisional gradient rules of V3b (§2): adjacent stops ≥ 24 px and ≥ 10 % of the line apart; ≤ 2 levels per channel per px. */
export const GRADIENT_RULES = { minStopPx: 24, minStopShare: 0.1, maxSlope: 2 } as const;

/** The stop rule of V3b for one gradient line (stops in px along the line, sRGB colours). Codes only. */
export function gradientStopProblems(stops: ReadonlyArray<{ at: number; rgb: Rgb }>, lineLength: number): string[] {
  const p = new Set<string>();
  const sorted = [...stops].sort((a, b) => a.at - b.at);
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!;
    const b = sorted[i]!;
    const d = b.at - a.at;
    const change = Math.max(...[0, 1, 2].map((c) => Math.abs(b.rgb[c]! - a.rgb[c]!)));
    if (change === 0) continue;
    if (d < GRADIENT_RULES.minStopPx || d < lineLength * GRADIENT_RULES.minStopShare) p.add("GRADIENT_HARD_STOP");
    if (d <= 0 || change / d > GRADIENT_RULES.maxSlope) p.add("GRADIENT_TOO_STEEP");
  }
  return [...p].sort();
}
