import { describe, expect, it } from "vitest";
import type { ImageDirection } from "@/lib/design-agent/assets/direction";
import { buildPhotoReviewPrompt } from "@/lib/design-agent/photo-prompts";
import { screenshotPage } from "@/lib/design-agent/preview-server";
import { buildReviewPrompt } from "@/lib/design-agent/prompts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cropsByPage, rendererChangeRule, SHOT_VIEWPORTS } from "@/lib/design-agent/shot-viewports";
import { AMERICAN_EDITORIAL, SHOP } from "./fixtures";
import { fakeAnalysis } from "./photo-fixtures";

// DEV-039: the reviewer judges sizes in CSS px. The phone screenshot is a 390 CSS px viewport
// at deviceScaleFactor 2 (a 780 px wide image); the prompts say so, from the same constants
// the screenshots are taken with.

const P = "asset-111111111111111111111111";
const direction: ImageDirection = {
  version: 1,
  layout: "split_hero",
  hero: { assetId: P, fit: "cover", focal: { x: 0.5, y: 0.5 }, mobileFocal: { x: 0.5, y: 0.5 }, aspect: { desktop: "4:5", mobile: "1:1" }, treatment: "natural" },
  features: [],
  rejected: [],
  paletteFit: 4,
};
const photoPrompt = (crops: { desktop: number; mobile: number; unknown?: number }) =>
  buildPhotoReviewPrompt({ demo: SHOP, profile: AMERICAN_EDITORIAL, direction, analyses: [fakeAnalysis(P)], referenceCount: 2, referenceKind: "instagram", crops, round: 1, maxRevisions: 2 });
const prompts = {
  review: buildReviewPrompt({ demo: SHOP, profile: AMERICAN_EDITORIAL, referenceCount: 3, referenceKind: "instagram", round: 1, maxRevisions: 2 }),
  photo: photoPrompt({ desktop: 1, mobile: 2 }),
};

describe("review prompts: CSS px vs screenshot pixels", () => {
  for (const [name, prompt] of Object.entries(prompts)) {
    it(`${name}: names each image's full width in CSS px, the stored raster scale, and asks for CSS px`, () => {
      expect(prompt).toContain("mobile (390 CSS px wide)");
      expect(prompt).toContain("desktop (1440 CSS px wide)");
      expect(prompt).toContain("the full width of the desktop image is 1440 CSS px (stored at 1×)");
      expect(prompt).toContain("the full width of the mobile image is 390 CSS px (stored at deviceScaleFactor 2, a 780 px file)");
      expect(prompt).toContain("Images may be scaled before you see them: judge type sizes and spacing in CSS px, as a fraction of the image's full width, never from raw pixel counts.");
      expect(prompt).not.toMatch(/\(390px wide\)|\(1440px wide\)/);
    });
  }

  it("asks for a renderer change only for what the vocabulary (and, with photos, a new image direction) and the renderer cannot reach", () => {
    expect(prompts.review).toContain(rendererChangeRule());
    expect(prompts.photo).toContain(rendererChangeRule({ photos: true }));
    expect(rendererChangeRule()).toContain("cannot be reached with the profile vocabulary above and the renderer's current behaviour");
    expect(rendererChangeRule({ photos: true })).toContain("the profile vocabulary above, a new image direction and the renderer's current behaviour");
    for (const rule of [rendererChangeRule(), rendererChangeRule({ photos: true })]) {
      expect(rule).toContain("Do not derive a CSS target from raw image-pixel sizes");
      expect(rule).toContain("do not ask for a renderer change to reach a size or spacing the page already has");
    }
  });

  it("counts the photo-section crops by page, in the order they are attached, only where there are crops", () => {
    expect(prompts.photo).toContain(
      "then 1 desktop crop(s) (each 1440 CSS px across), then 2 mobile crop(s) (each 390 CSS px across) of photo sections the full screenshots cut off (a crop may overlap their end).",
    );
    expect(prompts.photo).toContain("Each photo-section crop spans the full width of its page, at that page's scale.");
    expect(photoPrompt({ desktop: 0, mobile: 1 })).toContain("then 1 mobile crop(s) (each 390 CSS px across) of photo sections");
    const none = photoPrompt({ desktop: 0, mobile: 0 });
    expect(none).toContain("mobile (390 CSS px wide).");
    expect(none).not.toMatch(/photo-section crop|desktop crop|mobile crop|cut off/);
    expect(prompts.review).not.toContain("photo-section crop");
  });

  it("orders the crops desktop first, then mobile, whatever order the renderer returns them in", () => {
    const shots = ["/s/candidate-1-mobile-section-1.png", "/s/candidate-1-desktop-section-1.png", "/s/candidate-1-mobile-section-2.png"];
    expect(cropsByPage(shots)).toEqual({ desktop: ["/s/candidate-1-desktop-section-1.png"], mobile: ["/s/candidate-1-mobile-section-1.png", "/s/candidate-1-mobile-section-2.png"], unknown: [] });
  });

  it("never counts a crop whose name names neither page as desktop or mobile (by file name, not directory)", () => {
    const shots = ["/s/candidate-1-d-section-1.png", "/run-desktop-section-x/candidate-1-m-section-1.png", "/s/candidate-1-mobile-section-1.png"];
    expect(cropsByPage(shots)).toEqual({ desktop: [], mobile: ["/s/candidate-1-mobile-section-1.png"], unknown: ["/s/candidate-1-d-section-1.png", "/run-desktop-section-x/candidate-1-m-section-1.png"] });
    expect(photoPrompt({ desktop: 0, mobile: 1, unknown: 2 })).toContain("then 1 mobile crop(s) (each 390 CSS px across), then 2 crop(s) whose page is not known of photo sections");
  });

  it("the photo review prompt changes only where DEV-039 meant it to", () => {
    expect(prompts.photo).toMatchSnapshot("photo-review");
  });
});

describe("the screenshots and the prompts share one source", () => {
  it("screenshotPage opens its contexts with SHOT_VIEWPORTS", async () => {
    const seen: unknown[] = [];
    const browser = {
      newContext: async (options: unknown) => {
        seen.push(options);
        throw new Error("stop");
      },
    } as unknown as Parameters<typeof screenshotPage>[0];
    for (const mobile of [true, false]) await expect(screenshotPage(browser, "http://127.0.0.1:1/x", "/nonexistent/x.png", mobile)).rejects.toThrow("stop");
    expect(seen[0]).toMatchObject({ viewport: { width: SHOT_VIEWPORTS.mobile.width, height: SHOT_VIEWPORTS.mobile.height }, deviceScaleFactor: SHOT_VIEWPORTS.mobile.scale, isMobile: true });
    expect(seen[1]).toMatchObject({ viewport: { width: SHOT_VIEWPORTS.desktop.width, height: SHOT_VIEWPORTS.desktop.height }, deviceScaleFactor: SHOT_VIEWPORTS.desktop.scale });
    expect(SHOT_VIEWPORTS).toEqual({ desktop: { width: 1440, height: 900, scale: 1 }, mobile: { width: 390, height: 844, scale: 2 } });
  });

  it("preview-server.ts keeps no second copy of the viewport numbers", () => {
    const src = readFileSync(join(process.cwd(), "lib/design-agent/preview-server.ts"), "utf8");
    expect(src).not.toMatch(/width:\s*(390|1440)\b|height:\s*(844|900)\b|\?\s*(390|1440)\s*:/);
    expect(src).not.toMatch(/deviceScaleFactor:\s*\d/);
  });
});
