import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { capturePublicProfile } from "@/lib/design-agent/worker/capture";
import { startMockSite, type MockSite } from "./worker-support";

// Privacy of the reference screenshots: media is pixelated in the PNG itself,
// including class-set background images and images inside shadow roots.

vi.setConfig({ testTimeout: 60_000 });

let site: MockSite;
let browser: Browser;
beforeAll(async () => {
  site = await startMockSite();
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
});
afterAll(async () => {
  await browser.close();
  site.server.close();
});

/** Standard deviation of the grey level in a square of a PNG (read with the browser). */
async function contrast(png: string, x: number, y: number, size: number): Promise<number> {
  const page = await browser.newPage();
  try {
    return await page.evaluate(
      async ({ src, x, y, size }) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(x, y, size, size).data;
        const g: number[] = [];
        for (let i = 0; i < d.length; i += 4) g.push((d[i]! + d[i + 1]! + d[i + 2]!) / 3);
        const mean = g.reduce((a, b) => a + b, 0) / g.length;
        return Math.sqrt(g.reduce((a, b) => a + (b - mean) ** 2, 0) / g.length);
      },
      { src: `data:image/png;base64,${readFileSync(png).toString("base64")}`, x, y, size },
    );
  } finally {
    await page.close();
  }
}

describe("capture privacy", () => {
  it("pixelates every media rectangle (img, class background, shadow DOM) while keeping the page", async () => {
    const out = mkdtempSync(join(tmpdir(), "srdw-cap-"));
    const result = await capturePublicProfile({ target: site.target("stripes_shop"), outDir: out, launch: () => chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) }), settleMs: 300 });
    expect(result.status).toBe("captured");
    if (result.status !== "captured") return;
    expect(result.softened).toBeGreaterThanOrEqual(3);
    const grid = result.files.find((f) => f.endsWith("grid-top.png"))!;
    // grid-top starts 10px above the first tile; tiles are 300px wide with 4px gaps.
    for (const x of [60, 364, 668]) expect(await contrast(grid, x, 80, 120)).toBeLessThan(25);
    // the unprocessed stripes would be ~127
    expect((readFileSync(grid)[0])).toBe(0x89);
  });
});
