import { describe, expect, it } from "vitest";
import type { ImageDirection } from "@/lib/design-agent/assets/direction";
import { buildPhotoReviewPrompt } from "@/lib/design-agent/photo-prompts";
import { screenshotPage } from "@/lib/design-agent/preview-server";
import { buildReviewPrompt } from "@/lib/design-agent/prompts";
import { RENDERER_CHANGE_RULE, SHOT_VIEWPORTS } from "@/lib/design-agent/shot-viewports";
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
const prompts = {
  review: buildReviewPrompt({ demo: SHOP, profile: AMERICAN_EDITORIAL, referenceCount: 3, referenceKind: "instagram", round: 1, maxRevisions: 2 }),
  photo: buildPhotoReviewPrompt({ demo: SHOP, profile: AMERICAN_EDITORIAL, direction, analyses: [fakeAnalysis(P)], referenceCount: 2, referenceKind: "instagram", sectionCount: 1, round: 1, maxRevisions: 2 }),
};

describe("review prompts: CSS px vs screenshot pixels", () => {
  for (const [name, prompt] of Object.entries(prompts)) {
    it(`${name}: names the CSS viewport, the raster width and the scale, and asks for CSS px`, () => {
      expect(prompt).toContain("mobile (390 CSS px wide)");
      expect(prompt).toContain("desktop (1440 CSS px wide)");
      expect(prompt).toContain("390 CSS px wide viewport at deviceScaleFactor 2, so the image is 780 px wide and 1 CSS px = 2 image px");
      expect(prompt).toContain("1440 CSS px wide viewport at 1× (the image is 1440 px wide)");
      expect(prompt).toContain("Judge type sizes and spacing in CSS px (divide mobile image pixels by 2), never in raw image pixels.");
      expect(prompt).not.toMatch(/\(390px wide\)|\(1440px wide\)/);
    });

    it(`${name}: asks for a renderer change only for what the vocabulary and the renderer cannot reach`, () => {
      expect(prompt).toContain(RENDERER_CHANGE_RULE);
      expect(RENDERER_CHANGE_RULE).toContain("cannot be reached with the profile vocabulary above and the renderer's current behaviour");
      expect(RENDERER_CHANGE_RULE).toContain("Do not derive a CSS target from raw image-pixel sizes");
      expect(RENDERER_CHANGE_RULE).toContain("do not ask for a renderer change to reach a size or spacing the page already has");
    });
  }

  it("mentions photo-section crops only where there are any", () => {
    expect(prompts.photo).toContain("Photo-section crops use the same scale as their page.");
    expect(prompts.review).not.toContain("Photo-section crops");
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
});
