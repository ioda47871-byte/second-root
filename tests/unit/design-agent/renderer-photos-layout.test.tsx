import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
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

// DEV-029 stage 2: the photo layouts in a real browser, at the review
// screenshot sizes (390 × 844 phone, 1440 × 900 desktop). Fictional shops and
// photos drawn by the test. The module CSS is loaded as written, with its
// class names mapped to the ones the components render in tests.

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

const P = "asset-111111111111111111111111"; // portrait, quiet, generated
const L = "asset-222222222222222222222222"; // landscape, busy, approved
const S = "asset-333333333333333333333333"; // square, quiet, generated
const ASSETS: FakeAsset[] = [
  { id: P, png: fakePng(600, 750, { seed: 1 }), sourceKind: "generated_concept" },
  { id: L, png: fakePng(900, 600, { seed: 2, busy: true }), sourceKind: "approved_real" },
  { id: S, png: fakePng(640, 640, { seed: 3 }), sourceKind: "generated_concept" },
];
const SRC = new Map(ASSETS.map((a) => [a.id, dataUrl(a.png)]));
const MANIFEST = fakeManifest("job-layout", ASSETS);
const ANALYSES = { photos: [fakeAnalysis(P), fakeAnalysis(L, { orientation: "landscape", busy: "busy" }), fakeAnalysis(S, { orientation: "square" })] };

type Place = NonNullable<ImageDirection["hero"]>;
const place = (assetId: string, over: Partial<Place> = {}): Place => ({
  assetId,
  fit: "cover",
  focal: { x: 0.3, y: 0.25 },
  mobileFocal: { x: 0.7, y: 0.6 },
  aspect: { desktop: "4:5", mobile: "1:1" },
  treatment: "natural",
  ...over,
});
const rejectRest = (...used: string[]) => [P, L, S].filter((id) => !used.includes(id)).map((assetId) => ({ assetId, reason: "not_needed" as const }));
const dir = (over: Partial<ImageDirection>): ImageDirection => ({ version: 1, layout: "none", hero: null, features: [], rejected: rejectRest(), paletteFit: 4, ...over });

const DIRECTIONS: Record<string, { direction: ImageDirection; count: number }> = {
  none: { direction: dir({}), count: 0 },
  split_portrait: { direction: dir({ layout: "split_hero", hero: place(P), rejected: rejectRest(P) }), count: 1 },
  split_plus_visit: {
    direction: dir({ layout: "split_hero", hero: place(P), features: [{ ...place(L, { fit: "contain", aspect: { desktop: "3:2", mobile: "4:3" } }), slot: "visit", side: "right" }], rejected: rejectRest(P, L) }),
    count: 2,
  },
  framed_landscape: { direction: dir({ layout: "framed_hero", hero: place(L, { fit: "contain", aspect: { desktop: "4:3", mobile: "3:2" }, treatment: "warm" }), rejected: rejectRest(L) }), count: 1 },
  framed_three: {
    direction: dir({
      layout: "framed_hero",
      hero: place(S, { aspect: { desktop: "1:1", mobile: "4:3" } }),
      features: [
        { ...place(P, { aspect: { desktop: "3:4", mobile: "4:5" }, treatment: "mono" }), slot: "about", side: "left" },
        { ...place(L, { aspect: { desktop: "3:2", mobile: "3:2" } }), slot: "visit", side: "right" },
      ],
      rejected: [],
    }),
    count: 3,
  },
  band_about_square: { direction: dir({ layout: "type_hero_feature_band", features: [{ ...place(S, { aspect: { desktop: "1:1", mobile: "1:1" }, treatment: "mono" }), slot: "about", side: "left" }], rejected: rejectRest(S) }), count: 1 },
  band_two: {
    direction: dir({
      layout: "type_hero_feature_band",
      features: [
        { ...place(L, { aspect: { desktop: "3:2", mobile: "4:3" } }), slot: "about", side: "right" },
        { ...place(P, { fit: "contain", aspect: { desktop: "4:5", mobile: "4:5" } }), slot: "visit", side: "left" },
      ],
      rejected: rejectRest(L, P),
    }),
    count: 2,
  },
};

const SHOPS: Record<string, DemoView> = {
  long: { ...SHOP, name: "EXAMPLE TEST BAKE HOUSE" },
  japanese: { ...SHOP, name: "架空の焼菓子とコーヒーのテスト店", ward: "千種区" },
};
const PROFILES: Record<string, DesignProfile> = {
  editorial: { ...AMERICAN_EDITORIAL, heroLayout: { layout: "split_crop", height: "medium", alignment: "left" }, motifs: ["stamp_ring", "muffin_paper_svg", "location_labels"], motion: { intro: "none", sectionFade: false } },
  condensed: {
    ...AMERICAN_EDITORIAL,
    typography: { ...AMERICAN_EDITORIAL.typography, display: "condensed_grotesk", displayWeight: "black" },
    heroLayout: { layout: "stacked_oversized", height: "full", alignment: "left" },
    composition: { grid: "single_column", infoStyle: "ruled_list", divider: "hairline" },
    motifs: ["ruled_frame", "corner_marks", "monogram"],
    motion: { intro: "none", sectionFade: false },
  },
};
const VIEWPORTS = {
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1440, height: 900 } },
} as const;

