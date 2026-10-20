import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import demoStyles from "@/components/demo/demo.module.css";
import ProfileRenderer from "@/components/demo/profile/ProfileRenderer";
import profileStyles from "@/components/demo/profile/profile.module.css";
import { DIRECTIONS, type DesignProfile } from "@/lib/design-agent/profile";
import { decodePng } from "@/lib/design-agent/worker/png-paint";
import type { DemoView } from "@/lib/sales/demo-content";
import { AMERICAN_EDITORIAL, SHOP } from "./fixtures";

// DEV-067: every direction draws a page of its own, and heroLayout.alignment
// moves the lower sections. In a real browser at the review sizes, fictional
// shops only: no overflow, every fact still on the page, and the pages differ
// in their computed styles and in their pixels.

vi.setConfig({ testTimeout: 180_000 });

function moduleCss(file: string, names: Record<string, string>): string {
  const css = readFileSync(join(process.cwd(), file), "utf8");
  return css.replace(/\.(-?[_a-zA-Z][\w-]*)/g, (whole, name: string) => (names[name] ? `.${names[name]}` : whole));
}
const CSS = [
  "*, *::before, *::after { box-sizing: border-box; } body { margin: 0; }",
  moduleCss("components/demo/demo.module.css", demoStyles as Record<string, string>),
  moduleCss("components/demo/profile/profile.module.css", profileStyles as Record<string, string>),
].join("\n");
const cls = (name: string) => `.${(profileStyles as Record<string, string>)[name]}`;

const SHOPS: Record<string, DemoView> = {
  full: { ...SHOP, name: "EXAMPLE BAKE" },
  sparseJa: { ...SHOP, name: "架空の焼菓子店", description: null, menuItems: ["季節のタルト"], ward: "千種区" },
};
const VIEWPORTS = {
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1440, height: 900 } },
} as const;

const base: DesignProfile = { ...AMERICAN_EDITORIAL, motion: { intro: "none", sectionFade: false } };
const withDirection = (direction: DesignProfile["direction"], align: "left" | "center" = "left"): DesignProfile => ({
  ...base,
  direction,
  heroLayout: { ...base.heroLayout, alignment: align },
});

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
});
afterAll(async () => {
  await browser?.close();
});

