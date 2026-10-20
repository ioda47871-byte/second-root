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
import type { DesignProfile } from "@/lib/design-agent/profile";
import type { DemoView } from "@/lib/sales/demo-content";
import { AMERICAN_EDITORIAL, SHOP } from "./fixtures";
import { dataUrl, fakeAnalysis, fakeManifest, fakePng, type FakeAsset } from "./photo-fixtures";

// DEV-038: `spacing: tight` as whole-page density for a sparse demo (a short name, a short
// description, two menu items, an address and an access line): the medium centered cover on
// desktop, the menu and information rows and the address → access gap on phones, the space
// before the footer, and the proposal notice / footer of a profile-rendered demo on phones.
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
  japaneseBakery: sparse({ name: "架空パン店", category: "bakery", template: "bakery_v1" }),
} as const;
const profile = (over: Partial<DesignProfile> = {}): DesignProfile => ({
  ...AMERICAN_EDITORIAL,
  heroLayout: { layout: "centered_cover", height: "medium", alignment: "center" },
  composition: { ...AMERICAN_EDITORIAL.composition, infoStyle: "ruled_list", divider: "hairline" },
  motifs: [],
  motion: { intro: "none", sectionFade: false },
  spacing: { scale: "tight" },
  ...over,
});

type Geo = { titlePad: string; rowH: number; addressInner: number; menuPad: string; footerPad: string; heroMinH: number; noticeClipped: boolean; footerClipped: boolean; heroH: number; menuRowH: number; addressToAccess: number; contentToFooter: number; noticeH: number; footerH: number; noticePx: number; footerPx: number; overflowX: boolean; noticeText: string; footerText: string };

