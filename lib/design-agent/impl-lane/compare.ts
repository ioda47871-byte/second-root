/**
 * Phase 2e (DEV-131, research-isolated): the implementation lane's comparison. Claude's implementation, rendered at
 * PC 1440 and SP 390, is compared with the design's own originals (the Artifact's viewport renders) at both widths:
 * the whole page (SSIM, colour blocks, edges, height) and every section of the design (mean / dominant colour ΔE, edge
 * density, share of the height), with the section boxes measured on both renders (data-section).
 *
 * The result is REPORT-ONLY: `passing` is always false. It also names the differences as cause codes
 * (e.g. SP_SECTION_MISSING_HERO, PC_SECTION_ORDER, PC_SECTION_COLOUR_STORY, SP_PAGE_HEIGHT), which is what the repair
 * loop (lib/design-agent/loop) takes as its compare port's answer. The loop sorts the codes and fixes the first one,
 * so the order here is only for reading; the codes themselves carry no priority. The thresholds that turn numbers into codes are
 * PROVISIONAL; a matching render is never a design approval, and the owner always compares the two pages.
 *
 * Pure: the PNG bytes and the boxes come from the caller; reuses the comp-impl similarity primitives (DEV-082/097).
 */
import { colourBlocks, compareCrops, cropStats, deltaE, edgesIou, gridOf, pixelRect, resample, rgbToLab, sectionGrid, ssim, GRID_WIDTH } from "../comp-impl/similarity";
import { decodePng, type Pixels } from "../worker/png-paint";

export type Viewport = "desktop_1440" | "mobile_390";
const PREFIX: Record<Viewport, string> = { desktop_1440: "PC", mobile_390: "SP" };
/** The render width each viewport must have (CSS px at device scale factor 1, as the boxes are). */
const WIDTHS: Record<Viewport, number> = { desktop_1440: 1440, mobile_390: 390 };

export type Box = { x: number; y: number; w: number; h: number };
export type RenderSide = { png: Buffer; sections: { id: string; box: Box | null }[] };

export type SectionDiff = {
  id: string;
  /**
   * SECTION_MISSING: shown in the design, not shown in the implementation; SECTION_EXTRA: hidden in the design at this
   * width, shown in the implementation; SECTION_NOT_VISIBLE: its box lies outside the captured page;
   * DESIGN_BOX_UNKNOWN: the design's box lies outside the design image. A section hidden at this width in both
   * (a box that is null or has no width or height) is not a difference (artifact schema: a legitimate design choice).
   */
  code: "SECTION_MISSING" | "SECTION_EXTRA" | "SECTION_NOT_VISIBLE" | "DESIGN_BOX_UNKNOWN" | null;
  /** The section's top as a share of the page height in the implementation minus in the design. */
  top_share_delta: number | null;
  /** Share of grid cells whose colour changed visibly (CIE76 ΔE above 10): local colour, which a mean over the section hides. */
  changed_cells: number | null;
  mean_delta_e: number | null;
  dominant_delta_e: number | null;
  edges_delta: number | null;
  /** The section's share of the page height in the implementation minus in the design. */
  height_share_delta: number | null;
};

export type ViewportCompare = {
  viewport: Viewport;
  page: { ssim: number; colour_blocks: number; edges_iou: number; height_ratio: number } | null;
  sections: SectionDiff[];
  /** The design's sections in the order the implementation shows them (top to bottom), when it differs from the design's. */
  order_changed: boolean;
  code: "DECODE_FAILED" | "WIDTH_MISMATCH" | "DUPLICATE_SECTION_ID" | null;
};

export type RenderComparison = {
  viewports: ViewportCompare[];
  /** Cause codes for the repair loop, largest first in a fixed order; empty when nothing crosses a threshold. */
  differences: string[];
  /** Never true: numbers never accept an implementation. */
  passing: false;
};

