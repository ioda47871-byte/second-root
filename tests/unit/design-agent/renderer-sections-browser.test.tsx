import { chromium, type Browser, type Page } from "playwright";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import ProfileRenderer from "@/components/demo/profile/ProfileRenderer";
import { normalizeLayout } from "@/lib/design-agent/layout";
import { paletteProblems, type DesignProfile } from "@/lib/design-agent/profile";
import type { DemoView } from "@/lib/sales/demo-content";
import { BASE_PROFILE, coverageLayouts, FULL_SHOP, pageHtml, SPARSE_JP_SHOP, THREE_SHOPS, VIEWPORTS } from "./stage1-fixtures";

// Stage 1 (DEV-071a) in a real browser: every section kind × variant × ground,
// on a 390px and a 360px phone and a 1440px desktop, for a shop with many
// facts and a sparse Japanese shop; then three fictional shops with
// hand-written specs must come out as clearly different pages. Pages are
// batched per browser context.

vi.setConfig({ testTimeout: 300_000 });

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
});
afterAll(async () => {
  await browser?.close();
});

type Check = {
  overflowX: boolean;
  clipped: string[];
  missing: string[];
  notice: boolean;
  footer: boolean;
  lowContrast: string[];
  vertical: string[];
  sections: string[];
};

/** Page facts gathered in the browser (no shop data leaves the test). */
async function check(page: Page, facts: string[]): Promise<Check> {
  return page.evaluate((facts) => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const lum = ([r, g, b]: number[]) => {
      const ch = (v: number) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
    };
    const ratio = (a: number[], b: number[]) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const visible = (e: Element) => {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && Number(s.opacity) > 0;
    };
    const texts: Text[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) if ((walker.currentNode.textContent ?? "").trim()) texts.push(walker.currentNode as Text);
    const clipped: string[] = [];
    for (const t of texts) {
      const range = document.createRange();
      range.selectNodeContents(t);
      for (const r of range.getClientRects()) if (r.width > 0 && (r.left < -0.5 || r.right > innerWidth + 0.5)) clipped.push(t.textContent!.trim().slice(0, 24));
    }
    const flat = (s: string) => s.replace(/\s+/g, "");
    const pageText = flat(document.body.innerText);
    const missing = facts.filter((f) => !pageText.includes(flat(f)));
    const note = document.querySelector('[role="note"]');
    const footer = document.querySelector("footer");
    // inside a band: each word against the band's own ground
    const lowContrast: string[] = [];
    for (const band of document.querySelectorAll('section[data-ground="surface"], section[data-ground="inverted"]')) {
      const bg = rgb(getComputedStyle(band).backgroundColor);
      for (const t of texts) {
        if (!band.contains(t)) continue;
        const el = t.parentElement!;
        // the nearest ground between the word and the band
        let ground = bg;
        for (let e: Element | null = el; e && e !== band; e = e.parentElement) {
          const c = getComputedStyle(e).backgroundColor;
          if (rgb(c).length >= 3 && (rgb(c)[3] ?? 1) > 0) {
            ground = rgb(c);
            break;
          }
        }
        const r = ratio(rgb(getComputedStyle(el).color), ground);
        if (r < 4.5) lowContrast.push(`${band.getAttribute("data-kind")}:${t.textContent!.trim().slice(0, 16)}:${r.toFixed(2)}`);
      }
    }
    const vertical = [...document.querySelectorAll("*")]
      .filter((e) => getComputedStyle(e).writingMode.startsWith("vertical") && e.children.length === 0 && (e.textContent ?? "").trim())
      .map((e) => e.textContent!.trim());
    return {
      overflowX: document.documentElement.scrollWidth > innerWidth,
      clipped,
      missing,
      notice: Boolean(note && visible(note) && note.textContent!.includes("公式サイトではありません")),
      footer: Boolean(footer && visible(footer) && footer.textContent!.includes("公式サイト・公式情報ではありません")),
      lowContrast,
      vertical,
      sections: [...document.querySelectorAll("section[data-kind]")].map((s) => `${s.getAttribute("data-kind")}/${s.getAttribute("data-variant")}/${s.getAttribute("data-ground")}`),
    };
  }, facts);
}

const factsOf = (demo: DemoView) =>
  [demo.name, demo.address, demo.hours, demo.closedDays, demo.access, demo.phone, demo.description, ...demo.menuItems].filter((v): v is string => Boolean(v));

const JAPANESE_ONLY = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々〆ヶ・]+$/u;

