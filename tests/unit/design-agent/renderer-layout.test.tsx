import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import demoStyles from "@/components/demo/demo.module.css";
import ProfileRenderer from "@/components/demo/profile/ProfileRenderer";
import profileStyles from "@/components/demo/profile/profile.module.css";
import type { DesignProfile } from "@/lib/design-agent/profile";
import type { DemoView } from "@/lib/sales/demo-content";
import { AMERICAN_EDITORIAL, SHOP } from "./fixtures";

// Layout of the profile renderer in a real browser, at the sizes the review
// screenshots use (390 × 844 phone, 1440 × 900 desktop). Fictional shops only.
// The module CSS is loaded as written, with its class names mapped to the
// ones the components render in tests.

vi.setConfig({ testTimeout: 120_000 });

function moduleCss(file: string, names: Record<string, string>): string {
  const css = readFileSync(join(process.cwd(), file), "utf8");
  return css.replace(/\.(-?[_a-zA-Z][\w-]*)/g, (whole, name: string) => (names[name] ? `.${names[name]}` : whole));
}
const CSS = [
  "*, *::before, *::after { box-sizing: border-box; } body { margin: 0; }",
  moduleCss("components/demo/demo.module.css", demoStyles as Record<string, string>),
  moduleCss("components/demo/profile/profile.module.css", profileStyles as Record<string, string>),
].join("\n");

const SHOPS: Record<string, DemoView> = {
  short: { ...SHOP, name: "EXAMPLE BAKE", description: null, menuItems: [] },
  long: { ...SHOP, name: "EXAMPLE TEST BAKE HOUSE" },
  japanese: { ...SHOP, name: "架空の焼菓子とコーヒーのテスト店", ward: "千種区" },
};

const medium = (over: Partial<DesignProfile>): DesignProfile => ({
  ...AMERICAN_EDITORIAL,
  heroLayout: { layout: "split_crop", height: "medium", alignment: "left" },
  motifs: ["monogram", "location_labels", "muffin_paper_svg"],
  motion: { intro: "none", sectionFade: false },
  ...over,
});
const PROFILES: Record<string, DesignProfile> = {
  split_crop: medium({}),
  stacked: medium({ heroLayout: { layout: "stacked_oversized", height: "medium", alignment: "left" } }),
  centered: medium({ heroLayout: { layout: "centered_cover", height: "medium", alignment: "center" } }),
  condensed_black: medium({
    typography: { ...AMERICAN_EDITORIAL.typography, display: "condensed_grotesk", displayWeight: "black" },
    heroLayout: { layout: "stacked_oversized", height: "medium", alignment: "left" },
  }),
  framed_mincho: medium({
    typography: { ...AMERICAN_EDITORIAL.typography, display: "mincho", displayCase: "as_is" },
    heroLayout: { layout: "centered_cover", height: "medium", alignment: "center" },
    motifs: ["muffin_paper_svg", "ruled_frame", "corner_marks", "location_labels"],
  }),
};
// The stamp ring, alone and together with the liner (both decorative motifs in the hero).
const STAMP_PROFILES: Record<string, DesignProfile> = {
  stamp_split: medium({ motifs: ["stamp_ring", "location_labels"] }),
  stamp_stacked: medium({ heroLayout: { layout: "stacked_oversized", height: "medium", alignment: "left" }, motifs: ["stamp_ring"] }),
  stamp_centered: medium({ heroLayout: { layout: "centered_cover", height: "medium", alignment: "center" }, motifs: ["stamp_ring", "ruled_frame", "corner_marks"] }),
  stamp_liner_split: medium({ motifs: ["stamp_ring", "muffin_paper_svg", "location_labels"] }),
  stamp_liner_centered_mincho: medium({
    typography: { ...AMERICAN_EDITORIAL.typography, display: "mincho", displayCase: "as_is" },
    heroLayout: { layout: "centered_cover", height: "medium", alignment: "center" },
    motifs: ["muffin_paper_svg", "stamp_ring", "ruled_frame", "corner_marks"],
  }),
  stamp_liner_condensed_black: medium({
    typography: { ...AMERICAN_EDITORIAL.typography, display: "condensed_grotesk", displayWeight: "black" },
    heroLayout: { layout: "stacked_oversized", height: "full", alignment: "left" },
    motifs: ["stamp_ring", "muffin_paper_svg"],
  }),
};

const VIEWPORTS = {
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1440, height: 900 } },
} as const;

type Box = { left: number; top: number; right: number; bottom: number };
type Measure = {
  hero: Box;
  name: Box[];
  pleats: Box | null;
  stamp: Box | null;
  folio: Box;
  dek: Box;
  overflowX: boolean;
  noticeSize: string;
  footerPadding: string;
};

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
});
afterAll(async () => {
  await browser?.close();
});

