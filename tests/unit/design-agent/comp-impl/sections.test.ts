import { describe, expect, it } from "vitest";
import type { CompMeasure } from "@/lib/design-agent/comp-impl/page-scripts";
import type { CompSpec } from "@/lib/design-agent/comp-impl/spec";
import { guardedSectionComparison } from "@/lib/design-agent/comp-impl/run";
import { compareCrops, cropStats, deltaE, dominantColour, edgeDensity, gridOf, resample, rgbToLab, sectionComparison, sectionGrid } from "@/lib/design-agent/comp-impl/similarity";
import { decodePng } from "@/lib/design-agent/worker/png-paint";
import { flatPng, paintedPng } from "./support";

// DEV-097: the per-section comparison is report-only. These tests pin what each number means on small built images.

type Rgb = [number, number, number];
const KINARI: Rgb = [244, 238, 227];
const SUMI: Rgb = [31, 29, 27];
const VERMILION: Rgb = [180, 71, 46];

/** Horizontal bands 8 px tall in two colours (4 grid rows each at 2 px per cell): marks a Sobel edge map sees. */
const bandsOf = (w: number, h: number, a: Rgb, b: Rgb) => paintedPng(w, h, (_x, y) => (Math.floor(y / 8) % 2 === 0 ? a : b));

const statsOf = (png: Buffer) => {
  const p = decodePng(png);
  return cropStats(sectionGrid(p, { left: 0, top: 0, width: p.width, height: p.height }));
};

const spec = (sections: Array<[string, number, number]>): CompSpec["sections"] => sections.map(([id, y, h]) => ({ id, role: "other", box: { x: 0, y, w: 1, h } }));
const measured = (width: number, height: number, sections: Array<[string, number, number, boolean?]>): Pick<CompMeasure, "sections" | "width" | "height"> => ({
  width,
  height,
  sections: sections.map(([id, top, h, shown]) => ({ id, shown: shown ?? true, box: { left: 0, top, width, height: h }, paddingTop: 0, paddingBottom: 0 })),
});

describe("colour metrics", () => {
  it("CIELAB: white is L* 100, black is L* 0, and a colour is at distance 0 from itself", () => {
    const white = rgbToLab([255, 255, 255]);
    expect(white[0]).toBeCloseTo(100, 1);
    expect(Math.abs(white[1])).toBeLessThan(0.01);
    expect(Math.abs(white[2])).toBeLessThan(0.01);
    expect(rgbToLab([0, 0, 0])[0]).toBeCloseTo(0, 5);
    expect(deltaE(rgbToLab(VERMILION), rgbToLab(VERMILION))).toBe(0);
    expect(deltaE(rgbToLab(KINARI), rgbToLab(SUMI))).toBeGreaterThan(80);
  });
});

describe("dominant colour", () => {
  const gridOfPng = (png: Buffer) => {
    const p = decodePng(png);
    return sectionGrid(p, { left: 0, top: 0, width: p.width, height: p.height });
  };
  const RED: Rgb = [200, 0, 0];
  const BLUE: Rgb = [0, 0, 200];

  it("a 70 / 30 grid: the 70 % colour, with its share", () => {
    const d = dominantColour(gridOfPng(paintedPng(10, 10, (x) => (x < 7 ? RED : BLUE))));
    expect(d.rgb).toEqual(RED);
    expect(d.share).toBeCloseTo(0.7, 10);
  });

  it("a tie goes to the lower bin key (blue, key 0x00c, before red, key 0xc00), whichever comes first", () => {
    for (const first of [RED, BLUE]) {
      const second = first === RED ? BLUE : RED;
      const d = dominantColour(gridOfPng(paintedPng(10, 10, (x) => (x < 5 ? first : second))));
      expect(d.rgb).toEqual(BLUE);
      expect(d.share).toBeCloseTo(0.5, 10);
    }
  });
});

