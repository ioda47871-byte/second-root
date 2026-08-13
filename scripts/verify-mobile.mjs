import { chromium } from "playwright";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "..", "public", "_verify");

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true });
const page = await context.newPage();
await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
await page.waitForTimeout(2200);
await page.locator("#home").screenshot({ path: join(outDir, "hero-mobile.png") });

const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
console.log("horizontal overflow:", overflow);

await browser.close();
