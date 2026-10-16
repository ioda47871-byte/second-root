import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import demoStyles from "@/components/demo/demo.module.css";
import ProfileRenderer from "@/components/demo/profile/ProfileRenderer";
import profileStyles from "@/components/demo/profile/profile.module.css";
import type { DesignProfile } from "@/lib/design-agent/profile";
import type { DemoView } from "@/lib/sales/demo-content";
import { AMERICAN_EDITORIAL, SHOP } from "./fixtures";

// DEV-036: a sparse demo (a short name, a short description, two menu items, an
// address) with `spacing: tight` and a medium centered cover must be compact on
// phones, and a short name must not become monumental on desktop. Measured from
// the rendered page in Chromium. Fictional shops only.

vi.setConfig({ testTimeout: 180_000 });

function moduleCss(file: string, names: Record<string, string>): string {
  const css = readFileSync(join(process.cwd(), file), "utf8");
  return css.replace(/\.(-?[_a-zA-Z][\w-]*)/g, (whole, name: string) => (names[name] ? `.${names[name]}` : whole));
}
const FACES = `:root { --font-editorial: "Liberation Serif", "DejaVu Serif"; --font-grotesk: "DejaVu Sans", "Liberation Sans"; --font-display: "WenQuanYi Zen Hei", "IPAGothic"; --font-body: "IPAGothic", "WenQuanYi Zen Hei"; }`;
const DENSITY_CSS = () =>
  [
    "*, *::before, *::after { box-sizing: border-box; } body { margin: 0; }",
    FACES,
    moduleCss("components/demo/demo.module.css", demoStyles as Record<string, string>),
    moduleCss("components/demo/profile/profile.module.css", profileStyles as Record<string, string>),
  ].join("\n");

const sparse = (over: Partial<DemoView>): DemoView => ({
  ...SHOP,
  hours: null,
  closedDays: null,
  access: null,
  phone: null,
  description: "架空のお店の短い紹介文です。",
  menuItems: ["テストマフィン", "テストクッキー"],
  ...over,
});
const SPARSE = {
  latinBakedGoods: sparse({ name: "TESTA", category: "baked_goods", template: "baked_goods_v1" }),
  japaneseBakery: sparse({ name: "架空パン店", category: "bakery", template: "bakery_v1" }),
} as const;

const compactProfile = (over: Partial<DesignProfile> = {}): DesignProfile => ({
  ...AMERICAN_EDITORIAL,
  heroLayout: { layout: "centered_cover", height: "medium", alignment: "center" },
  motifs: [],
  motion: { intro: "none", sectionFade: false },
  spacing: { scale: "tight" },
  ...over,
});

type Density = {
  heroH: number;
  sectionTopPad: number;
  interSection: number[];
  headingGap: number;
  footerGap: number;
  headingPx: number;
  namePx: number;
  nameLines: number;
  overflowX: boolean;
  nameInside: boolean;
  pageH: number;
};

async function measureDensity(page: Page, demo: DemoView, profile: DesignProfile, css: string): Promise<Density> {
  const body = renderToStaticMarkup(<ProfileRenderer demo={demo} profile={profile} />);
  await page.setContent(`<!doctype html><html lang="ja"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body>${body}</body></html>`);
  return page.evaluate(
    ({ hero, section, heading }) => {
      const r = (e: Element) => e.getBoundingClientRect();
      const sections = [...document.querySelectorAll(`.${section}`)];
      const contentBottom = (s: Element) => Math.max(...[...s.children].map((c) => r(c).bottom));
      const headingOf = (s: Element) => s.querySelector(`.${heading}`)!;
      const first = sections[0]!;
      const h = headingOf(first);
      const afterHeading = h.nextElementSibling!;
      const footer = document.querySelector("footer")!;
      const name = document.querySelector("h1")!;
      const pieces = [...name.querySelectorAll("span")].filter((e) => !e.children.length && e.textContent!.trim()).map(r);
      const title = r(name.parentElement!);
      const lines = new Set(pieces.map((x) => Math.round(x.top)));
      return {
        heroH: Math.round(r(document.querySelector(`.${hero}`)!).height),
        sectionTopPad: Math.round(r(h).top - r(first).top),
        interSection: sections.slice(1).map((s, i) => Math.round(r(headingOf(s)).top - contentBottom(sections[i]!))),
        headingGap: Math.round(Math.max(0, r(afterHeading).top - r(h).bottom)),
        footerGap: Math.round(r(footer).top - contentBottom(sections.at(-1)!)),
        headingPx: parseFloat(getComputedStyle(h).fontSize),
        namePx: parseFloat(getComputedStyle(name).fontSize),
        nameLines: lines.size,
        overflowX: document.documentElement.scrollWidth > innerWidth,
        nameInside: pieces.every((x) => x.left >= title.left - 0.5 && x.right <= title.right + 0.5),
        pageH: Math.round(document.documentElement.scrollHeight),
      };
    },
    { hero: profileStyles.hero, section: profileStyles.section, heading: profileStyles.heading },
  );
}