describe("crop comparison", () => {
  it("identical crops give zero distance on every metric", () => {
    const png = bandsOf(256, 128, KINARI, SUMI);
    const r = compareCrops(statsOf(png), statsOf(png));
    expect(r.colour).toMatchObject({ mean_delta_e: 0, lightness_delta: 0, dominant_delta_e: 0 });
    expect(r.colour.comp_mean).toBe(r.colour.page_mean);
    expect(r.edges.delta).toBe(0);
    expect(r.edges.comp_density).toBeGreaterThan(0.3);
  });

  it("a colour change moves only the colour metrics (flat and striped)", () => {
    const flat = compareCrops(statsOf(flatPng(256, 128, KINARI)), statsOf(flatPng(256, 128, VERMILION)));
    expect(flat.colour.mean_delta_e).toBeGreaterThan(30);
    expect(flat.colour.dominant_delta_e).toBe(flat.colour.mean_delta_e);
    expect(flat.colour.lightness_delta).toBeLessThan(0); // vermilion is darker than kinari
    expect(flat.edges).toEqual({ comp_density: 0, page_density: 0, delta: 0 });
    const striped = compareCrops(statsOf(bandsOf(256, 128, KINARI, SUMI)), statsOf(bandsOf(256, 128, [255, 255, 255], [0, 0, 64])));
    expect(striped.colour.mean_delta_e).toBeGreaterThan(2.3);
    expect(striped.edges.delta).toBe(0);
  });

  it("added marks move the edge density, not the mean colour", () => {
    const grey = compareCrops(statsOf(flatPng(256, 128, [128, 128, 128])), statsOf(bandsOf(256, 128, [200, 200, 200], [56, 56, 56])));
    expect(grey.colour.comp_mean).toBe(grey.colour.page_mean);
    expect(grey.colour.mean_delta_e).toBe(0);
    expect(grey.edges.comp_density).toBe(0);
    expect(grey.edges.delta).toBeGreaterThan(0.3);
  });

  it("edge density reads the same marks at the comp's half scale and the page's full scale", () => {
    const paint = (s: number) => (x: number, y: number): Rgb => (Math.floor(x / (16 * s)) % 2 === Math.floor(y / (16 * s)) % 2 ? KINARI : SUMI);
    const half = statsOf(paintedPng(256, 128, paint(1)));
    const full = statsOf(paintedPng(512, 256, paint(2)));
    expect(Math.abs(half.edges - full.edges)).toBeLessThan(0.01);
    expect(edgeDensity(sectionGrid(decodePng(flatPng(2, 2, KINARI)), { left: 0, top: 0, width: 2, height: 2 }))).toBe(0);
  });

  it("the crop grid on the whole image is the whole-page resample (the DEV-082 numbers are unchanged)", () => {
    const png = paintedPng(97, 61, (x, y) => [(x * 7) % 256, (y * 11) % 256, (x * y) % 256]);
    const p = decodePng(png);
    expect(gridOf(p, { left: 0, top: 0, width: p.width, height: p.height }, 24, 16)).toEqual(resample(png, 24, 16));
  });
});