describe("sections in Chromium", () => {
  it("every kind × variant × ground: no sideways scroll or cut text, every fact shown, notices kept, band ink readable, vertical text on desktop only", async () => {
    const shops: Record<string, DemoView> = { full: FULL_SHOP, sparse_jp: SPARSE_JP_SHOP };
    const seen = new Set<string>();
    expect(paletteProblems(BASE_PROFILE.palette)).toEqual([]);
    for (const device of ["phone", "narrow", "desktop"] as const) {
      const context = await browser.newContext({ ...VIEWPORTS[device], reducedMotion: "reduce" });
      const page = await context.newPage();
      try {
        for (const [shopKey, demo] of Object.entries(shops)) {
          for (const { key, layout } of coverageLayouts()) {
            const label = `${shopKey}/${key}/${device}`;
            const profile: DesignProfile = { ...BASE_PROFILE, layout };
            await page.setContent(pageHtml(renderToStaticMarkup(<ProfileRenderer demo={demo} profile={profile} />)));
            const m = await check(page, factsOf(demo));
            const normal = normalizeLayout(layout, demo).layout;
            expect(m.sections, label).toEqual(normal.sections.map((s) => `${s.kind}/${s.variant}/${s.ground}`));
            m.sections.forEach((s) => seen.add(s));
            expect(m.overflowX, `${label}: sideways scroll`).toBe(false);
            expect(m.clipped, `${label}: text outside the page`).toEqual([]);
            expect(m.missing, `${label}: facts not shown`).toEqual([]);
            expect(m.notice, `${label}: notice bar`).toBe(true);
            expect(m.footer, `${label}: footer notice`).toBe(true);
            expect(m.lowContrast, `${label}: band ink`).toEqual([]);
            if (device === "desktop") {
              for (const v of m.vertical) expect(v, `${label}: vertical text`).toMatch(JAPANESE_ONLY);
              if (normal.type.headings === "vertical_ja") expect(m.vertical.length, `${label}: vertical headings`).toBeGreaterThanOrEqual(normal.sections.length);
              if (normal.firstView === "vertical_name") expect(m.vertical, label).toContain(demo.name);
            } else {
              expect(m.vertical, `${label}: vertical text on a phone`).toEqual([]);
            }
          }
        }
      } finally {
        await context.close();
      }
    }
    // the full shop drew every kind × variant × ground
    expect(seen.size).toBe(13 * 3);
  });
});

describe("three fictional shops", () => {
  it("come out as clearly different pages: section order, variants, first view and pixels", async () => {
    const keys = Object.keys(THREE_SHOPS);
    const signature = (k: string) => {
      const { demo, profile } = THREE_SHOPS[k];
      const n = normalizeLayout(profile.layout!, demo).layout;
      return { order: n.sections.map((s) => s.kind).join(">"), variants: n.sections.map((s) => `${s.kind}:${s.variant}:${s.ground}`), firstView: n.firstView };
    };
    for (const k of keys) expect(paletteProblems(THREE_SHOPS[k].profile.palette), k).toEqual([]);
    for (const [i, a] of keys.entries()) {
      for (const b of keys.slice(i + 1)) {
        const [sa, sb] = [signature(a), signature(b)];
        expect(sa.order, `${a}/${b}: order`).not.toBe(sb.order);
        expect(sa.firstView, `${a}/${b}: first view`).not.toBe(sb.firstView);
        expect(sa.variants.filter((v) => sb.variants.includes(v)), `${a}/${b}: shared section settings`).toEqual([]);
      }
    }

    for (const device of ["phone", "desktop"] as const) {
      const context = await browser.newContext({ ...VIEWPORTS[device], reducedMotion: "reduce" });
      const page = await context.newPage();
      try {
        const shots: Record<string, string> = {};
        for (const k of keys) {
          const { demo, profile } = THREE_SHOPS[k];
          await page.setContent(pageHtml(renderToStaticMarkup(<ProfileRenderer demo={demo} profile={profile} />)));
          const m = await check(page, factsOf(demo));
          expect(m.overflowX, `${k}/${device}`).toBe(false);
          expect(m.missing, `${k}/${device}`).toEqual([]);
          expect(m.lowContrast, `${k}/${device}`).toEqual([]);
          // the first screen and the page below it, at a fixed size
          shots[k] = (await page.screenshot({ fullPage: true, clip: { x: 0, y: 0, width: VIEWPORTS[device].viewport.width, height: 2400 } })).toString("base64");
        }
        // share of pixels that differ clearly between two pages (compared in the page's canvas)
        for (const [i, a] of keys.entries()) {
          for (const b of keys.slice(i + 1)) {
            const share = await page.evaluate(async ([x, y]) => {
              const load = (src: string) =>
                new Promise<HTMLImageElement>((resolve) => {
                  const img = new Image();
                  img.onload = () => resolve(img);
                  img.src = `data:image/png;base64,${src}`;
                });
              const [ia, ib] = await Promise.all([load(x), load(y)]);
              const w = Math.min(ia.width, ib.width);
              const h = Math.min(ia.height, ib.height);
              const pixels = (img: HTMLImageElement) => {
                const c = document.createElement("canvas");
                c.width = w;
                c.height = h;
                const ctx = c.getContext("2d")!;
                ctx.drawImage(img, 0, 0);
                return ctx.getImageData(0, 0, w, h).data;
              };
              const [pa, pb] = [pixels(ia), pixels(ib)];
              let differ = 0;
              for (let p = 0; p < pa.length; p += 4) if (Math.abs(pa[p] - pb[p]) + Math.abs(pa[p + 1] - pb[p + 1]) + Math.abs(pa[p + 2] - pb[p + 2]) > 48) differ++;
              return differ / (w * h);
            }, [shots[a], shots[b]] as const);
            expect(share, `${a}/${b}/${device}: share of differing pixels`).toBeGreaterThan(0.25);
          }
        }
      } finally {
        await context.close();
      }
    }
  });
});
