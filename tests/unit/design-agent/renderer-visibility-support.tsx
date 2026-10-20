import { chromium, type Browser, type Page } from "playwright";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import ProfileRenderer from "@/components/demo/profile/ProfileRenderer";
import { DEFAULT_LAYOUT } from "@/lib/design-agent/layout";
import { DIRECTIONS, DIVIDERS, FIRST_VIEWS, GRIDS, HEADING_STYLES, INFO_STYLES, TYPE_SCALES, type DesignProfile, type Layout } from "@/lib/design-agent/profile";
import { visibleChanges } from "@/lib/design-agent/visible-profile";
import type { DemoView } from "@/lib/sales/demo-content";
import { MINIMAL_SHOP } from "./fixtures";
import { BASE_PROFILE, coverageLayouts, FULL_SHOP, pageHtml, SPARSE_JP_SHOP, sweepViewport, THREE_SHOPS } from "./stage1-fixtures";

// DEV-071b re-review: a safety net for visibleChanges. Whenever it says a revision
// changes nothing the screenshots can show ([]), the two pages must be drawn pixel
// for pixel the same, at the review's sizes (1440 and 390). A wrong "hidden" would
// throw away a real revision (NO_VISIBLE_REVISION), so every hidden-able setting is
// varied: composition (grid, infoStyle, divider), the surface and accent colours,
// motifs, motion, and the layout (first view, grounds, type), across directions,
// visit sections of one and of many rows, section mixes and pages without sections.
// The directions are split over renderer-visibility-{1,2,3}.test.tsx so vitest runs
// them in parallel; each file calls defineVisibilityTests with its directions.

const SHOPS: Record<string, DemoView> = {
  full: FULL_SHOP,
  one_visit_row: { ...FULL_SHOP, hours: null, closedDays: null, access: null, phone: null },
  sparse_jp: SPARSE_JP_SHOP,
  vertical_jp: THREE_SHOPS.bakery.demo,
  name_only: { ...MINIMAL_SHOP, name: "EXAMPLE TEST BAKE" },
  // one section only (visit): the divider draws nothing
  visit_only: { ...MINIMAL_SHOP, name: "EXAMPLE TEST BAKE", address: "名古屋市北区テスト町1-2-3", access: "テスト駅から徒歩5分" },
};

/** The base profiles' motifs: none drawn in the accent colour, and one drawn in it (gallery_mono repaints it). */
const MOTIF_SETS: DesignProfile["motifs"][] = [
  ["monogram", "corner_marks"],
  ["dot_grid", "monogram"],
];

const LAYOUTS: Record<string, Layout | undefined> = {
  none: undefined,
  default: DEFAULT_LAYOUT,
  fixed_columns: { ...DEFAULT_LAYOUT, sections: [{ kind: "about", variant: "statement", ground: "plain" }, { kind: "visit", variant: "stacked", ground: "surface" }] },
  cards: { ...DEFAULT_LAYOUT, sections: [{ kind: "visit", variant: "cards", ground: "plain" }, { kind: "menu", variant: "chips", ground: "inverted" }] },
  vertical: { firstView: "vertical_name", sections: THREE_SHOPS.bakery.profile.layout!.sections, type: { scale: "quiet", headings: "vertical_ja" } },
  coverage: coverageLayouts()[5]!.layout,
};

type Mutation = { key: string; apply: (p: DesignProfile) => DesignProfile };
const other = <T,>(list: readonly T[], value: T): T[] => list.filter((v) => v !== value);
const withLayout = (p: DesignProfile, f: (l: Layout) => Layout): DesignProfile => ({ ...p, layout: f(p.layout ?? DEFAULT_LAYOUT) });
function mutations(p: DesignProfile): Mutation[] {
  return [
    ...other(GRIDS, p.composition.grid).map((grid) => ({ key: `grid:${grid}`, apply: (q: DesignProfile) => ({ ...q, composition: { ...q.composition, grid } }) })),
    ...other(INFO_STYLES, p.composition.infoStyle).map((infoStyle) => ({ key: `info:${infoStyle}`, apply: (q: DesignProfile) => ({ ...q, composition: { ...q.composition, infoStyle } }) })),
    ...other(DIVIDERS, p.composition.divider).map((divider) => ({ key: `divider:${divider}`, apply: (q: DesignProfile) => ({ ...q, composition: { ...q.composition, divider } }) })),
    { key: "surface", apply: (q) => ({ ...q, palette: { ...q.palette, surface: "#E0D2BC" } }) },
    { key: "accent", apply: (q) => ({ ...q, palette: { ...q.palette, accent: "#2E7D6B" } }) },
    { key: "motifs_order", apply: (q) => ({ ...q, motifs: [...q.motifs].reverse() }) },
    { key: "motion", apply: (q) => ({ ...q, motion: { intro: "letter_reveal", sectionFade: !q.motion.sectionFade } }) },
    ...other(FIRST_VIEWS, p.layout?.firstView ?? "name_only").map((firstView) => ({ key: `first_view:${firstView}`, apply: (q: DesignProfile) => withLayout(q, (l) => ({ ...l, firstView })) })),
    ...other(HEADING_STYLES, p.layout?.type.headings ?? "en_ja").map((headings) => ({ key: `headings:${headings}`, apply: (q: DesignProfile) => withLayout(q, (l) => ({ ...l, type: { ...l.type, headings } })) })),
    ...other(TYPE_SCALES, p.layout?.type.scale ?? "standard").map((scale) => ({ key: `scale:${scale}`, apply: (q: DesignProfile) => withLayout(q, (l) => ({ ...l, type: { ...l.type, scale } })) })),
    { key: "ground", apply: (q) => withLayout(q, (l) => ({ ...l, sections: l.sections.map((x, i) => (i === 0 ? { ...x, ground: x.ground === "surface" ? "plain" : "surface" } : x)) })) },
  ];
}

