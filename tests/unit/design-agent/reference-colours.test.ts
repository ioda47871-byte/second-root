import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildPhotoReviewPrompt } from "@/lib/design-agent/photo-prompts";
import { buildBriefPrompt, buildReviewPrompt } from "@/lib/design-agent/prompts";
import { observeColours, observedColoursLine, type ObservedColours } from "@/lib/design-agent/reference-colours";
import { AMERICAN_EDITORIAL, SHOP } from "./fixtures";

// DEV-069: colours measured in the (privacy-processed) reference PNGs. Only hex
// values and shares reach the prompts; neutral and near-neutral pixels are
// counted apart; on Instagram captures, Instagram's own blue is left out.

type RGB = [number, number, number];

/** A PNG painted by `paint(x, y)`: RGBA (colour type 6) by default, or RGB (2); other header fields for the format tests. */
function png(width: number, height: number, paint: (x: number, y: number) => RGB, opts: { channels?: 3 | 4; colourType?: number; depth?: number; interlace?: number } = {}): Buffer {
  const channels = opts.channels ?? 4;
  const raw = Buffer.alloc((width * channels + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * channels + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      const i = y * (width * channels + 1) + 1 + x * channels;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      if (channels === 4) raw[i + 3] = 255;
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
  ihdr[8] = opts.depth ?? 8;
  ihdr[9] = opts.colourType ?? (channels === 4 ? 6 : 2);
  ihdr[12] = opts.interlace ?? 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const WHITE: RGB = [255, 255, 255];
const IG_BLUE: RGB = [0, 149, 246];
const CRUST: RGB = [160, 104, 60];
const BERRY: RGB = [140, 30, 60];
const CUSTARD: RGB = [248, 214, 125];
const ORANGE: RGB = [245, 120, 35];
const near = (hex: string, rgb: RGB) => Math.hypot(...[0, 1, 2].map((i) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) - rgb[i]!)) < 8;

describe("observeColours", () => {
  it("an Instagram-like capture: the white ground, grey text and the blue button are left out; the posts' colours remain", () => {
    const capture = png(120, 120, (x, y) => {
      if (y < 30) return x < 20 ? IG_BLUE : x % 7 === 0 ? [38, 38, 38] : WHITE; // header: a blue button, grey text on white
      return x < 60 ? CRUST : y < 90 ? BERRY : [CRUST[0] + 6, CRUST[1] + 4, CRUST[2]]; // the grid: blurred posts
    });
    const o = observeColours([capture], "instagram")!;
    // the two crust tones merge into one colour, the most common; the berry is second
    expect(o.colours).toHaveLength(2);
    expect(near(o.colours[0]!.hex, CRUST)).toBe(true);
    expect(o.colours[1]!.hex).toBe("#8C1E3C");
    expect(o.colours.every((c) => c.share >= 0.04)).toBe(true);
    expect(o.colours.some((c) => c.hex === "#0095F6")).toBe(false);
    expect(o.colourfulShare).toBeGreaterThan(0.6);
    expect(o.lightNeutralShare).toBeGreaterThan(0.1);
    expect(o.darkNeutralShare).toBeGreaterThan(0);
  });

  it("a custard-yellow Instagram post is a colour of the shop (the story-ring colours are not left out)", () => {
    const o = observeColours([png(60, 60, (x) => (x < 40 ? CUSTARD : WHITE))], "instagram")!;
    expect(near(o.colours[0]!.hex, CUSTARD)).toBe(true);
  });

  it("a website: nothing but neutrals is left out (an orange header on white keeps its orange, even a blue one)", () => {
    const site = png(90, 60, (x, y) => (y < 15 ? ORANGE : y < 20 && x < 30 ? IG_BLUE : WHITE));
    const o = observeColours([site], "website")!;
    expect(near(o.colours[0]!.hex, ORANGE)).toBe(true);
    expect(o.colours.some((c) => near(c.hex, IG_BLUE))).toBe(true);
    expect(o.lightNeutralShare).toBeGreaterThan(0.6);
    // the same image as an Instagram capture loses the blue only
    const ig = observeColours([site], "instagram")!;
    expect(ig.colours.some((c) => near(c.hex, IG_BLUE))).toBe(false);
    expect(near(ig.colours[0]!.hex, ORANGE)).toBe(true);
  });

  it("a neutral capture: no colours, a small colourful share; light and dark neutrals counted", () => {
    const o = observeColours([png(60, 60, (x) => (x % 5 === 0 ? [20, 20, 20] : WHITE))])!;
    expect(o.colours).toEqual([]);
    expect(o.colourfulShare).toBe(0);
    expect(o.lightNeutralShare + o.darkNeutralShare).toBe(1);
    expect(o.darkNeutralShare).toBeGreaterThan(0.1);
  });

  it("many colours, none above 4%: an empty list with a high colourful share", () => {
    // 64 colours on a 4×4×4 grid, 60 apart (more than the merge distance), each a small part
    const level = [30, 90, 150, 210];
    const grid = (i: number): RGB => [level[i % 4]!, level[Math.floor(i / 4) % 4]!, level[Math.floor(i / 16) % 4]!];
    const o = observeColours([png(192, 30, (x) => grid(Math.floor(x / 3)))])!;
    expect(o.colours).toEqual([]);
    expect(o.colourfulShare).toBeGreaterThan(0.5);
  });

  it("an RGB (3-channel) PNG is read like RGBA", () => {
    expect(observeColours([png(30, 30, () => BERRY, { channels: 3 })])!.colours[0]!.hex).toBe("#8C1E3C");
  });

  it("unreadable files and unsupported formats (palette, 16-bit, interlaced) are skipped; none readable → null", () => {
    expect(observeColours([Buffer.from("not a png")])).toBeNull();
    expect(observeColours([])).toBeNull();
    expect(observeColours([png(10, 10, () => BERRY, { colourType: 3 })])).toBeNull();
    expect(observeColours([png(10, 10, () => BERRY, { depth: 16 })])).toBeNull();
    expect(observeColours([png(10, 10, () => BERRY, { interlace: 1 })])).toBeNull();
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
  const observed: ObservedColours = { colours: [{ hex: "#A1693C", share: 0.62 }, { hex: "#8C1E3C", share: 0.3 }], colourfulShare: 0.71, lightNeutralShare: 0.2, darkNeutralShare: 0.09 };

  it("lists hex values and shares only, as measurements; the neutral shares; per reference kind", () => {
    const line = observedColoursLine(observed, "instagram");
    expect(line).toContain("#A1693C (62% of the colourful pixels), #8C1E3C (30% of the colourful pixels)");
    expect(line).toContain("Colourful pixels are 71% of the images.");
    expect(line).toContain("Neutral or near-neutral pixels (white, cream, grey, dark brown, black): 20% light, 9% dark.");
    expect(line).toContain("Instagram's own interface blue is left out.");
    expect(line).toContain("not as a palette to copy");
    expect(observedColoursLine(observed, "website")).not.toContain("Instagram");
    expect(observedColoursLine(null)).toBe("");
  });

  it("an empty list: neutral only when the colourful share is small; otherwise many colours, none above 4%", () => {
    const neutral = observedColoursLine({ colours: [], colourfulShare: 0.02, lightNeutralShare: 0.9, darkNeutralShare: 0.08 });
    expect(neutral).toContain("almost no colourful pixels (2%): the material is neutral.");
    const varied = observedColoursLine({ colours: [], colourfulShare: 0.98, lightNeutralShare: 0.01, darkNeutralShare: 0.01 });
    expect(varied).toContain("colourful pixels are 98% of the images, spread over many colours with none above 4% of them.");
    expect(varied).not.toContain("neutral.");
  });

  it("the brief, the review and the photo review carry it; without colours the prompts are unchanged", () => {
    const brief = (o?: ObservedColours) => buildBriefPrompt({ demo: SHOP, referenceCount: 2, referenceKind: "instagram", currentDemoCount: 2, observedColours: o });
    const review = (o?: ObservedColours) => buildReviewPrompt({ demo: SHOP, profile: AMERICAN_EDITORIAL, referenceCount: 2, referenceKind: "instagram", round: 0, maxRevisions: 2, observedColours: o });
    const photo = (o?: ObservedColours) =>
      buildPhotoReviewPrompt({
        demo: SHOP,
        profile: AMERICAN_EDITORIAL,
        direction: { version: 1, layout: "split_hero", hero: null, features: [] } as never,
        analyses: [],
        referenceCount: 2,
        referenceKind: "instagram",
        crops: { desktop: 0, mobile: 0 },
        round: 0,
        maxRevisions: 2,
        observedColours: o,
      });
    const line = observedColoursLine(observed, "instagram");
    expect(brief(observed)).toContain(line);
    expect(review(observed)).toContain(line);
    expect(photo(observed)).toContain(line);
    for (const p of [brief(), review(), photo()]) expect(p).not.toContain("Colours measured");
    expect(brief()).toBe(buildBriefPrompt({ demo: SHOP, referenceCount: 2, referenceKind: "instagram", currentDemoCount: 2 }));
    // the two sentences about the attached images stay together
    expect(brief(observed)).toMatch(/Attached images: [^\n]*\n\nThe last 2 show the current generic demo/);
  });
});
