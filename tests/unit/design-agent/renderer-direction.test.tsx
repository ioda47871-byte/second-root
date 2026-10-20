import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import demoStyles from "@/components/demo/demo.module.css";
import ProfileRenderer from "@/components/demo/profile/ProfileRenderer";
import profileStyles from "@/components/demo/profile/profile.module.css";
import { checkProfile, DIRECTIONS, type DesignProfile } from "@/lib/design-agent/profile";
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

  it("alignment: center moves the headings and the menu to the middle of their column, left keeps them at the start (every direction)", async () => {
    for (const vp of Object.keys(VIEWPORTS) as Array<keyof typeof VIEWPORTS>)
      for (const direction of DIRECTIONS) {
        const mids: Record<string, { heading: number; column: number; menu: number; menuBox: number }> = {};
        for (const align of ["left", "center"] as const) {
          const page = await open(vp, SHOPS.full!, withDirection(direction, align));
          mids[align] = await page.evaluate(
            (sel) => {
              const contentMid = (el: Element) => {
                const r = el.getBoundingClientRect();
                const cs = getComputedStyle(el);
                const l = r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
                const rr = r.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight);
                return (l + rr) / 2;
              };
              const textMid = (els: Element[]) => {
                const rects = els.map((el) => {
                  const range = document.createRange();
                  range.selectNodeContents(el);
                  return range.getBoundingClientRect();
                });
                return (Math.min(...rects.map((r) => r.left)) + Math.max(...rects.map((r) => r.right))) / 2;
              };
              const heading = document.querySelector(sel.heading)!;
              const menu = document.querySelector(sel.menu)!;
              // the heading's first word as drawn (its box includes any mark the direction adds beside it)
              const first = heading.firstElementChild!.getBoundingClientRect();
              return { heading: (first.left + first.right) / 2, column: contentMid(heading), menu: textMid([...menu.querySelectorAll(sel.menuName)]), menuBox: contentMid(menu) };
            },
            { heading: cls("heading"), menu: cls("menu"), menuName: cls("menuName") },
          );
          await page.close();
        }
        const c = mids.center!;
        const l = mids.left!;
        expect(Math.abs(c.heading - c.column), `${vp} ${direction}: centred heading`).toBeLessThan(8);
        expect(Math.abs(c.menu - c.menuBox), `${vp} ${direction}: centred menu`).toBeLessThan(28);
        expect(l.column - l.heading, `${vp} ${direction}: left heading starts left`).toBeGreaterThan(20);
      }
  });

  // ---- DEV-067 review: contrast, grid headings, long names, more profiles

  // A palette checkProfile accepts, where every pair it does NOT guarantee reads badly:
  // primary / secondary on the surface ≈ 1.8:1.
  const ADVERSE: DesignProfile["palette"] = { background: "#FBF7EF", surface: "#B07A4F", text: "#000000", primary: "#8A4B22", secondary: "#6E5A44", accent: "#D4A017" };

  it("every word is set in a colour pair the palette rules guarantee (an adversarial palette, every direction)", async () => {
    expect(checkProfile({ ...base, palette: ADVERSE }).ok).toBe(true);
    const guaranteed: Array<[string, string]> = [
      ["text", "background"],
      ["text", "surface"],
      ["primary", "background"],
      ["background", "primary"],
      ["secondary", "background"],
    ];
    const tokens = Object.entries(ADVERSE).map(([k, hex]) => [k, `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`] as const);
    const token = (rgb: string) => tokens.find(([, v]) => v === rgb)?.[0] ?? rgb;
    const motifSets: DesignProfile["motifs"][] = [
      ["monogram", "location_labels", "muffin_paper_svg", "corner_marks"],
      ["stamp_ring", "dot_grid", "ruled_frame", "location_labels"],
    ];
    for (const vp of ["phone", "desktop"] as const)
      for (const direction of DIRECTIONS)
        for (const motifs of motifSets) {
          const page = await open(vp, SHOPS.full!, { ...withDirection(direction), palette: ADVERSE, motifs });
          const pairs = await page.evaluate(() => {
            const out: Array<{ text: string; fg: string; bg: string }> = [];
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            for (let n = walker.nextNode(); n; n = walker.nextNode()) {
              const text = (n.textContent ?? "").trim();
              const el = n.parentElement;
              if (!text || !el) continue;
              const cs = getComputedStyle(el);
              const r = el.getBoundingClientRect();
              if (cs.visibility === "hidden" || cs.display === "none" || r.width === 0 || r.height === 0 || Number(cs.opacity) === 0) continue;
              let bg = "";
              for (let a: Element | null = el; a; a = a.parentElement) {
                const c = getComputedStyle(a).backgroundColor;
                if (c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent") {
                  bg = c;
                  break;
                }
              }
              out.push({ text: text.slice(0, 24), fg: cs.color, bg });
            }
            return out;
          });
          await page.close();
          for (const p of pairs) {
            const pair: [string, string] = [token(p.fg), token(p.bg)];
            expect(guaranteed.some(([f, b]) => f === pair[0] && b === pair[1]), `${vp} ${direction} [${motifs.join(",")}]: "${p.text}" is ${pair[0]} on ${pair[1]}`).toBe(true);
          }
        }
  });

  it("desktop grids: a heading stays at the top of its row (it does not stretch with the content)", async () => {
    for (const grid of ["editorial_12", "asymmetric_7_5"] as const)
      for (const direction of DIRECTIONS) {
        const page = await open("desktop", SHOPS.full!, { ...withDirection(direction), composition: { ...base.composition, grid } });
        // the stretch = the heading's height now minus its height when held at the top of its row
        const slack = await page.evaluate((sel) => {
          return [...document.querySelectorAll(sel)].map((h) => {
            const el = h as HTMLElement;
            const now = el.getBoundingClientRect().height;
            el.style.alignSelf = "start";
            const own = el.getBoundingClientRect().height;
            el.style.alignSelf = "";
            return now - own;
          });
        }, cls("heading"));
        await page.close();
        for (const v of slack) expect(v, `${grid} ${direction}: heading stretched by ${Math.round(v)}px`).toBeLessThan(1);
      }
  });

  it("long spaced Latin names: no direction breaks a word where the frameless page does not (360 and 390)", async () => {
    const names = ["Patisserie Mademoiselle Coquelicot", "Konditorei Schwarzwaldhaus", "BOULANGERIE PATISSERIE LUMIERE"];
    const brokenWords = (page: Page) =>
      page.evaluate(() => {
        const h = document.querySelector("h1")!;
        let broken = 0;
        const walker = document.createTreeWalker(h, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const text = n.textContent ?? "";
          for (const m of text.matchAll(/\S+/g)) {
            const range = document.createRange();
            range.setStart(n, m.index!);
            range.setEnd(n, m.index! + m[0].length);
            const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
            if (tops.size > 1) broken += 1;
          }
        }
        return broken;
      });
    for (const width of [360, 390])
      for (const name of names)
        for (const layout of ["split_crop", "centered_cover", "stacked_oversized"] as const) {
          const counts = new Map<string, number>();
          for (const direction of DIRECTIONS) {
            const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
            const profile = { ...withDirection(direction), heroLayout: { layout, height: "medium" as const, alignment: "left" as const } };
            const html = renderToStaticMarkup(<ProfileRenderer demo={{ ...SHOP, name }} profile={profile} />);
            await page.setContent(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${CSS}</style></head><body>${html}</body></html>`);
            counts.set(direction, await brokenWords(page));
            await page.close();
          }
          const baseline = counts.get("nordic_minimal")!; // no frame around the name
          for (const [direction, n] of counts) expect(n, `${width} ${layout} "${name}" ${direction}`).toBeLessThanOrEqual(baseline);
        }
  });

  const VARIANTS: Record<string, Partial<DesignProfile>> = {
    tightLedgerSingle: {
      spacing: { scale: "tight" },
      composition: { grid: "single_column", infoStyle: "ledger_columns", divider: "thick_rule" },
      heroLayout: { layout: "centered_cover", height: "medium", alignment: "center" },
      motifs: ["ruled_frame", "dot_grid", "stamp_ring", "location_labels"],
    },
    ruledAsymmetric: {
      composition: { grid: "asymmetric_7_5", infoStyle: "ruled_list", divider: "none" },
      heroLayout: { layout: "stacked_oversized", height: "full", alignment: "left" },
      motifs: ["corner_marks", "muffin_paper_svg", "monogram"],
    },
  };
  for (const [key, over] of Object.entries(VARIANTS))
    it(`${key}: every direction at 360 / 390 / 1440, long name too: no overflow, every fact, no squeezed column`, async () => {
      const sizes = { phone360: { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true }, phone390: VIEWPORTS.phone, desktop: VIEWPORTS.desktop };
      for (const [vp, opts] of Object.entries(sizes))
        for (const demo of [SHOPS.full!, { ...SHOP, name: "Patisserie Mademoiselle Coquelicot" }, SHOPS.sparseJa!])
          for (const direction of DIRECTIONS) {
            const page = await browser.newPage({ ...opts, reducedMotion: "reduce" });
            const html = renderToStaticMarkup(<ProfileRenderer demo={demo} profile={{ ...withDirection(direction), ...over }} />);
            await page.setContent(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${CSS}</style></head><body>${html}</body></html>`);
            const g = await page.evaluate(
              (sel) => ({
                scrollW: document.documentElement.scrollWidth,
                innerW: window.innerWidth,
                text: document.body.innerText.replace(/\s+/g, ""),
                squeezed: [...document.querySelectorAll(sel)].filter((el) => {
                  const r = el.getBoundingClientRect();
                  const line = parseFloat(getComputedStyle(el).lineHeight) || 24;
                  return r.width < 96 && r.height > line * 2.5;
                }).length,
              }),
              [cls("menuName"), cls("rowValue"), cls("addressValue"), cls("lead")].join(","),
            );
            expect(g.scrollW, `${key} ${vp} ${direction} ${demo.name}: overflow`).toBeLessThanOrEqual(g.innerW);
            expect(g.squeezed, `${key} ${vp} ${direction}: squeezed`).toBe(0);
            for (const fact of FACTS(demo)) expect(g.text, `${key} ${vp} ${direction}: ${fact}`).toContain(fact.replace(/\s+/g, ""));
            await page.close();
          }
    });
});
