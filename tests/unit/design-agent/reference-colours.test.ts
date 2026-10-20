import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildBriefPrompt, buildReviewPrompt } from "@/lib/design-agent/prompts";
import { observeColours, observedColoursLine } from "@/lib/design-agent/reference-colours";
import { AMERICAN_EDITORIAL, SHOP } from "./fixtures";

// DEV-069: colours measured in the (privacy-processed) reference PNGs. Only hex
// values and shares reach the prompts; neutral pixels and Instagram's own
// interface colours are left out.

type RGB = [number, number, number];

/** An RGBA PNG (filter 0) painted by `paint(x, y)`. */
function png(width: number, height: number, paint: (x: number, y: number) => RGB): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      const i = y * (width * 4 + 1) + 1 + x * 4;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = 255;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]); // CRC is not checked by decodePng
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const WHITE: RGB = [255, 255, 255];
const near = (hex: string, rgb: RGB) => Math.hypot(...[0, 1, 2].map((i) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) - rgb[i]!)) < 8;
const IG_BLUE: RGB = [0, 149, 246];
const CRUST: RGB = [160, 104, 60];
const BERRY: RGB = [140, 30, 60];

describe("observeColours", () => {
  it("an Instagram-like capture: the white ground, grey text and the blue button are left out; the posts' colours remain", () => {
    const capture = png(120, 120, (x, y) => {
      if (y < 30) return x < 20 ? IG_BLUE : x % 7 === 0 ? [38, 38, 38] : WHITE; // header: a blue button, grey text on white
      return x < 60 ? CRUST : y < 90 ? BERRY : [CRUST[0] + 6, CRUST[1] + 4, CRUST[2]]; // the grid: blurred posts
    });
    const o = observeColours([capture])!;
    // the two crust tones merge into one colour, the most common; the berry is second
    expect(o.colours).toHaveLength(2);
    expect(near(o.colours[0]!.hex, CRUST)).toBe(true);
    expect(o.colours[1]!.hex).toBe("#8C1E3C");
    expect(o.colours.every((c) => c.share >= 0.04)).toBe(true);
    expect(o.colours.some((c) => c.hex === "#0095F6")).toBe(false);
    expect(o.colourfulShare).toBeGreaterThan(0.6);
    expect(o.colourfulShare).toBeLessThan(0.8);
  });

  it("a neutral capture: no colours, a small colourful share", () => {
    const o = observeColours([png(60, 60, (x) => (x % 5 === 0 ? [20, 20, 20] : WHITE))])!;
    expect(o.colours).toEqual([]);
    expect(o.colourfulShare).toBe(0);
  });

  it("unreadable files are skipped; none readable → null", () => {
    expect(observeColours([Buffer.from("not a png")])).toBeNull();
    expect(observeColours([])).toBeNull();
    expect(observeColours([Buffer.alloc(0), png(30, 30, () => BERRY)])!.colours[0]!.hex).toBe("#8C1E3C");
  });

  it("at most five colours, most common first", () => {
    const palette: RGB[] = [
      [200, 40, 40],
      [40, 160, 60],
      [40, 60, 200],
      [220, 180, 40],
      [150, 60, 180],
      [30, 170, 170],
    ];
    const o = observeColours([png(120, 60, (x) => palette[Math.min(5, Math.floor(x / 20))]!)])!;
    expect(o.colours).toHaveLength(5);
    expect(o.colours.map((c) => c.share)).toEqual([...o.colours.map((c) => c.share)].sort((a, b) => b - a));
  });
});

describe("the prompt line", () => {
  const observed = { colours: [{ hex: "#A1693C", share: 0.62 }, { hex: "#8C1E3C", share: 0.3 }], colourfulShare: 0.71 };

  it("lists hex values and shares only, as measurements", () => {
    const line = observedColoursLine(observed);
    expect(line).toContain("#A1693C (62% of the colourful pixels), #8C1E3C (30% of the colourful pixels)");
    expect(line).toContain("Colourful pixels are 71% of the images.");
    expect(line).toContain("not as a palette to copy");
    expect(observedColoursLine({ colours: [], colourfulShare: 0.02 })).toContain("the material is neutral");
    expect(observedColoursLine(null)).toBe("");
  });

  it("the brief and the review carry it; without colours the prompts are unchanged", () => {
    const brief = (o?: typeof observed) => buildBriefPrompt({ demo: SHOP, referenceCount: 2, referenceKind: "instagram", currentDemoCount: 2, observedColours: o });
    const review = (o?: typeof observed) => buildReviewPrompt({ demo: SHOP, profile: AMERICAN_EDITORIAL, referenceCount: 2, referenceKind: "instagram", round: 0, maxRevisions: 2, observedColours: o });
    expect(brief(observed)).toContain(observedColoursLine(observed));
    expect(review(observed)).toContain(observedColoursLine(observed));
    expect(brief()).toBe(buildBriefPrompt({ demo: SHOP, referenceCount: 2, referenceKind: "instagram", currentDemoCount: 2 }));
    expect(brief()).not.toContain("Colours measured");
    expect(review()).not.toContain("Colours measured");
  });
});