type Box = { left: number; top: number; right: number; bottom: number };
type Figure = { box: Box; source: string; label: Box | null; labelVisible: boolean; loaded: boolean; fit: string; position: string; container: string };
type Measure = { figures: Figure[]; text: { what: string; box: Box }[]; hero: Box; split: Box | null; header: Box; nameLines: Box[]; title: Box; overflowX: boolean };

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
});
afterAll(async () => {
  await browser?.close();
});

function photosFor(demo: DemoView, direction: ImageDirection): RenderPhotos | null {
  return resolvePhotos({ demo, manifest: MANIFEST, analyses: ANALYSES, direction, src: (id) => SRC.get(id)! }).photos;
}

async function measure(demo: DemoView, profile: DesignProfile, photos: RenderPhotos | null, device: keyof typeof VIEWPORTS): Promise<Measure> {
  const context = await browser.newContext({ ...VIEWPORTS[device], reducedMotion: "reduce" });
  try {
    const page = await context.newPage();
    const body = renderToStaticMarkup(<ProfileRenderer demo={demo} profile={profile} photos={photos} />);
    await page.setContent(`<!doctype html><html lang="ja"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${CSS}</style></head><body>${body}</body></html>`);
    await page.evaluate(() => Promise.all([...document.images].map((img) => img.decode().catch(() => undefined))));
    const names = ["imageLabel", "heroSplit", "lineText", "folio", "dek", "stamp", "pleats", "monogram", "lead", "visit", "menu", "title"] as const;
    const s = Object.fromEntries(names.map((n) => [n, (profileStyles as Record<string, string>)[n]])) as Record<(typeof names)[number], string>;
    return await page.evaluate((c) => {
      const box = (e: Element) => {
        const r = e.getBoundingClientRect();
        return { left: r.left, top: r.top + scrollY, right: r.right, bottom: r.bottom + scrollY };
      };
      const rects = (e: Element) => [...e.getClientRects()].map((r) => ({ left: r.left, top: r.top + scrollY, right: r.right, bottom: r.bottom + scrollY }));
      const all = (sel: string) => [...document.querySelectorAll(sel)];
      const figures = all("figure").map((f) => {
        const img = f.querySelector("img")!;
        const label = f.querySelector(`.${c.imageLabel}`);
        const style = getComputedStyle(img);
        const ls = label ? getComputedStyle(label) : null;
        const container = f.closest(`.${c.heroSplit}`) ? "split" : f.closest("header") ? "header" : (f.closest("section")?.getAttribute("aria-labelledby") ?? "none");
        return {
          box: box(f),
          source: f.getAttribute("data-source") ?? "",
          label: label ? box(label) : null,
          labelVisible: Boolean(label && ls && ls.visibility === "visible" && ls.display !== "none" && Number(ls.opacity) > 0.99 && label.textContent === "イメージ画像"),
          loaded: img.complete && img.naturalWidth > 0,
          fit: style.objectFit,
          position: style.objectPosition,
          container,
        };
      });
      const text: { what: string; box: { left: number; top: number; right: number; bottom: number } }[] = [];
      const add = (what: string, els: Element[]) => els.forEach((e) => rects(e).forEach((b) => text.push({ what, box: b })));
      add("name", all(`.${c.lineText}`).length ? all(`.${c.lineText}`) : all("h1"));
      add("folio", all(`.${c.folio}`));
      add("dek", all(`.${c.dek}`));
      add("motif", all(`.${c.stamp}, .${c.pleats}, .${c.monogram}`));
      add("heading", all("h2"));
      add("lead", all(`.${c.lead}`));
      add("visit", all(`.${c.visit}`));
      add("menu", all(`.${c.menu}`));
      add("notice", all('[role="note"]'));
      add("footer", all("footer"));
      const header = document.querySelector("header")!;
      return {
        figures,
        text,
        hero: box(document.querySelector(`.${c.heroSplit}`) ?? header),
        split: document.querySelector(`.${c.heroSplit}`) ? box(document.querySelector(`.${c.heroSplit}`)!) : null,
        header: box(header),
        nameLines: rects(header.querySelector("h1")!),
        title: box(header.querySelector(`.${c.title}`)!),
        overflowX: document.documentElement.scrollWidth > innerWidth,
      };
    }, s);
  } finally {
    await context.close();
  }
}

const overlaps = (a: Box, b: Box) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
const inside = (a: Box, b: Box) => a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5;
const ar = (s: string) => {
  const [w, h] = s.split(":").map(Number);
  return w / h;
};
const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;

