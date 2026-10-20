import { chromium, type Browser, type Page } from "playwright";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { areaLabel } from "@/components/demo/info";
import ProfileRenderer from "@/components/demo/profile/ProfileRenderer";
import { normalizeLayout } from "@/lib/design-agent/layout";
import { checkProfile, DIRECTIONS, paletteProblems, type DesignProfile } from "@/lib/design-agent/profile";
import type { DemoView } from "@/lib/sales/demo-content";
import { BASE_PROFILE, coverageLayouts, DESKTOP_MIN, PALETTES, SWEEP_WIDTHS, sweepViewport, FULL_SHOP, pageHtml, SPARSE_JP_SHOP, THREE_SHOPS, VIEWPORTS } from "./stage1-fixtures";

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
  long: number;
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
      // vertical headings are set only when no section is short (one page never mixes the two)
      long: document.querySelector("section[data-kind][data-short]") ? 0 : document.querySelectorAll("section[data-kind]").length,
      sections: [...document.querySelectorAll("section[data-kind]")].map((s) => `${s.getAttribute("data-kind")}/${s.getAttribute("data-variant")}/${s.getAttribute("data-ground")}`),
    };
  }, facts);
}

const factsOf = (demo: DemoView) =>
  [demo.name, demo.address, demo.hours, demo.closedDays, demo.access, demo.phone, demo.description, ...demo.menuItems].filter((v): v is string => Boolean(v));

const JAPANESE_ONLY = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々〆ヶ・]+$/u;