/** PROVISIONAL thresholds (Issue #159: offline; to be fixed with the owner's look at real pairs). */
export const THRESHOLDS = { pageSsim: 0.8, sectionTopShare: 0.06, pageHeightRatio: 0.12, sectionChangedCells: 0.05, sectionMeanDeltaE: 12, sectionDominantDeltaE: 15, sectionEdgesDelta: 0.08, sectionHeightShare: 0.05 } as const;

const r3 = (n: number) => Math.round(n * 1000) / 1000;
/** A section id as part of a cause code (the loop accepts A-Z, 0-9 and _ only). */
const codePart = (id: string) => id.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30) || "SECTION";
/** Code parts for all section ids, all distinct: an id whose part is taken gets the first free _2, _3 ... (never merged). */
function codeParts(ids: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const id of ids) {
    const base = codePart(id);
    let part = base;
    for (let n = 2; taken.has(part); n++) part = `${base}_${n}`;
    taken.add(part);
    out.set(id, part);
  }
  return out;
}

const shown = (b: Box | null | undefined): b is Box => !!b && b.w > 0 && b.h > 0;
const dupIds = (side: RenderSide) => new Set(side.sections.map((s) => s.id)).size !== side.sections.length;

/** The share of cells (same grid) whose colours differ by more than ΔE 10. */
function changedCells(a: { rgb: Float64Array }, b: { rgb: Float64Array }): number {
  const n = Math.min(a.rgb.length, b.rgb.length) / 3;
  let changed = 0;
  for (let k = 0; k < n; k++) {
    const ca: [number, number, number] = [a.rgb[k * 3]!, a.rgb[k * 3 + 1]!, a.rgb[k * 3 + 2]!];
    const cb: [number, number, number] = [b.rgb[k * 3]!, b.rgb[k * 3 + 1]!, b.rgb[k * 3 + 2]!];
    if (deltaE(rgbToLab(ca), rgbToLab(cb)) > 10) changed++;
  }
  return n ? changed / n : 0;
}

function compareViewport(viewport: Viewport, design: RenderSide, impl: RenderSide): ViewportCompare {
  let d: Pixels;
  let i: Pixels;
  try {
    d = decodePng(design.png);
    i = decodePng(impl.png);
  } catch {
    return { viewport, page: null, sections: [], order_changed: false, code: "DECODE_FAILED" };
  }
  if (d.width !== WIDTHS[viewport] || i.width !== WIDTHS[viewport]) return { viewport, page: null, sections: [], order_changed: false, code: "WIDTH_MISMATCH" };
  // one id names one section: with duplicates a section could hide behind its twin
  if (dupIds(design) || dupIds(impl)) return { viewport, page: null, sections: [], order_changed: false, code: "DUPLICATE_SECTION_ID" };
  // the whole page, on a grid of the design's aspect (the implementation stretched to it; the height ratio says how much)
  const gh = Math.max(8, Math.round((GRID_WIDTH * d.height) / d.width));
  const gd = resample(design.png, GRID_WIDTH, gh);
  const gi = resample(impl.png, GRID_WIDTH, gh);
  const page = { ssim: r3(ssim(gd, gi)), colour_blocks: r3(colourBlocks(gd, gi)), edges_iou: r3(edgesIou(gd, gi)), height_ratio: r3(i.height / d.height) };
  const sections = design.sections.map((s): SectionDiff => {
    const empty = { id: s.id, top_share_delta: null, changed_cells: null, mean_delta_e: null, dominant_delta_e: null, edges_delta: null, height_share_delta: null };
    const got = impl.sections.find((x) => x.id === s.id)?.box ?? null;
    // hidden at this width in the design: a difference only if the implementation shows it
    if (!shown(s.box)) return { ...empty, code: shown(got) ? "SECTION_EXTRA" : null };
    if (!shown(got)) return { ...empty, code: "SECTION_MISSING" };
    const cd = pixelRect(d, s.box.x, s.box.y, s.box.w, s.box.h);
    const ci = pixelRect(i, got.x, got.y, got.w, got.h);
    if (!cd) return { ...empty, code: "DESIGN_BOX_UNKNOWN" };
    if (!ci) return { ...empty, code: "SECTION_NOT_VISIBLE" };
    const { colour, edges } = compareCrops(cropStats(sectionGrid(d, cd)), cropStats(sectionGrid(i, ci)));
    // both crops on the design crop's grid, so a local change of colour shows even when the means stay close
    const sg = sectionGrid(d, cd);
    const changed = changedCells(sg, gridOf(i, ci, sg.w, sg.h));
    return { id: s.id, code: null, top_share_delta: r3(ci.top / i.height - cd.top / d.height), changed_cells: r3(changed), mean_delta_e: colour.mean_delta_e, dominant_delta_e: colour.dominant_delta_e, edges_delta: edges.delta, height_share_delta: r3(ci.height / i.height - cd.height / d.height) };
  });
  // the order the implementation shows the design's sections in, top to bottom (only those shown on both)
  const both = design.sections.filter((s) => shown(s.box) && shown(impl.sections.find((x) => x.id === s.id)?.box));
  const designOrder = [...both].sort((a, b) => a.box!.y - b.box!.y).map((s) => s.id);
  const implOrder = [...both].sort((a, b) => impl.sections.find((x) => x.id === a.id)!.box!.y - impl.sections.find((x) => x.id === b.id)!.box!.y).map((s) => s.id);
  return { viewport, page, sections, order_changed: designOrder.join("\n") !== implOrder.join("\n"), code: null };
}