const markup = (demo: DemoView, profile: DesignProfile) => renderToStaticMarkup(<ProfileRenderer demo={demo} profile={profile} />);

async function shot(page: Page, html: string): Promise<string> {
  await page.setContent(pageHtml(html));
  // JPEG at full quality: identical pixels give identical bytes, and it encodes much faster than PNG
  return (await page.screenshot({ fullPage: true, type: "jpeg", quality: 100 })).toString("base64");
}

/** The directions of renderer-visibility-1/2/3.test.tsx (each runs in its own file, in parallel). */
export const VISIBILITY_PARTS: readonly (readonly DesignProfile["direction"][])[] = [
  ["american_editorial", "editorial_luxury", "french_classic", "nordic_minimal"],
  ["japanese_modern", "kissaten_retro", "gallery_mono"],
  ["craft_paper", "boutique_minimal", "pop_bakeshop"],
];

export function defineVisibilityTests(part: number): void {
  const directions = VISIBILITY_PARTS[part]!;
  vi.setConfig({ testTimeout: 600_000 });
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  });
  afterAll(async () => {
    await browser?.close();
  });

  describe("visibleChanges against the drawn page (Chromium)", () => {
  if (part === 0)
    it("the parts cover every direction exactly once", () => {
      expect([...VISIBILITY_PARTS.flat()].sort()).toEqual([...DIRECTIONS].sort());
    });
  // one test per direction keeps each within its time limit
  for (const direction of directions)
    it(`${direction}: every revision it calls invisible draws the same pixels at 1440 and 390`, async () => {
      // the pairs it calls invisible
      const pairs: Array<{ label: string; demo: DemoView; a: DesignProfile; b: DesignProfile }> = [];
      for (const [shopKey, demo] of Object.entries(SHOPS))
        for (const [layoutKey, layout] of Object.entries(LAYOUTS))
          for (const [motifKey, motifs] of MOTIF_SETS.entries()) {
            // the accent-motif base on two layouts only (it exercises the accent rules)
            if (motifKey > 0 && !["none", "default"].includes(layoutKey)) continue;
            const a: DesignProfile = { ...BASE_PROFILE, direction, motifs, ...(layout ? { layout } : {}) };
            for (const m of mutations(a)) {
              const b = m.apply(a);
              if (visibleChanges(a, b, { photos: false, demo }).length === 0) pairs.push({ label: `${shopKey}/${layoutKey}${motifKey > 0 ? "+accent" : ""}/${m.key}`, demo, a, b });
            }
          }
      // the net is not empty: hidden cases of every kind are drawn
      expect(pairs.length).toBeGreaterThan(60);
      // (surface and accent are hidden only in some directions: checked across them below)
      for (const kind of ["grid", "info", "divider", "first_view", "headings", "scale", "motion"]) expect(pairs.some((p) => p.label.split("/")[2]!.startsWith(kind)), kind).toBe(true);
      // the one-section page's divider, and gallery_mono's repainted accent motif
      expect(pairs.some((p) => p.label.startsWith("visit_only/") && p.label.includes("/divider:")), "divider on a one-section page").toBe(true);
      if (direction === "gallery_mono") expect(pairs.some((p) => p.label.includes("+accent/accent")), "gallery_mono accent").toBe(true);

      // Each distinct pair of pages is drawn once: the same markup with the same CSS is the same page,
      // so a pair with equal markup needs no drawing, and pairs that render the same two pages (a
      // sparse shop collapses many layouts) are compared once.
      const cases = new Map<string, { label: string; htmlA: string; htmlB: string }>();
      for (const { label, demo, a, b } of pairs) {
        const [htmlA, htmlB] = [markup(demo, a), markup(demo, b)];
        if (htmlA !== htmlB && !cases.has(htmlA + "\u0000" + htmlB)) cases.set(htmlA + "\u0000" + htmlB, { label, htmlA, htmlB });
      }
      const drawn = cases.size;
      for (const width of [1440, 390]) {
        const context = await browser.newContext({ ...sweepViewport(width), reducedMotion: "reduce" });
        const page = await context.newPage();
        try {
          const cache = new Map<string, string>();
          const of = async (html: string) => cache.get(html) ?? cache.set(html, await shot(page, html)).get(html)!;
          for (const { label, htmlA, htmlB } of cases.values())
            expect.soft((await of(htmlB)) === (await of(htmlA)), `${direction}/${label}/${width}px: called invisible, but the page changes`).toBe(true);
        } finally {
          await context.close();
        }
      }
      // most hidden cases change the markup (data attributes): they are really drawn and compared
      expect(drawn).toBeGreaterThan(40);
    });
  });
}