async function open(vp: keyof typeof VIEWPORTS, demo: DemoView, profile: DesignProfile): Promise<Page> {
  const page = await browser.newPage({ ...VIEWPORTS[vp], reducedMotion: "reduce" });
  const html = renderToStaticMarkup(<ProfileRenderer demo={demo} profile={profile} />);
  await page.setContent(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${CSS}</style></head><body>${html}</body></html>`);
  return page;
}

/** Computed styles of the parts a direction draws (headings, menu, folio, address, page ground). */
async function signature(page: Page): Promise<string> {
  return page.evaluate(
    (sel) => {
      const props = ["borderTop", "borderBottom", "borderLeft", "borderRadius", "backgroundColor", "backgroundImage", "boxShadow", "fontStyle", "fontWeight", "fontSize", "letterSpacing", "textDecorationLine", "display", "gridTemplateColumns", "flexDirection"];
      const pick = (el: Element | null) => (el ? props.map((p) => getComputedStyle(el)[p as keyof CSSStyleDeclaration]).join("|") : "-");
      const pseudo = (el: Element | null, which: string) => (el ? ["content", "width", "height", "backgroundColor"].map((p) => getComputedStyle(el, which)[p as keyof CSSStyleDeclaration]).join("|") : "-");
      const heading = document.querySelector(sel.heading);
      return [
        pick(document.querySelector(sel.hero)),
        pick(document.querySelector(sel.title)),
        pick(document.querySelector(sel.dek)),
        pick(document.querySelector(sel.canvas)),
        pick(document.querySelector(sel.main)),
        pick(document.querySelector(sel.folio)),
        pick(heading),
        pick(heading?.firstElementChild ?? null),
        pseudo(heading, "::before"),
        pseudo(heading, "::after"),
        pick(document.querySelector(sel.menu)),
        pick(document.querySelector(sel.menuItem)),
        pick(document.querySelector(sel.menuNo)),
        pick(document.querySelector(sel.address)),
      ].join("\n");
    },
    { hero: cls("hero"), title: cls("title"), dek: cls("dek"), canvas: cls("canvas"), main: cls("main"), folio: cls("folio"), heading: cls("heading"), menu: cls("menu"), menuItem: cls("menuItem"), menuNo: cls("menuNo"), address: cls("address") },
  );
}

/** The pixels of the hero or of the main sections below it. */
async function regionPixels(page: Page, region: "hero" | "main"): Promise<{ width: number; height: number; data: Buffer; channels: number }> {
  const box = await page.locator(cls(region)).boundingBox();
  const png = await page.screenshot({ fullPage: true, clip: { x: 0, y: box!.y, width: box!.width, height: Math.min(box!.height, 1200) } });
  return decodePng(png);
}

function differingShare(a: { data: Buffer; channels: number; width: number; height: number }, b: typeof a): number {
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  let diff = 0;
  for (let y = 0; y < h; y += 2)
    for (let x = 0; x < w; x += 2) {
      const i = (y * a.width + x) * a.channels;
      const j = (y * b.width + x) * b.channels;
      if (Math.abs(a.data[i]! - b.data[j]!) + Math.abs(a.data[i + 1]! - b.data[j + 1]!) + Math.abs(a.data[i + 2]! - b.data[j + 2]!) > 30) diff += 1;
    }
  return diff / (Math.ceil(w / 2) * Math.ceil(h / 2)) + Math.abs(a.height - b.height) / Math.max(a.height, b.height);
}

const FACTS = (demo: DemoView) => [demo.name, ...(demo.description ? [demo.description] : []), ...demo.menuItems, demo.address].filter((v): v is string => Boolean(v));

describe("direction presets (DEV-067)", () => {
  for (const vp of Object.keys(VIEWPORTS) as Array<keyof typeof VIEWPORTS>)
    for (const [shopKey, demo] of Object.entries(SHOPS))
      it(`every direction @${vp} (${shopKey}): no overflow, every fact shown, a page of its own`, async () => {
        const signatures = new Map<string, string>();
        for (const direction of DIRECTIONS)
          for (const align of ["left", "center"] as const) {
            const page = await open(vp, demo, withDirection(direction, align));
            const g = await page.evaluate(
              (sel) => ({
                scrollW: document.documentElement.scrollWidth,
                innerW: window.innerWidth,
                text: document.body.innerText.replace(/\s+/g, ""),
                // facts set in a box under 96px wide over 3+ lines (a squeezed column sets one character per line)
                squeezed: [...document.querySelectorAll(sel)].filter((el) => {
                  const r = el.getBoundingClientRect();
                  const line = parseFloat(getComputedStyle(el).lineHeight) || 24;
                  return r.width < 96 && r.height > line * 2.5;
                }).length,
              }),
              [cls("menuName"), cls("rowValue"), cls("addressValue"), cls("lead")].join(","),
            );
            expect(g.scrollW, `${direction}/${align} overflow`).toBeLessThanOrEqual(g.innerW);
            expect(g.squeezed, `${direction}/${align}: a fact squeezed into a narrow column`).toBe(0);
            for (const fact of FACTS(demo)) expect(g.text, `${direction}/${align}: ${fact}`).toContain(fact.replace(/\s+/g, ""));
            if (align === "left") signatures.set(direction, await signature(page));
            await page.close();
          }
        // every pair of directions differs in its computed styles
        const seen = new Map<string, string>();
        for (const [direction, sig] of signatures) {
          expect(seen.get(sig), `${direction} draws the same as ${seen.get(sig)}`).toBeUndefined();
          seen.set(sig, direction);
        }
      });

  for (const region of ["hero", "main"] as const)
    it(`every pair of directions differs visibly in the ${region} (pixels, desktop and phone)`, async () => {
      for (const vp of Object.keys(VIEWPORTS) as Array<keyof typeof VIEWPORTS>) {
        const shots = new Map<string, Awaited<ReturnType<typeof regionPixels>>>();
        for (const direction of DIRECTIONS) {
          const page = await open(vp, SHOPS.full!, withDirection(direction));
          shots.set(direction, await regionPixels(page, region));
          await page.close();
        }
        const list = [...shots];
        for (let i = 0; i < list.length; i += 1)
          for (let j = i + 1; j < list.length; j += 1) {
            const share = differingShare(list[i]![1], list[j]![1]);
            expect(share, `${vp} ${region}: ${list[i]![0]} vs ${list[j]![0]}`).toBeGreaterThan(0.02);
          }
      }
    });

  it("alignment: center moves the headings, the lead and the menu to the middle of their column; left keeps them at the start", async () => {
    for (const vp of Object.keys(VIEWPORTS) as Array<keyof typeof VIEWPORTS>) {
      for (const align of ["left", "center"] as const) {
        const page = await open(vp, SHOPS.full!, withDirection("nordic_minimal", align));
        const g = await page.evaluate(
          (sel) => {
            const mid = (el: Element) => {
              const r = el.getBoundingClientRect();
              return (r.left + r.right) / 2;
            };
            const text = (el: Element) => {
              const range = document.createRange();
              range.selectNodeContents(el);
              const r = range.getBoundingClientRect();
              return (r.left + r.right) / 2;
            };
            const section = document.querySelector(sel.section)!;
            const heading = section.querySelector(sel.heading)!;
            return { column: mid(heading), heading: text(heading.firstElementChild!), lead: text(document.querySelector(sel.lead)!), menuName: text(document.querySelector(sel.menuName)!), menuItem: mid(document.querySelector(sel.menuItem)!) };
          },
          { section: cls("section"), heading: cls("heading"), lead: cls("lead"), menuName: cls("menuName"), menuItem: cls("menuItem") },
        );
        if (align === "center") {
          expect(Math.abs(g.heading - g.column), `${vp} heading`).toBeLessThan(6);
          expect(Math.abs(g.menuName - g.menuItem), `${vp} menu`).toBeLessThan(24);
        } else {
          expect(g.column - g.heading, `${vp} heading starts left`).toBeGreaterThan(40);
        }
        await page.close();
      }
    }
  });
});
