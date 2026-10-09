import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import demoStyles from "@/components/demo/demo.module.css";
import ProfileRenderer from "@/components/demo/profile/ProfileRenderer";
import profileStyles from "@/components/demo/profile/profile.module.css";
import type { ImageDirection } from "@/lib/design-agent/assets/direction";
import { checkRenderedPhotos } from "@/lib/design-agent/assets/render-check";
import { resolvePhotos } from "@/lib/design-agent/assets/resolve";
import { capturePage, SHOT_CAP } from "@/lib/design-agent/preview-server";
import { AMERICAN_EDITORIAL, SHOP } from "./fixtures";
import { dataUrl, fakeAnalysis, fakeManifest, fakePng, type FakeAsset } from "./photo-fixtures";

// DEV-029 stage 4: what the photo-aware review gets to see. The full-page
// screenshot keeps its height cap; any photo section the cap cuts off is
// captured on its own, so no photo drops out of the review. The page's
// photos are also collected for the mechanical check.

vi.setConfig({ testTimeout: 120_000 });

let browser: Browser;
let dir: string;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  dir = mkdtempSync(join(tmpdir(), "photo-shots-"));
});
afterAll(async () => {
  await browser?.close();
});

async function pageWith(html: string, mobile: boolean): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true } : { viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.setContent(html);
  return { page, close: () => context.close() };
}

const pngHeight = (path: string) => readFileSync(path).readUInt32BE(20);

describe("segmented screenshots", () => {
  it("keeps the full-page cap and adds a crop for each photo section the cap cuts off", async () => {
    const img = dataUrl(fakePng(390, 300));
    const html = `<body style="margin:0">
      <section data-photo-section="hero" style="height:600px"><figure data-asset="asset-aaaaaaaaaaaaaaaaaaaaaaaa" data-role="hero" style="margin:0"><img src="${img}" style="width:100%"></figure></section>
      <div style="height:4000px"></div>
      <section data-photo-section="visit" style="height:500px"><figure data-asset="asset-bbbbbbbbbbbbbbbbbbbbbbbb" data-role="visit" style="margin:0"><img src="${img}" style="width:100%"></figure></section>
    </body>`;
    const { page, close } = await pageWith(html, true);
    try {
      const shot = join(dir, "c-mobile.png");
      const r = await capturePage(page, { path: shot, mobile: true, sectionPrefix: join(dir, "c-mobile-section") });
      expect(pngHeight(shot)).toBe(SHOT_CAP.mobile);
      // the hero is inside the full screenshot; the visit section is not, so it gets its own crop
      expect(r.sections).toEqual([join(dir, "c-mobile-section-1.png")]);
      expect(existsSync(r.sections[0])).toBe(true);
      expect(pngHeight(r.sections[0])).toBe(500);
      expect(r.placed.map((p) => p.role)).toEqual(["hero", "visit"]);
    } finally {
      await close();
    }
  });

  it("adds no crop when everything fits, and caps a very tall section", async () => {
    const img = dataUrl(fakePng(300, 300));
    const fits = await pageWith(`<body style="margin:0"><section data-photo-section="about"><figure data-asset="asset-aaaaaaaaaaaaaaaaaaaaaaaa" data-role="about" style="margin:0"><img src="${img}"></figure></section></body>`, false);
    try {
      expect((await capturePage(fits.page, { path: join(dir, "fit.png"), mobile: false, sectionPrefix: join(dir, "fit-section") })).sections).toEqual([]);
    } finally {
      await fits.close();
    }
    const tall = await pageWith(`<body style="margin:0"><div style="height:3000px"></div><section data-photo-section="visit" style="height:6000px"><figure data-asset="asset-aaaaaaaaaaaaaaaaaaaaaaaa" data-role="visit" style="margin:0"><img src="${img}"></figure></section></body>`, false);
    try {
      const r = await capturePage(tall.page, { path: join(dir, "tall.png"), mobile: false, sectionPrefix: join(dir, "tall-section") });
      expect(r.sections).toHaveLength(1);
      expect(pngHeight(r.sections[0])).toBe(SHOT_CAP.section);
    } finally {
      await tall.close();
    }
  });
});

// ---------------------------------------------------------------- the real renderer, collected and checked

function moduleCss(file: string, names: Record<string, string>): string {
  const css = readFileSync(join(process.cwd(), file), "utf8");
  return css.replace(/\.(-?[_a-zA-Z][\w-]*)/g, (whole, name: string) => (names[name] ? `.${names[name]}` : whole));
}
const CSS = ["*, *::before, *::after { box-sizing: border-box; } body { margin: 0; }", moduleCss("components/demo/demo.module.css", demoStyles as Record<string, string>), moduleCss("components/demo/profile/profile.module.css", profileStyles as Record<string, string>)].join("\n");

describe("collected photos of the real renderer pass the render check", () => {
  const A = "asset-111111111111111111111111";
  const B = "asset-222222222222222222222222";
  const ASSETS: FakeAsset[] = [
    { id: A, png: fakePng(600, 750, { seed: 1 }), sourceKind: "generated_concept" },
    { id: B, png: fakePng(900, 600, { seed: 2 }), sourceKind: "approved_real" },
  ];
  const manifest = fakeManifest("job-shots", ASSETS);
  const place = (assetId: string) => ({ assetId, fit: "cover" as const, focal: { x: 0.5, y: 0.4 }, mobileFocal: { x: 0.5, y: 0.4 }, aspect: { desktop: "4:5" as const, mobile: "1:1" as const }, treatment: "natural" as const });
  const direction: ImageDirection = { version: 1, layout: "framed_hero", hero: place(A), features: [{ ...place(B), slot: "visit", side: "right" }], rejected: [], paletteFit: 4 };

  it("on both devices", async () => {
    const photos = resolvePhotos({ demo: SHOP, manifest, analyses: { photos: [fakeAnalysis(A), fakeAnalysis(B, { orientation: "landscape" })] }, direction, src: (id) => dataUrl(ASSETS.find((a) => a.id === id)!.png) }).photos;
    expect(photos).not.toBeNull();
    const body = renderToStaticMarkup(<ProfileRenderer demo={SHOP} profile={AMERICAN_EDITORIAL} photos={photos} />);
    const placed = [];
    for (const mobile of [true, false]) {
      const { page, close } = await pageWith(`<!doctype html><html lang="ja"><head><style>${CSS}</style></head><body>${body}</body></html>`, mobile);
      try {
        await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => undefined))));
        placed.push(...(await capturePage(page, { path: join(dir, `real-${mobile}.png`), mobile, sectionPrefix: join(dir, `real-${mobile}-section`) })).placed);
      } finally {
        await close();
      }
    }
    expect(placed).toHaveLength(4);
    expect(checkRenderedPhotos(direction, manifest, placed)).toEqual([]);
    // and a page without the visit photo does not
    expect(checkRenderedPhotos(direction, manifest, placed.filter((p) => p.role !== "visit"))).not.toEqual([]);
  });
});