/** Compares the implementation with the design at both widths; `differences` feeds the repair loop. */
export function compareRenders(pair: Record<Viewport, { design: RenderSide; impl: RenderSide }>): RenderComparison {
  const viewports = (["desktop_1440", "mobile_390"] as const).map((v) => compareViewport(v, pair[v].design, pair[v].impl));
  const differences: string[] = [];
  for (const vc of viewports) {
    const p = PREFIX[vc.viewport];
    if (vc.code) {
      differences.push(`${p}_${vc.code}`);
      continue;
    }
    const part = codeParts(vc.sections.map((s) => s.id));
    // what is missing or not visible, the order, the page as a whole, then each section's place, colour, density and size
    for (const s of vc.sections) if (s.code) differences.push(`${p}_${s.code}_${part.get(s.id)}`);
    if (vc.order_changed) differences.push(`${p}_SECTION_ORDER`);
    if (vc.page && Math.abs(vc.page.height_ratio - 1) > THRESHOLDS.pageHeightRatio) differences.push(`${p}_PAGE_HEIGHT`);
    if (vc.page && vc.page.ssim < THRESHOLDS.pageSsim) differences.push(`${p}_PAGE_LAYOUT`);
    for (const s of vc.sections) {
      if (s.code || s.mean_delta_e === null) continue;
      if (!vc.order_changed && Math.abs(s.top_share_delta ?? 0) > THRESHOLDS.sectionTopShare) differences.push(`${p}_SECTION_POSITION_${part.get(s.id)}`);
      if ((s.changed_cells ?? 0) > THRESHOLDS.sectionChangedCells || (s.mean_delta_e ?? 0) > THRESHOLDS.sectionMeanDeltaE || (s.dominant_delta_e ?? 0) > THRESHOLDS.sectionDominantDeltaE) differences.push(`${p}_SECTION_COLOUR_${part.get(s.id)}`);
      if (Math.abs(s.edges_delta ?? 0) > THRESHOLDS.sectionEdgesDelta) differences.push(`${p}_SECTION_DENSITY_${part.get(s.id)}`);
      if (Math.abs(s.height_share_delta ?? 0) > THRESHOLDS.sectionHeightShare) differences.push(`${p}_SECTION_SIZE_${part.get(s.id)}`);
    }
  }
  return { viewports, differences: [...new Set(differences)], passing: false };
}