const VIEWPORTS = { phone360: { width: 360, height: 780 }, phone390: { width: 390, height: 844 }, desktop: { width: 1440, height: 900 } } as const;

let browser: Browser;
const pages = new Map<string, Page>();
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
});
afterAll(async () => {
  await browser?.close();
});
async function pageFor(key: keyof typeof VIEWPORTS): Promise<Page> {
  let page = pages.get(key);
  if (!page) {
    const mobile = key !== "desktop";
    const context = await browser.newContext({ viewport: VIEWPORTS[key], ...(mobile ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}), reducedMotion: "reduce" });
    page = await context.newPage();
    pages.set(key, page);
  }
  return page;
}

const LONG = {
  latin: sparse({ name: "TESTA NORTHSIDE BAKING COMPANY", category: "baked_goods", template: "baked_goods_v1" }),
  japanese: sparse({ name: "架空の森のちいさなパン工房", category: "bakery", template: "bakery_v1" }),
};
const PHONES = ["phone360", "phone390"] as const;
const css = DENSITY_CSS();

describe("DEV-036 sparse content under spacing=tight", () => {
  for (const [key, demo] of Object.entries(SPARSE))
    for (const vp of PHONES)
      it(`${key} @${vp}: compact rhythm, readable headings, short cover`, async () => {
        const d = await measureDensity(await pageFor(vp), demo, compactProfile(), css);
        // Develop before DEV-036 measured 48 / 99 / 24 / 48 / 35.2px / 40% of the screen.
        expect(d.sectionTopPad).toBeLessThanOrEqual(34);
        for (const gap of d.interSection) {
          expect(gap).toBeLessThanOrEqual(40); // one rhythm, not padding + margin
          expect(gap).toBeGreaterThanOrEqual(24);
        }
        expect(d.headingGap).toBeLessThanOrEqual(18);
        expect(d.headingGap).toBeGreaterThanOrEqual(10);
        expect(d.footerGap).toBeLessThanOrEqual(28);
        expect(d.headingPx).toBeLessThanOrEqual(30);
        expect(d.headingPx).toBeGreaterThanOrEqual(26); // still display-sized
        expect(d.heroH).toBeLessThanOrEqual(VIEWPORTS[vp].height * 0.3);
        expect(d.nameLines).toBe(1);
        expect(d.nameInside).toBe(true);
        expect(d.overflowX).toBe(false);
      });

  for (const [key, demo] of Object.entries(SPARSE))
    it(`${key} @desktop: a short name is not monumental, sections stay close`, async () => {
      const d = await measureDensity(await pageFor("desktop"), demo, compactProfile(), css);
      // Before: 208px name, 99px between sections, 48px before the footer.
      expect(d.namePx).toBeLessThanOrEqual(144);
      expect(d.namePx).toBeGreaterThanOrEqual(96);
      for (const gap of d.interSection) expect(gap).toBeLessThanOrEqual(80);
      expect(d.footerGap).toBeLessThanOrEqual(36);
      expect(d.nameLines).toBe(1);
      expect(d.nameInside).toBe(true);
      expect(d.overflowX).toBe(false);
    });

  for (const [key, demo] of Object.entries(LONG))
    for (const vp of Object.keys(VIEWPORTS) as (keyof typeof VIEWPORTS)[])
      it(`long ${key} name @${vp} still fits the compact cover`, async () => {
        const d = await measureDensity(await pageFor(vp), demo, compactProfile(), css);
        expect(d.nameInside).toBe(true);
        expect(d.overflowX).toBe(false);
        expect(d.namePx).toBeLessThanOrEqual(144);
      });

  it("standard spacing keeps its rhythm on phones", async () => {
    const d = await measureDensity(await pageFor("phone390"), SPARSE.latinBakedGoods, compactProfile({ spacing: { scale: "standard" } }), css);
    expect(d.sectionTopPad).toBe(72);
    for (const gap of d.interSection) expect(gap).toBeGreaterThan(140);
    expect(d.headingPx).toBeCloseTo(35.2, 0);
  });
});
