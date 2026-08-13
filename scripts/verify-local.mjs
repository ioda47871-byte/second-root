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

// Hero
await page.waitForTimeout(2200); // let the settle-in animation finish
await page.locator("#home").screenshot({ path: join(outDir, "hero.png") });

// Works
const works = page.locator("#works");
await works.scrollIntoViewIfNeeded();
await page.waitForTimeout(1200);
await works.screenshot({ path: join(outDir, "works.png") });

await browser.close();
console.log("Saved to", outDir);
