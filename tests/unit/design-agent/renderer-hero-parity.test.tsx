import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import demoStyles from "@/components/demo/demo.module.css";
import ProfileRenderer from "@/components/demo/profile/ProfileRenderer";
import profileStyles from "@/components/demo/profile/profile.module.css";
import type { ImageDirection } from "@/lib/design-agent/assets/direction";
import { resolvePhotos, type RenderPhotos } from "@/lib/design-agent/assets/resolve";
import { HERO_LAYOUTS, type DesignProfile } from "@/lib/design-agent/profile";
import type { DemoView } from "@/lib/sales/demo-content";
import { AMERICAN_EDITORIAL, SHOP } from "./fixtures";
import { dataUrl, fakeAnalysis, fakeManifest, fakePng, type FakeAsset } from "./photo-fixtures";

// DEV-043: the sparse-page compaction of `spacing: tight` + `heroLayout.height: medium`
// (DEV-036 / DEV-038) applied only to `centered_cover`, so a reviewer asking for a lower hero
// on a sparse page could only reach it with that layout (.ai/reviews/DEV-042.md, cause 3).
// Every hero layout now gets the same floor and padding; centered_cover keeps its values.
// Measured from the rendered page in Chromium. Fictional shops only.

vi.setConfig({ testTimeout: 180_000 });

function moduleCss(file: string, names: Record<string, string>): string {
  const css = readFileSync(join(process.cwd(), file), "utf8");
  return css.replace(/\.(-?[_a-zA-Z][\w-]*)/g, (whole, name: string) => (names[name] ? `.${names[name]}` : whole));
}
const FACES = `:root { --font-editorial: "Liberation Serif", "DejaVu Serif"; --font-grotesk: "DejaVu Sans", "Liberation Sans"; --font-display: "WenQuanYi Zen Hei", "IPAGothic"; --font-body: "IPAGothic", "WenQuanYi Zen Hei"; }`;
const CSS = [
  "*, *::before, *::after { box-sizing: border-box; } body { margin: 0; }",
  FACES,
  moduleCss("components/demo/demo.module.css", demoStyles as Record<string, string>),
  moduleCss("components/demo/profile/profile.module.css", profileStyles as Record<string, string>),
].join("\n");

const sparse = (over: Partial<DemoView>): DemoView => ({
  ...SHOP,
  hours: null,
  closedDays: null,
  phone: null,
  access: "架空駅から徒歩5分",
  description: "架空のお店の短い紹介文です。",
  menuItems: ["テストマフィン", "テストクッキー"],
  ...over,
});
const SHOPS = {
  latinBakedGoods: sparse({ name: "TESTA", category: "baked_goods", template: "baked_goods_v1" }),
  latinTwoWords: sparse({ name: "TEST BAKE", category: "bakery", template: "bakery_v1" }),
  japaneseBakery: sparse({ name: "架空パン店", category: "bakery", template: "bakery_v1" }),
  longJapanese: sparse({ name: "架空ベーカリー名古屋テスト本店", category: "bakery", template: "bakery_v1" }),
} as const;
type Layout = (typeof HERO_LAYOUTS)[number];
const profile = (layout: Layout, over: Partial<DesignProfile> = {}): DesignProfile => ({
  ...AMERICAN_EDITORIAL,
  heroLayout: { layout, height: "medium", alignment: "left" },
  composition: { ...AMERICAN_EDITORIAL.composition, infoStyle: "ruled_list", divider: "hairline" },
  motifs: [],
  motion: { intro: "none", sectionFade: false },
  spacing: { scale: "tight" },
  ...over,
});

type Geo = { heroMinH: number; heroH: number; heroPad: string; titlePad: string; nameClipped: boolean; nameInHero: boolean; overflowX: boolean };

async function measure(page: Page, demo: DemoView, p: DesignProfile, photos: RenderPhotos | null = null): Promise<Geo> {
  const body = renderToStaticMarkup(<ProfileRenderer demo={demo} profile={p} photos={photos} />);
  await page.setContent(`<!doctype html><html lang="ja"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${CSS}</style></head><body>${body}</body></html>`);
  return page.evaluate(
    ({ hero, title }) => {
      const h = document.querySelector(`.${hero}`)!;
      const t = h.querySelector(`.${title}`)!;
      const name = t.querySelector("h1")!;
      const hs = getComputedStyle(h);
      const hr = h.getBoundingClientRect();
      const nr = name.getBoundingClientRect();
      return {
        heroMinH: parseFloat(hs.minHeight) || 0,
        heroH: Math.round(hr.height),
        heroPad: `${hs.paddingTop} ${hs.paddingBottom}`,
        titlePad: getComputedStyle(t).paddingTop,
        // the name is never cut: its lines fit the title's width and the hero holds it
        nameClipped: name.scrollWidth > t.clientWidth + 1,
        nameInHero: nr.top >= hr.top - 1 && nr.bottom <= hr.bottom + 1,
        overflowX: document.documentElement.scrollWidth > innerWidth,
      };
    },
    { hero: profileStyles.hero, title: profileStyles.title },
  );
}

