import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "..", "public", "_verify");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
await page.goto("http://localhost:3000", { waitUntil: "networkidle" });

// scroll down gradually in real steps so IntersectionObserver actually fires
const totalHeight = await page.evaluate(() => document.body.scrollHeight);
for (let y = 0; y < totalHeight; y += 400) {
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(120);
}
await page.waitForTimeout(600);

const galleryState = await page.evaluate(() => {
  return Array.from(document.querySelectorAll(".gallery-photo")).map((f) => ({
    inView: f.classList.contains("in-view"),
    opacity: getComputedStyle(f).opacity,
  }));
});
console.log("gallery state after real scroll:", JSON.stringify(galleryState));

await page.locator("#works").screenshot({ path: join(outDir, "works-final.png") });

await browser.close();