async function measure(page: Page, demo: DemoView, p: DesignProfile, photos: RenderPhotos | null = null): Promise<Geo> {
  const body = renderToStaticMarkup(<ProfileRenderer demo={demo} profile={p} photos={photos} />);
  await page.setContent(`<!doctype html><html lang="ja"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${CSS}</style></head><body>${body}</body></html>`);
  return page.evaluate(
    ({ hero, menuItem, address, rows, section, row, rowLabel, addressValue }) => {
      const r = (e: Element) => e.getBoundingClientRect();
      const q = (c: string) => document.querySelector(`.${c}`)!;
      const sections = [...document.querySelectorAll(`.${section}`)];
      const last = sections.at(-1)!;
      const contentBottom = Math.max(...[...last.children].map((c) => r(c).bottom));
      const notice = document.querySelector('[role="note"]')!;
      const footer = document.querySelector("footer")!;
      return {
        heroH: Math.round(r(q(hero)).height),
        rowH: Math.round(r(q(row)).height),
        titlePad: getComputedStyle(q(hero).querySelector("h1")!.parentElement!).paddingTop,
        addressInner: Math.round(r(document.querySelector(`.${address} .${addressValue}`)!).top - r(document.querySelector(`.${address} .${rowLabel}`)!).bottom),
        menuPad: getComputedStyle(q(menuItem)).paddingTop,
        footerPad: `${getComputedStyle(footer).paddingTop} ${getComputedStyle(footer).paddingBottom}`,
        heroMinH: parseFloat(getComputedStyle(q(hero)).minHeight) || 0,
        noticeClipped: notice.scrollHeight > notice.clientHeight + 1 || notice.scrollWidth > notice.clientWidth + 1,
        footerClipped: footer.scrollHeight > footer.clientHeight + 1 || footer.scrollWidth > footer.clientWidth + 1,
        menuRowH: Math.round(r(q(menuItem)).height),
        addressToAccess: Math.round(r(q(rows)).top - r(q(address)).bottom),
        contentToFooter: Math.round(r(footer).top - contentBottom),
        noticeH: Math.round(r(notice).height),
        footerH: Math.round(r(footer).height),
        noticePx: parseFloat(getComputedStyle(notice).fontSize),
        footerPx: parseFloat(getComputedStyle(footer).fontSize),
        overflowX: document.documentElement.scrollWidth > innerWidth,
        noticeText: notice.textContent ?? "",
        footerText: footer.textContent ?? "",
      };
    },
    { hero: profileStyles.hero, menuItem: profileStyles.menuItem, address: profileStyles.address, rows: profileStyles.rows, section: profileStyles.section, row: profileStyles.row, rowLabel: profileStyles.rowLabel, addressValue: profileStyles.addressValue },
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
function splitPhotos(demo: DemoView): RenderPhotos {
  const direction: ImageDirection = {
    version: 1,
    layout: "split_hero",
    hero: { assetId: PORTRAIT, fit: "cover", focal: { x: 0.5, y: 0.5 }, mobileFocal: { x: 0.5, y: 0.5 }, aspect: { desktop: "4:5", mobile: "1:1" }, treatment: "natural" },
    features: [],
    rejected: [],
    paletteFit: 4,
  };
  const src = new Map(PHOTO_ASSETS.map((a) => [a.id, dataUrl(a.png)]));
  return resolvePhotos({ demo, manifest: fakeManifest("job-density-2", PHOTO_ASSETS), analyses: { photos: [fakeAnalysis(PORTRAIT)] }, direction, src: (id) => src.get(id)! }).photos!;
}

const NOTICE = /Second Root.*ご提案用のデモページ.*様の公式サイトではありません。/;
const FOOTER = /Second Root が公開情報をもとに作成したデモです。.*掲載内容は確認できた公開情報のみで、公式サイト・公式情報ではありません。.*名古屋の小さなお店のホームページ制作/;
const PHONES = ["phone360", "phone390"] as const;

describe("DEV-038 tight as whole-page density (sparse demo)", () => {
  for (const [key, demo] of Object.entries(SHOPS)) {
    for (const vp of PHONES)
      it(`${key} @${vp}: compact cover, rows, visit block, notice and footer`, async () => {
        const g = await measure(await pageFor(vp), demo, profile());
        // develop before DEV-038 (see .ai/reviews/DEV-038.md): hero 28% of the screen, menu row 66px,
        // address → access 40px, notice 62px, footer 246px.
        expect(g.heroH).toBeLessThanOrEqual(VIEWPORTS[vp].height * 0.26);
        expect(g.titlePad).toBe("14px"); // develop: 20px
        expect(g.menuRowH).toBeLessThanOrEqual(56);
        expect(g.rowH).toBeLessThanOrEqual(88); // the access row (develop: 95px)
        expect(g.addressInner).toBeLessThanOrEqual(10); // label → address value (develop: 12px)
        expect(g.addressToAccess).toBeLessThanOrEqual(24);
        expect(g.addressToAccess).toBeGreaterThanOrEqual(12);
        expect(g.contentToFooter).toBeLessThanOrEqual(28); // DEV-036's footer gap is kept
        expect(g.noticeH).toBeLessThanOrEqual(52);
        expect(g.footerH).toBeLessThanOrEqual(180);
        // full wording, readable size, nothing clipped
        expect(g.noticeText).toMatch(NOTICE);
        expect(g.footerText).toMatch(FOOTER);
        expect(g.noticePx).toBeGreaterThanOrEqual(12);
        expect(g.footerPx).toBeGreaterThanOrEqual(12);
        expect(g.noticeClipped || g.footerClipped).toBe(false);
        expect(g.overflowX).toBe(false);
      });

    it(`${key} @desktop: the medium centered cover is a band, the footer is closer`, async () => {
      const g = await measure(await pageFor("desktop"), demo, profile());
      // before: hero 504px (56svh), footer 176px
      expect(g.heroH).toBeLessThanOrEqual(VIEWPORTS.desktop.height * 0.4);
      expect(g.footerH).toBeLessThanOrEqual(150);
      expect(g.footerPad).toBe("16px 20px"); // tight: the footer is closer on desktop too
      expect(g.titlePad).toBe("24px"); // develop: 36px (matters when the content is taller than the floor)
      expect(g.contentToFooter).toBeLessThanOrEqual(36);
      expect(g.noticeText).toMatch(NOTICE);
      expect(g.footerText).toMatch(FOOTER);
      expect(g.noticeClipped || g.footerClipped).toBe(false);
      expect(g.overflowX).toBe(false);
    });
  }

  it("standard spacing keeps its rows, visit gap and desktop cover; the phone notice / footer rule applies to every profile demo", async () => {
    const phone = await measure(await pageFor("phone390"), SHOPS.latinBakedGoods, profile({ spacing: { scale: "standard" } }));
    expect(phone.menuPad).toBe("16px");
    expect(phone.addressToAccess).toBe(40);
    expect(phone.footerPad).toBe("16px 20px"); // phones: every profile demo (DEV-038 requirement 4)
    expect(phone.noticePx).toBe(12);
    const desktop = await measure(await pageFor("desktop"), SHOPS.latinBakedGoods, profile({ spacing: { scale: "standard" } }));
    expect(desktop.heroMinH).toBe(504); // 56svh
    expect(desktop.footerPad).toBe("28px 40px");
    expect(desktop.noticePx).toBe(12.8);
  });

  it("a split photo hero keeps its own height under tight (no floor on phones, 56svh on desktop)", async () => {
    const photos = splitPhotos(SHOPS.latinBakedGoods);
    expect((await measure(await pageFor("phone390"), SHOPS.latinBakedGoods, profile(), photos)).heroMinH).toBe(0);
    expect((await measure(await pageFor("desktop"), SHOPS.latinBakedGoods, profile(), photos)).heroMinH).toBe(504);
  });
});