const VIEWPORTS = { phone360: { width: 360, height: 780 }, phone390: { width: 390, height: 844 }, desktop: { width: 1440, height: 900 } } as const;
type Vp = keyof typeof VIEWPORTS;
let browser: Browser;
const pages = new Map<Vp, Page>();
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
});
afterAll(async () => {
  await browser?.close();
});
async function pageFor(key: Vp): Promise<Page> {
  let page = pages.get(key);
  if (!page) {
    const mobile = key !== "desktop";
    const context = await browser.newContext({ viewport: VIEWPORTS[key], ...(mobile ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}), reducedMotion: "reduce" });
    page = await context.newPage();
    pages.set(key, page);
  }
  return page;
}

const PORTRAIT = "asset-111111111111111111111111";
const PHOTO_ASSETS: FakeAsset[] = [{ id: PORTRAIT, png: fakePng(600, 750, { seed: 1 }), sourceKind: "approved_real" }];
function photosFor(demo: DemoView, layout: ImageDirection["layout"]): RenderPhotos {
  const direction: ImageDirection = {
    version: 1,
    layout,
    hero: { assetId: PORTRAIT, fit: "cover", focal: { x: 0.5, y: 0.5 }, mobileFocal: { x: 0.5, y: 0.5 }, aspect: { desktop: "4:5", mobile: "1:1" }, treatment: "natural" },
    features: [],
    rejected: [],
    paletteFit: 4,
  };
  const src = new Map(PHOTO_ASSETS.map((a) => [a.id, dataUrl(a.png)]));
  return resolvePhotos({ demo, manifest: fakeManifest("job-hero-parity", PHOTO_ASSETS), analyses: { photos: [fakeAnalysis(PORTRAIT)] }, direction, src: (id) => src.get(id)! }).photos!;
}

const PHONES = ["phone360", "phone390"] as const;
// The values DEV-036 / DEV-038 gave centered_cover under tight + medium (unchanged here).
const TIGHT_MEDIUM = {
  phone: { floor: 0.22, heroPad: "14px 14px", titlePad: "14px" },
  desktop: { floor: 0.38, heroPad: "18px 24px", titlePad: "24px" },
} as const;
const OTHERS = HERO_LAYOUTS.filter((l) => l !== "centered_cover");

