/**
 * Phase 2e (DEV-131, research-isolated): the implementation lane's comparison. Claude's implementation, rendered at
 * PC 1440 and SP 390, is compared with the design's own originals (the Artifact's viewport renders) at both widths:
 * the whole page (SSIM, colour blocks, edges, height) and every section of the design (mean / dominant colour ΔE, edge
 * density, share of the height), with the section boxes measured on both renders (data-section).
 *
 * The result is REPORT-ONLY: `passing` is always false. It also names the largest differences as cause codes
 * (e.g. SP_SECTION_MISSING_HERO, PC_SECTION_COLOUR_STORY, SP_PAGE_HEIGHT) in a fixed order, which is what the repair
 * loop (lib/design-agent/loop) takes as its compare port's answer. The thresholds that turn numbers into codes are
 * PROVISIONAL; a matching render is never a design approval, and the owner always compares the two pages.
 *
 * Pure: the PNG bytes and the boxes come from the caller; reuses the comp-impl similarity primitives (DEV-082/097).
 */
import { colourBlocks, compareCrops, cropStats, deltaE, edgesIou, gridOf, pixelRect, resample, rgbToLab, sectionGrid, ssim, GRID_WIDTH } from "../comp-impl/similarity";
import { decodePng, type Pixels } from "../worker/png-paint";

export type Viewport = "desktop_1440" | "mobile_390";
const PREFIX: Record<Viewport, string> = { desktop_1440: "PC", mobile_390: "SP" };

export type Box = { x: number; y: number; w: number; h: number };
export type RenderSide = { png: Buffer; sections: { id: string; box: Box | null }[] };

export type SectionDiff = {
  id: string;
  code: "SECTION_MISSING" | "SECTION_CROP_EMPTY" | null;
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
  code: "DECODE_FAILED" | "WIDTH_MISMATCH" | null;
};

export type RenderComparison = {
  viewports: ViewportCompare[];
  /** Cause codes for the repair loop, largest first in a fixed order; empty when nothing crosses a threshold. */
  differences: string[];
  /** Never true: numbers never accept an implementation. */
  passing: false;
};

/** PROVISIONAL thresholds (Issue #159: offline; to be fixed with the owner's look at real pairs). */
export const THRESHOLDS = { pageHeightRatio: 0.12, sectionChangedCells: 0.05, sectionMeanDeltaE: 12, sectionDominantDeltaE: 15, sectionEdgesDelta: 0.08, sectionHeightShare: 0.05 } as const;

const r3 = (n: number) => Math.round(n * 1000) / 1000;
/** A section id as part of a cause code (the loop accepts A-Z, 0-9 and _ only). */
const codePart = (id: string) => id.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30) || "SECTION";

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
    return { viewport, page: null, sections: [], code: "DECODE_FAILED" };
  }
  if (d.width !== i.width) return { viewport, page: null, sections: [], code: "WIDTH_MISMATCH" };
  // the whole page, on a grid of the design's aspect (the implementation stretched to it; the height ratio says how much)
  const gh = Math.max(8, Math.round((GRID_WIDTH * d.height) / d.width));
  const gd = resample(design.png, GRID_WIDTH, gh);
  const gi = resample(impl.png, GRID_WIDTH, gh);
  const page = { ssim: r3(ssim(gd, gi)), colour_blocks: r3(colourBlocks(gd, gi)), edges_iou: r3(edgesIou(gd, gi)), height_ratio: r3(i.height / d.height) };
  const sections = design.sections.map((s): SectionDiff => {
    const empty = { id: s.id, changed_cells: null, mean_delta_e: null, dominant_delta_e: null, edges_delta: null, height_share_delta: null };
    const got = impl.sections.find((x) => x.id === s.id)?.box ?? null;
    if (!s.box) return { ...empty, code: "SECTION_CROP_EMPTY" };
    if (!got || got.w <= 0 || got.h <= 0) return { ...empty, code: "SECTION_MISSING" };
    const cd = pixelRect(d, s.box.x, s.box.y, s.box.w, s.box.h);
    const ci = pixelRect(i, got.x, got.y, got.w, got.h);
    if (!cd || !ci) return { ...empty, code: "SECTION_CROP_EMPTY" };
    const { colour, edges } = compareCrops(cropStats(sectionGrid(d, cd)), cropStats(sectionGrid(i, ci)));
    // both crops on the design crop's grid, so a local change of colour shows even when the means stay close
    const sg = sectionGrid(d, cd);
    const changed = changedCells(sg, gridOf(i, ci, sg.w, sg.h));
    return { id: s.id, code: null, changed_cells: r3(changed), mean_delta_e: colour.mean_delta_e, dominant_delta_e: colour.dominant_delta_e, edges_delta: edges.delta, height_share_delta: r3(ci.height / i.height - cd.height / d.height) };
  });
  return { viewport, page, sections, code: null };
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
    // fixed order: what is missing, then the page height, then each section's colour, layout density and size
    for (const s of vc.sections) if (s.code === "SECTION_MISSING") differences.push(`${p}_SECTION_MISSING_${codePart(s.id)}`);
    if (vc.page && Math.abs(vc.page.height_ratio - 1) > THRESHOLDS.pageHeightRatio) differences.push(`${p}_PAGE_HEIGHT`);
    for (const s of vc.sections) {
      if (s.code) continue;
      if ((s.changed_cells ?? 0) > THRESHOLDS.sectionChangedCells || (s.mean_delta_e ?? 0) > THRESHOLDS.sectionMeanDeltaE || (s.dominant_delta_e ?? 0) > THRESHOLDS.sectionDominantDeltaE) differences.push(`${p}_SECTION_COLOUR_${codePart(s.id)}`);
      if (Math.abs(s.edges_delta ?? 0) > THRESHOLDS.sectionEdgesDelta) differences.push(`${p}_SECTION_DENSITY_${codePart(s.id)}`);
      if (Math.abs(s.height_share_delta ?? 0) > THRESHOLDS.sectionHeightShare) differences.push(`${p}_SECTION_SIZE_${codePart(s.id)}`);
    }
  }
  return { viewports, differences: [...new Set(differences)], passing: false };
}

