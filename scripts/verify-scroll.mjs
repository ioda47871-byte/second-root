import { chromium } from "playwright";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "..", "public", "_verify");
import { mkdirSync } from "node:fs";
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
await page.goto("http://localhost:3000", { waitUntil: "networkidle" });

// buttons: confirm sharp corners
const btnRadius = await page.evaluate(() => {
  const btn = document.querySelector(".btn-primary");
  return btn ? getComputedStyle(btn).borderRadius : "not found";
});
console.log("btn-primary border-radius:", btnRadius);

// scroll to works, check reveal-media state before/after
const works = page.locator("#works");
await works.scrollIntoViewIfNeeded();
await page.waitForTimeout(1300);
await works.screenshot({ path: join(outDir, "works-rhythm.png") });

const galleryState = await page.evaluate(() => {
  const figs = Array.from(document.querySelectorAll(".gallery-photo"));
  return figs.map((f) => ({ inView: f.classList.contains("in-view"), opacity: getComputedStyle(f).opacity }));
});
console.log("gallery reveal state:", JSON.stringify(galleryState));

// check hero parallax transform changes with scroll
await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
await page.waitForTimeout(500);
const t1 = await page.evaluate(() => document.querySelector(".parallax")?.style.transform);
await page.mouse.wheel(0, 300);
await page.waitForTimeout(300);
const t2 = await page.evaluate(() => document.querySelector(".parallax")?.style.transform);
console.log("parallax transform before scroll:", t1, "| after scroll:", t2);

await browser.close();