describe("DEV-043 tight + medium: every hero layout gets the sparse-page compaction", () => {
  for (const layout of HERO_LAYOUTS)
    for (const vp of [...PHONES, "desktop"] as const) {
      const want = vp === "desktop" ? TIGHT_MEDIUM.desktop : TIGHT_MEDIUM.phone;
      it(`${layout} @${vp}: floor ${want.floor * 100}svh, hero padding ${want.heroPad}, title padding ${want.titlePad}`, async () => {
        for (const demo of Object.values(SHOPS)) {
          const g = await measure(await pageFor(vp), demo, profile(layout));
          expect(g.heroMinH).toBeCloseTo(VIEWPORTS[vp].height * want.floor, 0);
          expect(g.heroPad).toBe(want.heroPad);
          expect(g.titlePad).toBe(want.titlePad);
          expect(g.nameClipped).toBe(false);
          expect(g.nameInHero).toBe(true);
          expect(g.overflowX).toBe(false);
        }
      });
    }

  for (const layout of OTHERS)
    for (const vp of [...PHONES, "desktop"] as const)
      it(`${layout} @${vp}: a short-name sparse hero is a band like centered_cover's, not a screen`, async () => {
        const page = await pageFor(vp);
        for (const demo of [SHOPS.latinBakedGoods, SHOPS.japaneseBakery]) {
          // develop before DEV-043: 40svh on phones, 56svh on desktop
          const g = await measure(page, demo, profile(layout));
          const ref = await measure(page, demo, profile("centered_cover"));
          expect(g.heroH).toBeLessThan(VIEWPORTS[vp].height * (vp === "desktop" ? 0.56 : 0.4));
          // the remaining difference is the layout's own name size (split_crop / stacked_oversized are larger by design)
          expect(g.heroMinH).toBe(ref.heroMinH);
        }
      });

  it("other spacings and heights are unchanged for every layout", async () => {
    for (const layout of HERO_LAYOUTS) {
      for (const scale of ["standard", "generous"] as const) {
        const phone = await measure(await pageFor("phone390"), SHOPS.japaneseBakery, profile(layout, { spacing: { scale } }));
        // DEV-036's every-spacing phone floor stays centered_cover's own
        expect(phone.heroMinH).toBeCloseTo(844 * (layout === "centered_cover" ? 0.28 : 0.4), 0);
        expect(phone.titlePad).toBe(layout === "centered_cover" ? "20px" : "36px");
        const desktop = await measure(await pageFor("desktop"), SHOPS.japaneseBakery, profile(layout, { spacing: { scale } }));
        expect(desktop.heroMinH).toBe(504); // 56svh
        expect(desktop.heroPad).toBe("24px 36px");
        expect(desktop.titlePad).toBe("36px");
      }
      for (const height of ["tall", "full"] as const) {
        const g = await measure(await pageFor("desktop"), SHOPS.japaneseBakery, profile(layout, { heroLayout: { layout, height, alignment: "left" } }));
        expect(g.heroMinH).toBe(height === "full" ? 860 : 662); // 100svh − 40 / 78svh − 40
        expect(g.titlePad).toBe("36px");
      }
    }
  });

  it("photo heroes keep their height: split heroes everywhere, framed heroes of the non-cover layouts", async () => {
    for (const layout of HERO_LAYOUTS) {
      const split = photosFor(SHOPS.latinBakedGoods, "split_hero");
      expect((await measure(await pageFor("phone390"), SHOPS.latinBakedGoods, profile(layout), split)).heroMinH).toBe(0);
      expect((await measure(await pageFor("desktop"), SHOPS.latinBakedGoods, profile(layout), split)).heroMinH).toBe(504);
      const framed = photosFor(SHOPS.latinBakedGoods, "framed_hero");
      for (const vp of [...PHONES, "desktop"] as const) {
        const g = await measure(await pageFor(vp), SHOPS.latinBakedGoods, profile(layout), framed);
        const desktop = vp === "desktop";
        if (layout === "centered_cover") {
          // DEV-038's values, unchanged
          const want = desktop ? TIGHT_MEDIUM.desktop : TIGHT_MEDIUM.phone;
          expect(g.heroMinH).toBeCloseTo(VIEWPORTS[vp].height * want.floor, 0);
          expect(g.heroPad).toBe(want.heroPad);
          expect(g.titlePad).toBe(want.titlePad);
        } else {
          // develop's generic medium hero (DEV-043 does not touch photo heroes)
          expect(g.heroMinH).toBeCloseTo(VIEWPORTS[vp].height * (desktop ? 0.56 : 0.4), 0);
          expect(g.heroPad).toBe(desktop ? "24px 36px" : "20px 28px");
          expect(g.titlePad).toBe("36px");
        }
        expect(g.nameInHero).toBe(true);
        expect(g.overflowX).toBe(false);
      }
    }
  });

  // The hero's grid rows (folio, motif row, title, area line) never overlap with any motif set.
  // The absolutely positioned motifs (frame, corners, dots) are not checked here; their
  // closeness on phones is recorded in .ai/reviews/DEV-043.md.
  it("motifs in the shorter hero: folio, motif row, name and area line never overlap", async () => {
    const sets = [["monogram", "location_labels", "ruled_frame", "corner_marks"], ["stamp_ring", "muffin_paper_svg", "dot_grid"]] as const;
    for (const layout of HERO_LAYOUTS)
      for (const vp of [...PHONES, "desktop"] as const)
        for (const motifs of sets)
          for (const demo of [SHOPS.latinTwoWords, SHOPS.longJapanese]) {
            const page = await pageFor(vp);
            await measure(page, demo, profile(layout, { motifs: [...motifs] }));
            const overlaps = await page.evaluate(
              ({ hero, folio, motifRow, title, dek }) => {
                const h = document.querySelector(`.${hero}`)!;
                const boxes = [folio, motifRow, title, dek]
                  .map((c) => [c, h.querySelector(`.${c}`)] as const)
                  .filter(([, e]) => e !== null)
                  .map(([c, e]) => [c, e!.getBoundingClientRect()] as const);
                const hit = (a: DOMRect, b: DOMRect) => Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5 && Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5;
                const out: string[] = [];
                for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (hit(boxes[i][1], boxes[j][1])) out.push(`${boxes[i][0]}/${boxes[j][0]}`);
                return out;
              },
              { hero: profileStyles.hero, folio: profileStyles.folio, motifRow: profileStyles.motifRow, title: profileStyles.title, dek: profileStyles.dek },
            );
            expect(overlaps, `${layout} @${vp} ${motifs.join("+")} ${demo.name}`).toEqual([]);
          }
  });
});