describe("sectionComparison", () => {
  // a comp of two bands (top third kinari, the rest vermilion) at 200 px wide; the page at 400 px, the same bands
  const bands = (w: number, h: number, split: number) => paintedPng(w, h, (_x, y) => (y < split ? KINARI : VERMILION));
  const sections = spec([["top", 0, 1 / 3], ["rest", 1 / 3, 2 / 3]]);

  it("matches each spec box with its rendered section; a faithful page reads zero distances and ratios of 1", () => {
    const r = sectionComparison(bands(200, 300, 100), bands(400, 600, 200), sections, measured(400, 600, [["top", 0, 200], ["rest", 200, 400]]));
    expect(r).toMatchObject({ viewport: "desktop_1440", mobile: "not_compared_no_mobile_comp", passing: false, code: null });
    expect(r.items.map((i) => i.id)).toEqual(["top", "rest"]);
    for (const item of r.items) {
      expect(item.code).toBeNull();
      expect(item.colour).toMatchObject({ mean_delta_e: 0, dominant_delta_e: 0 });
      expect(item.edges?.delta).toBe(0);
      expect(item.height_share?.ratio).toBe(1);
      expect(item.aspect_h_per_w?.ratio).toBe(1);
    }
    expect(r.items[0]!.comp_box_px).toEqual([0, 0, 200, 100]);
    expect(r.items[1]!.page_box_css_px).toEqual([0, 200, 400, 400]);
  });

  it("a taller section moves its height share and aspect; a recoloured one moves only its colour", () => {
    // the page's top band is twice as tall, and its rest is sumi instead of vermilion
    const shot = paintedPng(400, 800, (_x, y) => (y < 400 ? KINARI : SUMI));
    const r = sectionComparison(bands(200, 300, 100), shot, sections, measured(400, 800, [["top", 0, 400], ["rest", 400, 400]]));
    const [top, rest] = r.items;
    expect(top!.colour?.mean_delta_e).toBe(0);
    expect(top!.height_share).toMatchObject({ comp: 0.333, page: 0.5, ratio: 1.5 });
    expect(top!.aspect_h_per_w).toMatchObject({ comp: 0.5, page: 1, ratio: 2 });
    expect(rest!.colour?.mean_delta_e).toBeGreaterThan(20);
    expect(rest!.colour?.lightness_delta).toBeLessThan(0);
    expect(rest!.edges?.delta).toBe(0);
    expect(r.passing).toBe(false);
  });

  it("reads the page box in CSS px when the screenshot is at 2× (shot width = 2 × the CSS width)", () => {
    const r = sectionComparison(bands(200, 300, 100), bands(800, 1200, 400), sections, measured(400, 600, [["top", 0, 200], ["rest", 200, 400]]));
    expect(r.items.map((i) => i.page_box_css_px)).toEqual([[0, 0, 400, 200], [0, 200, 400, 400]]);
    for (const item of r.items) {
      expect(item.colour).toMatchObject({ mean_delta_e: 0, dominant_delta_e: 0 });
      expect(item.height_share?.ratio).toBe(1);
      expect(item.aspect_h_per_w?.ratio).toBe(1);
    }
  });

  it("the page box is the crop compared: a box past the screenshot's bottom is clamped, and so are its share and aspect", () => {
    // "rest" is measured 400 px tall from 200, but the screenshot ends at 500
    const r = sectionComparison(bands(200, 300, 100), bands(400, 500, 200), sections, measured(400, 600, [["top", 0, 200], ["rest", 200, 400]]));
    const rest = r.items[1]!;
    expect(rest.page_box_css_px).toEqual([0, 200, 400, 300]);
    expect(rest.height_share).toMatchObject({ page: 0.5 });
    expect(rest.aspect_h_per_w).toMatchObject({ page: 0.75 });
  });

  it("the guarded call reports any error as SECTION_COMPARE_ERROR instead of throwing", () => {
    const r = guardedSectionComparison(bands(200, 300, 100), bands(400, 600, 200), null as unknown as CompSpec["sections"], measured(400, 600, []));
    expect(r).toMatchObject({ code: "SECTION_COMPARE_ERROR", items: [], passing: false, viewport: "desktop_1440" });
  });

  it("reports a section that is missing or hidden, and an undecodable image, with a code (never a failure)", () => {
    const r = sectionComparison(bands(200, 300, 100), bands(400, 600, 200), sections, measured(400, 600, [["top", 0, 200, false]]));
    expect(r.items.map((i) => i.code)).toEqual(["SECTION_NOT_RENDERED", "SECTION_NOT_RENDERED"]);
    expect(r.items[0]).toMatchObject({ colour: null, edges: null, height_share: null });
    const empty = sectionComparison(bands(200, 300, 100), bands(400, 600, 200), sections, measured(400, 600, [["top", 900, 200], ["rest", 200, 400]]));
    expect(empty.items.map((i) => i.code)).toEqual(["SECTION_CROP_EMPTY", null]);
    const bad = sectionComparison(Buffer.from("not a png"), bands(400, 600, 200), sections, measured(400, 600, []));
    expect(bad).toMatchObject({ code: "SIMILARITY_DECODE_UNSUPPORTED", items: [], passing: false });
  });
});
