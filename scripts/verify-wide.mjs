import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "..", "public", "_verify");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1920, height: 1100 } });
const page = await context.newPage();
await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
await page.waitForTimeout(2200);
await page.screenshot({ path: join(outDir, "hero-wide.png") });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
console.log("overflow at 1920:", overflow);
await browser.close();