describe("photo layouts (Chromium, 390 × 844 and 1440 × 900)", () => {
  it("keeps every photo in its own area: no text, motif or other photo on it, nothing clipped, no sideways scroll", async () => {
    for (const [shopKey, demo] of Object.entries(SHOPS)) {
      for (const [profileKey, profile] of Object.entries(PROFILES)) {
        for (const [dirKey, { direction, count }] of Object.entries(DIRECTIONS)) {
          const photos = photosFor(demo, direction);
          if (count > 0) expect(photos, dirKey).not.toBeNull();
          const used = photos ? [...(photos.hero ? [photos.hero] : []), ...photos.features] : [];
          for (const device of ["phone", "desktop"] as const) {
            const label = `${shopKey}/${profileKey}/${dirKey}/${device}`;
            const m = await measure(demo, profile, photos, device);
            expect(m.figures.length, label).toBe(count);
            expect(m.overflowX, `${label}: sideways scroll`).toBe(false);
            for (const line of m.nameLines) expect(inside(line, m.header), `${label}: name clipped`).toBe(true);
            m.figures.forEach((f, i) => {
              const photo = used[i];
              const what = `${label}: photo ${i}`;
              expect(f.loaded, `${what} not loaded`).toBe(true);
              for (const t of m.text) expect(overlaps(f.box, t.box), `${what} over ${t.what}`).toBe(false);
              m.figures.forEach((g, j) => j !== i && expect(overlaps(f.box, g.box), `${what} over photo ${j}`).toBe(false));
              // the generated image label, and only there
              expect(f.label !== null, `${what} label`).toBe(f.source === "generated_concept");
              if (f.label) {
                expect(f.labelVisible, `${what} label hidden`).toBe(true);
                expect(inside(f.label, f.box), `${what} label outside the photo`).toBe(true);
              }
              // fit, crop direction and aspect as directed, per device
              expect(f.fit, what).toBe(photo.fit);
              const focal = device === "phone" ? photo.mobileFocal : photo.focal;
              expect(f.position, what).toBe(`${pct(focal.x)} ${pct(focal.y)}`);
              const want = ar(device === "phone" ? photo.aspect.mobile : photo.aspect.desktop);
              expect(Math.abs((f.box.right - f.box.left) / (f.box.bottom - f.box.top) - want), `${what} aspect`).toBeLessThan(0.02);
            });
            // hero photos inside the hero, feature photos inside their section
            const heroPhotos = m.figures.filter((f) => f.container === "split" || f.container === "header");
            for (const f of heroPhotos) expect(inside(f.box, m.hero), `${label}: hero photo outside the hero`).toBe(true);
            // a split photo has its own column or row: it never reaches into the type hero
            for (const f of m.figures.filter((g) => g.container === "split")) expect(overlaps(f.box, m.header), `${label}: split photo over the type hero`).toBe(false);
            const bands = m.figures.filter((f) => f.container.startsWith("pr-"));
            expect(bands.length, label).toBe(photos?.features.length ?? 0);
          }
        }
      }
    }
  });

  it("changes the page layout itself with the photo: split side by side or stacked, framed beside or above the name", async () => {
    const demo = SHOPS.long;
    const profile = PROFILES.editorial;
    const split = photosFor(demo, DIRECTIONS.split_portrait.direction);
    const phone = await measure(demo, profile, split, "phone");
    expect(phone.figures[0].box.bottom).toBeLessThanOrEqual(phone.header.top + 0.5);
    const desk = await measure(demo, profile, split, "desktop");
    expect(desk.figures[0].box.right).toBeLessThanOrEqual(desk.header.left + 0.5);
    expect(desk.split).not.toBeNull();

    const framed = photosFor(demo, DIRECTIONS.framed_landscape.direction);
    const fPhone = await measure(demo, profile, framed, "phone");
    expect(fPhone.figures[0].box.bottom).toBeLessThanOrEqual(fPhone.title.top + 0.5);
    const fDesk = await measure(demo, profile, framed, "desktop");
    expect(fDesk.figures[0].box.left).toBeGreaterThanOrEqual(fDesk.title.right - 0.5);

    const band = photosFor(demo, DIRECTIONS.band_about_square.direction);
    const bDesk = await measure(demo, profile, band, "desktop");
    const plain = await measure(demo, profile, null, "desktop");
    expect(bDesk.header).toEqual(plain.header);
    expect(bDesk.figures[0].container).toBe("pr-about");
  });

  it("draws no photo when a feature's section is missing, and the same page as without photos", async () => {
    const demo = { ...SHOPS.long, description: null };
    const photos = photosFor(demo, DIRECTIONS.band_about_square.direction);
    expect(photos).toBeNull();
    const m = await measure(demo, PROFILES.editorial, photos, "phone");
    expect(m.figures).toEqual([]);
  });
});