describe("sections in Chromium", () => {
  it("every kind × variant × ground at every width (320 to 1440, each breakpoint ±1px): no sideways scroll or cut text, every fact shown, notices kept, band ink readable, vertical text on desktop only", async () => {
    const shops: Record<string, DemoView> = { full: FULL_SHOP, sparse_jp: SPARSE_JP_SHOP };
    const seen = new Set<string>();
    expect(paletteProblems(BASE_PROFILE.palette)).toEqual([]);
    for (const width of SWEEP_WIDTHS) {
      const device = `${width}px`;
      const context = await browser.newContext({ ...sweepViewport(width), reducedMotion: "reduce" });
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
            expect.soft(m.overflowX, `${label}: sideways scroll`).toBe(false);
            expect.soft(m.clipped, `${label}: text outside the page`).toEqual([]);
            expect.soft(m.missing, `${label}: facts not shown`).toEqual([]);
            expect(m.notice, `${label}: notice bar`).toBe(true);
            expect(m.footer, `${label}: footer notice`).toBe(true);
            expect(m.lowContrast, `${label}: band ink`).toEqual([]);
            if (width >= DESKTOP_MIN) {
              for (const v of m.vertical) expect(v, `${label}: vertical text`).toMatch(JAPANESE_ONLY);
              // a section with little content (data-short) keeps a horizontal heading
              if (normal.type.headings === "vertical_ja") expect(m.vertical.length, `${label}: vertical headings`).toBeGreaterThanOrEqual(m.long);
              // (the hero's vertical name and its caption are not headings)
              if (m.long === 0) expect(m.vertical.filter((v) => v !== demo.name && v !== areaLabel(demo)), `${label}: mixed heading directions`).toEqual([]);
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

describe("every direction at every width (DEV-071b)", () => {
  // DIRECTIONS restyle the sections (panels, frames, tiles): each one, with the
  // layouts that use every variant, at every sweep width.
  for (const direction of DIRECTIONS)
    it(`${direction}: no sideways scroll, no text outside the page, every fact shown`, async () => {
      const layouts = [...coverageLayouts(), ...Object.values(THREE_SHOPS).map((v) => ({ key: "three", layout: v.profile.layout! }))];
      for (const width of SWEEP_WIDTHS) {
        const context = await browser.newContext({ ...sweepViewport(width), reducedMotion: "reduce" });
        const page = await context.newPage();
        try {
          for (const [shopKey, demo] of Object.entries({ full: FULL_SHOP, sparse_jp: SPARSE_JP_SHOP })) {
            for (const { key, layout } of layouts.filter((_, i) => shopKey === "full" || i % 3 === 0)) {
              const label = `${direction}/${shopKey}/${key}/${width}px`;
              await page.setContent(pageHtml(renderToStaticMarkup(<ProfileRenderer demo={demo} profile={{ ...BASE_PROFILE, direction, layout }} />)));
              const m = await check(page, factsOf(demo));
              expect.soft(m.overflowX, `${label}: sideways scroll`).toBe(false);
              expect.soft(m.clipped, `${label}: text outside the page`).toEqual([]);
              expect.soft(m.missing, `${label}: facts not shown`).toEqual([]);
            }
          }
        } finally {
          await context.close();
        }
      }
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
        const doms: Record<string, string> = {};
        for (const k of keys) {
          const { demo, profile } = THREE_SHOPS[k];
          await page.setContent(pageHtml(renderToStaticMarkup(<ProfileRenderer demo={demo} profile={profile} />)));
          const m = await check(page, factsOf(demo));
          doms[k] = m.sections.join(">");
          expect(m.overflowX, `${k}/${device}`).toBe(false);
          expect(m.missing, `${k}/${device}`).toEqual([]);
          expect(m.lowContrast, `${k}/${device}`).toEqual([]);
          // the first screen and the page below it, at a fixed size
          shots[k] = (await page.screenshot({ fullPage: true, clip: { x: 0, y: 0, width: VIEWPORTS[device].viewport.width, height: 2400 } })).toString("base64");
        }
        // the drawn pages differ in structure: section order, variants and grounds in the DOM
        for (const [i, a] of keys.entries()) for (const b of keys.slice(i + 1)) expect(doms[a], `${a}/${b}/${device}: DOM sections`).not.toBe(doms[b]);
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

// ------------------------------------------------------------ quality and colour pairs

const VERTICAL_SHOP: DemoView = { ...FULL_SHOP, name: "麦と灯", category: "bakery", template: "bakery_v1" };
const VERTICAL_SIX: DemoView = { ...VERTICAL_SHOP, name: "架空焼菓子店" };

type Quality = {
  headingSizes: number[];
  nameSize: number;
  nameBox: { width: number; height: number };
  hero: { width: number; height: number };
  stretched: string[];
  footerGap: number | null;
  /** vertical_name: horizontal distance from the area label to the name column, and the name column's width */
  captionGap: number | null;
  nameWidth: number;
  /** the largest rectangle of the hero with no word, motif or photo in it, as a share of the hero */
  emptyShare: number;
};

async function quality(page: Page): Promise<Quality> {
  return page.evaluate(() => {
    const h1 = document.querySelector("h1")!;
    const hero = document.querySelector("header")!;
    const stretched: string[] = [];
    // a chip, a column item or a list never grows past its own content
    for (const list of document.querySelectorAll("section[data-kind='menu'] ol")) {
      const el = list as HTMLElement;
      const now = el.getBoundingClientRect().height;
      el.style.alignSelf = "start";
      const own = el.getBoundingClientRect().height;
      el.style.alignSelf = "";
      if (now - own > 1) stretched.push(`list +${Math.round(now - own)}`);
      // each item at its own height: as tall as when nothing around it may stretch it
      const items = [...el.querySelectorAll("li")] as HTMLElement[];
      const before = items.map((li) => li.getBoundingClientRect().height);
      el.style.alignSelf = "start";
      el.style.alignItems = "flex-start";
      el.style.alignContent = "flex-start";
      items.forEach((li, i) => {
        const own = li.getBoundingClientRect().height;
        if (before[i] - own > 1) stretched.push(`${li.textContent} +${Math.round(before[i] - own)}`);
      });
      el.style.alignSelf = el.style.alignItems = el.style.alignContent = "";
    }
    const main = document.querySelector("main")!;
    const last = main.lastElementChild;
    const footer = document.querySelector("footer")!;
    const band = last && ["surface", "inverted"].includes(last.getAttribute("data-ground") ?? "");
    // the largest empty rectangle of the hero, on an 8px grid (words, motifs, photos are content;
    // the frame and corner lines are not)
    const hb = hero.getBoundingClientRect();
    const cell = 8;
    const cols = Math.ceil(hb.width / cell);
    const rows = Math.ceil(hb.height / cell);
    const busy = Array.from({ length: rows }, () => new Uint8Array(cols));
    const mark = (r: DOMRect) => {
      if (r.width === 0 || r.height === 0) return;
      for (let y = Math.max(0, Math.floor((r.top - hb.top) / cell)); y < Math.min(rows, Math.ceil((r.bottom - hb.top) / cell)); y++)
        for (let x = Math.max(0, Math.floor((r.left - hb.left) / cell)); x < Math.min(cols, Math.ceil((r.right - hb.left) / cell)); x++) busy[y][x] = 1;
    };
    const walker = document.createTreeWalker(hero, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!(n.textContent ?? "").trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) mark(r);
    }
    for (const el of hero.querySelectorAll("svg, figure, [aria-hidden='true'] > span")) mark(el.getBoundingClientRect());
    let best = 0;
    const heights = new Array(cols).fill(0);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) heights[x] = busy[y][x] ? 0 : heights[x] + 1;
      const stack: number[] = [];
      for (let x = 0; x <= cols; x++) {
        const h = x === cols ? 0 : heights[x];
        while (stack.length && heights[stack[stack.length - 1]] >= h) {
          const top = heights[stack.pop()!];
          const left = stack.length ? stack[stack.length - 1] + 1 : 0;
          best = Math.max(best, top * (x - left));
        }
        stack.push(x);
      }
    }
    const dek = hero.querySelector("p");
    const nameRect = h1.getBoundingClientRect();
    const dekRange = dek ? document.createRange() : null;
    dekRange?.selectNodeContents(dek!);
    const dr = dekRange?.getBoundingClientRect();
    return {
      captionGap: dr && getComputedStyle(dek!).writingMode.startsWith("vertical") ? nameRect.left - dr.right : null,
      nameWidth: nameRect.width,
      emptyShare: best / (rows * cols),
      headingSizes: [...document.querySelectorAll("section > h2")].map((h) => parseFloat(getComputedStyle(h).fontSize)),
      nameSize: parseFloat(getComputedStyle(h1).fontSize),
      nameBox: { width: h1.getBoundingClientRect().width, height: h1.getBoundingClientRect().height },
      hero: { width: hero.getBoundingClientRect().width, height: hero.getBoundingClientRect().height },
      stretched,
      footerGap: band ? footer.getBoundingClientRect().top - last!.getBoundingClientRect().bottom : null,
    };
  });
}

describe("layout quality in Chromium", () => {
  it("vertical name leads the desktop hero; headings agree in size; lists are not stretched; a final band meets the footer", async () => {
    for (const device of ["phone", "desktop"] as const) {
      const context = await browser.newContext({ ...VIEWPORTS[device], reducedMotion: "reduce" });
      const page = await context.newPage();
      try {
        for (const direction of DIRECTIONS) {
          for (const [key, { demo, profile }] of [...Object.entries(THREE_SHOPS), ["vertical-full", { demo: VERTICAL_SHOP, profile: THREE_SHOPS.bakery.profile }] as const, ["vertical-six", { demo: VERTICAL_SIX, profile: THREE_SHOPS.bakery.profile }] as const, ["vertical-motifs", { demo: VERTICAL_SHOP, profile: { ...THREE_SHOPS.bakery.profile, motifs: ["stamp_ring", "muffin_paper_svg", "ruled_frame"] as DesignProfile["motifs"] } }] as const]) {
            const label = `${key}/${direction}/${device}`;
            await page.setContent(pageHtml(renderToStaticMarkup(<ProfileRenderer demo={demo} profile={{ ...profile, direction }} />)));
            const q = await quality(page);
            // one heading size per page (a variant does not shrink its heading)
            expect(new Set(q.headingSizes.map((v) => Math.round(v))).size, `${label}: heading sizes ${q.headingSizes}`).toBeLessThanOrEqual(1);
            expect(q.stretched, `${label}: stretched`).toEqual([]);
            if (direction !== "boutique_minimal" && q.footerGap !== null) expect(Math.abs(q.footerGap), `${label}: band to footer`).toBeLessThan(1);
            if (device === "desktop" && profile.layout?.firstView === "vertical_name") {
              expect(q.nameSize, `${label}: name size vs headings`).toBeGreaterThanOrEqual(2 * Math.max(...q.headingSizes));
              expect(q.nameBox.height / q.hero.height, `${label}: name column height`).toBeGreaterThan(0.5);
              // the area label is a caption beside the name, and the hero has no large unused field
              expect(q.captionGap, `${label}: caption beside the name`).not.toBeNull();
              expect(q.captionGap!, `${label}: caption to name`).toBeLessThanOrEqual(q.nameWidth);
              // The same shop without a layout (the name across the hero) as the yardstick:
              // choosing vertical_name must not leave more of the first screen unused.
              const { layout: _l, ...plain } = { ...profile, direction };
              void _l;
              await page.setContent(pageHtml(renderToStaticMarkup(<ProfileRenderer demo={demo} profile={plain} />)));
              const base = await quality(page);
              expect(q.emptyShare, `${label}: largest empty rectangle vs the same shop without a layout (${base.emptyShare.toFixed(2)})`).toBeLessThanOrEqual(base.emptyShare + 0.01);
              expect(q.emptyShare, `${label}: largest empty rectangle of the hero`).toBeLessThanOrEqual(0.43);
            }
          }
        }
      } finally {
        await context.close();
      }
    }
  });

  it("every word is set in a colour pair the palette guarantees: every direction × adversarial palettes × layouts, alpha and opacity included", async () => {
    const guaranteed: Array<[string, string]> = [
      ["text", "background"],
      ["text", "surface"],
      ["primary", "background"],
      ["background", "primary"],
      ["secondary", "background"],
    ];
    const layouts = coverageLayouts().filter((_, i) => i % 3 === 0);
    for (const [paletteKey, palette] of Object.entries(PALETTES)) expect(checkProfile({ ...BASE_PROFILE, palette }).ok, paletteKey).toBe(true);
    for (const device of ["phone", "desktop"] as const) {
      const context = await browser.newContext({ ...VIEWPORTS[device], reducedMotion: "reduce" });
      const page = await context.newPage();
      try {
        for (const [paletteKey, palette] of Object.entries(PALETTES)) {
          const rgb = (hex: string) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
          const tokens = Object.entries(palette).map(([k, hex]) => [k, rgb(hex)] as const);
          const token = (c: string) => tokens.find(([, v]) => v === c)?.[0] ?? c;
          for (const direction of DIRECTIONS) {
            for (const { key, layout } of [...layouts, ...Object.entries(THREE_SHOPS).map(([k, v]) => ({ key: k, layout: v.profile.layout! }))]) {
              const label = `${paletteKey}/${direction}/${key}/${device}`;
              await page.setContent(pageHtml(renderToStaticMarkup(<ProfileRenderer demo={FULL_SHOP} profile={{ ...BASE_PROFILE, direction, palette, layout }} />)));
              const pairs = await page.evaluate(() => {
                const out: Array<{ text: string; fg: string; bg: string; faded: boolean }> = [];
                const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                for (let n = walker.nextNode(); n; n = walker.nextNode()) {
                  const text = (n.textContent ?? "").trim();
                  const el = n.parentElement;
                  if (!text || !el) continue;
                  const cs = getComputedStyle(el);
                  const r = el.getBoundingClientRect();
                  if (cs.visibility === "hidden" || cs.display === "none" || r.width === 0 || r.height === 0) continue;
                  // any transparency on the way (a colour's alpha, an ancestor's opacity) changes the pair
                  let faded = /rgba|\/ /.test(cs.color);
                  let bg = "";
                  for (let a: Element | null = el; a; a = a.parentElement) {
                    const s = getComputedStyle(a);
                    if (Number(s.opacity) < 1) faded = true;
                    const c = s.backgroundColor;
                    if (!bg && c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent") {
                      bg = c;
                      if (/rgba/.test(c)) faded = true;
                    }
                  }
                  out.push({ text: text.slice(0, 24), fg: cs.color, bg, faded });
                }
                return out;
              });
              for (const p of pairs) {
                const pair: [string, string] = [token(p.fg), token(p.bg)];
                expect(p.faded, `${label}: "${p.text}" is not opaque`).toBe(false);
                // contrast is symmetric: a guaranteed pair may be set either way round (a badge in a band)
                expect(guaranteed.some(([f, b]) => (f === pair[0] && b === pair[1]) || (f === pair[1] && b === pair[0])), `${label}: "${p.text}" is ${pair[0]} on ${pair[1]}`).toBe(true);
              }
            }
          }
        }
      } finally {
        await context.close();
      }
    }
  });
});