async function measure(demo: DemoView, profile: DesignProfile, device: keyof typeof VIEWPORTS): Promise<Measure> {
  const context = await browser.newContext({ ...VIEWPORTS[device], reducedMotion: "reduce" });
  try {
    const page = await context.newPage();
    const body = renderToStaticMarkup(<ProfileRenderer demo={demo} profile={profile} />);
    await page.setContent(`<!doctype html><html lang="ja"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${CSS}</style></head><body>${body}</body></html>`);
    return await page.evaluate(
      ({ hero, pleats, stamp, folio, dek, lineText, notice, footer }) => {
        const box = (e: Element): Box => {
          const r = e.getBoundingClientRect();
          return { left: r.left, top: r.top + scrollY, right: r.right, bottom: r.bottom + scrollY };
        };
        const h1 = document.querySelector("h1")!;
        const parts = [...h1.querySelectorAll(`.${lineText}`)];
        const name = (parts.length > 0 ? parts : [h1]).flatMap((e) =>
          [...e.getClientRects()].map((r) => ({ left: r.left, top: r.top + scrollY, right: r.right, bottom: r.bottom + scrollY })),
        );
        const svg = document.querySelector(`.${pleats}`);
        const ring = document.querySelector(`.${stamp}`);
        return {
          hero: box(document.querySelector(`.${hero}`)!),
          name,
          pleats: svg ? box(svg) : null,
          stamp: ring ? box(ring) : null,
          folio: box(document.querySelector(`.${folio}`)!),
          dek: box(document.querySelector(`.${dek}`)!),
          overflowX: document.documentElement.scrollWidth > innerWidth,
          noticeSize: getComputedStyle(document.querySelector(`.${notice}`)!).fontSize,
          footerPadding: getComputedStyle(document.querySelector(`.${footer}`)!).padding,
        };
      },
      {
        hero: profileStyles.hero,
        pleats: profileStyles.pleats,
        stamp: profileStyles.stamp,
        folio: profileStyles.folio,
        dek: profileStyles.dek,
        lineText: profileStyles.lineText,
        notice: demoStyles.notice,
        footer: demoStyles.footer,
      },
    );
  } finally {
    await context.close();
  }
}

const overlaps = (a: Box, b: Box) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
const inside = (a: Box, b: Box) => a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5;

describe("profile renderer layout (Chromium)", () => {
  it("keeps the liner motif clear of the name, the folio and the dek, with no clipping or sideways scroll", async () => {
    for (const [shopKey, demo] of Object.entries(SHOPS)) {
      for (const [profileKey, profile] of Object.entries(PROFILES)) {
        for (const device of ["phone", "desktop"] as const) {
          const label = `${shopKey}/${profileKey}/${device}`;
          const m = await measure(demo, profile, device);
          expect(m.pleats, label).not.toBeNull();
          for (const line of m.name) expect(overlaps(m.pleats!, line), `${label}: liner over the name`).toBe(false);
          expect(overlaps(m.pleats!, m.folio), `${label}: liner over the folio`).toBe(false);
          expect(overlaps(m.pleats!, m.dek), `${label}: liner over the dek`).toBe(false);
          expect(inside(m.pleats!, m.hero), `${label}: liner outside the hero`).toBe(true);
          for (const line of m.name) expect(inside(line, m.hero), `${label}: name clipped by the hero`).toBe(true);
          expect(m.overflowX, `${label}: sideways scroll`).toBe(false);
        }
      }
    }
  });

  it("keeps the stamp ring clear of the name, the folio, the dek and the liner, inside the hero", async () => {
    for (const [shopKey, demo] of Object.entries(SHOPS)) {
      for (const [profileKey, profile] of Object.entries(STAMP_PROFILES)) {
        for (const device of ["phone", "desktop"] as const) {
          const label = `${shopKey}/${profileKey}/${device}`;
          const m = await measure(demo, profile, device);
          expect(m.stamp, label).not.toBeNull();
          for (const line of m.name) expect(overlaps(m.stamp!, line), `${label}: stamp over the name`).toBe(false);
          expect(overlaps(m.stamp!, m.folio), `${label}: stamp over the folio`).toBe(false);
          expect(overlaps(m.stamp!, m.dek), `${label}: stamp over the dek`).toBe(false);
          expect(inside(m.stamp!, m.hero), `${label}: stamp outside the hero`).toBe(true);
          if (profile.motifs.includes("muffin_paper_svg")) {
            expect(m.pleats, label).not.toBeNull();
            expect(overlaps(m.stamp!, m.pleats!), `${label}: stamp over the liner`).toBe(false);
            for (const line of m.name) expect(overlaps(m.pleats!, line), `${label}: liner over the name`).toBe(false);
            expect(inside(m.pleats!, m.hero), `${label}: liner outside the hero`).toBe(true);
          }
          for (const line of m.name) expect(inside(line, m.hero), `${label}: name clipped by the hero`).toBe(true);
          expect(m.overflowX, `${label}: sideways scroll`).toBe(false);
        }
      }
    }
  });

  it("gives a medium hero a lower floor on phones and lets it grow with its content", async () => {
    // Before: a 56svh floor (473px at 844px) even for a short name.
    const short = await measure(SHOPS.short, PROFILES.stacked, "phone");
    expect(short.hero.bottom - short.hero.top).toBeLessThan(0.56 * 844 - 24);
    // With little content the hero is exactly the phone floor, 40svh.
    const bare = await measure(SHOPS.short, { ...PROFILES.stacked, motifs: [] }, "phone");
    expect(bare.hero.bottom - bare.hero.top).toBeCloseTo(0.4 * 844, 0);

    const long = await measure(SHOPS.long, PROFILES.split_crop, "phone");
    expect(long.hero.bottom - long.hero.top).toBeGreaterThan(0.56 * 844);
    for (const line of long.name) expect(inside(line, long.hero)).toBe(true);

    const desktop = await measure(SHOPS.short, PROFILES.stacked, "desktop");
    expect(desktop.hero.bottom - desktop.hero.top).toBeGreaterThanOrEqual(0.56 * 900 - 1);
  });

  it("leaves the notice and the footer of every demo as they were", async () => {
    for (const device of ["phone", "desktop"] as const) {
      const m = await measure(SHOPS.long, PROFILES.split_crop, device);
      expect(m.noticeSize).toBe("12.8px");
      expect(m.footerPadding).toBe("28px 16px 40px");
    }
  });
});
